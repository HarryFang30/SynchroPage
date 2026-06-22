from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

DEFAULT_PROVIDER_ID = "codex_oauth"
OAUTH_CLIENT_ID_ENV_VARS = ("PDF_AGENT_OPENAI_OAUTH_CLIENT_ID", "OPENAI_OAUTH_CLIENT_ID")
OAUTH_STORAGE_PATH_ENV_VAR = "PDF_AGENT_OPENAI_OAUTH_STORAGE_PATH"
DATA_DIR_ENV_VAR = "PDF_AGENT_HOME"
# Public OAuth client id for the Codex device-code flow.  This is NOT a
# secret / access token / refresh token — it only identifies the application
# to the OpenAI device-auth endpoint.  Keeping it compiled into the module
# lets the desktop app refresh an existing OAuth session after restart
# without requiring shell environment variables.
#
# Source: ChatGPT Codex public device-flow registration.
# Set ``PDF_AGENT_OPENAI_OAUTH_CLIENT_ID`` or ``OPENAI_OAUTH_CLIENT_ID`` to
# override at runtime (see ``_default_oauth_client_id``).
DEFAULT_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
DEVICE_AUTH_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode"
DEVICE_AUTH_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token"
OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device"
DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback"

DEFAULT_DEVICE_EXPIRES_IN_SECONDS = 900
DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 3600
POLLING_SAFETY_MARGIN_SECONDS = 3
TOKEN_REFRESH_BUFFER_SECONDS = 60
DEFAULT_USER_AGENT = "pdf-agent-openai-oauth/0.1"
ERROR_DETAIL_MAX_CHARS = 500
SENSITIVE_OAUTH_FIELDS = (
    "access_token",
    "refresh_token",
    "id_token",
    "authorization_code",
    "code_verifier",
    "device_auth_id",
)
_SENSITIVE_FIELD_PATTERN = "|".join(re.escape(field) for field in SENSITIVE_OAUTH_FIELDS)
_JSON_SECRET_RE = re.compile(rf'("(?:(?:{_SENSITIVE_FIELD_PATTERN}))"\s*:\s*")[^"]+(")', re.IGNORECASE)
_JSON_DANGLING_SECRET_RE = re.compile(rf'("(?:(?:{_SENSITIVE_FIELD_PATTERN}))"\s*:\s*")[^"]*\Z', re.IGNORECASE)
_FORM_SECRET_RE = re.compile(rf"((?:{_SENSITIVE_FIELD_PATTERN})=)[^&\s]+", re.IGNORECASE)
_BEARER_SECRET_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/-]+", re.IGNORECASE)
_ENV_VAR_RE = re.compile(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$")


class OpenAIOAuthError(RuntimeError):
    def __init__(self, code: str, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class HttpJsonResponse:
    status: int
    body: Any
    text: str


class JsonHttpClient(Protocol):
    def post_json(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> HttpJsonResponse:
        ...

    def post_form(self, url: str, payload: dict[str, str], headers: dict[str, str]) -> HttpJsonResponse:
        ...


class UrllibJsonHttpClient:
    def __init__(self, *, timeout_seconds: float = 30.0) -> None:
        self.timeout_seconds = timeout_seconds

    def post_json(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> HttpJsonResponse:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        merged = {"Content-Type": "application/json", **headers}
        return self._request("POST", url, data, merged)

    def post_form(self, url: str, payload: dict[str, str], headers: dict[str, str]) -> HttpJsonResponse:
        data = urllib.parse.urlencode(payload).encode("utf-8")
        merged = {"Content-Type": "application/x-www-form-urlencoded", **headers}
        return self._request("POST", url, data, merged)

    def _request(self, method: str, url: str, data: bytes, headers: dict[str, str]) -> HttpJsonResponse:
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                text = response.read().decode("utf-8")
                return HttpJsonResponse(response.status, _loads_json(text), text)
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace")
            return HttpJsonResponse(exc.code, _loads_json(text), text)
        except urllib.error.URLError as exc:
            raise OpenAIOAuthError("network_error", str(exc)) from exc


@dataclass(frozen=True)
class OpenAIOAuthConfig:
    provider_id: str = DEFAULT_PROVIDER_ID
    client_id: str = field(default_factory=lambda: _default_oauth_client_id())
    device_start_url: str = DEVICE_AUTH_USERCODE_URL
    device_poll_url: str = DEVICE_AUTH_TOKEN_URL
    token_url: str = OAUTH_TOKEN_URL
    verification_uri: str = DEVICE_VERIFICATION_URL
    redirect_uri: str = DEVICE_REDIRECT_URI
    storage_path: Path | None = None
    polling_safety_margin_seconds: int = POLLING_SAFETY_MARGIN_SECONDS
    refresh_before_expiry_seconds: int = TOKEN_REFRESH_BUFFER_SECONDS
    user_agent: str = DEFAULT_USER_AGENT

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> OpenAIOAuthConfig:
        provider = _mapping(value.get("provider"))
        flow = _mapping(value.get("device_flow"))
        storage = _mapping(value.get("storage"))
        return cls(
            provider_id=_string_value(provider.get("id"), DEFAULT_PROVIDER_ID),
            client_id=_config_string_value(flow.get("client_id"), _default_oauth_client_id()),
            device_start_url=_string_value(flow.get("start_url"), DEVICE_AUTH_USERCODE_URL),
            device_poll_url=_string_value(flow.get("poll_url"), DEVICE_AUTH_TOKEN_URL),
            token_url=_string_value(flow.get("token_url"), OAUTH_TOKEN_URL),
            verification_uri=_string_value(flow.get("verification_uri"), DEVICE_VERIFICATION_URL),
            redirect_uri=_string_value(flow.get("redirect_uri"), DEVICE_REDIRECT_URI),
            storage_path=_optional_path(storage.get("path")),
            polling_safety_margin_seconds=_positive_int(
                flow.get("polling_safety_margin_seconds"),
                POLLING_SAFETY_MARGIN_SECONDS,
            ),
            refresh_before_expiry_seconds=_positive_int(
                flow.get("refresh_before_expiry_seconds"),
                TOKEN_REFRESH_BUFFER_SECONDS,
            ),
            user_agent=_string_value(value.get("user_agent"), DEFAULT_USER_AGENT),
        )

    @classmethod
    def from_file(cls, path: Path | str) -> OpenAIOAuthConfig:
        config_path = Path(path).expanduser()
        try:
            text = config_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise OpenAIOAuthError("config_load_failed", f"Unable to load OAuth config: {exc}") from exc
        loaded = _loads_mapping_document(text, config_path)
        return cls.from_mapping(loaded)

    @classmethod
    def coerce(cls, value: OpenAIOAuthConfig | Mapping[str, Any] | Path | str | None) -> OpenAIOAuthConfig:
        if value is None:
            return cls()
        if isinstance(value, cls):
            return value
        if isinstance(value, Mapping):
            return cls.from_mapping(value)
        if isinstance(value, (str, Path)):
            return cls.from_file(value)
        raise TypeError(f"unsupported OpenAI OAuth config type: {type(value)!r}")

    def require_client_id(self) -> str:
        client_id = self.client_id.strip()
        if not client_id or _ENV_VAR_RE.match(client_id):
            env_names = " or ".join(OAUTH_CLIENT_ID_ENV_VARS)
            raise OpenAIOAuthError(
                "oauth_client_id_missing",
                f"OpenAI OAuth client id is not configured. Set {env_names}.",
            )
        return client_id


@dataclass(frozen=True)
class DeviceAuthorization:
    provider: str
    device_code: str
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int

    def to_public_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class OpenAIAccount:
    id: str
    provider: str
    login: str
    authenticated_at: int
    is_default: bool = False

    def to_public_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class OpenAIAuthStatus:
    provider: str
    authenticated: bool
    default_account_id: str | None
    accounts: list[OpenAIAccount]

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "authenticated": self.authenticated,
            "default_account_id": self.default_account_id,
            "accounts": [account.to_public_dict() for account in self.accounts],
        }


@dataclass(frozen=True)
class OpenAIRequestContext:
    account_id: str
    access_token: str

    def chatgpt_codex_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.access_token}",
            "ChatGPT-Account-Id": self.account_id,
        }


@dataclass
class _StoredAccount:
    account_id: str
    refresh_token: str
    authenticated_at: int
    email: str | None = None

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> _StoredAccount:
        return cls(
            account_id=str(value["account_id"]),
            refresh_token=str(value["refresh_token"]),
            authenticated_at=int(value.get("authenticated_at") or 0),
            email=value.get("email") if isinstance(value.get("email"), str) else None,
        )

    def to_json(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "account_id": self.account_id,
            "refresh_token": self.refresh_token,
            "authenticated_at": self.authenticated_at,
        }
        if self.email:
            value["email"] = self.email
        return value


@dataclass
class _OAuthStore:
    version: int = 1
    accounts: dict[str, _StoredAccount] = field(default_factory=dict)
    default_account_id: str | None = None

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> _OAuthStore:
        raw_accounts = value.get("accounts") if isinstance(value, dict) else None
        accounts: dict[str, _StoredAccount] = {}
        if isinstance(raw_accounts, dict):
            for account_id, raw_account in raw_accounts.items():
                if isinstance(raw_account, dict):
                    account = _StoredAccount.from_json(raw_account)
                    accounts[str(account_id)] = account
        default_account_id = value.get("default_account_id")
        return cls(
            version=int(value.get("version") or 1),
            accounts=accounts,
            default_account_id=default_account_id if isinstance(default_account_id, str) else None,
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "accounts": {account_id: account.to_json() for account_id, account in self.accounts.items()},
            "default_account_id": self.default_account_id,
        }


@dataclass(frozen=True)
class _CachedAccessToken:
    token: str
    expires_at_ms: int

    def expiring_soon(self, *, refresh_buffer_seconds: int = TOKEN_REFRESH_BUFFER_SECONDS) -> bool:
        return self.expires_at_ms - _now_ms() < refresh_buffer_seconds * 1000


@dataclass(frozen=True)
class _PendingDeviceCode:
    user_code: str
    expires_at_ms: int


class OpenAIOAuthManager:
    """OpenAI/ChatGPT device-code OAuth manager adapted from cc-switch.

    This manager intentionally persists refresh tokens only. Access tokens live
    in memory and are refreshed on demand behind a per-account lock.
    """

    provider = DEFAULT_PROVIDER_ID

    def __init__(
        self,
        *,
        config: OpenAIOAuthConfig | Mapping[str, Any] | Path | str | None = None,
        data_dir: Path | str | None = None,
        storage_path: Path | str | None = None,
        http_client: JsonHttpClient | None = None,
        user_agent: str | None = None,
    ) -> None:
        self.config = OpenAIOAuthConfig.coerce(config)
        self.provider = self.config.provider_id
        if storage_path is None:
            env_storage_path = _optional_path(os.environ.get(OAUTH_STORAGE_PATH_ENV_VAR))
            env_data_dir = _optional_path(os.environ.get(DATA_DIR_ENV_VAR))
            if env_storage_path is not None:
                storage_path = env_storage_path
            elif data_dir is not None:
                storage_path = Path(data_dir) / "openai_oauth.json"
            elif env_data_dir is not None:
                storage_path = env_data_dir / "openai_oauth.json"
            elif self.config.storage_path is not None:
                storage_path = self.config.storage_path
            else:
                storage_path = default_data_dir() / "openai_oauth.json"

        self.storage_path = Path(storage_path).expanduser()
        self.http_client = http_client or UrllibJsonHttpClient()
        self.user_agent = user_agent or self.config.user_agent
        self._store = self._load_store()
        self._access_tokens: dict[str, _CachedAccessToken] = {}
        self._pending_device_codes: dict[str, _PendingDeviceCode] = {}
        self._lock = asyncio.Lock()
        self._refresh_locks: dict[str, asyncio.Lock] = {}

    async def start_login(self) -> DeviceAuthorization:
        client_id = self.config.require_client_id()
        response = await asyncio.to_thread(
            self.http_client.post_json,
            self.config.device_start_url,
            {"client_id": client_id},
            self._headers(),
        )
        self._ensure_success(response, "device_code_failed")

        body = response.body if isinstance(response.body, dict) else {}
        device_code = _require_string(body, "device_auth_id")
        user_code = _require_string(body, "user_code")
        expires_in = _positive_int(body.get("expires_in"), DEFAULT_DEVICE_EXPIRES_IN_SECONDS)
        interval = _parse_interval(
            body.get("interval"),
            safety_margin_seconds=self.config.polling_safety_margin_seconds,
        )
        expires_at_ms = _now_ms() + expires_in * 1000

        async with self._lock:
            now_ms = _now_ms()
            self._pending_device_codes = {
                key: value for key, value in self._pending_device_codes.items() if value.expires_at_ms > now_ms
            }
            self._pending_device_codes[device_code] = _PendingDeviceCode(user_code=user_code, expires_at_ms=expires_at_ms)

        return DeviceAuthorization(
            provider=self.provider,
            device_code=device_code,
            user_code=user_code,
            verification_uri=self.config.verification_uri,
            expires_in=expires_in,
            interval=interval,
        )

    async def poll_login(self, device_code: str) -> OpenAIAccount | None:
        async with self._lock:
            pending = self._pending_device_codes.get(device_code)
            if pending is None:
                raise OpenAIOAuthError("unknown_device_code", "Device code is unknown or already completed")
            if pending.expires_at_ms <= _now_ms():
                self._pending_device_codes.pop(device_code, None)
                raise OpenAIOAuthError("expired_token", "Device code expired")
            user_code = pending.user_code

        response = await asyncio.to_thread(
            self.http_client.post_json,
            self.config.device_poll_url,
            {"device_auth_id": device_code, "user_code": user_code},
            self._headers(),
        )
        if response.status in {403, 404}:
            return None
        if response.status == 410:
            async with self._lock:
                self._pending_device_codes.pop(device_code, None)
            raise OpenAIOAuthError("expired_token", "Device code expired", status=response.status)
        self._ensure_success(response, "device_poll_failed")

        body = response.body if isinstance(response.body, dict) else {}
        authorization_code = _require_string(body, "authorization_code")
        code_verifier = _require_string(body, "code_verifier")
        tokens = await self._exchange_code_for_tokens(authorization_code, code_verifier)
        refresh_token = _require_string(tokens, "refresh_token")
        access_token = _require_string(tokens, "access_token")
        account_id, email = _extract_identity_from_tokens(tokens)
        if not account_id:
            raise OpenAIOAuthError("identity_missing", "Unable to extract ChatGPT account id from OAuth tokens")

        account = _StoredAccount(
            account_id=account_id,
            refresh_token=refresh_token,
            authenticated_at=int(time.time()),
            email=email,
        )
        async with self._lock:
            self._pending_device_codes.pop(device_code, None)
            self._store.accounts[account_id] = account
            if not self._store.default_account_id or self._store.default_account_id not in self._store.accounts:
                self._store.default_account_id = account_id
            self._access_tokens[account_id] = _CachedAccessToken(
                token=access_token,
                expires_at_ms=_compute_expires_at_ms(tokens.get("expires_in")),
            )
            self._save_store()
            default_account_id = self._resolve_default_account_id_locked()

        return self._public_account(account, default_account_id)

    async def get_status(self) -> OpenAIAuthStatus:
        async with self._lock:
            default_account_id = self._resolve_default_account_id_locked()
            accounts = self._sorted_public_accounts_locked(default_account_id)
        return OpenAIAuthStatus(
            provider=self.provider,
            authenticated=bool(accounts),
            default_account_id=default_account_id,
            accounts=accounts,
        )

    async def list_accounts(self) -> list[OpenAIAccount]:
        return (await self.get_status()).accounts

    async def set_default_account(self, account_id: str) -> None:
        async with self._lock:
            if account_id not in self._store.accounts:
                raise OpenAIOAuthError("account_not_found", f"Account not found: {account_id}")
            self._store.default_account_id = account_id
            self._save_store()

    async def remove_account(self, account_id: str) -> None:
        async with self._lock:
            if self._store.accounts.pop(account_id, None) is None:
                raise OpenAIOAuthError("account_not_found", f"Account not found: {account_id}")
            self._access_tokens.pop(account_id, None)
            self._refresh_locks.pop(account_id, None)
            if self._store.default_account_id == account_id:
                self._store.default_account_id = self._fallback_default_account_id_locked()
            self._save_store()

    async def logout(self) -> None:
        async with self._lock:
            self._store = _OAuthStore()
            self._access_tokens.clear()
            self._refresh_locks.clear()
            self._pending_device_codes.clear()
            if self.storage_path.exists():
                self.storage_path.unlink()

    async def get_valid_access_token(self, account_id: str | None = None) -> str:
        return (await self.get_request_context(account_id)).access_token

    async def get_request_context(self, account_id: str | None = None) -> OpenAIRequestContext:
        resolved_account_id = await self.resolve_account_id(account_id)
        cached = await self._cached_token_if_valid(resolved_account_id)
        if cached is not None:
            return OpenAIRequestContext(account_id=resolved_account_id, access_token=cached)

        refresh_lock = await self._refresh_lock_for(resolved_account_id)
        async with refresh_lock:
            cached = await self._cached_token_if_valid(resolved_account_id)
            if cached is not None:
                return OpenAIRequestContext(account_id=resolved_account_id, access_token=cached)

            async with self._lock:
                account = self._store.accounts.get(resolved_account_id)
                if account is None:
                    raise OpenAIOAuthError("account_not_found", f"Account not found: {resolved_account_id}")
                refresh_token = account.refresh_token

            tokens = await self._refresh_with_token(refresh_token)
            access_token = _require_string(tokens, "access_token")
            new_refresh_token = tokens.get("refresh_token")

            async with self._lock:
                stored_account = self._store.accounts.get(resolved_account_id)
                if stored_account is None:
                    raise OpenAIOAuthError("account_not_found", f"Account not found: {resolved_account_id}")
                if isinstance(new_refresh_token, str) and new_refresh_token and new_refresh_token != stored_account.refresh_token:
                    stored_account.refresh_token = new_refresh_token
                    self._save_store()
                self._access_tokens[resolved_account_id] = _CachedAccessToken(
                    token=access_token,
                    expires_at_ms=_compute_expires_at_ms(tokens.get("expires_in")),
                )

            return OpenAIRequestContext(account_id=resolved_account_id, access_token=access_token)

    async def resolve_account_id(self, account_id: str | None = None) -> str:
        requested = account_id.strip() if isinstance(account_id, str) else None
        async with self._lock:
            if requested:
                if requested not in self._store.accounts:
                    raise OpenAIOAuthError("account_not_found", f"Account not found: {requested}")
                return requested
            resolved = self._resolve_default_account_id_locked()
            if resolved is None:
                raise OpenAIOAuthError("account_not_found", "No ChatGPT account is available")
            return resolved

    async def _cached_token_if_valid(self, account_id: str) -> str | None:
        async with self._lock:
            cached = self._access_tokens.get(account_id)
            if cached is not None and not cached.expiring_soon(
                refresh_buffer_seconds=self.config.refresh_before_expiry_seconds,
            ):
                return cached.token
        return None

    async def _refresh_lock_for(self, account_id: str) -> asyncio.Lock:
        async with self._lock:
            lock = self._refresh_locks.get(account_id)
            if lock is None:
                lock = asyncio.Lock()
                self._refresh_locks[account_id] = lock
            return lock

    async def _exchange_code_for_tokens(self, code: str, code_verifier: str) -> dict[str, Any]:
        client_id = self.config.require_client_id()
        response = await asyncio.to_thread(
            self.http_client.post_form,
            self.config.token_url,
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.config.redirect_uri,
                "client_id": client_id,
                "code_verifier": code_verifier,
            },
            self._headers(),
        )
        self._ensure_success(response, "token_exchange_failed")
        if not isinstance(response.body, dict):
            raise OpenAIOAuthError("parse_error", "OAuth token response is not an object")
        return response.body

    async def _refresh_with_token(self, refresh_token: str) -> dict[str, Any]:
        client_id = self.config.require_client_id()
        response = await asyncio.to_thread(
            self.http_client.post_form,
            self.config.token_url,
            {
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": client_id,
                "scope": "openid profile email",
            },
            self._headers(),
        )
        if response.status in {401, 403}:
            raise OpenAIOAuthError("refresh_token_invalid", "Refresh token is invalid", status=response.status)
        self._ensure_success(response, "refresh_failed")
        if not isinstance(response.body, dict):
            raise OpenAIOAuthError("parse_error", "OAuth refresh response is not an object")
        return response.body

    def _headers(self) -> dict[str, str]:
        return {"User-Agent": self.user_agent}

    def _load_store(self) -> _OAuthStore:
        if not self.storage_path.exists():
            return _OAuthStore()
        try:
            raw = json.loads(self.storage_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise OpenAIOAuthError("store_load_failed", f"Unable to load OAuth store: {exc}") from exc
        if not isinstance(raw, dict):
            raise OpenAIOAuthError("store_load_failed", "OAuth store root must be an object")
        return _OAuthStore.from_json(raw)

    def _save_store(self) -> None:
        content = json.dumps(self._store.to_json(), ensure_ascii=False, indent=2, sort_keys=True)
        atomic_write_secret(self.storage_path, content)

    def _ensure_success(self, response: HttpJsonResponse, code: str) -> None:
        if 200 <= response.status < 300:
            return
        detail = redact_secret_text(response.text, max_chars=ERROR_DETAIL_MAX_CHARS) if response.text else f"HTTP {response.status}"
        raise OpenAIOAuthError(code, detail, status=response.status)

    def _resolve_default_account_id_locked(self) -> str | None:
        stored = self._store.default_account_id
        if stored and stored in self._store.accounts:
            return stored
        fallback = self._fallback_default_account_id_locked()
        self._store.default_account_id = fallback
        return fallback

    def _fallback_default_account_id_locked(self) -> str | None:
        if not self._store.accounts:
            return None
        return max(
            self._store.accounts.values(),
            key=lambda account: (account.authenticated_at, account.account_id),
        ).account_id

    def _sorted_public_accounts_locked(self, default_account_id: str | None) -> list[OpenAIAccount]:
        accounts = [self._public_account(account, default_account_id) for account in self._store.accounts.values()]
        accounts.sort(key=lambda account: (not account.is_default, -account.authenticated_at, account.login))
        return accounts

    def _public_account(self, account: _StoredAccount, default_account_id: str | None) -> OpenAIAccount:
        return OpenAIAccount(
            id=account.account_id,
            provider=self.provider,
            login=account.email or f"ChatGPT ({account.account_id})",
            authenticated_at=account.authenticated_at,
            is_default=account.account_id == default_account_id,
        )


def default_data_dir() -> Path:
    return Path(os.environ.get(DATA_DIR_ENV_VAR, "~/.pdf_agent")).expanduser()


def atomic_write_secret(path: Path, content: str) -> None:
    path = path.expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp.{os.getpid()}.{secrets.token_hex(8)}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(tmp_path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(tmp_path, path)
        if os.name == "posix":
            os.chmod(path, 0o600)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        finally:
            raise


def redact_secret_text(text: str, *, max_chars: int | None = None) -> str:
    redacted = _JSON_SECRET_RE.sub(r"\1<redacted>\2", text)
    redacted = _JSON_DANGLING_SECRET_RE.sub(r"\1<redacted>", redacted)
    redacted = _FORM_SECRET_RE.sub(r"\1<redacted>", redacted)
    redacted = _BEARER_SECRET_RE.sub(r"\1<redacted>", redacted)
    if max_chars is not None and len(redacted) > max_chars:
        return redacted[:max_chars]
    return redacted


def _loads_mapping_document(text: str, source: Path) -> dict[str, Any]:
    stripped = text.lstrip()
    if stripped.startswith("{"):
        try:
            value = json.loads(text)
        except json.JSONDecodeError as exc:
            raise OpenAIOAuthError("config_parse_failed", f"Invalid OAuth config JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise OpenAIOAuthError("config_parse_failed", "OAuth config root must be an object")
        return value

    import yaml

    try:
        value = yaml.safe_load(text)
    except Exception as exc:
        raise OpenAIOAuthError("config_parse_failed", f"Invalid OAuth config YAML {source}: {exc}") from exc
    if not isinstance(value, dict):
        raise OpenAIOAuthError("config_parse_failed", "OAuth config root must be an object")
    return value


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _string_value(value: Any, default: str) -> str:
    return value.strip() if isinstance(value, str) and value.strip() else default


def _config_string_value(value: Any, default: str) -> str:
    if not isinstance(value, str) or not value.strip():
        return default
    raw = value.strip()
    env_match = _ENV_VAR_RE.match(raw)
    if env_match:
        return os.environ.get(env_match.group(1), default).strip()
    return os.path.expandvars(raw).strip()


def _default_oauth_client_id() -> str:
    for name in OAUTH_CLIENT_ID_ENV_VARS:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    # See comment on :data:`DEFAULT_CODEX_OAUTH_CLIENT_ID` above.
    return DEFAULT_CODEX_OAUTH_CLIENT_ID


def _optional_path(value: Any) -> Path | None:
    return Path(os.path.expandvars(value.strip())).expanduser() if isinstance(value, str) and value.strip() else None


def _loads_json(text: str) -> Any:
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _require_string(value: dict[str, Any], key: str) -> str:
    raw = value.get(key)
    if not isinstance(raw, str) or not raw.strip():
        raise OpenAIOAuthError("parse_error", f"Missing string field: {key}")
    return raw.strip()


def _positive_int(value: Any, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return number if number > 0 else default


def _parse_interval(value: Any, *, safety_margin_seconds: int = POLLING_SAFETY_MARGIN_SECONDS) -> int:
    return _positive_int(value, 5) + safety_margin_seconds


def _compute_expires_at_ms(expires_in: Any) -> int:
    seconds = _positive_int(expires_in, DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS)
    return _now_ms() + seconds * 1000


def _now_ms() -> int:
    return int(time.monotonic() * 1000)


def _extract_identity_from_tokens(tokens: dict[str, Any]) -> tuple[str | None, str | None]:
    for key in ("id_token", "access_token"):
        token = tokens.get(key)
        if not isinstance(token, str):
            continue
        claims = _parse_jwt_claims(token)
        if not claims:
            continue
        account_id = _claim_account_id(claims)
        email = claims.get("email") if isinstance(claims.get("email"), str) else None
        if account_id:
            return account_id, email
    return None, None


def _parse_jwt_claims(token: str) -> dict[str, Any] | None:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1]
    padding = "=" * (-len(payload) % 4)
    try:
        decoded = base64.urlsafe_b64decode((payload + padding).encode("ascii"))
        claims = json.loads(decoded.decode("utf-8"))
    except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return claims if isinstance(claims, dict) else None


def _claim_account_id(claims: dict[str, Any]) -> str | None:
    direct = claims.get("chatgpt_account_id")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()

    openai_auth = claims.get("https://api.openai.com/auth")
    if isinstance(openai_auth, dict):
        nested = openai_auth.get("chatgpt_account_id")
        if isinstance(nested, str) and nested.strip():
            return nested.strip()

    organizations = claims.get("organizations")
    if isinstance(organizations, list):
        for organization in organizations:
            if isinstance(organization, dict):
                org_id = organization.get("id")
                if isinstance(org_id, str) and org_id.strip():
                    return org_id.strip()
    return None
