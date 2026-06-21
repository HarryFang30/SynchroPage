"""Agent chat gateway — sends payloads to the Codex API and returns responses."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from pdf_agent.auth import OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
    build_codex_responses_payload,
    codex_responses_url,
)
from pdf_agent.server.constants import AGENT_RETRY_DELAYS_SECONDS, DEFAULT_AGENT_MODEL
from pdf_agent.server.errors import HttpError
from pdf_agent.server.gateway_fallback import post_payload_with_cache_fallback
from pdf_agent.server.gateway_transport import post_json_responses
from pdf_agent.server.payload_builders import _build_responses_payload
from pdf_agent.server.prompt_cache import (
    _prompt_cache_metadata,
    _should_retry_transient_upstream_error,
    _transient_retry_delay_seconds,
)
from pdf_agent.server.response_parsing import _extract_gateway_text
from pdf_agent.server.value_utils import string_or_none as _string_or_none


class AgentChatGateway:
    """Posts agent-chat payloads to the Codex responses API with retries."""

    def __init__(
        self,
        manager: OpenAIOAuthManager,
        *,
        model: str = DEFAULT_AGENT_MODEL,
        timeout_seconds: float = 120.0,
    ) -> None:
        self.manager = manager
        self.model = model
        self.timeout_seconds = timeout_seconds

    async def chat(self, body: Mapping[str, Any]) -> dict[str, Any]:
        auth = await build_chatgpt_codex_auth(self.manager, session_id=_string_or_none(body.get("session_id")))
        payload = build_codex_responses_payload(
            _build_responses_payload(body, default_model=self.model),
            force_stream=True,
            include_reasoning_encrypted_content=True,
            strip_unsupported_fields=True,
        )
        text, content_type, payload = await post_payload_with_cache_fallback(
            self._post_with_retries,
            codex_responses_url(base_url=auth.upstream_base_url),
            payload,
            auth.headers,
        )
        content = _extract_gateway_text(text, content_type)
        if not content:
            raise HttpError(502, "OpenAI gateway returned an empty response", code="empty_gateway_response")
        return {
            "message": {
                "role": "assistant",
                "content": content,
            },
            "account_id": auth.account_id,
            "model": payload.get("model"),
            "cache": _prompt_cache_metadata(payload, response_text=text, content_type=content_type),
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
