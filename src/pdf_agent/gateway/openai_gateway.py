from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin

from pdf_agent.auth import OpenAIOAuthManager
from pdf_agent.auth.openai_oauth import redact_secret_text

CHATGPT_CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex/"
CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_RESPONSES_PATH = "responses"
CODEX_MODELS_PATH = "models"
CODEX_REASONING_INCLUDE = "reasoning.encrypted_content"
DEFAULT_CODEX_ORIGINATOR = os.environ.get("PDF_AGENT_CODEX_ORIGINATOR", "pdf-agent")
MANAGED_TOKEN_PLACEHOLDERS = frozenset({"PROXY_MANAGED", "OAUTH_MANAGED", "<managed>"})
CODEX_UNSUPPORTED_RESPONSE_FIELDS = frozenset({"max_output_tokens", "temperature", "top_p"})


@dataclass(frozen=True)
class FetchedModel:
    id: str
    owned_by: str | None = None


@dataclass(frozen=True)
class GatewayAuthContext:
    upstream_base_url: str
    account_id: str
    headers: dict[str, str]


async def build_chatgpt_codex_auth(
    manager: OpenAIOAuthManager,
    *,
    account_id: str | None = None,
    upstream_base_url: str = CHATGPT_CODEX_BACKEND_BASE_URL,
    originator: str | None = DEFAULT_CODEX_ORIGINATOR,
    session_id: str | None = None,
) -> GatewayAuthContext:
    context = await manager.get_request_context(account_id)
    headers = build_codex_backend_headers(
        access_token=context.access_token,
        account_id=context.account_id,
        originator=originator,
        session_id=session_id,
    )
    assert_no_placeholder_authorization(headers)
    return GatewayAuthContext(
        upstream_base_url=normalize_base_url(upstream_base_url),
        account_id=context.account_id,
        headers=headers,
    )


def build_codex_backend_headers(
    *,
    access_token: str,
    account_id: str,
    originator: str | None = DEFAULT_CODEX_ORIGINATOR,
    session_id: str | None = None,
) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {access_token}",
        "ChatGPT-Account-Id": account_id,
    }
    if originator:
        headers["originator"] = originator
    headers.update(build_codex_oauth_session_headers(session_id))
    assert_no_placeholder_authorization(headers)
    return headers


def build_codex_oauth_session_headers(session_id: str | None) -> dict[str, str]:
    value = session_id.strip() if isinstance(session_id, str) else ""
    if not value:
        return {}
    return {
        "session_id": value,
        "x-client-request-id": value,
        "x-codex-window-id": f"{value}:0",
    }


def build_codex_responses_payload(
    payload: dict[str, Any],
    *,
    force_stream: bool = True,
    include_reasoning_encrypted_content: bool = True,
    strip_unsupported_fields: bool = True,
    service_tier: str | None = None,
) -> dict[str, Any]:
    """Normalize a Responses payload for ChatGPT Codex backend compatibility."""

    normalized = dict(payload)
    normalized["store"] = False
    if force_stream:
        normalized["stream"] = True
    if service_tier:
        normalized["service_tier"] = service_tier
    if include_reasoning_encrypted_content:
        normalized["include"] = _with_include(
            normalized.get("include"),
            CODEX_REASONING_INCLUDE,
        )
    if strip_unsupported_fields:
        for field in CODEX_UNSUPPORTED_RESPONSE_FIELDS:
            normalized.pop(field, None)
    return normalized


def codex_responses_url(*, base_url: str = CHATGPT_CODEX_BACKEND_BASE_URL) -> str:
    return codex_backend_url(CODEX_RESPONSES_PATH, base_url=base_url)


def codex_models_url(*, base_url: str = CHATGPT_CODEX_BACKEND_BASE_URL) -> str:
    return codex_backend_url(CODEX_MODELS_PATH, base_url=base_url)


def codex_backend_url(path: str, *, base_url: str = CHATGPT_CODEX_BACKEND_BASE_URL) -> str:
    return urljoin(normalize_base_url(base_url), path.lstrip("/"))


def normalize_base_url(base_url: str) -> str:
    stripped = base_url.strip()
    return stripped if stripped.endswith("/") else f"{stripped}/"


def assert_no_placeholder_authorization(headers: dict[str, str]) -> None:
    authorization = headers.get("Authorization", "")
    if not authorization.lower().startswith("bearer "):
        return
    token = authorization.split(None, 1)[1].strip()
    if token in MANAGED_TOKEN_PLACEHOLDERS:
        raise ValueError("managed OAuth placeholder token must never be sent upstream")


def assert_no_managed_placeholder_upstream(url: str, headers: dict[str, str]) -> None:
    if is_chatgpt_codex_upstream_url(url):
        assert_no_placeholder_authorization(headers)


def is_chatgpt_codex_upstream_url(url: str) -> bool:
    lowered = url.lower()
    return "://chatgpt.com/backend-api/codex" in lowered or "://chat.openai.com/backend-api/codex" in lowered


def parse_codex_models(value: Any) -> list[FetchedModel]:
    raw_entries = _model_entries(value)
    models: dict[str, FetchedModel] = {}
    for entry, fallback_id in raw_entries:
        model = _parse_model_entry(entry, fallback_id=fallback_id)
        if model is not None:
            models.setdefault(model.id, model)
    return [models[model_id] for model_id in sorted(models)]


def redacted_gateway_error(text: str, *, max_chars: int = 512) -> str:
    return redact_secret_text(text, max_chars=max_chars)


def _with_include(value: Any, required: str) -> list[str]:
    if isinstance(value, list):
        include = [item for item in value if isinstance(item, str) and item.strip()]
    elif isinstance(value, str) and value.strip():
        include = [value.strip()]
    else:
        include = []
    if required not in include:
        include.append(required)
    return include


def _model_entries(value: Any) -> list[tuple[Any, str | None]]:
    if isinstance(value, list):
        return [(entry, None) for entry in value]
    if not isinstance(value, dict):
        return []

    entries: list[tuple[Any, str | None]] = []
    for key in ("data", "models", "items"):
        field = value.get(key)
        if isinstance(field, list):
            entries.extend((entry, None) for entry in field)
        elif key == "models" and isinstance(field, dict):
            entries.extend((entry, model_id) for model_id, entry in field.items())
    if not entries:
        entries.extend((entry, model_id) for model_id, entry in value.items() if isinstance(entry, dict))
    return entries


def _parse_model_entry(entry: Any, *, fallback_id: str | None) -> FetchedModel | None:
    if isinstance(entry, str):
        model_id = entry.strip()
        return FetchedModel(model_id, "Codex") if model_id else None

    if isinstance(entry, dict):
        model_id = _string_field(entry, "slug", "id", "model", "name") or _clean_string(fallback_id)
        if not model_id:
            return None
        owned_by = _string_field(entry, "owned_by", "ownedBy", "provider", "vendor", "category", "owner") or "Codex"
        return FetchedModel(model_id, owned_by)

    model_id = _clean_string(fallback_id)
    return FetchedModel(model_id, "Codex") if model_id else None


def _string_field(value: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        cleaned = _clean_string(value.get(key))
        if cleaned:
            return cleaned
    return None


def _clean_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
