"""Teaching generation gateway — sends teaching payloads to the Codex API."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from pdf_agent.auth import OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
    codex_responses_url,
)
from pdf_agent.server.constants import (
    DEFAULT_AGENT_MODEL,
    TEACHING_API_CONCURRENCY,
    TEACHING_RATE_LIMIT_MIN_COOLDOWN_SECONDS,
    TEACHING_UPSTREAM_TIMEOUT_SECONDS,
)
from pdf_agent.server.errors import HttpError
from pdf_agent.server.gateway_fallback import post_payload_with_cache_fallback
from pdf_agent.server.gateway_transport import post_json_responses
from pdf_agent.server.generation_parsing import (
    _parse_generated_page,
    _parse_generated_pages,
)
from pdf_agent.server.payload_builders import (
    _build_teaching_codex_responses_payload,
    _teaching_generation_candidate_bodies,
)
from pdf_agent.server.prompt_cache import (
    TEACHING_MAX_RETRY_DELAY_SECONDS,
    TEACHING_RETRY_DELAYS_SECONDS,
    _prompt_cache_metadata,
    _should_retry_transient_upstream_error,
    _should_try_next_teaching_generation_candidate,
    _transient_retry_delay_seconds,
)
from pdf_agent.server.response_parsing import _extract_gateway_text
from pdf_agent.server.value_utils import string_or_none as _string_or_none


class TeachingGenerationGateway:
    """Posts teaching-generation payloads to the Codex responses API."""

    def __init__(
        self,
        manager: OpenAIOAuthManager,
        *,
        model: str = DEFAULT_AGENT_MODEL,
        timeout_seconds: float = float(TEACHING_UPSTREAM_TIMEOUT_SECONDS),
        api_concurrency: int = TEACHING_API_CONCURRENCY,
    ) -> None:
        self.manager = manager
        self.model = model
        self.timeout_seconds = timeout_seconds
        self._api_semaphore = asyncio.Semaphore(max(1, api_concurrency))
        self._rate_limit_lock = asyncio.Lock()
        self._rate_limit_cooldown_until = 0.0

    async def generate_page(self, body: Mapping[str, Any]) -> dict[str, Any]:
        auth = await build_chatgpt_codex_auth(self.manager, session_id=_string_or_none(body.get("session_id")))
        content, payload, document_file_used, cache_metadata = await self._generate_content_with_fallback(
            codex_responses_url(base_url=auth.upstream_base_url),
            body,
            auth.headers,
        )
        page = _parse_generated_page(content, body)
        return {
            "page": page,
            "account_id": auth.account_id,
            "model": payload.get("model"),
            "cache": {
                **cache_metadata,
                "document_file_input": document_file_used,
            },
        }

    async def generate_pages(self, body: Mapping[str, Any]) -> dict[str, Any]:
        auth = await build_chatgpt_codex_auth(self.manager, session_id=_string_or_none(body.get("session_id")))
        content, payload, document_file_used, cache_metadata = await self._generate_content_with_fallback(
            codex_responses_url(base_url=auth.upstream_base_url),
            body,
            auth.headers,
        )
        pages = _parse_generated_pages(content, body)
        return {
            "pages": pages,
            "account_id": auth.account_id,
            "model": payload.get("model"),
            "cache": {
                **cache_metadata,
                "document_file_input": document_file_used,
            },
        }

    async def _generate_content_with_fallback(
        self,
        url: str,
        body: Mapping[str, Any],
        headers: dict[str, str],
    ) -> tuple[str, dict[str, Any], bool, dict[str, Any]]:
        candidate_bodies = _teaching_generation_candidate_bodies(body)

        last_error: HttpError | None = None
        for candidate_index, (candidate_body, document_file_used) in enumerate(candidate_bodies):
            payload = await asyncio.to_thread(
                _build_teaching_codex_responses_payload,
                candidate_body,
                self.model,
            )
            try:
                text, content_type, payload = await post_payload_with_cache_fallback(
                    self._post_with_retries,
                    url, payload, headers,
                )
                content = _extract_gateway_text(text, content_type)
                if not content:
                    raise HttpError(502, "OpenAI gateway returned an empty generation response", code="empty_gateway_response")
                return (
                    content,
                    payload,
                    document_file_used,
                    _prompt_cache_metadata(payload, response_text=text, content_type=content_type),
                )
            except HttpError as exc:
                last_error = exc
                if candidate_index < len(candidate_bodies) - 1 and _should_try_next_teaching_generation_candidate(
                    exc,
                    document_file_used=document_file_used,
                ):
                    continue
                raise
        if last_error:
            raise last_error
        raise HttpError(502, "OpenAI gateway returned an empty generation response", code="empty_gateway_response")

    async def _post_with_retries(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
    ) -> tuple[str, str]:
        for attempt in range(len(TEACHING_RETRY_DELAYS_SECONDS) + 1):
            try:
                await self._wait_for_rate_limit_cooldown()
                async with self._api_semaphore:
                    return await asyncio.to_thread(
                        post_json_responses,
                        url, payload, headers,
                        timeout_seconds=self.timeout_seconds,
                        handle_timeout=True,
                    )
            except HttpError as exc:
                if attempt >= len(TEACHING_RETRY_DELAYS_SECONDS) or not _should_retry_transient_upstream_error(exc):
                    raise
                delay_seconds = _transient_retry_delay_seconds(exc, attempt)
                if exc.status == 429 or exc.retry_after_seconds is not None:
                    await self._note_rate_limit_cooldown(delay_seconds)
                await asyncio.sleep(delay_seconds)
        raise HttpError(502, "OpenAI gateway returned an empty generation response", code="empty_gateway_response")

    async def _wait_for_rate_limit_cooldown(self) -> None:
        while True:
            async with self._rate_limit_lock:
                delay_seconds = self._rate_limit_cooldown_until - asyncio.get_running_loop().time()
            if delay_seconds <= 0:
                return
            await asyncio.sleep(min(delay_seconds, TEACHING_MAX_RETRY_DELAY_SECONDS))

    async def _note_rate_limit_cooldown(self, delay_seconds: float) -> None:
        cooldown_seconds = min(
            max(delay_seconds, TEACHING_RATE_LIMIT_MIN_COOLDOWN_SECONDS),
            TEACHING_MAX_RETRY_DELAY_SECONDS,
        )
        until = asyncio.get_running_loop().time() + cooldown_seconds
        async with self._rate_limit_lock:
            self._rate_limit_cooldown_until = max(self._rate_limit_cooldown_until, until)
