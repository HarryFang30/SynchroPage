"""Model provider configuration storage and normalization."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from pdf_agent.auth.openai_oauth import atomic_write_secret, default_data_dir
from pdf_agent.server.errors import HttpError
from pdf_agent.server.json_utils import json_dumps_utf8_safe
from pdf_agent.server.value_utils import string_value


MODEL_CONFIG_VERSION = 1
DEFAULT_CODEX_PROVIDER_ID = "codex_oauth"
DEFAULT_MODEL_CONFIG_PATH = default_data_dir() / "model_providers.json"
MODEL_REF_KEYS = frozenset({"assistant", "teachingFast", "teachingBalanced", "teachingQuality"})
PROVIDER_TYPES = frozenset({"codex-oauth", "openai-compatible", "openai-responses"})


def default_model_config() -> dict[str, Any]:
    return {
        "version": MODEL_CONFIG_VERSION,
        "selectedProviderId": DEFAULT_CODEX_PROVIDER_ID,
        "providers": [
            {
                "id": DEFAULT_CODEX_PROVIDER_ID,
                "name": "OpenAI OAuth",
                "type": "codex-oauth",
                "apiHost": "https://chatgpt.com/backend-api/codex/",
                "apiKeyRequired": False,
                "enabled": True,
                "models": ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
            },
            {
                "id": "openai_api",
                "name": "OpenAI API Key",
                "type": "openai-responses",
                "apiHost": "https://api.openai.com/v1",
                "apiKeyRequired": True,
                "enabled": False,
                "models": ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
            },
            {
                "id": "deepseek",
                "name": "DeepSeek",
                "type": "openai-compatible",
                "apiHost": "https://api.deepseek.com",
                "apiKeyRequired": True,
                "enabled": False,
                "models": ["deepseek-chat", "deepseek-reasoner"],
            },
            {
                "id": "openrouter",
                "name": "OpenRouter",
                "type": "openai-compatible",
                "apiHost": "https://openrouter.ai/api/v1",
                "apiKeyRequired": True,
                "enabled": False,
                "models": ["openai/gpt-4.1", "anthropic/claude-sonnet-4", "deepseek/deepseek-chat"],
            },
            {
                "id": "siliconflow",
                "name": "SiliconFlow",
                "type": "openai-compatible",
                "apiHost": "https://api.siliconflow.cn/v1",
                "apiKeyRequired": True,
                "enabled": False,
                "models": ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
            },
            {
                "id": "ollama",
                "name": "Ollama",
                "type": "openai-compatible",
                "apiHost": "http://127.0.0.1:11434/v1",
                "apiKeyRequired": False,
                "enabled": False,
                "models": ["llama3.1", "qwen2.5"],
            },
        ],
        "defaults": {
            "assistant": {"providerId": DEFAULT_CODEX_PROVIDER_ID, "model": "gpt-5.5"},
            "teachingFast": {"providerId": DEFAULT_CODEX_PROVIDER_ID, "model": "gpt-5.4-mini"},
            "teachingBalanced": {"providerId": DEFAULT_CODEX_PROVIDER_ID, "model": "gpt-5.4"},
            "teachingQuality": {"providerId": DEFAULT_CODEX_PROVIDER_ID, "model": "gpt-5.5"},
        },
    }


class ModelConfigStore:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = Path(path) if path is not None else DEFAULT_MODEL_CONFIG_PATH

    def load_private(self) -> dict[str, Any]:
        if not self.path.exists():
            return normalize_model_config(default_model_config())
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HttpError(500, f"Unable to load model provider config: {exc}", code="model_config_load_failed") from exc
        return normalize_model_config(raw)

    def load_public(self) -> dict[str, Any]:
        return public_model_config(self.load_private())

    def save(self, value: Mapping[str, Any]) -> dict[str, Any]:
        current = self.load_private()
        normalized = normalize_model_config(value, existing=current)
        serialized = json_dumps_utf8_safe(normalized, ensure_ascii=False, indent=2)
        atomic_write_secret(self.path, serialized + "\n")
        return public_model_config(normalized)


def public_model_config(config: Mapping[str, Any]) -> dict[str, Any]:
    normalized = normalize_model_config(config)
    providers: list[dict[str, Any]] = []
    for provider in normalized["providers"]:
        public_provider = {key: value for key, value in provider.items() if key != "apiKey"}
        public_provider["hasApiKey"] = bool(provider.get("apiKey"))
        providers.append(public_provider)
    return {
        "version": normalized["version"],
        "selectedProviderId": normalized["selectedProviderId"],
        "providers": providers,
        "defaults": normalized["defaults"],
    }


def normalize_model_config(value: Mapping[str, Any] | None, *, existing: Mapping[str, Any] | None = None) -> dict[str, Any]:
    source = value if isinstance(value, Mapping) else {}
    fallback = default_model_config()
    existing_providers = {
        str(provider.get("id")): provider
        for provider in (existing or {}).get("providers", [])
        if isinstance(provider, Mapping) and provider.get("id")
    }

    raw_providers = source.get("providers")
    if not isinstance(raw_providers, list):
        raw_providers = fallback["providers"]
    providers: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw_provider in enumerate(raw_providers):
        if not isinstance(raw_provider, Mapping):
            continue
        provider = _normalize_provider(raw_provider, existing=existing_providers.get(str(raw_provider.get("id"))), index=index)
        if provider["id"] in seen:
            provider["id"] = _unique_provider_id(provider["id"], seen)
        seen.add(provider["id"])
        providers.append(provider)
    if not providers:
        providers = list(fallback["providers"])

    providers_by_id = {provider["id"]: provider for provider in providers}
    selected_provider_id = string_value(source.get("selectedProviderId"), "") or string_value(
        (existing or {}).get("selectedProviderId"), DEFAULT_CODEX_PROVIDER_ID
    )
    if selected_provider_id not in providers_by_id:
        selected_provider_id = providers[0]["id"]

    defaults = _normalize_defaults(source.get("defaults"), providers_by_id, selected_provider_id)
    return {
        "version": MODEL_CONFIG_VERSION,
        "selectedProviderId": selected_provider_id,
        "providers": providers,
        "defaults": defaults,
    }


def _normalize_provider(raw: Mapping[str, Any], *, existing: Mapping[str, Any] | None, index: int) -> dict[str, Any]:
    provider_id = _clean_provider_id(raw.get("id")) or f"provider_{index + 1}"
    provider_type = string_value(raw.get("type"), "openai-compatible")
    if provider_type not in PROVIDER_TYPES:
        provider_type = "openai-compatible"
    name = string_value(raw.get("name"), provider_id.replace("_", " ").title())
    api_host = string_value(raw.get("apiHost"), "")
    if not api_host:
        api_host = string_value(raw.get("baseUrl"), "") or string_value((existing or {}).get("apiHost"), "")
    api_key = raw.get("apiKey")
    if isinstance(api_key, str) and api_key.strip():
        normalized_api_key = api_key.strip()
    elif existing and isinstance(existing.get("apiKey"), str) and existing.get("apiKey"):
        normalized_api_key = str(existing["apiKey"])
    else:
        normalized_api_key = ""
    models = _normalize_models(raw.get("models"))
    if not models and existing:
        models = _normalize_models(existing.get("models"))
    api_key_required = raw.get("apiKeyRequired")
    return {
        "id": provider_id,
        "name": name,
        "type": provider_type,
        "apiHost": api_host,
        "apiKey": normalized_api_key,
        "apiKeyRequired": bool(api_key_required) if api_key_required is not None else provider_type != "codex-oauth",
        "enabled": bool(raw.get("enabled")) if raw.get("enabled") is not None else provider_type == "codex-oauth",
        "models": models,
    }


def _normalize_defaults(value: Any, providers_by_id: Mapping[str, Mapping[str, Any]], selected_provider_id: str) -> dict[str, dict[str, str]]:
    raw_defaults = value if isinstance(value, Mapping) else {}
    fallback = default_model_config()["defaults"]
    normalized: dict[str, dict[str, str]] = {}
    for key in MODEL_REF_KEYS:
        raw_ref = raw_defaults.get(key)
        fallback_ref = fallback.get(key, {"providerId": selected_provider_id, "model": ""})
        provider_id = selected_provider_id
        model = ""
        if isinstance(raw_ref, Mapping):
            provider_id = string_value(raw_ref.get("providerId"), selected_provider_id)
            model = string_value(raw_ref.get("model"), "")
        if provider_id not in providers_by_id:
            provider_id = string_value(fallback_ref.get("providerId"), selected_provider_id)
        if provider_id not in providers_by_id:
            provider_id = selected_provider_id
        if not model:
            provider = providers_by_id.get(provider_id) or {}
            models = provider.get("models")
            model = string_value(fallback_ref.get("model"), "")
            if isinstance(models, list) and models:
                model = string_value(models[0], model)
        normalized[key] = {"providerId": provider_id, "model": model}
    return normalized


def _normalize_models(value: Any) -> list[str]:
    if isinstance(value, str):
        values = re.split(r"[\n,]+", value)
    elif isinstance(value, list):
        values = value
    else:
        return []
    models: list[str] = []
    seen: set[str] = set()
    for item in values:
        model = string_value(item, "")
        if not model or model in seen:
            continue
        seen.add(model)
        models.append(model)
    return models


def _clean_provider_id(value: Any) -> str:
    text = string_value(value, "")
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", text).strip("_")
    return cleaned[:48]


def _unique_provider_id(provider_id: str, seen: set[str]) -> str:
    index = 2
    while f"{provider_id}_{index}" in seen:
        index += 1
    return f"{provider_id}_{index}"


def provider_by_id(config: Mapping[str, Any], provider_id: str) -> Mapping[str, Any] | None:
    for provider in config.get("providers", []):
        if isinstance(provider, Mapping) and provider.get("id") == provider_id:
            return provider
    return None


def resolve_model_ref(
    config: Mapping[str, Any],
    body: Mapping[str, Any],
    *,
    default_key: str,
    legacy_model: str,
) -> dict[str, str]:
    defaults = config.get("defaults") if isinstance(config.get("defaults"), Mapping) else {}
    default_ref = defaults.get(default_key) if isinstance(defaults.get(default_key), Mapping) else {}
    selected_provider_id = string_value(config.get("selectedProviderId"), DEFAULT_CODEX_PROVIDER_ID)
    provider_id = string_value(body.get("modelProviderId"), "") or string_value(default_ref.get("providerId"), selected_provider_id)
    model = string_value(body.get("model"), "") or string_value(default_ref.get("model"), legacy_model)
    if not provider_by_id(config, provider_id):
        provider_id = selected_provider_id
    return {"providerId": provider_id, "model": model or legacy_model}
