"""Teaching generation gateway — sends teaching payloads to the model gateway.

Stability contract for long PDFs (one-click generation of many pages):

* every client request gets an overall deadline derived from the reasoning
  effort and the number of target pages (``generation_policy``);
* upstream calls are streamed, run on a dedicated thread pool, and wait for a
  slot for at most 30 s before answering ``queue_timeout`` (503);
* transient failures retry with full jitter and a shared 429 cooldown;
* a response whose JSON cannot be parsed gets exactly one repair retry at one
  reasoning step lower;
* a batch that parsed some pages returns those pages plus ``missing``;
* identical in-flight requests are coalesced onto one upstream call;
* every response carries ``timing`` = ``{elapsed_ms, attempts, coalesced}``.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import time
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from pdf_agent.auth import OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
)
from pdf_agent.server.constants import (
    DEFAULT_AGENT_MODEL,
    LESSON_PLAN_CHUNK_PAGES,
    LESSON_PLAN_VERSION,
    TRANSCRIPTION_MAX_PAGES,
)
from pdf_agent.server.errors import HttpError
from pdf_agent.server.gateway_transport import post_json_responses
from pdf_agent.server.generation_parsing import (
    _parse_generated_page,
    _parse_generated_pages_with_missing,
    _parse_lesson_plan,
    _parse_transcription,
)
from pdf_agent.server.generation_policy import (
    MAX_TIMEOUT_RETRIES,
    QUEUE_RETRY_AFTER_SECONDS,
    QUEUE_WAIT_TIMEOUT_SECONDS,
    RATE_LIMIT_MAX_COOLDOWN_SECONDS,
    RATE_LIMIT_MIN_COOLDOWN_SECONDS,
    STREAM_INACTIVITY_TIMEOUT_SECONDS,
    TEACHING_RETRY_DELAYS_SECONDS,
    deadlines_seconds_payload,
    generation_request_key,
    lower_reasoning_effort,
    max_output_tokens_for,
    request_deadline_seconds,
    teaching_concurrency,
)
from pdf_agent.server.model_config import ModelConfigStore
from pdf_agent.server.model_gateway import (
    extract_provider_text,
    post_responses_payload_for_body,
    provider_cache_metadata,
    supported_reasoning_efforts,
)
from pdf_agent.server.payload_builders import (
    _build_lesson_plan_payload,
    _build_teaching_generation_payload,
    _build_transcription_payload,
    _lesson_plan_pages,
    _reasoning_effort,
    _teaching_generation_candidate_bodies,
    _teaching_generation_page_numbers,
    _teaching_generation_pages,
    _teaching_output_language,
)
from pdf_agent.server.pdf_file_cache import PdfFileCache
from pdf_agent.server.prompt_cache import (
    _should_retry_transient_upstream_error,
    _should_try_next_teaching_generation_candidate,
    _transient_retry_delay_seconds,
)
from pdf_agent.server.value_utils import string_value

LOGGER = logging.getLogger("pdf_agent.server.teaching_gateway")

#: Appended to the instructions of the single JSON-repair retry.
REPAIR_INSTRUCTIONS_SUFFIX = "Return only the JSON object."

ParseFn = Callable[[str], dict[str, Any]]
PayloadBuilder = Callable[[Mapping[str, Any], str, int], dict[str, Any]]


class _RequestContext:
    """Per-client-request budget shared by every candidate and attempt."""

    __slots__ = ("attempts", "deadline", "started", "timeout_retries")

    def __init__(self, deadline_seconds: float, *, started: float | None = None) -> None:
        self.started = started if started is not None else time.monotonic()
        self.deadline = self.started + float(deadline_seconds)
        self.attempts = 0
        self.timeout_retries = 0

    @property
    def remaining_seconds(self) -> float:
        return self.deadline - time.monotonic()

    @property
    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self.started) * 1000)


class _LoopState:
    """Async primitives bound to one event loop.

    The gateway object outlives individual event loops (tests call
    ``asyncio.run`` repeatedly), so the semaphore/locks are rebuilt whenever
    the running loop changes instead of raising "bound to a different loop".
    """

    __slots__ = ("inflight", "inflight_lock", "loop", "semaphore")

    def __init__(self, loop: asyncio.AbstractEventLoop, concurrency: int) -> None:
        self.loop = loop
        self.semaphore = asyncio.Semaphore(max(1, concurrency))
        self.inflight_lock = asyncio.Lock()
        self.inflight: dict[str, asyncio.Future[dict[str, Any]]] = {}


def _consume_future_exception(future: asyncio.Future[Any]) -> None:
    """Retrieve a failed coalescing future's exception to silence asyncio."""
    if not future.cancelled():
        future.exception()


class TeachingGenerationGateway:
    """Posts teaching-generation payloads to the configured model provider."""

    def __init__(
        self,
        manager: OpenAIOAuthManager,
        *,
        model: str = DEFAULT_AGENT_MODEL,
        timeout_seconds: float = float(STREAM_INACTIVITY_TIMEOUT_SECONDS),
        api_concurrency: int | None = None,
        config_store: ModelConfigStore | None = None,
        pdf_file_cache: PdfFileCache | None = None,
        rate_limit_min_cooldown_seconds: float = RATE_LIMIT_MIN_COOLDOWN_SECONDS,
    ) -> None:
        self.manager = manager
        self.model = model
        #: Inactivity timeout for the streamed upstream response.
        self.timeout_seconds = timeout_seconds
        self.config_store = config_store
        self.pdf_file_cache = pdf_file_cache
        self.concurrency = max(1, int(api_concurrency or teaching_concurrency()))
        self.rate_limit_min_cooldown_seconds = float(rate_limit_min_cooldown_seconds)
        self._state: _LoopState | None = None
        self._upstream_executor = ThreadPoolExecutor(
            max_workers=self.concurrency + 2,
            thread_name_prefix="teaching-upstream",
        )
        self._rate_limit_cooldown_until = 0.0  # time.monotonic() based
        self._active = 0
        self._queued = 0

    # -- public API ---------------------------------------------------------

    async def generate_page(self, body: Mapping[str, Any]) -> dict[str, Any]:
        def parse(content: str) -> dict[str, Any]:
            return {
                "page": _parse_generated_page(
                    content, body, pdf_file_cache=self.pdf_file_cache
                )
            }

        return await self._generate(body, kind="page", parse=parse)

    async def generate_pages(self, body: Mapping[str, Any]) -> dict[str, Any]:
        def parse(content: str) -> dict[str, Any]:
            pages, missing = _parse_generated_pages_with_missing(
                content, body, pdf_file_cache=self.pdf_file_cache
            )
            if not pages:
                raise HttpError(
                    502,
                    "Generation response did not contain any requested page",
                    code="invalid_generation_json",
                )
            if missing:
                LOGGER.info(
                    "teaching.batch_partial pages=%d missing=%s",
                    len(pages),
                    missing,
                )
            return {"pages": pages, "missing": missing}

        return await self._generate(body, kind="pages", parse=parse)

    async def generate_plan(self, body: Mapping[str, Any]) -> dict[str, Any]:
        """Plan the whole document once: segments, per-page role and depth.

        Long documents are planned in chunks of ``LESSON_PLAN_CHUNK_PAGES``
        pages, sequentially, with the running summary carried forward; the
        chunks' segments are renumbered into one contiguous plan.
        """
        pages = _lesson_plan_pages(body)
        if not pages:
            raise HttpError(400, "Lesson plan request did not contain pages", code="invalid_request")
        chunks = [pages[index : index + LESSON_PLAN_CHUNK_PAGES] for index in range(0, len(pages), LESSON_PLAN_CHUNK_PAGES)]
        started = time.monotonic()
        summary = ""
        segments: list[dict[str, Any]] = []
        rows: list[dict[str, Any]] = []
        attempts = 0
        last: dict[str, Any] = {}
        for index, chunk in enumerate(chunks, start=1):
            chunk_body: dict[str, Any] = {
                **body,
                "pages": list(chunk),
                "previousSummary": summary,
                "chunk": {"index": index, "count": len(chunks)},
            }

            def parse(content: str, _chunk_body: Mapping[str, Any] = chunk_body) -> dict[str, Any]:
                return {"plan": _parse_lesson_plan(content, _chunk_body)}

            last = await self._generate(
                chunk_body, kind="plan", parse=parse, payload_builder=self._build_plan_payload
            )
            plan = last["plan"]
            summary = plan["document_summary"] or summary
            offset = len(segments)
            for segment in plan["segments"]:
                segments.append({**segment, "id": segment["id"] + offset})
            for row in plan["pages"]:
                rows.append({**row, "segment": row["segment"] + offset})
            timing = last.get("timing") if isinstance(last.get("timing"), Mapping) else {}
            attempts += int(timing.get("attempts", 1) or 1)
        result = dict(last)
        result["plan"] = {
            "version": LESSON_PLAN_VERSION,
            "model": string_value(last.get("model"), ""),
            "document_summary": summary,
            "segments": segments,
            "pages": rows,
        }
        result["timing"] = {
            "elapsed_ms": int((time.monotonic() - started) * 1000),
            "attempts": max(1, attempts),
            "coalesced": False,
        }
        return result

    async def generate_transcription(self, body: Mapping[str, Any]) -> dict[str, Any]:
        """Transcribe pages whose text layer is unreadable from the attached PDF pages.

        The client sends at most ``TRANSCRIPTION_MAX_PAGES`` pages with the
        document file; the page subset travels as an ``input_file`` and the
        model returns Markdown with LaTeX for each page. There is no text-only
        fallback: without the page there is nothing to transcribe.
        """
        pages = _lesson_plan_pages(body)
        if not pages:
            raise HttpError(400, "Transcription request did not contain pages", code="invalid_request")
        if len(pages) > TRANSCRIPTION_MAX_PAGES:
            raise HttpError(
                400,
                f"Transcription covers at most {TRANSCRIPTION_MAX_PAGES} pages per request",
                code="invalid_request",
            )
        request_body: dict[str, Any] = {**body, "requirePdfFile": True}

        def parse(content: str) -> dict[str, Any]:
            return _parse_transcription(content, request_body)

        return await self._generate(
            request_body, kind="transcribe", parse=parse, payload_builder=self._build_transcription_payload
        )

    def status(self) -> dict[str, Any]:
        """Cheap, read-only snapshot for ``GET /api/generate/status``."""
        remaining = self._rate_limit_cooldown_until - time.monotonic()
        cooldown_until_ms = int((time.time() + remaining) * 1000) if remaining > 0 else 0
        return {
            "active": max(0, self._active),
            "queued": max(0, self._queued),
            "cooldown_until_ms": cooldown_until_ms,
            "concurrency": self.concurrency,
            "deadlines_seconds": deadlines_seconds_payload(),
        }

    def close(self) -> None:
        """Stop the upstream thread pool (called on server shutdown).

        Reads that are already blocked on the upstream socket cannot be
        interrupted; they end at the inactivity timeout at the latest.
        """
        if self._active > 0:
            LOGGER.warning(
                "teaching.close waiting for %d in-flight model request(s); they stop at the "
                "inactivity timeout (%.0fs) at the latest",
                self._active,
                self.timeout_seconds,
            )
        self._upstream_executor.shutdown(wait=False, cancel_futures=True)

    # -- coalescing ---------------------------------------------------------

    async def _generate(
        self,
        body: Mapping[str, Any],
        *,
        kind: str,
        parse: ParseFn,
        payload_builder: PayloadBuilder | None = None,
    ) -> dict[str, Any]:
        started = time.monotonic()
        key = self._request_key(body, kind=kind)
        state = self._loop_state()

        async with state.inflight_lock:
            inflight = state.inflight.get(key)
            is_producer = inflight is None
            if inflight is None:
                inflight = state.loop.create_future()
                state.inflight[key] = inflight
        future = inflight

        if not is_producer:
            LOGGER.info("teaching.coalesced kind=%s key=%s", kind, key[:12])
            shared = await asyncio.shield(future)
            timing = shared.get("timing") if isinstance(shared.get("timing"), Mapping) else {}
            result = dict(shared)
            result["timing"] = {
                "elapsed_ms": int((time.monotonic() - started) * 1000),
                "attempts": int(timing.get("attempts", 1) or 1),
                "coalesced": True,
            }
            return result

        try:
            result = await self._generate_uncoalesced(
                body, parse=parse, started=started, payload_builder=payload_builder
            )
        except asyncio.CancelledError:
            if not future.done():
                future.cancel()
            raise
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
                future.add_done_callback(_consume_future_exception)
            raise
        else:
            if not future.done():
                future.set_result(result)
            return result
        finally:
            async with state.inflight_lock:
                if state.inflight.get(key) is future:
                    del state.inflight[key]

    async def _generate_uncoalesced(
        self,
        body: Mapping[str, Any],
        *,
        parse: ParseFn,
        started: float,
        payload_builder: PayloadBuilder | None = None,
    ) -> dict[str, Any]:
        page_count = max(1, len(_teaching_generation_pages(body)))
        effort = _reasoning_effort(body)
        context = _RequestContext(
            request_deadline_seconds(effort, page_count), started=started
        )
        parsed, result, document_file_used, cache_metadata = await self._generate_content_with_fallback(
            body,
            parse=parse,
            context=context,
            effort=effort,
            page_count=page_count,
            payload_builder=payload_builder or self._build_payload,
        )
        return {
            **parsed,
            "account_id": result.account_id,
            "provider_id": result.provider_id,
            "provider": result.provider_name,
            "model": result.payload.get("model"),
            "cache": {
                **cache_metadata,
                "document_file_input": document_file_used,
            },
            "timing": {
                "elapsed_ms": context.elapsed_ms,
                "attempts": max(1, context.attempts),
                "coalesced": False,
            },
        }

    # -- candidate / repair flow -------------------------------------------

    async def _generate_content_with_fallback(
        self,
        body: Mapping[str, Any],
        *,
        parse: ParseFn,
        context: _RequestContext,
        effort: str,
        page_count: int,
        payload_builder: PayloadBuilder,
    ):
        candidate_bodies = await asyncio.to_thread(
            _teaching_generation_candidate_bodies, body, pdf_file_cache=self.pdf_file_cache
        )

        last_error: HttpError | None = None
        repaired = False
        for candidate_index, (candidate_body, document_file_used) in enumerate(candidate_bodies):
            payload = await asyncio.to_thread(
                payload_builder, candidate_body, effort, page_count
            )
            try:
                content, result = await self._post_and_extract(candidate_body, payload, context)
                try:
                    parsed = await asyncio.to_thread(parse, content)
                except HttpError as parse_error:
                    if (
                        parse_error.code != "invalid_generation_json"
                        or repaired
                        or context.remaining_seconds <= 0
                    ):
                        raise
                    repaired = True
                    repair_payload = self._repair_payload(payload)
                    LOGGER.info(
                        "teaching.repair_retry effort=%s->%s remaining=%.0fs reason=%s",
                        _payload_effort(payload),
                        _payload_effort(repair_payload),
                        context.remaining_seconds,
                        parse_error.code,
                    )
                    content, result = await self._post_and_extract(
                        candidate_body, repair_payload, context
                    )
                    parsed = await asyncio.to_thread(parse, content)
                return (
                    parsed,
                    result,
                    document_file_used,
                    provider_cache_metadata(
                        result.payload,
                        response_text=result.text,
                        content_type=result.content_type,
                    ),
                )
            except HttpError as exc:
                last_error = exc
                if (
                    candidate_index < len(candidate_bodies) - 1
                    and context.remaining_seconds > 0
                    and _should_try_next_teaching_generation_candidate(
                        exc,
                        document_file_used=document_file_used,
                    )
                ):
                    LOGGER.info(
                        "teaching.candidate_fallback index=%d status=%s code=%s",
                        candidate_index,
                        exc.status,
                        exc.code,
                    )
                    continue
                raise
        if last_error:
            raise last_error
        raise HttpError(502, "Model provider returned an empty generation response", code="empty_gateway_response")

    async def _post_and_extract(
        self,
        candidate_body: Mapping[str, Any],
        payload: dict[str, Any],
        context: _RequestContext,
    ):
        result = await post_responses_payload_for_body(
            manager=self.manager,
            config_store=self.config_store,
            body=candidate_body,
            default_key="teachingQuality",
            legacy_model=self.model,
            responses_payload=payload,
            post_with_retries=self._post_fn(context),
            codex_include_reasoning_encrypted_content=False,
            codex_auth_builder=build_chatgpt_codex_auth,
        )
        content = extract_provider_text(result.text, result.content_type)
        if not content:
            raise HttpError(502, "Model provider returned an empty generation response", code="empty_gateway_response")
        return content, result

    def _build_payload(
        self,
        candidate_body: Mapping[str, Any],
        effort: str,
        page_count: int,
    ) -> dict[str, Any]:
        payload = _build_teaching_generation_payload(
            candidate_body,
            default_model=self.model,
            pdf_file_cache=self.pdf_file_cache,
        )
        payload.setdefault("max_output_tokens", max_output_tokens_for(effort, page_count))
        return payload

    def _build_plan_payload(
        self,
        candidate_body: Mapping[str, Any],
        effort: str,
        page_count: int,
    ) -> dict[str, Any]:
        payload = _build_lesson_plan_payload(
            candidate_body, default_model=self.model, pdf_file_cache=self.pdf_file_cache
        )
        payload.setdefault("max_output_tokens", max_output_tokens_for(effort, page_count))
        return payload

    def _build_transcription_payload(
        self,
        candidate_body: Mapping[str, Any],
        effort: str,
        page_count: int,
    ) -> dict[str, Any]:
        payload = _build_transcription_payload(
            candidate_body, default_model=self.model, pdf_file_cache=self.pdf_file_cache
        )
        payload.setdefault("max_output_tokens", max_output_tokens_for(effort, page_count))
        return payload

    def _repair_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Same plan, one reasoning step lower, JSON-only instructions."""
        repaired = dict(payload)
        instructions = str(repaired.get("instructions") or "").rstrip()
        if not instructions.endswith(REPAIR_INSTRUCTIONS_SUFFIX):
            repaired["instructions"] = f"{instructions}\n{REPAIR_INSTRUCTIONS_SUFFIX}".strip()
        reasoning = dict(repaired.get("reasoning") or {})
        lowered = lower_reasoning_effort(
            reasoning.get("effort"),
            supported_reasoning_efforts(string_value(repaired.get("model"), "")),
        )
        if lowered:
            reasoning["effort"] = lowered
            repaired["reasoning"] = reasoning
        return repaired

    # -- transport ----------------------------------------------------------

    def _post_fn(self, context: _RequestContext):
        async def post(url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[str, str]:
            return await self._post_with_retries(url, payload, headers, context=context)

        return post

    async def _post_with_retries(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
        *,
        context: _RequestContext,
    ) -> tuple[str, str]:
        attempt = 0
        while True:
            if context.remaining_seconds <= 0:
                raise _deadline_error(context)
            try:
                await self._wait_for_rate_limit_cooldown(context)
                context.attempts += 1
                return await self._post_once(url, payload, headers, context=context)
            except HttpError as exc:
                if exc.status == 429 or exc.code == "rate_limited":
                    # A local queue_timeout also carries Retry-After but is not
                    # an upstream rate limit; it must not stall other requests.
                    self._note_rate_limit_cooldown(exc)
                if not self._should_retry(exc, attempt, context):
                    raise
                delay_seconds = _transient_retry_delay_seconds(exc, attempt)
                if delay_seconds >= context.remaining_seconds:
                    raise
                if exc.code == "upstream_timeout":
                    context.timeout_retries += 1
                LOGGER.info(
                    "teaching.retry attempt=%d status=%s code=%s delay=%.1fs remaining=%.0fs",
                    attempt + 1,
                    exc.status,
                    exc.code,
                    delay_seconds,
                    context.remaining_seconds,
                )
                await asyncio.sleep(delay_seconds)
                attempt += 1

    def _should_retry(self, exc: HttpError, attempt: int, context: _RequestContext) -> bool:
        if attempt >= len(TEACHING_RETRY_DELAYS_SECONDS):
            return False
        if exc.code == "queue_timeout":
            return False
        if not _should_retry_transient_upstream_error(exc):
            return False
        if exc.code == "upstream_timeout" and context.timeout_retries >= MAX_TIMEOUT_RETRIES:
            return False
        return context.remaining_seconds > 0

    async def _post_once(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
        *,
        context: _RequestContext,
    ) -> tuple[str, str]:
        state = self._loop_state()
        self._queued += 1
        try:
            await asyncio.wait_for(state.semaphore.acquire(), QUEUE_WAIT_TIMEOUT_SECONDS)
        except TimeoutError as exc:
            LOGGER.info(
                "teaching.queue_timeout active=%d queued=%d concurrency=%d",
                self._active,
                self._queued,
                self.concurrency,
            )
            raise HttpError(
                503,
                f"Generation queue is full; retry in {QUEUE_RETRY_AFTER_SECONDS}s",
                code="queue_timeout",
                retry_after_seconds=float(QUEUE_RETRY_AFTER_SECONDS),
            ) from exc
        finally:
            self._queued -= 1

        self._active += 1
        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(
                self._upstream_executor,
                functools.partial(
                    post_json_responses,
                    url,
                    payload,
                    headers,
                    timeout_seconds=self.timeout_seconds,
                    handle_timeout=True,
                    deadline_seconds=max(1.0, context.remaining_seconds),
                ),
            )
        finally:
            self._active -= 1
            state.semaphore.release()

    # -- rate-limit cooldown ------------------------------------------------

    async def _wait_for_rate_limit_cooldown(self, context: _RequestContext) -> None:
        while True:
            cooldown_seconds = self._rate_limit_cooldown_until - time.monotonic()
            if cooldown_seconds <= 0:
                return
            if cooldown_seconds >= context.remaining_seconds:
                raise HttpError(
                    429,
                    f"Model provider rate limit is still cooling down for {cooldown_seconds:.0f}s",
                    code="rate_limited",
                    retry_after_seconds=cooldown_seconds,
                )
            await asyncio.sleep(min(cooldown_seconds, 1.0))

    def _note_rate_limit_cooldown(self, exc: HttpError) -> None:
        retry_after = float(exc.retry_after_seconds or 0.0)
        cooldown_seconds = min(
            max(retry_after, self.rate_limit_min_cooldown_seconds),
            RATE_LIMIT_MAX_COOLDOWN_SECONDS,
        )
        until = time.monotonic() + cooldown_seconds
        if until > self._rate_limit_cooldown_until:
            self._rate_limit_cooldown_until = until
            LOGGER.info(
                "teaching.rate_limit_cooldown seconds=%.1f status=%s",
                cooldown_seconds,
                exc.status,
            )

    # -- helpers ------------------------------------------------------------

    def _loop_state(self) -> _LoopState:
        loop = asyncio.get_running_loop()
        state = self._state
        if state is None or state.loop is not loop:
            state = _LoopState(loop, self.concurrency)
            self._state = state
        return state

    def _request_key(self, body: Mapping[str, Any], *, kind: str) -> str:
        document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
        document_context = (
            body.get("documentContext") if isinstance(body.get("documentContext"), Mapping) else {}
        )
        quality_plan = body.get("qualityPlan") if isinstance(body.get("qualityPlan"), Mapping) else {}
        document_file = body.get("documentFile") if isinstance(body.get("documentFile"), Mapping) else {}
        return generation_request_key(
            kind=kind,
            provider_id=string_value(body.get("modelProviderId"), ""),
            model=string_value(body.get("model"), self.model),
            document_id=string_value(
                document.get("id") or document_context.get("documentId"), ""
            ),
            page_numbers=_teaching_generation_page_numbers(body),
            output_language=_teaching_output_language(body)[0],
            attempt=string_value(quality_plan.get("attempt"), ""),
            reasoning_effort=_reasoning_effort(body),
            has_document_file=bool(document_file),
        )


def _payload_effort(payload: Mapping[str, Any]) -> str:
    reasoning = payload.get("reasoning")
    if isinstance(reasoning, Mapping):
        return string_value(reasoning.get("effort"), "")
    return ""


def _deadline_error(context: _RequestContext) -> HttpError:
    return HttpError(
        504,
        f"Generation exceeded its {context.deadline - context.started:.0f}s budget "
        f"after {context.attempts} attempt(s)",
        code="upstream_timeout",
    )
