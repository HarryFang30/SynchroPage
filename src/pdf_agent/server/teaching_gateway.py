"""Teaching generation gateway — sends teaching payloads to the Codex API."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from pdf_agent.auth import OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
)
from pdf_agent.server.constants import (
    DEFAULT_AGENT_MODEL,
    TEACHING_API_CONCURRENCY,
    TEACHING_RATE_LIMIT_MIN_COOLDOWN_SECONDS,
    TEACHING_UPSTREAM_TIMEOUT_SECONDS,
)
from pdf_agent.server.errors import HttpError
from pdf_agent.server.gateway_transport import post_json_responses
from pdf_agent.server.generation_parsing import (
    _parse_generated_page,
    _parse_generated_pages,
)
from pdf_agent.server.model_config import ModelConfigStore
from pdf_agent.server.model_gateway import (
    extract_provider_text,
    post_responses_payload_for_body,
    provider_cache_metadata,
)
from pdf_agent.server.payload_builders import (
    _build_teaching_generation_payload,
    _teaching_generation_candidate_bodies,
)
from pdf_agent.server.prompt_cache import (
    TEACHING_MAX_RETRY_DELAY_SECONDS,
    TEACHING_RETRY_DELAYS_SECONDS,
    _should_retry_transient_upstream_error,
    _should_try_next_teaching_generation_candidate,
    _transient_retry_delay_seconds,
)


class TeachingGenerationGateway:
    """Posts teaching-generation payloads to the Codex responses API."""

    def __init__(
        self,
        manager: OpenAIOAuthManager,
        *,
        model: str = DEFAULT_AGENT_MODEL,
        timeout_seconds: float = float(TEACHING_UPSTREAM_TIMEOUT_SECONDS),
        api_concurrency: int = TEACHING_API_CONCURRENCY,
        config_store: ModelConfigStore | None = None,
    ) -> None:
        self.manager = manager
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.config_store = config_store
        self._api_semaphore = asyncio.Semaphore(max(1, api_concurrency))
        self._rate_limit_lock = asyncio.Lock()
        self._rate_limit_cooldown_until = 0.0

    async def generate_page(self, body: Mapping[str, Any]) -> dict[str, Any]:
        content, result, document_file_used, cache_metadata = await self._generate_content_with_fallback(body)
        page = _parse_generated_page(content, body)
        return {
            "page": page,
            "account_id": result.account_id,
            "provider_id": result.provider_id,
            "provider": result.provider_name,
            "model": result.payload.get("model"),
            "cache": {
                **cache_metadata,
                "document_file_input": document_file_used,
            },
        }

    async def generate_pages(self, body: Mapping[str, Any]) -> dict[str, Any]:
        content, result, document_file_used, cache_metadata = await self._generate_content_with_fallback(body)
        pages = _parse_generated_pages(content, body)
        return {
            "pages": pages,
            "account_id": result.account_id,
            "provider_id": result.provider_id,
            "provider": result.provider_name,
            "model": result.payload.get("model"),
            "cache": {
                **cache_metadata,
                "document_file_input": document_file_used,
            },
        }

    async def _generate_content_with_fallback(
        self,
        body: Mapping[str, Any],
    ):
        candidate_bodies = _teaching_generation_candidate_bodies(body)

        last_error: HttpError | None = None
        for candidate_index, (candidate_body, document_file_used) in enumerate(candidate_bodies):
            payload = await asyncio.to_thread(_build_teaching_generation_payload, candidate_body, default_model=self.model)
            try:
                result = await post_responses_payload_for_body(
                    manager=self.manager,
                    config_store=self.config_store,
                    body=candidate_body,
                    default_key="teachingQuality",
                    legacy_model=self.model,
                    responses_payload=payload,
                    post_with_retries=self._post_with_retries,
                    codex_include_reasoning_encrypted_content=False,
                    codex_auth_builder=build_chatgpt_codex_auth,
                )
                content = extract_provider_text(result.text, result.content_type)
                if not content:
                    raise HttpError(502, "Model provider returned an empty generation response", code="empty_gateway_response")
                return (
                    content,
                    result,
                    document_file_used,
                    provider_cache_metadata(result.payload, response_text=result.text, content_type=result.content_type),
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
