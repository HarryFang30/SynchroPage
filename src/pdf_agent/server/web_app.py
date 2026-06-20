from __future__ import annotations

import argparse
import asyncio
import base64
import datetime
import hashlib
import io
import json
import math
import mimetypes
import os
import random
import re
import shutil
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from email.utils import parsedate_to_datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from pdf_agent.auth import OpenAIOAuthApi, OpenAIOAuthError, OpenAIOAuthManager
from pdf_agent.gateway import (
    build_chatgpt_codex_auth,
    build_codex_responses_payload,
    codex_responses_url,
    redacted_gateway_error,
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
SOURCE_WEB_ROOT = PROJECT_ROOT / "apps" / "web"
DIST_WEB_ROOT = SOURCE_WEB_ROOT / "dist"
WEB_ROOT = DIST_WEB_ROOT if DIST_WEB_ROOT.exists() else SOURCE_WEB_ROOT
OAUTH_CONFIG_PATH = PROJECT_ROOT / "config" / "auth" / "openai_oauth.yaml"
DEFAULT_AGENT_MODEL = os.environ.get("PDF_AGENT_MODEL", "gpt-5.5")
MAX_CONTEXT_ITEMS = 10
MAX_CONTEXT_CHARS = 16_000
MAX_TEACHING_FAST_SOURCE_CHARS = 2_500
MAX_TEACHING_BALANCED_SOURCE_CHARS = 8_000
MAX_TEACHING_QUALITY_SOURCE_CHARS = 16_000
MAX_PDF_CONTEXT_CHARS = 120_000
MAX_TEACHING_CACHE_CHARS = 750_000
PDF_CONTEXT_FULL_PAGE_LIMIT = 50
PDF_CONTEXT_EDGE_PAGE_COUNT = 10
MAX_TRANSCRIPT_MESSAGES = 8
MAX_IMAGE_ATTACHMENTS = 8
MAX_IMAGE_DATA_URL_CHARS = 8_000_000
MAX_PDF_FILE_DATA_CHARS = 80_000_000
PDF_FILE_CACHE_MAX_ENTRIES = 8
PDF_FILE_CACHE_MAX_BYTES = 240_000_000
PDF_FILE_SUBSET_CACHE_MAX_ENTRIES = 64
PDF_FILE_SUBSET_CACHE_MAX_BYTES = 120_000_000
PROMPT_CACHE_VERSION = "pagepair.prompt-cache.v2"
DOCUMENT_CACHE_PREFIX_VERSION = "pagepair.document-prefix.v2"
TEACHING_API_CONCURRENCY = 6
TEACHING_RETRY_DELAYS_SECONDS = (0.5, 1.5, 3.0)
TEACHING_MAX_RETRY_DELAY_SECONDS = 12.0
TEACHING_RATE_LIMIT_MIN_COOLDOWN_SECONDS = 0.75
_PDF_FILE_CACHE_LOCK = threading.Lock()
_PDF_FILE_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
_PDF_FILE_CACHE_BYTES = 0
_PDF_FILE_SUBSET_CACHE_LOCK = threading.Lock()
_PDF_FILE_SUBSET_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
_PDF_FILE_SUBSET_CACHE_BYTES = 0

PAGEPAIR_SHARED_INSTRUCTIONS = """You are the model backend for PagePair Reader.
Use the provided PDF/page context, selected text, formulas, images, and task-specific instructions as primary evidence.
Preserve LaTeX formulas, cite page numbers when available, and do not invent facts that are not supported by the provided source material.
Follow the task-specific instructions included in each request, including any required output format."""

PAGEPAIR_FAST_TEACHING_INSTRUCTIONS = (
    "Generate PagePair teaching notes from the compact document context and provided page source. "
    "Return strict JSON only, preserve technical tokens/LaTeX, and do not invent unsupported facts."
)

AGENT_INSTRUCTIONS = """You are the AI agent panel inside PagePair Reader.
Use the current PDF/page context, selected text, formulas, and image attachments as primary evidence.
Answer in the user's language, preserve LaTeX formulas, cite page numbers when available, and keep the response useful for study, review, or editing.
Follow the answer-mode instructions included in each request."""

TEACHING_GENERATOR_INSTRUCTIONS = """You are the PagePair per-page teaching generator.
Generate page-aligned study notes for one PDF page at a time.
Return strict JSON only. Do not wrap JSON in Markdown fences.
Use the requested output language from the prompt for all prose. Preserve formulas in LaTeX using $...$ or $$...$$.
For display math, put opening and closing $$ on their own lines and do not attach prose to the same line.
When writing LaTeX in JSON strings, escape every LaTeX backslash as a JSON backslash pair, for example write \\\\frac and \\\\to.
Do not put natural-language Chinese text directly inside math delimiters. Write ranges like $0$ 到 $2^n - 1$, or use $0 \\text{ 到 } 2^n - 1$.
Never escape digits in LaTeX; write 2^n, not \\2^n.
Never escape binary strings; write 000, 111, not \\000 or \\111.
For binary counting sequences, write $000 \\to 001 \\to 010 \\to \\cdots \\to 111 \\to 000$ and close math before Chinese prose.
Render tables as GitHub-Flavored Markdown tables inside speaker_notes_md when the source page contains tabular content.
Keep speaker_notes_md concise: prefer 4-7 focused bullets or short sections, avoid restating the source text line by line, and only expand when formulas, tables, or derivations need it.
Do not invent facts that are not supported by the source page text. If the page has no extractable text, mark it as needs_parser_fallback."""

TEACHING_GENERATOR_FAST_INSTRUCTIONS = """You are the PagePair per-page teaching generator.
Return strict JSON only. Use the requested output language for all prose.
Keep speaker_notes_md concise, explain rather than transcribe, preserve technical tokens, and do not invent unsupported facts.
Escape LaTeX backslashes in JSON strings, for example write \\\\frac and \\\\to."""


class HttpError(RuntimeError):
    def __init__(
        self,
        status: int,
        message: str,
        *,
        code: str = "http_error",
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after_seconds = retry_after_seconds


class AsyncRunner:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, name="pdf-agent-async", daemon=True)
        self.thread.start()

    def run(self, awaitable: Any) -> Any:
        future = asyncio.run_coroutine_threadsafe(awaitable, self.loop)
        return future.result()

    def shutdown(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=2)

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()


class AgentChatGateway:
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
        text, content_type, payload = await self._post_payload_with_cache_fallback(
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

    async def _post_payload_with_cache_fallback(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
    ) -> tuple[str, str, dict[str, Any]]:
        try:
            text, content_type = await asyncio.to_thread(self._post_responses, url, payload, headers)
            return text, content_type, payload
        except HttpError as exc:
            if not _should_retry_without_prompt_cache(exc, payload):
                raise
            fallback_payload = _without_prompt_cache(payload)
            text, content_type = await asyncio.to_thread(self._post_responses, url, fallback_payload, headers)
            fallback_payload["_pagepair_cache_fallback_without_fields"] = True
            return text, content_type, fallback_payload

    def _post_responses(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[str, str]:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Accept": "text/event-stream, application/json",
                "Content-Type": "application/json",
                **headers,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                text = response.read().decode("utf-8", errors="replace")
                return text, response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise HttpError(exc.code, redacted_gateway_error(detail), code="upstream_error") from exc
        except urllib.error.URLError as exc:
            raise HttpError(502, redacted_gateway_error(str(exc)), code="network_error") from exc


class TeachingGenerationGateway:
    def __init__(
        self,
        manager: OpenAIOAuthManager,
        *,
        model: str = DEFAULT_AGENT_MODEL,
        timeout_seconds: float = 180.0,
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
                text, content_type, payload = await self._post_payload_with_cache_fallback(url, payload, headers)
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

    async def _post_payload_with_cache_fallback(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
    ) -> tuple[str, str, dict[str, Any]]:
        try:
            text, content_type = await self._post_responses_with_retries(url, payload, headers)
            return text, content_type, payload
        except HttpError as exc:
            if not _should_retry_without_prompt_cache(exc, payload):
                raise
            fallback_payload = _without_prompt_cache(payload)
            text, content_type = await self._post_responses_with_retries(url, fallback_payload, headers)
            fallback_payload["_pagepair_cache_fallback_without_fields"] = True
            return text, content_type, fallback_payload

    async def _post_responses_with_retries(
        self,
        url: str,
        payload: dict[str, Any],
        headers: dict[str, str],
    ) -> tuple[str, str]:
        for attempt in range(len(TEACHING_RETRY_DELAYS_SECONDS) + 1):
            try:
                await self._wait_for_rate_limit_cooldown()
                async with self._api_semaphore:
                    return await asyncio.to_thread(self._post_responses, url, payload, headers)
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

    def _post_responses(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[str, str]:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Accept": "text/event-stream, application/json",
                "Content-Type": "application/json",
                **headers,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                text = response.read().decode("utf-8", errors="replace")
                return text, response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise HttpError(
                exc.code,
                redacted_gateway_error(detail),
                code="upstream_error",
                retry_after_seconds=_retry_after_seconds(exc.headers.get("Retry-After")),
            ) from exc
        except urllib.error.URLError as exc:
            raise HttpError(502, redacted_gateway_error(str(exc)), code="network_error") from exc


class PdfAgentHttpServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[BaseHTTPRequestHandler],
        *,
        web_root: Path,
        oauth_api: OpenAIOAuthApi,
        chat_gateway: AgentChatGateway,
        teaching_gateway: TeachingGenerationGateway,
        runner: AsyncRunner,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.web_root = web_root
        self.oauth_api = oauth_api
        self.chat_gateway = chat_gateway
        self.teaching_gateway = teaching_gateway
        self.runner = runner


class PdfAgentRequestHandler(BaseHTTPRequestHandler):
    server: PdfAgentHttpServer

    def do_GET(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/health":
                self._send_json({"ok": True, "service": "pdf-agent"})
            elif path == "/auth/openai/status":
                self._send_json(self.server.runner.run(self.server.oauth_api.status()))
            else:
                self._send_static(path)
        except Exception as exc:
            self._send_exception(exc)

    def do_HEAD(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        try:
            self._send_static(path, include_body=False)
        except Exception as exc:
            self._send_exception(exc)

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/auth/openai/start":
                self._send_json(self.server.runner.run(self.server.oauth_api.start_login()))
            elif path == "/auth/openai/poll":
                body = self._read_json()
                self._send_json(self.server.runner.run(self.server.oauth_api.poll_login(str(body.get("device_code", "")))))
            elif path == "/auth/openai/logout":
                self._send_json(self.server.runner.run(self.server.oauth_api.logout()))
            elif path == "/auth/openai/default":
                body = self._read_json()
                self._send_json(self.server.runner.run(self.server.oauth_api.set_default_account(str(body.get("account_id", "")))))
            elif path == "/api/agent/chat":
                body = self._read_json()
                self._send_json(self.server.runner.run(self.server.chat_gateway.chat(body)))
            elif path == "/api/pdf/cache":
                body = self._read_json()
                self._send_json(_cache_pdf_file_payload(body.get("documentFile") or body))
            elif path == "/api/generate/page":
                body = self._read_json()
                self._send_json(self.server.runner.run(self.server.teaching_gateway.generate_page(body)))
            elif path == "/api/generate/pages":
                body = self._read_json()
                self._send_json(self.server.runner.run(self.server.teaching_gateway.generate_pages(body)))
            else:
                raise HttpError(404, f"Route not found: {path}", code="not_found")
        except Exception as exc:
            self._send_exception(exc)

    def do_DELETE(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        try:
            prefix = "/auth/openai/accounts/"
            if path.startswith(prefix):
                account_id = urllib.parse.unquote(path[len(prefix) :])
                self._send_json(self.server.runner.run(self.server.oauth_api.remove_account(account_id)))
            else:
                raise HttpError(404, f"Route not found: {path}", code="not_found")
        except Exception as exc:
            self._send_exception(exc)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise HttpError(400, f"Invalid JSON: {exc}", code="invalid_json") from exc
        if not isinstance(value, dict):
            raise HttpError(400, "JSON body must be an object", code="invalid_json")
        return value

    def _send_json(self, value: Any, *, status: int = 200) -> None:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _send_static(self, path: str, *, include_body: bool = True) -> None:
        file_path = _resolve_static_path(self.server.web_root, path)
        if not file_path.exists() or not file_path.is_file():
            raise HttpError(404, f"File not found: {path}", code="not_found")
        stat_result = file_path.stat()
        etag = _static_file_etag(stat_result)
        cache_control = _static_cache_control(self.server.web_root, file_path)
        if _request_etag_matches(self.headers.get("If-None-Match"), etag):
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache_control)
            self.end_headers()
            return

        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(stat_result.st_size))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", cache_control)
        self.end_headers()
        if include_body:
            with file_path.open("rb") as file:
                shutil.copyfileobj(file, self.wfile, length=1024 * 1024)

    def _send_exception(self, exc: Exception) -> None:
        if isinstance(exc, OpenAIOAuthError):
            status = 401 if exc.code in {"account_not_found", "refresh_token_invalid"} else 400
            self._send_json({"error": exc.code, "message": str(exc)}, status=status)
        elif isinstance(exc, HttpError):
            self._send_json({"error": exc.code, "message": str(exc)}, status=exc.status)
        else:
            self._send_json({"error": "internal_error", "message": redacted_gateway_error(str(exc))}, status=500)


def create_server(
    host: str = "127.0.0.1",
    port: int = 8765,
    *,
    web_root: Path | None = None,
    oauth_config_path: Path = OAUTH_CONFIG_PATH,
    model: str = DEFAULT_AGENT_MODEL,
) -> PdfAgentHttpServer:
    manager = OpenAIOAuthManager(config=oauth_config_path if oauth_config_path.exists() else None)
    runner = AsyncRunner()
    oauth_api = OpenAIOAuthApi(manager)
    chat_gateway = AgentChatGateway(manager, model=model)
    teaching_gateway = TeachingGenerationGateway(manager, model=model)
    return PdfAgentHttpServer(
        (host, port),
        PdfAgentRequestHandler,
        web_root=web_root or _default_web_root(),
        oauth_api=oauth_api,
        chat_gateway=chat_gateway,
        teaching_gateway=teaching_gateway,
        runner=runner,
    )


def _default_web_root() -> Path:
    return DIST_WEB_ROOT if (DIST_WEB_ROOT / "index.html").exists() else SOURCE_WEB_ROOT


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the local PDF Agent web app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--web-root", type=Path, default=None, help="Directory containing the built web UI.")
    parser.add_argument("--model", default=DEFAULT_AGENT_MODEL)
    args = parser.parse_args(argv)

    server = create_server(args.host, args.port, web_root=args.web_root, model=args.model)
    url = f"http://{args.host}:{server.server_address[1]}/"
    print(f"PDF Agent web app: {url}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.runner.shutdown()
        server.server_close()
    return 0


def _build_responses_payload(body: Mapping[str, Any], *, default_model: str) -> dict[str, Any]:
    model = _clean_model(body.get("model")) or default_model
    content: list[dict[str, Any]] = []
    cache_prefix = _build_document_cache_prefix(body)
    if cache_prefix:
        content.append({"type": "input_text", "text": cache_prefix})
    pdf_file = _pdf_file_input(body.get("documentFile"))
    if pdf_file:
        content.append(pdf_file)
    content.append({"type": "input_text", "text": _build_agent_interaction_prompt(body)})
    for image in _image_attachments(body.get("attachments"), body.get("parts")):
        content.append({"type": "input_image", "image_url": image["data_url"]})
    payload: dict[str, Any] = {
        "model": model,
        "instructions": PAGEPAIR_SHARED_INSTRUCTIONS,
        "input": [{"role": "user", "content": content}],
        "reasoning": {"effort": _reasoning_effort(body)},
    }
    _apply_prompt_cache_fields(payload, body, model)
    return payload


def _build_teaching_generation_payload(body: Mapping[str, Any], *, default_model: str) -> dict[str, Any]:
    model = _clean_model(body.get("model")) or default_model
    content: list[dict[str, Any]] = []
    cache_prefix = _build_document_cache_prefix(body)
    if cache_prefix:
        content.append({"type": "input_text", "text": cache_prefix})
    pdf_file = _pdf_file_input(body.get("documentFile"), page_numbers=_teaching_generation_page_numbers(body))
    if pdf_file:
        content.append(pdf_file)
    content.append({"type": "input_text", "text": _build_teaching_generation_prompt(body)})
    payload: dict[str, Any] = {
        "model": model,
        "instructions": _teaching_payload_instructions(body),
        "input": [{"role": "user", "content": content}],
        "reasoning": {"effort": _reasoning_effort(body)},
    }
    _apply_prompt_cache_fields(payload, body, model)
    return payload


def _teaching_payload_instructions(body: Mapping[str, Any]) -> str:
    return PAGEPAIR_FAST_TEACHING_INSTRUCTIONS if _is_fast_teaching_generation(body) else PAGEPAIR_SHARED_INSTRUCTIONS


def _build_teaching_codex_responses_payload(body: Mapping[str, Any], default_model: str) -> dict[str, Any]:
    return build_codex_responses_payload(
        _build_teaching_generation_payload(body, default_model=default_model),
        force_stream=True,
        include_reasoning_encrypted_content=False,
        strip_unsupported_fields=True,
    )


def _teaching_generation_candidate_bodies(body: Mapping[str, Any]) -> list[tuple[Mapping[str, Any], bool]]:
    requested_model = _clean_model(body.get("model"))
    fallback_model = _clean_model(body.get("fallbackModel"))
    model_bodies: list[Mapping[str, Any]] = [body]
    if fallback_model and fallback_model != requested_model:
        fallback_body = dict(body)
        fallback_body["model"] = fallback_model
        fallback_body.pop("fallbackModel", None)
        model_bodies.append(fallback_body)

    has_pdf_file = bool(_pdf_file_input(body.get("documentFile")))
    candidates: list[tuple[Mapping[str, Any], bool]] = []
    if has_pdf_file:
        candidates.extend((candidate, True) for candidate in model_bodies)
        for candidate in model_bodies:
            without_file = dict(candidate)
            without_file.pop("documentFile", None)
            candidates.append((without_file, False))
    else:
        candidates.extend((candidate, False) for candidate in model_bodies)
    return candidates


def _agent_answer_mode(body: Mapping[str, Any]) -> str:
    value = str(body.get("answerMode") or "").strip()
    if value in {"concise", "guided", "detailed"}:
        return value
    return "concise"


def _agent_answer_mode_effort(mode: str) -> str:
    if mode == "detailed":
        return "xhigh"
    if mode == "guided":
        return "high"
    return "medium"


def _reasoning_effort(body: Mapping[str, Any]) -> str:
    reasoning = body.get("reasoning") if isinstance(body.get("reasoning"), Mapping) else {}
    quality_plan = body.get("qualityPlan") if isinstance(body.get("qualityPlan"), Mapping) else {}
    value = str(body.get("reasoningEffort") or reasoning.get("effort") or quality_plan.get("reasoningEffort") or "").strip()
    if value in {"none", "low", "medium", "high", "xhigh"}:
        return value
    if body.get("answerMode"):
        return _agent_answer_mode_effort(_agent_answer_mode(body))
    return "medium"


def _teaching_output_language(body: Mapping[str, Any]) -> tuple[str, str]:
    value = str(body.get("outputLanguage") or "").strip()
    label = str(body.get("outputLanguageLabel") or "").strip()
    if value in {"zh-CN", "zh", "zh_CN"}:
        return "zh-CN", label or "Simplified Chinese"
    if value in {"en-US", "en", "en_US"}:
        return "en-US", label or "English"

    ui_language = str(body.get("uiLanguage") or "").strip()
    if ui_language == "en-US":
        return "en-US", "English"
    return "zh-CN", "Simplified Chinese"


def _teaching_generation_pages(body: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    pages = body.get("pages")
    if isinstance(pages, list):
        valid_pages = [page for page in pages if isinstance(page, Mapping)]
        if valid_pages:
            return valid_pages
    page = body.get("page")
    return [page] if isinstance(page, Mapping) else []


def _teaching_generation_page_numbers(body: Mapping[str, Any]) -> list[int]:
    numbers: list[int] = []
    seen: set[int] = set()
    for index, page in enumerate(_teaching_generation_pages(body), start=1):
        page_no = _int_value(page.get("page_no"), index)
        if page_no > 0 and page_no not in seen:
            seen.add(page_no)
            numbers.append(page_no)
    return numbers


def _teaching_quality_plan_lines(body: Mapping[str, Any]) -> list[str]:
    plan = body.get("qualityPlan")
    if not isinstance(plan, Mapping):
        return []
    if _is_fast_teaching_generation(body):
        return ["mode: fast text-page path; concise output preferred."]
    attempt = _string_value(plan.get("attempt"), "initial")
    mode = "quality retry" if attempt == "retry" else "pdf-grounded" if bool(plan.get("attachPdf")) else "balanced text"
    lines = [f"mode: {mode}; reasoning={_string_value(plan.get('reasoningEffort'), _reasoning_effort(body))}"]
    reasons = _string_list(plan.get("reasons"))
    if reasons:
        lines.append(f"reasons: {', '.join(reasons)}")
    if attempt == "retry":
        lines.append("This is a quality retry. Prefer more complete visual/source grounding over speed.")
    elif bool(plan.get("batchable")):
        lines.append("This path can be batched. Keep the output concise and do not over-expand.")
    return lines


def _teaching_generator_instructions(body: Mapping[str, Any]) -> str:
    return TEACHING_GENERATOR_FAST_INSTRUCTIONS if _is_fast_teaching_generation(body) else TEACHING_GENERATOR_INSTRUCTIONS


def _teaching_source_text_limit(body: Mapping[str, Any]) -> int:
    plan = body.get("qualityPlan")
    if not isinstance(plan, Mapping):
        return MAX_TEACHING_QUALITY_SOURCE_CHARS
    model = _string_value(plan.get("model") or body.get("model"), "")
    reasoning_effort = _string_value(plan.get("reasoningEffort"), _reasoning_effort(body))
    attach_pdf = bool(plan.get("attachPdf"))
    if attach_pdf or reasoning_effort in {"high", "xhigh"}:
        return MAX_TEACHING_QUALITY_SOURCE_CHARS
    if "mini" in model and reasoning_effort in {"none", "low"}:
        return MAX_TEACHING_FAST_SOURCE_CHARS
    return MAX_TEACHING_BALANCED_SOURCE_CHARS


def _is_fast_teaching_generation(body: Mapping[str, Any]) -> bool:
    plan = body.get("qualityPlan")
    if not isinstance(plan, Mapping):
        return False
    model = _string_value(plan.get("model") or body.get("model"), "")
    reasoning_effort = _string_value(plan.get("reasoningEffort"), _reasoning_effort(body))
    return "mini" in model and reasoning_effort in {"none", "low"} and not bool(plan.get("attachPdf"))


def _teaching_contract_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _teaching_prompt_rules(body: Mapping[str, Any], *, batch: bool) -> list[str]:
    page_rule = (
        "- Return exactly one object for each target page; each page_no must match one requested target page."
        if batch
        else "- Keep page_no exactly equal to the target page number."
    )
    empty_source_rule = (
        "- If source text is empty but the original PDF is attached, inspect that exact PDF page. "
        "If no PDF is attached, do not hallucinate; set needs_parser_fallback=true, needs_review=true, confidence<=0.35."
    )
    if _is_fast_teaching_generation(body):
        return [
            "Rules:",
            "- Return JSON only, no Markdown fences or prose outside JSON.",
            r"- Escape LaTeX backslashes in JSON strings: write \\frac, \\to, and \\cdots, not \frac, \to, or \cdots.",
            page_rule,
            "- Do not copy source text into the response; omit source unless setting source.pdf_page_ref.",
            "- Keep speaker_notes_md concise: 4-7 focused bullets or short sections, explaining rather than transcribing.",
            "- Use Markdown tables or LaTeX only when the page source clearly needs them.",
            empty_source_rule,
        ]
    return [
        "Rules:",
        "- Return JSON only, no Markdown fences or prose outside JSON.",
        r"- Escape LaTeX backslashes in JSON strings: write \\frac, \\to, and \\cdots, not \frac, \to, or \cdots.",
        page_rule,
        "- Do not copy source text into the response; omit source unless setting source.pdf_page_ref.",
        "- Keep speaker_notes_md concise and suitable for side-by-side learning; explain rather than transcribe.",
        "- Use headings, short paragraphs, bullets, Markdown tables, and LaTeX math when helpful.",
        "- Put display math delimiters $$ on their own lines; keep prose outside math delimiters when possible.",
        "- Never escape digits or binary strings in LaTeX; use 2^n, 000, and 111.",
        "- Explain formulas, symbols, tables, and intuition in speaker_notes_md when present.",
        empty_source_rule,
    ]


def _teaching_fast_output_shape(page_numbers: Sequence[int], *, batch: bool) -> str:
    if batch:
        return _teaching_contract_json({"pages": [_teaching_fast_page_output_contract("<requested_page_no>")]})
    page_no = page_numbers[0] if page_numbers else 1
    return _teaching_contract_json({"page": _teaching_fast_page_output_contract(page_no)})


def _teaching_fast_page_jsonl(page: Mapping[str, Any], source_text_limit: int) -> str:
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    page_no = _int_value(page.get("page_no"), 1)
    source_text = str(source.get("text_md") or "").strip()
    return json.dumps(
        {
            "page_no": page_no,
            "pdf_page_ref": _string_value(source.get("pdf_page_ref"), f"#page={page_no}"),
            "source_text": _truncate(source_text, source_text_limit)
            if source_text
            else "[No embedded text extracted for this page.]",
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _build_fast_teaching_generation_prompt(body: Mapping[str, Any], target_pages: list[Mapping[str, Any]]) -> str:
    output_language_code, output_language_label = _teaching_output_language(body)
    target_page_numbers = [_int_value(page.get("page_no"), index + 1) for index, page in enumerate(target_pages)]
    source_text_limit = _teaching_source_text_limit(body)
    batch = len(target_pages) > 1
    sections = [
        f"Generate concise PagePair teaching JSON for PDF page(s): {_format_page_ranges(target_page_numbers)}.",
        f"Output shape: {_teaching_fast_output_shape(target_page_numbers, batch=batch)}",
        f"Language: {output_language_label} ({output_language_code}); write all prose in this language and preserve technical tokens.",
        "Rules: JSON only; no Markdown fences; escape LaTeX backslashes as \\\\frac and \\\\to; do not copy source text; use 3-5 focused bullets/short sections.",
        "Set teaching.confidence between 0 and 1. If the page seems underspecified or notes may be incomplete, set teaching.needs_review=true and confidence<=0.55.",
        "If source_text is empty, keep notes brief; the server will mark parser fallback when needed.",
        "Pages JSONL:",
    ]
    sections.extend(_teaching_fast_page_jsonl(page, source_text_limit) for page in target_pages)
    return "\n".join(sections)


def _build_teaching_generation_prompt(body: Mapping[str, Any]) -> str:
    target_pages = _teaching_generation_pages(body)
    if _is_fast_teaching_generation(body):
        return _build_fast_teaching_generation_prompt(body, target_pages)
    if len(target_pages) > 1:
        return _build_teaching_batch_generation_prompt(body, target_pages)

    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page = target_pages[0] if target_pages else {}
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
    previous_page = body.get("previousPage") if isinstance(body.get("previousPage"), Mapping) else {}
    next_page = body.get("nextPage") if isinstance(body.get("nextPage"), Mapping) else {}
    page_no = _int_value(page.get("page_no"), 1)
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), 0))
    output_language_code, output_language_label = _teaching_output_language(body)
    source_text = str(source.get("text_md") or "").strip()
    source_text_limit = _teaching_source_text_limit(body)
    existing_notes = str(teaching.get("speaker_notes_md") or "").strip()
    quality_plan_lines = _teaching_quality_plan_lines(body)

    sections = [
        "Task-specific instructions:",
        _teaching_generator_instructions(body),
        "",
        "Generate one PagePair teaching page JSON for the given PDF page.",
        "",
        "Output shape:",
        _teaching_contract_json(_teaching_page_output_contract(page_no)),
        "",
        "Output language:",
        f"code: {output_language_code}",
        f"name: {output_language_label}",
        f"- Write every heading, paragraph, bullet, table heading, and explanatory sentence in {output_language_label}.",
        "- Do not mix Chinese and English prose unless quoting source text or preserving a technical term from the PDF.",
        "- Keep source code identifiers, Verilog keywords, signal names, module names, and formulas exactly as technical tokens.",
        "- Set teaching.output_language to the exact language code above.",
        "",
        *_teaching_prompt_rules(body, batch=False),
    ]
    if quality_plan_lines:
        sections.extend(["", "Generation quality plan:", *quality_plan_lines])
    sections.extend([
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"page_count: {page_count}",
        "",
        "Target page:",
        f"page_no: {page_no}",
        f"pdf_page_ref: {_string_value(source.get('pdf_page_ref'), f'#page={page_no}')}",
    ])
    neighbor_lines = []
    previous_title = _string_value(previous_page.get("title"), "")
    next_title = _string_value(next_page.get("title"), "")
    if previous_title:
        neighbor_lines.append(f"previous_page_title: {previous_title}")
    if next_title:
        neighbor_lines.append(f"next_page_title: {next_title}")
    if neighbor_lines:
        sections.extend(["", "Neighbor context:", *neighbor_lines])
    if existing_notes:
        sections.extend(["", "Existing notes, if regenerating:", _truncate(existing_notes, 1200)])
    sections.extend([
        "",
        "Extracted source text for this exact PDF page:",
        _truncate(source_text, source_text_limit) if source_text else "[No embedded text extracted for this page.]",
    ])
    return "\n".join(sections)


def _build_teaching_batch_generation_prompt(body: Mapping[str, Any], target_pages: list[Mapping[str, Any]]) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), 0))
    output_language_code, output_language_label = _teaching_output_language(body)
    target_page_numbers = [_int_value(page.get("page_no"), index + 1) for index, page in enumerate(target_pages)]
    quality_plan_lines = _teaching_quality_plan_lines(body)
    source_text_limit = _teaching_source_text_limit(body)
    sections = [
        "Task-specific instructions:",
        _teaching_generator_instructions(body),
        "",
        f"Generate PagePair teaching page JSON for {len(target_pages)} PDF pages in one batch.",
        "Return one page object for every target page. Do not skip pages. Do not merge pages.",
        f"Target page numbers: {_format_page_ranges(target_page_numbers)}",
        "",
        "Output shape; repeat the single page object once per target page:",
        _teaching_contract_json({"pages": [_teaching_page_output_contract("<target_page_no>")]}),
        "",
        "Output language:",
        f"code: {output_language_code}",
        f"name: {output_language_label}",
        f"- Write every heading, paragraph, bullet, table heading, and explanatory sentence in {output_language_label}.",
        "- Set every teaching.output_language to the exact language code above.",
        "",
        *_teaching_prompt_rules(body, batch=True),
    ]
    if quality_plan_lines:
        sections.extend(["", "Generation quality plan:", *quality_plan_lines])
    sections.extend([
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"page_count: {page_count}",
        "",
        "Target pages:",
    ])
    for page in target_pages:
        source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
        teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
        page_no = _int_value(page.get("page_no"), 1)
        source_text = str(source.get("text_md") or "").strip()
        existing_notes = str(teaching.get("speaker_notes_md") or "").strip()
        sections.extend(
            [
                "",
                f"--- Target page {page_no} ---",
                f"page_no: {page_no}",
                f"pdf_page_ref: {_string_value(source.get('pdf_page_ref'), f'#page={page_no}')}",
            ]
        )
        if existing_notes:
            sections.extend(["existing_notes:", _truncate(existing_notes, 1000)])
        sections.extend([
            "source_text:",
            _truncate(source_text, source_text_limit) if source_text else "[No embedded text extracted for this page.]",
        ])
    return "\n".join(sections)


def _build_document_cache_prefix(body: Mapping[str, Any]) -> str:
    context = _normalized_document_cache_context(body)
    if not context["pages"]:
        return ""
    chunks = [
        "PAGEPAIR CACHEABLE DOCUMENT CONTEXT",
        f"cache_version: {context['cacheVersion']}",
        "This section is intentionally identical for repeated requests for this PDF so prompt caching can reuse it.",
        "Use this compact document context to understand course structure, symbols, terminology, and cross-page dependencies.",
        "When answering a question or explaining a target page, prioritize the user's current request and selected source, but use this document context for prerequisites and continuity.",
        "",
        f"document_id: {context['documentId']}",
        f"document_title: {context['documentTitle']}",
        f"page_count: {context['pageCount']}",
        f"truncated_context: {'yes' if context['truncated'] else 'no'}",
        f"included_original_pdf_pages: {_format_page_ranges(context['includedPageNumbers']) or 'none'}",
        "",
        "FULL PDF TEXT CONTEXT BY ORIGINAL PAGE NUMBER:",
    ]
    for item in context["pages"]:
        chunks.append(f"\n[p.{item['page_no']}] {item['title']}\n{item['text_md']}")
    return _truncate("\n".join(chunks), MAX_TEACHING_CACHE_CHARS)


def _cacheable_document_context(body: Mapping[str, Any]) -> Mapping[str, Any]:
    document_context = body.get("documentContext")
    if isinstance(document_context, Mapping):
        return document_context
    pdf_context = body.get("pdfContext")
    if isinstance(pdf_context, Mapping):
        return pdf_context
    return {}


def _normalized_document_cache_context(body: Mapping[str, Any]) -> dict[str, Any]:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    context = _cacheable_document_context(body)
    pages = context.get("pages")
    raw_pages = pages if isinstance(pages, list) else []
    page_count = _int_value(context.get("pageCount") or document.get("page_count"), len(raw_pages))
    full_page_limit = _int_value(context.get("fullPageLimit"), page_count or PDF_CONTEXT_FULL_PAGE_LIMIT)
    edge_page_count = _int_value(context.get("edgePageCount"), page_count or PDF_CONTEXT_EDGE_PAGE_COUNT)
    included_pages = _pdf_included_page_numbers(context, page_count, full_page_limit, edge_page_count)
    allowed_pages = set(included_pages)
    explicit_truncated = context.get("truncated")
    truncated = bool(explicit_truncated) if explicit_truncated is not None else len(included_pages) < page_count
    normalized_pages: list[dict[str, Any]] = []
    for item in raw_pages:
        if not isinstance(item, Mapping):
            continue
        page_no = _int_value(item.get("page_no"), 0)
        if page_no <= 0 or page_no not in allowed_pages:
            continue
        normalized_pages.append(
            {
                "page_no": page_no,
                "title": _string_value(item.get("title"), f"PDF p.{page_no}"),
                "text_md": str(item.get("text_md") or "").strip() or "[No embedded text extracted for this page.]",
            }
        )
    normalized_pages.sort(key=lambda item: item["page_no"])
    return {
        "cacheVersion": DOCUMENT_CACHE_PREFIX_VERSION,
        "documentId": _string_value(document.get("id") or context.get("documentId"), "unknown"),
        "documentTitle": _string_value(document.get("title") or context.get("documentTitle"), "Untitled PDF"),
        "pageCount": page_count,
        "fullPageLimit": full_page_limit,
        "edgePageCount": edge_page_count,
        "truncated": truncated,
        "includedPageNumbers": included_pages,
        "pages": normalized_pages,
    }


def _pdf_file_input(value: Any, *, page_numbers: Sequence[int] | None = None) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    file_data = str(value.get("fileData") or value.get("file_data") or "").strip()
    sha256 = _string_value(value.get("sha256"), "")
    if not file_data and sha256:
        cached = _cached_pdf_file_payload(sha256)
        if cached:
            value = {**cached, **value}
            file_data = str(cached.get("fileData") or "").strip()
    if not file_data:
        return None
    if file_data.startswith("data:") and "," in file_data:
        file_data = file_data.split(",", 1)[1].strip()
    if not file_data or len(file_data) > MAX_PDF_FILE_DATA_CHARS:
        return None
    filename = _string_value(value.get("filename") or value.get("fileName"), "document.pdf")
    if not filename.lower().endswith(".pdf"):
        filename = f"{filename}.pdf"
    if page_numbers:
        file_data = _cached_or_subset_pdf_file_data(file_data, page_numbers, sha256=sha256) or file_data
    return {
        "type": "input_file",
        "filename": filename,
        "file_data": file_data,
    }


def _cache_pdf_file_payload(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise HttpError(400, "PDF cache request did not include a document file", code="invalid_pdf_cache")
    file_data = str(value.get("fileData") or value.get("file_data") or "").strip()
    if file_data.startswith("data:") and "," in file_data:
        file_data = file_data.split(",", 1)[1].strip()
    if not file_data or len(file_data) > MAX_PDF_FILE_DATA_CHARS:
        raise HttpError(400, "PDF cache request did not include usable PDF data", code="invalid_pdf_cache")
    try:
        pdf_bytes = base64.b64decode(file_data, validate=False)
    except Exception as exc:
        raise HttpError(400, "PDF cache request contained invalid base64 data", code="invalid_pdf_cache") from exc
    if not pdf_bytes:
        raise HttpError(400, "PDF cache request contained an empty PDF", code="invalid_pdf_cache")

    sha256 = _string_value(value.get("sha256"), "") or hashlib.sha256(pdf_bytes).hexdigest()
    filename = _string_value(value.get("filename") or value.get("fileName"), "document.pdf")
    if not filename.lower().endswith(".pdf"):
        filename = f"{filename}.pdf"
    record = {
        "filename": filename,
        "mimeType": _string_value(value.get("mimeType"), "application/pdf"),
        "size": len(pdf_bytes),
        "sha256": sha256,
        "fileData": file_data,
    }
    _store_cached_pdf_file_payload(record)
    return {key: record[key] for key in ("filename", "mimeType", "size", "sha256")}


def _store_cached_pdf_file_payload(record: Mapping[str, Any]) -> None:
    global _PDF_FILE_CACHE_BYTES
    sha256 = _string_value(record.get("sha256"), "")
    size = _int_value(record.get("size"), 0)
    if not sha256 or size <= 0:
        return
    with _PDF_FILE_CACHE_LOCK:
        previous = _PDF_FILE_CACHE.pop(sha256, None)
        if previous:
            _PDF_FILE_CACHE_BYTES -= _int_value(previous.get("size"), 0)
        _PDF_FILE_CACHE[sha256] = dict(record)
        _PDF_FILE_CACHE_BYTES += size
        while (
            len(_PDF_FILE_CACHE) > PDF_FILE_CACHE_MAX_ENTRIES
            or _PDF_FILE_CACHE_BYTES > PDF_FILE_CACHE_MAX_BYTES
        ) and _PDF_FILE_CACHE:
            _key, evicted = _PDF_FILE_CACHE.popitem(last=False)
            _PDF_FILE_CACHE_BYTES -= _int_value(evicted.get("size"), 0)


def _cached_pdf_file_payload(sha256: str) -> dict[str, Any] | None:
    if not sha256:
        return None
    with _PDF_FILE_CACHE_LOCK:
        cached = _PDF_FILE_CACHE.pop(sha256, None)
        if not cached:
            return None
        _PDF_FILE_CACHE[sha256] = cached
        return dict(cached)


def _normalized_pdf_subset_page_numbers(page_numbers: Sequence[int]) -> list[int]:
    requested_pages: list[int] = []
    seen: set[int] = set()
    for value in page_numbers:
        page_no = _int_value(value, 0)
        if page_no > 0 and page_no not in seen:
            seen.add(page_no)
            requested_pages.append(page_no)
    return requested_pages


def _pdf_subset_cache_key(sha256: str, page_numbers: Sequence[int]) -> str:
    return f"{sha256}:{','.join(str(page_no) for page_no in page_numbers)}"


def _cached_or_subset_pdf_file_data(file_data: str, page_numbers: Sequence[int], *, sha256: str = "") -> str | None:
    requested_pages = _normalized_pdf_subset_page_numbers(page_numbers)
    if not requested_pages:
        return None
    cache_key = _pdf_subset_cache_key(sha256, requested_pages) if sha256 else ""
    if cache_key:
        cached = _cached_pdf_subset_file_data(cache_key)
        if cached:
            return cached
    subset = _subset_pdf_file_data(file_data, requested_pages)
    if subset and cache_key:
        _store_cached_pdf_subset_file_data(cache_key, subset)
    return subset


def _cached_pdf_subset_file_data(cache_key: str) -> str | None:
    if not cache_key:
        return None
    with _PDF_FILE_SUBSET_CACHE_LOCK:
        cached = _PDF_FILE_SUBSET_CACHE.pop(cache_key, None)
        if not cached:
            return None
        _PDF_FILE_SUBSET_CACHE[cache_key] = cached
        return str(cached.get("fileData") or "") or None


def _store_cached_pdf_subset_file_data(cache_key: str, file_data: str) -> None:
    global _PDF_FILE_SUBSET_CACHE_BYTES
    if not cache_key or not file_data:
        return
    size = len(file_data)
    with _PDF_FILE_SUBSET_CACHE_LOCK:
        previous = _PDF_FILE_SUBSET_CACHE.pop(cache_key, None)
        if previous:
            _PDF_FILE_SUBSET_CACHE_BYTES -= _int_value(previous.get("size"), 0)
        _PDF_FILE_SUBSET_CACHE[cache_key] = {"fileData": file_data, "size": size}
        _PDF_FILE_SUBSET_CACHE_BYTES += size
        while (
            len(_PDF_FILE_SUBSET_CACHE) > PDF_FILE_SUBSET_CACHE_MAX_ENTRIES
            or _PDF_FILE_SUBSET_CACHE_BYTES > PDF_FILE_SUBSET_CACHE_MAX_BYTES
        ) and _PDF_FILE_SUBSET_CACHE:
            _key, evicted = _PDF_FILE_SUBSET_CACHE.popitem(last=False)
            _PDF_FILE_SUBSET_CACHE_BYTES -= _int_value(evicted.get("size"), 0)


def _subset_pdf_file_data(file_data: str, page_numbers: Sequence[int]) -> str | None:
    requested_pages = _normalized_pdf_subset_page_numbers(page_numbers)
    if not requested_pages:
        return None
    try:
        from PyPDF2 import PdfReader, PdfWriter  # type: ignore[import-untyped]

        source_bytes = base64.b64decode(file_data, validate=False)
        reader = PdfReader(io.BytesIO(source_bytes))
        total_pages = len(reader.pages)
        page_indexes = [page_no - 1 for page_no in requested_pages if 1 <= page_no <= total_pages]
        if not page_indexes or len(page_indexes) >= total_pages:
            return None
        writer = PdfWriter()
        for page_index in page_indexes:
            writer.add_page(reader.pages[page_index])
        output = io.BytesIO()
        writer.write(output)
        return base64.b64encode(output.getvalue()).decode("ascii")
    except Exception:
        return None


def _apply_prompt_cache_fields(payload: dict[str, Any], body: Mapping[str, Any], model: str) -> None:
    if not _supports_prompt_cache(model):
        return
    cache_key = _prompt_cache_key(body)
    if cache_key:
        payload["prompt_cache_key"] = cache_key
        payload["prompt_cache_retention"] = "24h"


def _supports_prompt_cache(model: str) -> bool:
    return model.startswith("gpt-5.5")


def _should_retry_without_prompt_cache(exc: HttpError, payload: Mapping[str, Any]) -> bool:
    return exc.status in {400, 422} and bool(
        payload.get("prompt_cache_key") or payload.get("prompt_cache_retention")
    )


def _should_retry_transient_upstream_error(exc: HttpError) -> bool:
    return exc.code == "network_error" or exc.status in {429, 500, 502, 503, 504}


def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        seconds = float(text)
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(text)
        except (TypeError, ValueError, IndexError, OverflowError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=datetime.timezone.utc)
        seconds = retry_at.timestamp() - datetime.datetime.now(datetime.timezone.utc).timestamp()
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return seconds


def _transient_retry_delay_seconds(exc: HttpError, attempt: int) -> float:
    base_delay = TEACHING_RETRY_DELAYS_SECONDS[min(max(attempt, 0), len(TEACHING_RETRY_DELAYS_SECONDS) - 1)]
    if exc.retry_after_seconds is not None:
        base_delay = max(base_delay, exc.retry_after_seconds)
    base_delay = min(base_delay, TEACHING_MAX_RETRY_DELAY_SECONDS)
    jitter = random.uniform(0, min(base_delay * 0.2, 0.75))
    return min(base_delay + jitter, TEACHING_MAX_RETRY_DELAY_SECONDS)


def _should_try_next_teaching_generation_candidate(exc: HttpError, *, document_file_used: bool) -> bool:
    if exc.status in {400, 404, 413, 415, 422}:
        return True
    return document_file_used and exc.status in {500, 502}


def _without_prompt_cache(payload: Mapping[str, Any]) -> dict[str, Any]:
    fallback_payload = dict(payload)
    fallback_payload.pop("prompt_cache_key", None)
    fallback_payload.pop("prompt_cache_retention", None)
    return fallback_payload


def _prompt_cache_metadata(
    payload: Mapping[str, Any],
    *,
    response_text: str | None = None,
    content_type: str = "",
) -> dict[str, Any]:
    prefix = _payload_document_cache_prefix(payload)
    metadata: dict[str, Any] = {
        "prompt_cache_key": payload.get("prompt_cache_key"),
        "prompt_cache_retention": payload.get("prompt_cache_retention"),
        "prefix_hash": _sha256_text(prefix)[:24] if prefix else None,
        "prefix_chars": len(prefix),
        "fallback_without_cache": bool(payload.get("_pagepair_cache_fallback_without_fields")),
    }
    if response_text is not None:
        usage = _extract_prompt_cache_usage(response_text, content_type)
        if usage:
            metadata["usage"] = usage
    return metadata


def _payload_document_cache_prefix(payload: Mapping[str, Any]) -> str:
    input_value = payload.get("input")
    if not isinstance(input_value, list) or not input_value:
        return ""
    first = input_value[0]
    if not isinstance(first, Mapping):
        return ""
    content = first.get("content")
    if not isinstance(content, list) or not content:
        return ""
    first_part = content[0]
    if not isinstance(first_part, Mapping) or first_part.get("type") != "input_text":
        return ""
    text = str(first_part.get("text") or "")
    return text if text.startswith("PAGEPAIR CACHEABLE DOCUMENT CONTEXT") else ""


def _prompt_cache_key(body: Mapping[str, Any]) -> str:
    context = _normalized_document_cache_context(body)
    document_file = body.get("documentFile") if isinstance(body.get("documentFile"), Mapping) else {}
    if not context["pages"] and not document_file:
        return ""
    document_id = _cache_key_part(_string_value(context.get("documentId"), "document"))
    stable_context = {
        "promptCacheVersion": PROMPT_CACHE_VERSION,
        "documentFileSha256": _string_value(document_file.get("sha256"), ""),
        "documentContext": context,
    }
    serialized = json.dumps(stable_context, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = _sha256_text(serialized)
    return f"pagepair:{document_id}:{_cache_key_part(digest)[:32]}"


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _cache_key_part(value: str) -> str:
    cleaned = "".join(
        character
        if character.isascii() and (character.isalnum() or character in {"-", "_"})
        else "_"
        for character in value
    )
    return cleaned[:48] or "unknown"


def _teaching_page_output_contract(page_no: Any) -> dict[str, Any]:
    return {
        "page_no": page_no,
        "teaching": {
            "output_language": "zh-CN|en-US",
            "slide_title": "short page title",
            "speaker_notes_md": "Markdown teaching notes with LaTeX and Markdown tables when useful",
            "confidence": 0.82,
            "needs_review": False,
            "needs_parser_fallback": False,
        },
    }


def _teaching_fast_page_output_contract(page_no: Any) -> dict[str, Any]:
    return {
        "page_no": page_no,
        "teaching": {
            "slide_title": "short page title",
            "speaker_notes_md": "concise Markdown teaching notes",
            "confidence": 0.72,
            "needs_review": False,
        },
    }


def _parse_generated_page(content: str, body: Mapping[str, Any]) -> dict[str, Any]:
    value = _json_from_model_text(content)
    page_input = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    candidate = _first_generated_page_candidate(value)
    if not isinstance(candidate, Mapping):
        raise HttpError(502, "Generation response did not contain a page JSON object", code="invalid_generation_json")
    return _normalize_generated_page_candidate(candidate, page_input, body)


def _parse_generated_pages(content: str, body: Mapping[str, Any]) -> list[dict[str, Any]]:
    value = _json_from_model_text(content)
    page_inputs = _teaching_generation_pages(body)
    if not page_inputs:
        raise HttpError(502, "Generation request did not contain target pages", code="invalid_generation_json")
    candidates = _generated_page_candidates(value)
    if not candidates:
        raise HttpError(502, "Generation response did not contain page JSON objects", code="invalid_generation_json")

    candidates_by_page_no: dict[int, Mapping[str, Any]] = {}
    for candidate in candidates:
        page_no = _int_value(candidate.get("page_no"), 0)
        if page_no > 0:
            candidates_by_page_no[page_no] = candidate

    pages: list[dict[str, Any]] = []
    for index, page_input in enumerate(page_inputs):
        page_no = _int_value(page_input.get("page_no"), index + 1)
        candidate = candidates_by_page_no.get(page_no)
        if candidate is None and index < len(candidates):
            candidate = candidates[index]
        if candidate is None:
            raise HttpError(502, f"Generation response did not contain page {page_no}", code="invalid_generation_json")
        pages.append(_normalize_generated_page_candidate(candidate, page_input, body))
    return pages


def _first_generated_page_candidate(value: Any) -> Mapping[str, Any] | None:
    candidates = _generated_page_candidates(value)
    return candidates[0] if candidates else None


def _generated_page_candidates(value: Any) -> list[Mapping[str, Any]]:
    if isinstance(value, Mapping) and isinstance(value.get("page"), Mapping):
        return [value["page"]]
    if isinstance(value, Mapping) and isinstance(value.get("pages"), list):
        return [candidate for candidate in value["pages"] if isinstance(candidate, Mapping)]
    if isinstance(value, list):
        return [candidate for candidate in value if isinstance(candidate, Mapping)]
    return [value] if isinstance(value, Mapping) else []


def _normalize_generated_page_candidate(
    candidate: Mapping[str, Any],
    page_input: Mapping[str, Any],
    body: Mapping[str, Any],
) -> dict[str, Any]:
    source_input = page_input.get("source") if isinstance(page_input.get("source"), Mapping) else {}
    page_no = _int_value(page_input.get("page_no"), 1)
    output_language_code, _output_language_label = _teaching_output_language(body)

    source = candidate.get("source") if isinstance(candidate.get("source"), Mapping) else {}
    teaching = candidate.get("teaching") if isinstance(candidate.get("teaching"), Mapping) else {}
    source_text = str(source.get("text_md") or source_input.get("text_md") or "").strip()
    has_pdf_file = bool(_pdf_file_input(body.get("documentFile")))
    no_source_available = not source_text and not has_pdf_file
    needs_fallback = bool(teaching.get("needs_parser_fallback")) or no_source_available
    fast_generation = _is_fast_teaching_generation(body)
    confidence_missing = teaching.get("confidence") is None
    needs_review = bool(teaching.get("needs_review")) or needs_fallback or (fast_generation and confidence_missing)
    default_confidence = 0.56 if fast_generation else 0.78
    confidence = _float_value(teaching.get("confidence"), 0.28 if no_source_available else default_confidence)
    if needs_fallback:
        confidence = min(confidence, 0.35)

    notes = str(teaching.get("speaker_notes_md") or "").strip()
    if no_source_available and not notes:
        if output_language_code == "en-US":
            notes = (
                "## This page cannot be explained reliably yet\n\n"
                "This page has no extractable PDF text layer. PagePair will not invent content; add OCR or page text, then regenerate."
            )
        else:
            notes = (
                "## 当前页暂无法生成可靠讲解\n\n"
                "这一页没有可提取的 PDF 文本层。本轮不会编造内容；请后续接入 OCR 或手动补充页面文本后再重新生成。"
            )
    notes = _normalize_markdown_math(notes)

    evidence = teaching.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        evidence = [{
            "kind": "other",
            "quote_or_reference": (
                "PDF.js extracted page text"
                if source_text
                else "Original PDF file input"
                if has_pdf_file
                else "No embedded text layer"
            ),
        }]

    return {
        "page_no": page_no,
        "source": {
            "pdf_page_ref": _string_value(source.get("pdf_page_ref") or source_input.get("pdf_page_ref"), f"#page={page_no}"),
            "text_md": source_text,
            "ocr_used": bool(source.get("ocr_used") or source_input.get("ocr_used") or False),
            "parser": _string_value(source.get("parser") or source_input.get("parser"), "pdfjs"),
            "page_type": _page_type_value(source.get("page_type")),
        },
        "teaching": {
            "output_language": output_language_code,
            "slide_title": _string_value(teaching.get("slide_title"), f"PDF p.{page_no}"),
            "speaker_notes_md": notes,
            "concepts": _string_list(teaching.get("concepts")),
            "prerequisites": _string_list(teaching.get("prerequisites")),
            "contextual_bridge": _string_value(teaching.get("contextual_bridge"), ""),
            "visual_explanations": _string_list(teaching.get("visual_explanations")),
            "formula_explanations": _string_list(teaching.get("formula_explanations")),
            "evidence": _evidence_list(evidence),
            "confidence": max(0.0, min(confidence, 1.0)),
            "needs_review": needs_review,
            "needs_parser_fallback": needs_fallback,
        },
        "status": "needs_review" if needs_review else "ready",
    }


def _json_from_model_text(content: str) -> Any:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        return _json_loads_with_latex_repair(text)
    except json.JSONDecodeError:
        start_candidates = [index for index in (text.find("{"), text.find("[")) if index >= 0]
        if not start_candidates:
            raise HttpError(502, "Generation response was not valid JSON", code="invalid_generation_json")
        start = min(start_candidates)
        end = max(text.rfind("}"), text.rfind("]"))
        if end <= start:
            raise HttpError(502, "Generation response was not valid JSON", code="invalid_generation_json")
        try:
            return _json_loads_with_latex_repair(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise HttpError(502, f"Generation response was not valid JSON: {exc}", code="invalid_generation_json") from exc


def _json_loads_with_latex_repair(text: str) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        repaired = _repair_json_string_backslashes(text)
        if repaired == text:
            raise
        return json.loads(repaired)


def _repair_json_string_backslashes(text: str) -> str:
    output: list[str] = []
    in_string = False
    index = 0
    while index < len(text):
        char = text[index]
        if not in_string:
            output.append(char)
            if char == '"':
                in_string = True
            index += 1
            continue

        if char == '"':
            output.append(char)
            in_string = False
            index += 1
            continue

        if char != "\\":
            output.append(char)
            index += 1
            continue

        if index + 1 >= len(text):
            output.append("\\\\")
            index += 1
            continue

        next_char = text[index + 1]
        if next_char in {'"', "\\", "/"}:
            output.append(text[index : index + 2])
            index += 2
            continue
        if next_char == "u" and _is_json_unicode_escape(text[index + 2 : index + 6]):
            output.append(text[index : index + 6])
            index += 6
            continue
        if _looks_like_latex_command(text, index):
            output.append("\\\\")
            index += 1
            continue
        if next_char in {"b", "f", "n", "r", "t"}:
            output.append(text[index : index + 2])
            index += 2
            continue

        output.append("\\\\")
        index += 1
    return "".join(output)


def _is_json_unicode_escape(value: str) -> bool:
    return len(value) == 4 and all(char in "0123456789abcdefABCDEF" for char in value)


def _looks_like_latex_command(text: str, slash_index: int) -> bool:
    command_start = slash_index + 1
    command_end = command_start
    while command_end < len(text) and text[command_end].isalpha():
        command_end += 1
    if command_end == command_start:
        return False
    command = text[command_start:command_end]
    return command in _LATEX_COMMANDS_REQUIRING_JSON_ESCAPE


_LATEX_COMMANDS_REQUIRING_JSON_ESCAPE = {
    "Gamma",
    "Delta",
    "Theta",
    "Lambda",
    "Xi",
    "Pi",
    "Sigma",
    "Upsilon",
    "Phi",
    "Psi",
    "Omega",
    "Leftarrow",
    "Rightarrow",
    "Leftrightarrow",
    "alpha",
    "approx",
    "arg",
    "bar",
    "begin",
    "beta",
    "bmod",
    "bmatrix",
    "binom",
    "cap",
    "cases",
    "cdot",
    "cdots",
    "chi",
    "choose",
    "cos",
    "cup",
    "delta",
    "dfrac",
    "div",
    "dot",
    "dots",
    "ddot",
    "end",
    "epsilon",
    "equiv",
    "eta",
    "exists",
    "exp",
    "forall",
    "frac",
    "gamma",
    "ge",
    "geq",
    "hat",
    "in",
    "infty",
    "int",
    "iota",
    "kappa",
    "lambda",
    "land",
    "ldots",
    "le",
    "left",
    "leftarrow",
    "leftrightarrow",
    "leq",
    "lim",
    "ln",
    "log",
    "lor",
    "mapsto",
    "mathrm",
    "mathbf",
    "mathit",
    "matrix",
    "max",
    "min",
    "mod",
    "mp",
    "mu",
    "nabla",
    "neg",
    "neq",
    "notin",
    "nu",
    "omega",
    "operatorname",
    "overline",
    "phi",
    "pi",
    "pm",
    "pmatrix",
    "pmod",
    "prod",
    "psi",
    "qquad",
    "quad",
    "rho",
    "right",
    "rightarrow",
    "sigma",
    "sin",
    "sqrt",
    "subset",
    "subseteq",
    "sum",
    "supset",
    "supseteq",
    "tan",
    "tau",
    "text",
    "tfrac",
    "theta",
    "tilde",
    "times",
    "to",
    "underline",
    "upsilon",
    "varepsilon",
    "varphi",
    "varpi",
    "varrho",
    "varsigma",
    "vartheta",
    "vec",
    "xi",
    "zeta",
}


def _normalize_markdown_math(value: str) -> str:
    if not value:
        return value
    segments = re.split(r"(```[\s\S]*?```)", value)
    return "".join(segment if segment.startswith("```") else _normalize_markdown_math_segment(segment) for segment in segments)


def _normalize_markdown_math_segment(value: str) -> str:
    value = _repair_binary_transition_math_spillover(value)
    return re.sub(r"(\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$])*\$)", _normalize_math_match, value)


def _repair_binary_transition_math_spillover(value: str) -> str:
    return re.sub(
        r"\$((?:[01]{2,}|\\cdots)(?:\s*(?:\\to|\\rightarrow|→)\s*(?:[01]{2,}|\\cdots))+)(\s*)([。；，、](?=[\u3400-\u9fff]))",
        lambda match: f"${match.group(1)}${match.group(2)}{match.group(3)}",
        value,
    )


def _normalize_math_match(match: re.Match[str]) -> str:
    segment = match.group(0)
    delimiter = "$$" if segment.startswith("$$") else "$"
    if not segment.endswith(delimiter):
        return segment
    body = segment[len(delimiter) : -len(delimiter)]
    return f"{delimiter}{_normalize_katex_body(body)}{delimiter}"


def _normalize_katex_body(value: str) -> str:
    normalized = re.sub(r"\\(?=\d)", "", value)
    if not re.search(r"\\(?:text|mathrm|operatorname)\s*\{", normalized):
        normalized = re.sub(r"([\u3400-\u9fff，。、；：！？、]+)", r"\\text{\1}", normalized)
    return normalized


def _agent_answer_mode_prompt(mode: str) -> str:
    if mode == "detailed":
        return "\n".join(
            [
                "Mode: detailed",
                "Reasoning effort: xhigh",
                "Response style:",
                "- Give a complete, page-grounded explanation with clear sections.",
                "- Start with a short direct answer, then explain prerequisites, symbols, formulas, code, tables, and edge cases when relevant.",
                "- Use the attached PDF and cacheable document context for cross-page continuity; cite original PDF page numbers when available.",
                "- Include examples or derivations when they help study the material.",
                "- End with a compact takeaway.",
            ]
        )
    if mode == "guided":
        return "\n".join(
            [
                "Mode: guided",
                "Reasoning effort: high",
                "Response style:",
                "- Start with the answer, then teach the path to it step by step.",
                "- Connect the selected material to the current PDF page and nearby document context.",
                "- Surface common mistakes, key assumptions, or one check-your-understanding point when useful.",
                "- Keep the structure clear and cite original PDF page numbers when available.",
            ]
        )
    return "\n".join(
        [
            "Mode: concise",
            "Reasoning effort: medium",
            "Response style:",
            "- Answer directly in a compact form.",
            "- Use only the necessary explanation, formulas, or code snippets.",
            "- Prefer 3-6 bullets or short paragraphs unless the user explicitly asks for more detail.",
            "- Cite original PDF page numbers when available.",
        ]
    )


def _build_agent_interaction_prompt(body: Mapping[str, Any]) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    messages = _transcript_messages(body.get("messages"))
    selected_context_value = body.get("selectedContext")
    selected_context = _selected_context(selected_context_value)
    contexts = [*_context_items(body.get("context")), *_context_parts(body.get("parts"))]
    raw_input = str(body.get("input") or "").strip() or _text_from_parts(body.get("parts"))
    input_text = _build_user_request(raw_input, selected_context_value, body.get("pdfContext"))
    answer_mode = _agent_answer_mode(body)

    sections = [
        "# Task-specific instructions",
        AGENT_INSTRUCTIONS,
        "# User request",
        input_text or "Continue from the provided context.",
        "# Answer mode",
        _agent_answer_mode_prompt(answer_mode),
        "# Document",
        f"Title: {_string_value(document.get('title'), 'Untitled')}",
        f"Document ID: {_string_value(document.get('id'), 'unknown')}",
    ]
    if _pdf_file_input(body.get("documentFile")):
        sections.extend([
            "Original PDF file:",
            "The original PDF is attached as an input_file. Use it as primary source evidence; use the page-text context below as a cacheable index for page numbers, truncation policy, and extracted snippets.",
        ])
    sections.extend(
        [
            "# Current page",
            f"Page: {_string_value(page.get('page_no'), 'unknown')}",
            f"Title: {_string_value(teaching.get('slide_title'), 'Untitled page')}",
        ]
    )
    if source.get("text_md"):
        sections.extend(["Source text:", _truncate(str(source.get("text_md")), MAX_CONTEXT_CHARS)])
    if teaching.get("speaker_notes_md"):
        sections.extend(["Existing notes:", _truncate(str(teaching.get("speaker_notes_md")), MAX_CONTEXT_CHARS)])
    if selected_context:
        sections.extend(
            [
                "# User selected source material",
                "The user selected this source from the current workspace. Prioritize it when answering, quote it carefully, and say when the selected source is insufficient.",
                selected_context,
            ]
        )
    if messages:
        sections.extend(["# Recent conversation", *messages])
    if contexts:
        sections.extend(["# Additional context", *contexts])
    return "\n\n".join(section for section in sections if section)


def _build_user_request(input_text: str, selected_context: Any, pdf_context: Any = None) -> str:
    cleaned_input = _truncate(input_text.strip(), MAX_CONTEXT_CHARS)
    selected_text = _selected_context_text(selected_context)
    if not selected_text:
        return cleaned_input
    normalized_input = cleaned_input.lstrip().lower()
    if normalized_input.startswith("selected source:") or normalized_input.startswith("selected text:"):
        return cleaned_input
    user_question = cleaned_input or "Please answer using the selected text."
    source_lines = _selected_source_lines(selected_context, pdf_context)
    sections = [
        "Selected source:",
        *source_lines,
        "Selected explanation text:" if _selected_context_source_type(selected_context) == "generated-explanation" else "Selected text:",
        selected_text,
    ]
    pdf_source_text = _selected_pdf_source_text(selected_context)
    if pdf_source_text:
        sections.extend(["Corresponding original PDF page text:", pdf_source_text])
    sections.extend(["User question:", user_question])
    return "\n\n".join(sections)


def _selected_source_lines(selected_context: Any, pdf_context: Any) -> list[str]:
    if not isinstance(selected_context, Mapping):
        return []
    source_type = _selected_context_source_type(selected_context)
    generated_page_no = _int_value(selected_context.get("generatedPageNumber"), 0)
    pdf_source = selected_context.get("pdfSource") if isinstance(selected_context.get("pdfSource"), Mapping) else {}
    pdf_source_page_no = _int_value(pdf_source.get("pageNumber") if isinstance(pdf_source, Mapping) else None, 0)
    page_no = _int_value(
        selected_context.get("pdfPageNumber")
        or pdf_source_page_no
        or selected_context.get("generatedPageNumber")
        or selected_context.get("pageNumber"),
        0,
    )
    lines: list[str] = []
    if source_type == "generated-explanation" and generated_page_no:
        lines.append(f"Selected explanation page: {generated_page_no}")
    if page_no:
        lines.append(f"Corresponding original PDF page: {page_no}" if source_type == "generated-explanation" else f"PDF page: {page_no}")
    section = _string_value(selected_context.get("sectionTitle"), "")
    if section:
        lines.append(f"Source: {section}")
    if isinstance(pdf_source, Mapping):
        title = _string_value(pdf_source.get("title"), "")
        ref = _string_value(pdf_source.get("ref"), "")
        if title:
            lines.append(f"PDF page title: {title}")
        if ref:
            lines.append(f"PDF page reference: {ref}")
    if not isinstance(pdf_context, Mapping):
        return lines

    page_count = _int_value(pdf_context.get("pageCount"), 0)
    full_page_limit = _int_value(pdf_context.get("fullPageLimit"), PDF_CONTEXT_FULL_PAGE_LIMIT)
    edge_page_count = _int_value(pdf_context.get("edgePageCount"), PDF_CONTEXT_EDGE_PAGE_COUNT)
    included_pages = _pdf_included_page_numbers(pdf_context, page_count, full_page_limit, edge_page_count)
    explicit_truncated = pdf_context.get("truncated")
    truncated = bool(explicit_truncated) if explicit_truncated is not None else (len(included_pages) < page_count if page_count else False)
    if truncated:
        included = _format_page_ranges(included_pages)
        lines.append(
            f"PDF context is truncated: original PDF has {page_count} pages, configured full-context limit is {full_page_limit} pages, and the model received pages {included or 'none'} ({edge_page_count} pages from each edge)."
        )
        if page_no:
            if page_no in set(included_pages):
                lines.append(f"The selected text is on PDF page {page_no}, which is included in the truncated PDF context.")
            else:
                lines.append(
                    f"The selected text is on PDF page {page_no}, which is outside the truncated PDF context; use the selected text as the exact evidence for that page."
                )
    return lines


def _selected_context_text(value: Any) -> str:
    if not isinstance(value, Mapping):
        return ""
    return _truncate(str(value.get("text") or "").strip(), MAX_CONTEXT_CHARS)


def _selected_context_source_type(value: Any) -> str:
    if not isinstance(value, Mapping):
        return "unknown"
    return _string_value(value.get("sourceType"), "unknown")


def _selected_pdf_source_text(value: Any) -> str:
    if not isinstance(value, Mapping):
        return ""
    pdf_source = value.get("pdfSource")
    if not isinstance(pdf_source, Mapping):
        return ""
    return _truncate(str(pdf_source.get("text") or "").strip(), MAX_CONTEXT_CHARS)


def _pdf_document_context(value: Any) -> str:
    if not isinstance(value, Mapping):
        return ""
    pages = value.get("pages")
    if not isinstance(pages, list):
        return ""

    page_count = _int_value(value.get("pageCount"), len(pages))
    full_page_limit = _int_value(value.get("fullPageLimit"), PDF_CONTEXT_FULL_PAGE_LIMIT)
    edge_page_count = _int_value(value.get("edgePageCount"), PDF_CONTEXT_EDGE_PAGE_COUNT)
    included_pages = _pdf_included_page_numbers(value, page_count, full_page_limit, edge_page_count)
    allowed_pages = set(included_pages)
    explicit_truncated = value.get("truncated")
    truncated = bool(explicit_truncated) if explicit_truncated is not None else len(included_pages) < page_count
    policy = f"first {edge_page_count} and last {edge_page_count} pages" if truncated else "all pages"

    chunks = [
        f"Document title: {_string_value(value.get('documentTitle'), 'Untitled')}",
        f"Page count: {page_count}",
        f"Full-context page limit: {full_page_limit}",
        f"Edge pages per side when truncated: {edge_page_count}",
        f"Truncated PDF context: {'yes' if truncated else 'no'}",
        f"Included pages: {policy}",
        f"Included original PDF page numbers: {_format_page_ranges(included_pages) or 'none'}",
    ]
    remaining = MAX_PDF_CONTEXT_CHARS - sum(len(chunk) for chunk in chunks)
    included = 0
    for item in pages:
        if not isinstance(item, Mapping):
            continue
        page_no = _int_value(item.get("page_no"), 0)
        if page_no <= 0 or page_no not in allowed_pages:
            continue
        title = _string_value(item.get("title"), f"PDF p.{page_no}")
        text = str(item.get("text_md") or "").strip()
        if not text:
            text = "[No embedded text extracted for this page.]"
        prefix = f"[p.{page_no}] {title}\n"
        available_for_text = remaining - len(prefix)
        if available_for_text <= 0:
            chunks.append("[PDF context truncated by server character budget.]")
            break
        truncated_by_budget = len(text) > available_for_text
        block = f"{prefix}{_truncate(text, available_for_text) if truncated_by_budget else text}"
        if truncated_by_budget:
            chunks.extend([block, "[PDF context truncated by server character budget.]"])
            break
        if remaining - len(block) < 0:
            chunks.append("[PDF context truncated by server character budget.]")
            break
        chunks.append(block)
        remaining -= len(block)
        included += 1
        if not truncated and included >= full_page_limit:
            break
    return "\n\n".join(chunks if included else [])


def _pdf_included_page_numbers(value: Mapping[str, Any], page_count: int, full_page_limit: int, edge_page_count: int) -> list[int]:
    included = value.get("includedPageNumbers")
    if isinstance(included, list):
        page_numbers = sorted(
            {
                page_no
                for page_no in (_int_value(item, 0) for item in included)
                if 1 <= page_no <= max(page_count, 1)
            }
        )
        if page_numbers:
            return page_numbers
    return _pdf_context_page_numbers(page_count, full_page_limit, edge_page_count)


def _pdf_context_page_numbers(page_count: int, full_page_limit: int = PDF_CONTEXT_FULL_PAGE_LIMIT, edge_page_count: int = PDF_CONTEXT_EDGE_PAGE_COUNT) -> list[int]:
    total = max(0, page_count)
    limit = max(1, full_page_limit)
    edge = max(1, edge_page_count)
    if total <= limit:
        return list(range(1, total + 1))
    pages = set(range(1, min(edge, total) + 1))
    pages.update(range(max(1, total - edge + 1), total + 1))
    return sorted(pages)


def _format_page_ranges(pages: list[int]) -> str:
    if not pages:
        return ""
    ranges: list[str] = []
    start = pages[0]
    previous = pages[0]
    for page_no in pages[1:]:
        if page_no == previous + 1:
            previous = page_no
            continue
        ranges.append(f"{start}" if start == previous else f"{start}-{previous}")
        start = previous = page_no
    ranges.append(f"{start}" if start == previous else f"{start}-{previous}")
    return ", ".join(ranges)


def _selected_context(value: Any) -> str:
    if not isinstance(value, Mapping):
        return ""
    text = _selected_context_text(value)
    if not text:
        return ""
    source_type = _string_value(value.get("sourceType"), "unknown")
    document_title = _string_value(value.get("documentTitle"), "")
    section_title = _string_value(value.get("sectionTitle"), "")
    pdf_source = value.get("pdfSource") if isinstance(value.get("pdfSource"), Mapping) else {}
    pdf_source_page = _string_value(pdf_source.get("pageNumber") if isinstance(pdf_source, Mapping) else "", "")
    page_number = _string_value(
        value.get("pdfPageNumber") or value.get("generatedPageNumber") or value.get("pageNumber"),
        "",
    )
    meta = [f"type={source_type}"]
    if page_number:
        meta.append(f"page={page_number}")
    if source_type == "generated-explanation" and pdf_source_page:
        meta.append(f"corresponding_pdf_page={pdf_source_page}")
    if document_title:
        meta.append(f"document={document_title}")
    if section_title:
        meta.append(f"section={section_title}")
    result = f"Selected context ({', '.join(meta)})\n{text}"
    pdf_source_text = _selected_pdf_source_text(value)
    if pdf_source_text:
        pdf_source_title = _string_value(pdf_source.get("title") if isinstance(pdf_source, Mapping) else "", "")
        pdf_label = f"Corresponding PDF source"
        if pdf_source_page:
            pdf_label += f" p.{pdf_source_page}"
        if pdf_source_title:
            pdf_label += f" · {pdf_source_title}"
        result += f"\n\n{pdf_label}\n{pdf_source_text}"
    return result


def _context_items(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for index, item in enumerate(value[:MAX_CONTEXT_ITEMS], start=1):
        if not isinstance(item, Mapping):
            continue
        label = _string_value(item.get("title") or item.get("source"), f"Context {index}")
        kind = _string_value(item.get("type"), "text")
        page_no = _string_value(item.get("page_no"), "")
        text = _truncate(str(item.get("text") or ""), MAX_CONTEXT_CHARS)
        if not text:
            continue
        page_suffix = f", page {page_no}" if page_no else ""
        items.append(f"[{index}] {label} ({kind}{page_suffix})\n{text}")
    return items


def _context_parts(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for index, part in enumerate(value[:MAX_CONTEXT_ITEMS], start=1):
        if not isinstance(part, Mapping):
            continue
        part_type = _string_value(part.get("type"), "text")
        if part_type not in {"quote", "pdf_reference"}:
            continue
        text = _truncate(str(part.get("text") or ""), MAX_CONTEXT_CHARS)
        if not text:
            continue
        source = part.get("source") if isinstance(part.get("source"), Mapping) else {}
        page_no = _string_value(source.get("page_no"), "")
        title = _string_value(part.get("title"), f"Reference {index}")
        page_suffix = f", page {page_no}" if page_no else ""
        items.append(f"[part {index}] {title} ({part_type}{page_suffix})\n{text}")
    return items


def _text_from_parts(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    texts: list[str] = []
    for part in value:
        if not isinstance(part, Mapping):
            continue
        if part.get("type") != "text":
            continue
        text = str(part.get("text") or "").strip()
        if text:
            texts.append(text)
    return "\n\n".join(texts)


def _transcript_messages(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    messages: list[str] = []
    for item in value[-MAX_TRANSCRIPT_MESSAGES:]:
        if not isinstance(item, Mapping):
            continue
        role = _string_value(item.get("role"), "message")
        content = _truncate(_message_content(item), 4000)
        if content:
            status = _string_value(item.get("status"), "success")
            status_suffix = f" [{status}]" if status not in {"", "success"} else ""
            messages.append(f"{role}{status_suffix}: {content}")
    return messages


def _message_content(message: Mapping[str, Any]) -> str:
    content = str(message.get("content") or "").strip()
    parts_text = _message_parts_content(message.get("parts"))
    if parts_text:
        return parts_text
    return content


def _message_parts_content(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    segments: list[str] = []
    for part in value:
        if not isinstance(part, Mapping):
            continue
        part_type = _string_value(part.get("type"), "text")
        if part_type == "file":
            continue
        text = str(part.get("text") or "").strip()
        if not text:
            continue
        if part_type in {"quote", "pdf_reference"}:
            source = part.get("source") if isinstance(part.get("source"), Mapping) else {}
            page_no = _string_value(source.get("page_no"), "")
            page_suffix = f" p.{page_no}" if page_no else ""
            segments.append(f"[{part_type}{page_suffix}] {text}")
        else:
            segments.append(text)
    return "\n\n".join(segments)


def _image_attachments(value: Any, parts: Any = None) -> list[dict[str, str]]:
    candidates: list[Any] = []
    if isinstance(value, list):
        candidates.extend(value)
    if isinstance(parts, list):
        candidates.extend(part for part in parts if isinstance(part, Mapping) and part.get("type") == "file")
    images: list[dict[str, str]] = []
    for item in candidates[:MAX_IMAGE_ATTACHMENTS]:
        if not isinstance(item, Mapping):
            continue
        data_url = str(item.get("data_url") or "")
        if not data_url.startswith("data:image/"):
            continue
        if len(data_url) > MAX_IMAGE_DATA_URL_CHARS:
            raise HttpError(413, "Image attachment is too large", code="image_too_large")
        images.append({"data_url": data_url})
    return images


def _extract_gateway_text(text: str, content_type: str) -> str:
    if "text/event-stream" in content_type or text.lstrip().startswith("event:") or text.lstrip().startswith("data:"):
        return _extract_event_stream_text(text)
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return text.strip()
    return _extract_response_text(value)


def _extract_prompt_cache_usage(text: str, content_type: str) -> dict[str, Any]:
    value: Any = None
    if "text/event-stream" in content_type or text.lstrip().startswith("event:") or text.lstrip().startswith("data:"):
        for event in _iter_event_stream_payloads(text):
            event_type = event.get("type") or event.get("event")
            if event_type == "response.completed":
                candidate = event.get("response") or event
                if _find_response_usage(candidate):
                    value = candidate
            elif isinstance(event.get("usage"), Mapping):
                value = event
    else:
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            return {}
    usage = _find_response_usage(value)
    if not usage:
        return {}

    input_tokens = _int_value(usage.get("input_tokens") or usage.get("prompt_tokens"), 0)
    output_tokens = _int_value(usage.get("output_tokens") or usage.get("completion_tokens"), 0)
    total_tokens = _int_value(usage.get("total_tokens"), 0)
    details = usage.get("input_tokens_details")
    if not isinstance(details, Mapping):
        details = usage.get("prompt_tokens_details")
    if not isinstance(details, Mapping):
        details = {}
    cached_tokens = _int_value(details.get("cached_tokens") or usage.get("cached_input_tokens"), 0)

    metadata: dict[str, Any] = {
        "cached_tokens": cached_tokens,
        "cache_hit": cached_tokens > 0,
    }
    if input_tokens:
        metadata["input_tokens"] = input_tokens
        metadata["cached_ratio"] = round(cached_tokens / input_tokens, 4)
    if output_tokens:
        metadata["output_tokens"] = output_tokens
    if total_tokens:
        metadata["total_tokens"] = total_tokens
    return metadata


def _find_response_usage(value: Any) -> Mapping[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    usage = value.get("usage")
    if isinstance(usage, Mapping):
        return usage
    response = value.get("response")
    if isinstance(response, Mapping):
        found = _find_response_usage(response)
        if found:
            return found
    return None


def _iter_event_stream_payloads(text: str) -> list[Mapping[str, Any]]:
    events: list[Mapping[str, Any]] = []
    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            continue
        if isinstance(event, Mapping):
            events.append(event)
    return events


def _extract_event_stream_text(text: str) -> str:
    chunks: list[str] = []
    completed: Any = None
    last_event: Any = None

    for event in _iter_event_stream_payloads(text):
        last_event = event
        event_type = event.get("type") or event.get("event")
        if event_type in {"response.output_text.delta", "response.refusal.delta"}:
            chunks.append(str(event.get("delta") or ""))
        elif event_type == "response.output_text.done" and not chunks:
            chunks.append(str(event.get("text") or ""))
        elif event_type == "response.completed":
            completed = event.get("response") or event
        elif event_type in {"response.failed", "response.error"}:
            error = event.get("error") if isinstance(event.get("error"), Mapping) else event
            raise HttpError(502, redacted_gateway_error(json.dumps(error, ensure_ascii=False)), code="upstream_error")

    if chunks:
        return "".join(chunks).strip()
    if completed is not None:
        return _extract_response_text(completed)
    if last_event is not None:
        return _extract_response_text(last_event)
    return ""


def _extract_response_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return "\n".join(filter(None, (_extract_response_text(item) for item in value))).strip()
    if not isinstance(value, Mapping):
        return ""

    for key in ("output_text", "text"):
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()

    if isinstance(value.get("response"), Mapping):
        found = _extract_response_text(value["response"])
        if found:
            return found

    output = value.get("output")
    if isinstance(output, list):
        found = _extract_response_text(output)
        if found:
            return found

    content = value.get("content")
    if isinstance(content, list):
        found = _extract_response_text(content)
        if found:
            return found
    if isinstance(content, str) and content.strip():
        return content.strip()

    choices = value.get("choices")
    if isinstance(choices, list):
        found = _extract_response_text(choices)
        if found:
            return found

    message = value.get("message")
    if isinstance(message, Mapping):
        found = _extract_response_text(message)
        if found:
            return found

    return ""


def _resolve_static_path(web_root: Path, request_path: str) -> Path:
    decoded = urllib.parse.unquote(request_path)
    relative = "index.html" if decoded in {"", "/"} else decoded.lstrip("/")
    candidate = (web_root / relative).resolve()
    root = web_root.resolve()
    if candidate != root and root not in candidate.parents:
        raise HttpError(403, "Forbidden", code="forbidden")
    if candidate.is_dir():
        candidate = candidate / "index.html"
    return candidate


def _static_file_etag(stat_result: os.stat_result) -> str:
    return f'W/"{stat_result.st_mtime_ns:x}-{stat_result.st_size:x}"'


def _request_etag_matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    return any(candidate.strip() in {etag, "*"} for candidate in header.split(","))


def _static_cache_control(web_root: Path, file_path: Path) -> str:
    try:
        relative = file_path.resolve().relative_to(web_root.resolve())
    except ValueError:
        relative = Path(file_path.name)
    if file_path.name == "index.html":
        return "no-cache"
    if "assets" in relative.parts or re.search(r"\.[0-9a-fA-F]{8,}\.", file_path.name):
        return "public, max-age=31536000, immutable"
    return "no-cache"


def _clean_model(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned if cleaned else None


def _string_or_none(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _string_value(value: Any, default: str) -> str:
    if value is None:
        return default
    cleaned = str(value).strip()
    return cleaned or default


def _int_value(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float_value(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _page_type_value(value: Any) -> str:
    allowed = {"title", "agenda", "concept", "example", "figure", "table", "formula", "exercise", "summary", "blank", "unknown"}
    cleaned = str(value or "").strip()
    return cleaned if cleaned in allowed else "unknown"


def _evidence_list(value: Any) -> list[dict[str, str]]:
    allowed = {"title", "keyword", "formula", "figure", "table", "caption", "layout", "other"}
    if not isinstance(value, list):
        return [{"kind": "other", "quote_or_reference": "Generated from page source text"}]
    evidence: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        kind = str(item.get("kind") or "other").strip()
        quote = str(item.get("quote_or_reference") or "").strip()
        if quote:
            evidence.append({"kind": kind if kind in allowed else "other", "quote_or_reference": quote})
    return evidence or [{"kind": "other", "quote_or_reference": "Generated from page source text"}]


def _truncate(value: str, max_chars: int) -> str:
    if len(value) <= max_chars:
        return value
    return f"{value[: max_chars - 1]}…"


if __name__ == "__main__":
    raise SystemExit(main())
