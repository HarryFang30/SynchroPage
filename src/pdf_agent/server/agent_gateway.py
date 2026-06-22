"""Agent chat gateway — sends payloads to the Codex API and returns responses."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from pdf_agent.auth import OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
)
from pdf_agent.server.constants import AGENT_RETRY_DELAYS_SECONDS, DEFAULT_AGENT_MODEL
from pdf_agent.server.errors import HttpError
from pdf_agent.server.gateway_transport import post_json_responses
from pdf_agent.server.model_config import ModelConfigStore
from pdf_agent.server.model_gateway import (
    extract_provider_text,
    post_responses_payload_for_body,
    provider_cache_metadata,
)
from pdf_agent.server.payload_builders import _build_responses_payload
from pdf_agent.server.pdf_file_cache import PdfFileCache
from pdf_agent.server.prompt_cache import _should_retry_transient_upstream_error, _transient_retry_delay_seconds


class AgentChatGateway:
    """Posts agent-chat payloads to the Codex responses API with retries."""

    def __init__(
        self,
        manager: OpenAIOAuthManager,
        *,
        model: str = DEFAULT_AGENT_MODEL,
        timeout_seconds: float = 120.0,
        config_store: ModelConfigStore | None = None,
        pdf_file_cache: PdfFileCache | None = None,
    ) -> None:
        self.manager = manager
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.config_store = config_store
        self.pdf_file_cache = pdf_file_cache

    async def chat(self, body: Mapping[str, Any]) -> dict[str, Any]:
        result = await post_responses_payload_for_body(
            manager=self.manager,
            config_store=self.config_store,
            body=body,
            default_key="assistant",
            legacy_model=self.model,
            responses_payload=_build_responses_payload(
                body,
                default_model=self.model,
                pdf_file_cache=self.pdf_file_cache,
            ),
            post_with_retries=self._post_with_retries,
            codex_include_reasoning_encrypted_content=True,
            codex_auth_builder=build_chatgpt_codex_auth,
        )
        content = extract_provider_text(result.text, result.content_type)
        if not content:
            raise HttpError(502, "Model provider returned an empty response", code="empty_gateway_response")
        return {
            "message": {
                "role": "assistant",
                "content": content,
            },
            "account_id": result.account_id,
            "provider_id": result.provider_id,
            "provider": result.provider_name,
            "model": result.payload.get("model"),
            "cache": provider_cache_metadata(result.payload, response_text=result.text, content_type=result.content_type),
        }

    async def _post_with_retries(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
    ) -> tuple[str, str]:
        for attempt in range(len(AGENT_RETRY_DELAYS_SECONDS) + 1):
            try:
                return await asyncio.to_thread(
                    post_json_responses,
                    url, payload, headers,
                    timeout_seconds=self.timeout_seconds,
                    handle_timeout=False,
                )
            except HttpError as exc:
                if attempt >= len(AGENT_RETRY_DELAYS_SECONDS) or not _should_retry_transient_upstream_error(exc):
                    raise
                await asyncio.sleep(_transient_retry_delay_seconds(exc, attempt, delays=AGENT_RETRY_DELAYS_SECONDS))
        raise HttpError(502, "OpenAI gateway returned an empty response", code="empty_gateway_response")
