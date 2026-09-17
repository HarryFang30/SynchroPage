"""Agent chat gateway — sends payloads to the Codex API and returns responses."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from pdf_agent.auth import OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
    redacted_gateway_error,
)
from pdf_agent.server.constants import (
    AGENT_RETRY_DELAYS_SECONDS,
    AGENT_UPSTREAM_TIMEOUT_SECONDS,
    DEFAULT_AGENT_MODEL,
)
from pdf_agent.server.errors import HttpError
from pdf_agent.server.gateway_transport import CLIENT_CLOSED_CODE, post_json_responses
from pdf_agent.server.json_utils import json_dumps_utf8_safe
from pdf_agent.server.model_config import ModelConfigStore
from pdf_agent.server.model_gateway import (
    ModelGatewayResult,
    extract_provider_text,
    post_responses_payload_for_body,
    provider_cache_metadata,
)
from pdf_agent.server.payload_builders import _build_responses_payload
from pdf_agent.server.pdf_file_cache import PdfFileCache
from pdf_agent.server.prompt_cache import (
    _should_retry_transient_upstream_error,
    _transient_retry_delay_seconds,
)
from pdf_agent.server.stream_text import StreamTextDecoder


@dataclass(frozen=True)
class ChatStreamSink:
    """Where a streamed chat answer goes while it is being written.

    The callbacks run on the transport's worker thread, so they must only hand
    the value over (a queue); ``cancelled`` is polled between chunks and stops
    the upstream request once nobody is reading the answer.
    """

    on_text: Callable[[str], None]
    on_thinking: Callable[[], None] | None = None
    on_start: Callable[[], None] | None = None
    cancelled: Callable[[], bool] | None = None


class AgentChatGateway:
    """Posts agent-chat payloads to the Codex responses API with retries."""

    def __init__(
        self,
        manager: OpenAIOAuthManager,
        *,
        model: str = DEFAULT_AGENT_MODEL,
        timeout_seconds: float = float(AGENT_UPSTREAM_TIMEOUT_SECONDS),
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
        return _chat_result(result, content)

    async def chat_stream(self, body: Mapping[str, Any], sink: ChatStreamSink) -> dict[str, Any]:
        """Answer like ``chat``, handing the text to *sink* while it arrives.

        The returned message holds the whole answer, so a caller that ignored
        the deltas (or an upstream that did not stream) loses nothing.
        """
        decoders: list[StreamTextDecoder] = []

        async def post(url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[str, str]:
            return await self._post_streaming_with_retries(url, payload, headers, sink=sink, decoders=decoders)

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
            post_with_retries=post,
            codex_include_reasoning_encrypted_content=True,
            codex_auth_builder=build_chatgpt_codex_auth,
            stream=True,
        )
        decoder = decoders[-1] if decoders else None
        streamed = decoder.text.strip() if decoder is not None else ""
        if decoder is not None and decoder.failure is not None and not streamed:
            raise HttpError(
                502,
                redacted_gateway_error(json_dumps_utf8_safe(decoder.failure, ensure_ascii=False)),
                code="upstream_error",
            )
        content = streamed or extract_provider_text(result.text, result.content_type)
        if not content:
            raise HttpError(502, "Model provider returned an empty response", code="empty_gateway_response")
        value = _chat_result(result, content)
        if decoder is not None and (decoder.truncated or (streamed and decoder.failure is not None)):
            # The answer stops short: the output budget ran out, or the
            # upstream failed after part of the text had already been shown.
            value["truncated"] = True
        return value

    async def _post_streaming_with_retries(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
        *,
        sink: ChatStreamSink,
        decoders: list[StreamTextDecoder],
    ) -> tuple[str, str]:
        for attempt in range(len(AGENT_RETRY_DELAYS_SECONDS) + 1):
            decoder = StreamTextDecoder(on_text=sink.on_text, on_thinking=sink.on_thinking, on_start=sink.on_start)
            try:
                text, content_type = await asyncio.to_thread(
                    post_json_responses,
                    url, payload, headers,
                    timeout_seconds=self.timeout_seconds,
                    handle_timeout=False,
                    on_chunk=decoder.feed,
                    cancelled=sink.cancelled,
                )
                decoder.finish()
                decoders.append(decoder)
                return text, content_type
            except HttpError as exc:
                # Text that already reached the reader cannot be taken back.
                if (
                    decoder.emitted
                    or exc.code == CLIENT_CLOSED_CODE
                    or attempt >= len(AGENT_RETRY_DELAYS_SECONDS)
                    or not _should_retry_transient_upstream_error(exc)
                ):
                    raise
                await asyncio.sleep(_transient_retry_delay_seconds(exc, attempt, delays=AGENT_RETRY_DELAYS_SECONDS))
        raise HttpError(502, "OpenAI gateway returned an empty response", code="empty_gateway_response")

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


def _chat_result(result: ModelGatewayResult, content: str) -> dict[str, Any]:
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
