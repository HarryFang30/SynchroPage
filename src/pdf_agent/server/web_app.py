from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import mimetypes
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
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
MAX_PDF_CONTEXT_CHARS = 120_000
MAX_TEACHING_CACHE_CHARS = 750_000
PDF_CONTEXT_FULL_PAGE_LIMIT = 50
PDF_CONTEXT_EDGE_PAGE_COUNT = 10
MAX_TRANSCRIPT_MESSAGES = 8
MAX_IMAGE_ATTACHMENTS = 8
MAX_IMAGE_DATA_URL_CHARS = 8_000_000
MAX_PDF_FILE_DATA_CHARS = 80_000_000

AGENT_INSTRUCTIONS = """You are the AI agent panel inside PagePair Reader.
Use the current PDF/page context, selected text, formulas, and image attachments as primary evidence.
Answer in the user's language, preserve LaTeX formulas, cite page numbers when available, and keep the response useful for study, review, or editing."""

TEACHING_GENERATOR_INSTRUCTIONS = """You are the PagePair per-page teaching generator.
Generate page-aligned study notes for one PDF page at a time.
Return strict JSON only. Do not wrap JSON in Markdown fences.
Use the user's language. Preserve formulas in LaTeX using $...$ or $$...$$.
Render tables as GitHub-Flavored Markdown tables inside speaker_notes_md when the source page contains tabular content.
Do not invent facts that are not supported by the source page text. If the page has no extractable text, mark it as needs_parser_fallback."""


class HttpError(RuntimeError):
    def __init__(self, status: int, message: str, *, code: str = "http_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


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
        text, content_type = await asyncio.to_thread(
            self._post_responses,
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
        }

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
    ) -> None:
        self.manager = manager
        self.model = model
        self.timeout_seconds = timeout_seconds

    async def generate_page(self, body: Mapping[str, Any]) -> dict[str, Any]:
        auth = await build_chatgpt_codex_auth(self.manager, session_id=_string_or_none(body.get("session_id")))
        document_file_used = bool(_pdf_file_input(body.get("documentFile")))
        payload = build_codex_responses_payload(
            _build_teaching_generation_payload(body, default_model=self.model),
            force_stream=True,
            include_reasoning_encrypted_content=True,
            strip_unsupported_fields=True,
        )
        try:
            text, content_type, payload = await self._post_payload_with_cache_fallback(
                codex_responses_url(base_url=auth.upstream_base_url),
                payload,
                auth.headers,
            )
        except HttpError as exc:
            if not document_file_used or exc.status not in {400, 413, 415, 422}:
                raise
            fallback_body = dict(body)
            fallback_body.pop("documentFile", None)
            document_file_used = False
            payload = build_codex_responses_payload(
                _build_teaching_generation_payload(fallback_body, default_model=self.model),
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
            raise HttpError(502, "OpenAI gateway returned an empty generation response", code="empty_gateway_response")
        page = _parse_generated_page(content, body)
        return {
            "page": page,
            "account_id": auth.account_id,
            "model": payload.get("model"),
            "cache": {
                "prompt_cache_key": payload.get("prompt_cache_key"),
                "prompt_cache_retention": payload.get("prompt_cache_retention"),
                "document_file_input": document_file_used,
            },
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
            if exc.status not in {400, 422} or not (
                payload.get("prompt_cache_key") or payload.get("prompt_cache_retention")
            ):
                raise
            fallback_payload = dict(payload)
            fallback_payload.pop("prompt_cache_key", None)
            fallback_payload.pop("prompt_cache_retention", None)
            text, content_type = await asyncio.to_thread(self._post_responses, url, fallback_payload, headers)
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
            elif path == "/api/generate/page":
                body = self._read_json()
                self._send_json(self.server.runner.run(self.server.teaching_gateway.generate_page(body)))
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
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        data = file_path.read_bytes() if include_body else b""
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(file_path.stat().st_size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if include_body:
            self.wfile.write(data)

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
    parser.add_argument("--model", default=DEFAULT_AGENT_MODEL)
    args = parser.parse_args(argv)

    server = create_server(args.host, args.port, model=args.model)
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
    prompt = _build_agent_prompt(body)
    content: list[dict[str, Any]] = [{"type": "input_text", "text": prompt}]
    for image in _image_attachments(body.get("attachments"), body.get("parts")):
        content.append({"type": "input_image", "image_url": image["data_url"]})
    return {
        "model": model,
        "instructions": AGENT_INSTRUCTIONS,
        "input": [{"role": "user", "content": content}],
    }


def _build_teaching_generation_payload(body: Mapping[str, Any], *, default_model: str) -> dict[str, Any]:
    model = _clean_model(body.get("model")) or default_model
    content: list[dict[str, Any]] = []
    pdf_file = _pdf_file_input(body.get("documentFile"))
    if pdf_file:
        content.append(pdf_file)
    cache_prefix = _build_teaching_cache_prefix(body)
    if cache_prefix:
        content.append({"type": "input_text", "text": cache_prefix})
    content.append({"type": "input_text", "text": _build_teaching_generation_prompt(body)})
    payload: dict[str, Any] = {
        "model": model,
        "instructions": TEACHING_GENERATOR_INSTRUCTIONS,
        "input": [{"role": "user", "content": content}],
    }
    cache_key = _prompt_cache_key(body)
    if cache_key:
        payload["prompt_cache_key"] = cache_key
    if model.startswith("gpt-5.5"):
        payload["prompt_cache_retention"] = "24h"
    return payload


def _build_teaching_generation_prompt(body: Mapping[str, Any]) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
    previous_page = body.get("previousPage") if isinstance(body.get("previousPage"), Mapping) else {}
    next_page = body.get("nextPage") if isinstance(body.get("nextPage"), Mapping) else {}
    page_no = _int_value(page.get("page_no"), 1)
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), 0))
    source_text = str(source.get("text_md") or "").strip()
    existing_notes = str(teaching.get("speaker_notes_md") or "").strip()

    sections = [
        "Generate one PagePair teaching page JSON for the given PDF page.",
        "",
        "Output shape:",
        json.dumps(_teaching_page_output_contract(page_no), ensure_ascii=False, indent=2),
        "",
        "Rules:",
        "- Return JSON only, no Markdown fences and no prose outside JSON.",
        "- Keep page_no exactly equal to the input page number.",
        "- source.text_md must preserve the source page text you received.",
        "- speaker_notes_md must be Markdown suitable for side-by-side learning.",
        "- Use headings, short paragraphs, bullet lists, Markdown tables, and LaTeX math when helpful.",
        "- If the page contains formulas, explain symbols and intuition in speaker_notes_md and formula_explanations.",
        "- If the page contains table-like content, reconstruct a concise Markdown table when possible.",
        "- If source text is empty or unreadable, do not hallucinate; set needs_parser_fallback=true, needs_review=true, confidence<=0.35.",
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"id: {_string_value(document.get('id'), 'unknown')}",
        f"page_count: {page_count}",
        "",
        "Target page:",
        f"page_no: {page_no}",
        f"pdf_page_ref: {_string_value(source.get('pdf_page_ref'), f'#page={page_no}')}",
        "",
        "Neighbor context:",
        f"previous_page_title: {_string_value(previous_page.get('title'), '')}",
        f"next_page_title: {_string_value(next_page.get('title'), '')}",
        "",
        "Existing notes, if regenerating:",
        _truncate(existing_notes, 4000) if existing_notes else "[none]",
        "",
        "Extracted source text for this exact PDF page:",
        _truncate(source_text, MAX_CONTEXT_CHARS) if source_text else "[No embedded text extracted for this page.]",
    ]
    return "\n".join(sections)


def _build_teaching_cache_prefix(body: Mapping[str, Any]) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    context = body.get("documentContext") if isinstance(body.get("documentContext"), Mapping) else {}
    pages = context.get("pages")
    if not isinstance(pages, list):
        return ""
    page_count = _int_value(context.get("pageCount"), len(pages))
    chunks = [
        "PAGEPAIR CACHEABLE DOCUMENT CONTEXT",
        "This section is intentionally identical for every page-generation request for this PDF so prompt caching can reuse it.",
        "Use this whole-document context to understand course structure, symbols, terminology, and cross-page dependencies.",
        "When explaining a target page, prioritize that target page, but use this document context for prerequisites and continuity.",
        "",
        f"document_id: {_string_value(document.get('id') or context.get('documentId'), 'unknown')}",
        f"document_title: {_string_value(document.get('title') or context.get('documentTitle'), 'Untitled PDF')}",
        f"page_count: {page_count}",
        "",
        "FULL PDF TEXT CONTEXT BY ORIGINAL PAGE NUMBER:",
    ]
    for item in pages:
        if not isinstance(item, Mapping):
            continue
        page_no = _int_value(item.get("page_no"), 0)
        if page_no <= 0:
            continue
        title = _string_value(item.get("title"), f"PDF p.{page_no}")
        text = str(item.get("text_md") or "").strip() or "[No embedded text extracted for this page.]"
        chunks.append(f"\n[p.{page_no}] {title}\n{text}")
    return _truncate("\n".join(chunks), MAX_TEACHING_CACHE_CHARS)


def _pdf_file_input(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    file_data = str(value.get("fileData") or value.get("file_data") or "").strip()
    if not file_data:
        return None
    if file_data.startswith("data:") and "," in file_data:
        file_data = file_data.split(",", 1)[1].strip()
    if not file_data or len(file_data) > MAX_PDF_FILE_DATA_CHARS:
        return None
    filename = _string_value(value.get("filename") or value.get("fileName"), "document.pdf")
    if not filename.lower().endswith(".pdf"):
        filename = f"{filename}.pdf"
    return {
        "type": "input_file",
        "filename": filename,
        "file_data": file_data,
    }


def _prompt_cache_key(body: Mapping[str, Any]) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    context = body.get("documentContext") if isinstance(body.get("documentContext"), Mapping) else {}
    document_file = body.get("documentFile") if isinstance(body.get("documentFile"), Mapping) else {}
    document_id = _cache_key_part(_string_value(document.get("id") or context.get("documentId"), "document"))
    digest = _string_value(document_file.get("sha256"), "")
    if not digest:
        stable_context = {
            "documentId": _string_value(document.get("id") or context.get("documentId"), ""),
            "documentTitle": _string_value(document.get("title") or context.get("documentTitle"), ""),
            "pageCount": _int_value(context.get("pageCount") or document.get("page_count"), 0),
            "pages": context.get("pages") if isinstance(context.get("pages"), list) else [],
        }
        serialized = json.dumps(stable_context, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    return f"pagepair:{document_id}:{_cache_key_part(digest)[:32]}"


def _cache_key_part(value: str) -> str:
    cleaned = "".join(
        character
        if character.isascii() and (character.isalnum() or character in {"-", "_"})
        else "_"
        for character in value
    )
    return cleaned[:48] or "unknown"


def _teaching_page_output_contract(page_no: int) -> dict[str, Any]:
    return {
        "page_no": page_no,
        "source": {
            "pdf_page_ref": f"#page={page_no}",
            "text_md": "same source text received for this page",
            "ocr_used": False,
            "parser": "pdfjs",
            "page_type": "title|agenda|concept|example|figure|table|formula|exercise|summary|blank|unknown",
        },
        "teaching": {
            "slide_title": "short page title",
            "speaker_notes_md": "Markdown teaching notes with LaTeX and Markdown tables when useful",
            "concepts": ["key concept"],
            "prerequisites": ["needed prior knowledge"],
            "contextual_bridge": "how this page connects to nearby pages, or empty string",
            "visual_explanations": ["figure/table explanation if applicable"],
            "formula_explanations": ["formula explanation if applicable"],
            "evidence": [{"kind": "title|keyword|formula|figure|table|caption|layout|other", "quote_or_reference": "visible evidence from this page"}],
            "confidence": 0.82,
            "needs_review": False,
            "needs_parser_fallback": False,
        },
        "status": "ready",
    }


def _parse_generated_page(content: str, body: Mapping[str, Any]) -> dict[str, Any]:
    value = _json_from_model_text(content)
    page_input = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    source_input = page_input.get("source") if isinstance(page_input.get("source"), Mapping) else {}
    page_no = _int_value(page_input.get("page_no"), 1)

    candidate: Any = value
    if isinstance(value, Mapping) and isinstance(value.get("page"), Mapping):
        candidate = value["page"]
    elif isinstance(value, Mapping) and isinstance(value.get("pages"), list) and value["pages"]:
        candidate = value["pages"][0]
    if not isinstance(candidate, Mapping):
        raise HttpError(502, "Generation response did not contain a page JSON object", code="invalid_generation_json")

    source = candidate.get("source") if isinstance(candidate.get("source"), Mapping) else {}
    teaching = candidate.get("teaching") if isinstance(candidate.get("teaching"), Mapping) else {}
    source_text = str(source.get("text_md") or source_input.get("text_md") or "").strip()
    no_text = not source_text
    needs_fallback = bool(teaching.get("needs_parser_fallback")) or no_text
    needs_review = bool(teaching.get("needs_review")) or needs_fallback
    confidence = _float_value(teaching.get("confidence"), 0.28 if no_text else 0.78)
    if needs_fallback:
        confidence = min(confidence, 0.35)

    notes = str(teaching.get("speaker_notes_md") or "").strip()
    if no_text and not notes:
        notes = (
            "## 当前页暂无法生成可靠讲解\n\n"
            "这一页没有可提取的 PDF 文本层。本轮不会编造内容；请后续接入 OCR 或手动补充页面文本后再重新生成。"
        )

    evidence = teaching.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        evidence = [{"kind": "other", "quote_or_reference": "PDF.js extracted page text" if source_text else "No embedded text layer"}]

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
        return json.loads(text)
    except json.JSONDecodeError:
        start_candidates = [index for index in (text.find("{"), text.find("[")) if index >= 0]
        if not start_candidates:
            raise HttpError(502, "Generation response was not valid JSON", code="invalid_generation_json")
        start = min(start_candidates)
        end = max(text.rfind("}"), text.rfind("]"))
        if end <= start:
            raise HttpError(502, "Generation response was not valid JSON", code="invalid_generation_json")
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise HttpError(502, f"Generation response was not valid JSON: {exc}", code="invalid_generation_json") from exc


def _build_agent_prompt(body: Mapping[str, Any]) -> str:
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
    pdf_context = _pdf_document_context(body.get("pdfContext"))

    sections = [
        "# User request",
        input_text or "Continue from the provided context.",
        "# Document",
        f"Title: {_string_value(document.get('title'), 'Untitled')}",
        f"Document ID: {_string_value(document.get('id'), 'unknown')}",
    ]
    if pdf_context:
        sections.extend(["# PDF document context", pdf_context])
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
    if messages:
        sections.extend(["# Recent conversation", *messages])
    if selected_context:
        sections.extend(
            [
                "# User selected source material",
                "The user selected this source from the current workspace. Prioritize it when answering, quote it carefully, and say when the selected source is insufficient.",
                selected_context,
            ]
        )
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
    return "\n\n".join(
        [
            "Selected source:",
            *source_lines,
            "Selected text:",
            selected_text,
            "User question:",
            user_question,
        ]
    )


def _selected_source_lines(selected_context: Any, pdf_context: Any) -> list[str]:
    if not isinstance(selected_context, Mapping):
        return []
    page_no = _int_value(
        selected_context.get("pdfPageNumber")
        or selected_context.get("generatedPageNumber")
        or selected_context.get("pageNumber"),
        0,
    )
    lines: list[str] = []
    if page_no:
        lines.append(f"PDF page: {page_no}")
    section = _string_value(selected_context.get("sectionTitle"), "")
    if section:
        lines.append(f"Source: {section}")
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
    page_number = _string_value(
        value.get("pdfPageNumber") or value.get("generatedPageNumber") or value.get("pageNumber"),
        "",
    )
    meta = [f"type={source_type}"]
    if page_number:
        meta.append(f"page={page_number}")
    if document_title:
        meta.append(f"document={document_title}")
    if section_title:
        meta.append(f"section={section_title}")
    return f"Selected context ({', '.join(meta)})\n{text}"


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


def _extract_event_stream_text(text: str) -> str:
    chunks: list[str] = []
    completed: Any = None
    last_event: Any = None

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
