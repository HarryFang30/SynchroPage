"""Provider-aware model gateway helpers."""

from __future__ import annotations

import asyncio
import json
import urllib.parse
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pdf_agent.auth import OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
    build_codex_responses_payload,
    codex_responses_url,
)
from pdf_agent.server.errors import HttpError
from pdf_agent.server.gateway_fallback import post_payload_with_cache_fallback
from pdf_agent.server.model_config import (
    DEFAULT_CODEX_PROVIDER_ID,
    ModelConfigStore,
    normalize_model_config,
    provider_by_id,
    resolve_model_ref,
)
from pdf_agent.server.prompt_cache import _prompt_cache_metadata
from pdf_agent.server.response_parsing import _extract_gateway_text
from pdf_agent.server.value_utils import string_value


PostWithRetries = Callable[[str, dict[str, Any], dict[str, str]], Awaitable[tuple[str, str]]]
CodexAuthBuilder = Callable[..., Awaitable[Any]]
DEEPSEEK_PROVIDER_ID = "deepseek"
DEEPSEEK_HOSTS = frozenset({"api.deepseek.com"})


@dataclass(frozen=True)
class ModelGatewayResult:
    text: str
    content_type: str
    payload: dict[str, Any]
    account_id: str
    provider_id: str
    provider_name: str
    model: str


async def post_responses_payload_for_body(
    *,
    manager: OpenAIOAuthManager,
    config_store: ModelConfigStore | None,
    body: Mapping[str, Any],
    default_key: str,
    legacy_model: str,
    responses_payload: dict[str, Any],
    post_with_retries: PostWithRetries,
    codex_include_reasoning_encrypted_content: bool,
    codex_auth_builder: CodexAuthBuilder = build_chatgpt_codex_auth,
) -> ModelGatewayResult:
    config = config_store.load_private() if config_store is not None else normalize_model_config(None)
    ref = resolve_model_ref(config, body, default_key=default_key, legacy_model=legacy_model)
    provider = provider_by_id(config, ref["providerId"])
    if provider is None:
        raise HttpError(400, f"Model provider not found: {ref['providerId']}", code="model_provider_not_found")
    if not bool(provider.get("enabled")) and provider.get("id") != DEFAULT_CODEX_PROVIDER_ID:
        raise HttpError(400, f"Model provider is disabled: {provider.get('name')}", code="model_provider_disabled")

    provider_type = string_value(provider.get("type"), "codex-oauth")
    payload = dict(responses_payload)
    payload["model"] = ref["model"]

    if provider_type == "codex-oauth":
        auth = await codex_auth_builder(
            manager,
            session_id=string_value(body.get("session_id"), "") or None,
        )
        codex_payload = build_codex_responses_payload(
            payload,
            force_stream=True,
            include_reasoning_encrypted_content=codex_include_reasoning_encrypted_content,
            strip_unsupported_fields=True,
        )
        text, content_type, sent_payload = await post_payload_with_cache_fallback(
            post_with_retries,
            codex_responses_url(base_url=auth.upstream_base_url),
            codex_payload,
            auth.headers,
        )
        return ModelGatewayResult(
            text=text,
            content_type=content_type,
            payload=sent_payload,
            account_id=auth.account_id,
            provider_id=DEFAULT_CODEX_PROVIDER_ID,
            provider_name=string_value(provider.get("name"), "OpenAI OAuth"),
            model=string_value(sent_payload.get("model"), ref["model"]),
        )

    headers = _api_key_headers(provider)
    if provider_type == "openai-responses":
        url = provider_api_url(provider, "responses")
        api_payload = _strip_nonportable_responses_fields(payload)
    else:
        url = provider_api_url(provider, "chat/completions")
        api_payload = responses_payload_to_chat_completions(payload, provider=provider)

    text, content_type, sent_payload = await post_payload_with_cache_fallback(
        post_with_retries,
        url,
        api_payload,
        headers,
    )
    return ModelGatewayResult(
        text=text,
        content_type=content_type,
        payload=sent_payload,
        account_id=string_value(provider.get("id"), "api-key"),
        provider_id=string_value(provider.get("id"), "api-key"),
        provider_name=string_value(provider.get("name"), "API Provider"),
        model=string_value(sent_payload.get("model"), ref["model"]),
    )


def provider_api_url(provider: Mapping[str, Any], path: str) -> str:
    base = normalized_provider_api_base(provider)
    return urllib.parse.urljoin(base, path.lstrip("/"))


def provider_endpoint_preview(provider: Mapping[str, Any]) -> str:
    provider_type = string_value(provider.get("type"), "openai-compatible")
    if provider_type == "codex-oauth":
        return urllib.parse.urljoin(_ensure_trailing_slash(string_value(provider.get("apiHost"), "")), "responses")
    return provider_api_url(provider, "responses" if provider_type == "openai-responses" else "chat/completions")


def normalized_provider_api_base(provider: Mapping[str, Any]) -> str:
    raw = string_value(provider.get("apiHost"), "")
    if not raw:
        raise HttpError(400, "API host is required for this provider", code="model_api_host_missing")
    base = _ensure_trailing_slash(raw)
    provider_type = string_value(provider.get("type"), "openai-compatible")
    if provider_type == "codex-oauth":
        return base
    parsed = urllib.parse.urlparse(base)
    path_parts = [part for part in parsed.path.split("/") if part]
    if not path_parts and _is_deepseek_official_api_host(parsed):
        return base
    if path_parts and path_parts[-1].lower() == "v1":
        return base
    next_path = "/".join([*path_parts, "v1"])
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, f"/{next_path}/", "", "", ""))


def responses_payload_to_chat_completions(
    payload: Mapping[str, Any],
    *,
    provider: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    system_text = string_value(payload.get("instructions"), "")
    user_text = _responses_input_text(payload.get("input"))
    messages: list[dict[str, str]] = []
    if system_text:
        messages.append({"role": "system", "content": system_text})
    messages.append({"role": "user", "content": user_text or "Continue."})
    chat_payload: dict[str, Any] = {
        "model": string_value(payload.get("model"), ""),
        "messages": messages,
        "stream": False,
    }
    if provider is not None and _is_deepseek_provider(provider):
        chat_payload.update(_deepseek_chat_options(payload, chat_payload["model"]))
    return chat_payload


def extract_provider_text(text: str, content_type: str) -> str:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return _extract_gateway_text(text, content_type)
    chat_text = _extract_chat_completion_text(value)
    if chat_text:
        return chat_text
    return _extract_gateway_text(text, content_type)


def provider_cache_metadata(payload: Mapping[str, Any], response_text: str, content_type: str) -> dict[str, Any]:
    metadata = _prompt_cache_metadata(payload, response_text=response_text, content_type=content_type)
    if payload.get("messages"):
        metadata["transport"] = "chat-completions"
    else:
        metadata["transport"] = "responses"
    return metadata


async def fetch_provider_models(
    *,
    manager: OpenAIOAuthManager,
    config_store: ModelConfigStore,
    provider_value: Mapping[str, Any],
) -> dict[str, Any]:
    config = config_store.load_private()
    provider_id = string_value(provider_value.get("id"), "")
    stored = provider_by_id(config, provider_id) if provider_id else None
    provider = {**dict(stored or {}), **dict(provider_value)}
    if not provider.get("apiKey") and stored and stored.get("apiKey"):
        provider["apiKey"] = stored["apiKey"]
    provider_type = string_value(provider.get("type"), "openai-compatible")
    if provider_type == "codex-oauth":
        auth = await build_chatgpt_codex_auth(manager)
        from pdf_agent.gateway import codex_models_url, parse_codex_models
        from pdf_agent.server.gateway_transport import get_json

        value = await asyncio.to_thread(get_json, codex_models_url(base_url=auth.upstream_base_url), auth.headers, timeout_seconds=30.0)
        models = parse_codex_models(value)
        return {"models": [{"id": model.id, "owned_by": model.owned_by} for model in models]}

    from pdf_agent.gateway import parse_codex_models
    from pdf_agent.server.gateway_transport import get_json

    value = await asyncio.to_thread(get_json, provider_api_url(provider, "models"), _api_key_headers(provider), timeout_seconds=30.0)
    models = parse_codex_models(value)
    return {"models": [{"id": model.id, "owned_by": model.owned_by} for model in models]}


def _api_key_headers(provider: Mapping[str, Any]) -> dict[str, str]:
    api_key = string_value(provider.get("apiKey"), "")
    if bool(provider.get("apiKeyRequired")) and not api_key:
        raise HttpError(400, f"API key is required for {string_value(provider.get('name'), 'this provider')}", code="model_api_key_missing")
    headers = {"Authorization": f"Bearer {api_key or 'no-key-required'}"}
    return headers


def _responses_input_text(value: Any) -> str:
    chunks: list[str] = []
    if isinstance(value, list):
        for message in value:
            if not isinstance(message, Mapping):
                continue
            role = string_value(message.get("role"), "user")
            text = _responses_content_text(message.get("content"))
            if text:
                chunks.append(f"{role}:\n{text}" if role != "user" else text)
    else:
        text = _responses_content_text(value)
        if text:
            chunks.append(text)
    return "\n\n".join(chunks).strip()


def _responses_content_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        chunks: list[str] = []
        for item in value:
            if isinstance(item, Mapping):
                item_type = item.get("type")
                if item_type in {"input_text", "text"}:
                    chunks.append(string_value(item.get("text"), ""))
                elif item_type == "input_file":
                    filename = string_value(item.get("filename") or item.get("file_id"), "attached PDF")
                    chunks.append(f"[Attached file omitted for Chat Completions compatibility: {filename}]")
                elif item_type == "input_image":
                    chunks.append("[Attached image omitted for broad Chat Completions compatibility.]")
            else:
                chunks.append(string_value(item, ""))
        return "\n\n".join(chunk for chunk in chunks if chunk).strip()
    if isinstance(value, Mapping):
        return _responses_content_text(value.get("content") or value.get("text"))
    return ""


def _strip_nonportable_responses_fields(payload: Mapping[str, Any]) -> dict[str, Any]:
    stripped = dict(payload)
    stripped["store"] = False
    stripped.pop("prompt_cache_key", None)
    stripped.pop("prompt_cache_retention", None)
    stripped.pop("include", None)
    return stripped


def _is_deepseek_provider(provider: Mapping[str, Any], *, parsed: urllib.parse.ParseResult | None = None) -> bool:
    provider_id = string_value(provider.get("id"), "").lower()
    if provider_id == DEEPSEEK_PROVIDER_ID:
        return True
    url = parsed or urllib.parse.urlparse(_ensure_trailing_slash(string_value(provider.get("apiHost"), "")))
    return _is_deepseek_official_api_host(url)


def _is_deepseek_official_api_host(parsed: urllib.parse.ParseResult) -> bool:
    return parsed.netloc.lower() in DEEPSEEK_HOSTS


def _deepseek_chat_options(payload: Mapping[str, Any], model: str) -> dict[str, Any]:
    effort = ""
    reasoning = payload.get("reasoning")
    if isinstance(reasoning, Mapping):
        effort = string_value(reasoning.get("effort"), "")
    lowered_model = model.lower()
    if lowered_model == "deepseek-chat":
        return {"thinking": {"type": "disabled"}}
    if lowered_model == "deepseek-reasoner":
        return {"thinking": {"type": "enabled"}, "reasoning_effort": _deepseek_reasoning_effort(effort)}
    if lowered_model.startswith("deepseek-v4"):
        if effort == "none":
            return {"thinking": {"type": "disabled"}}
        return {"thinking": {"type": "enabled"}, "reasoning_effort": _deepseek_reasoning_effort(effort)}
    return {}


def _deepseek_reasoning_effort(value: str) -> str:
    if value == "xhigh":
        return "max"
    return "high" if value in {"", "low", "medium", "high"} else "high"


def _extract_chat_completion_text(value: Any) -> str:
    if not isinstance(value, Mapping):
        return ""
    choices = value.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, Mapping):
        return ""
    message = first.get("message")
    if isinstance(message, Mapping):
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, Mapping) and isinstance(item.get("text"), str):
                    parts.append(item["text"])
            if parts:
                return "\n".join(parts).strip()
    text = first.get("text")
    return text.strip() if isinstance(text, str) else ""


def _ensure_trailing_slash(value: str) -> str:
    stripped = value.strip()
    if not stripped:
        return ""
    return stripped if stripped.endswith("/") else f"{stripped}/"
