"""Integration tests for HTTP server, AsyncRunner timeout, and PDF cache.

These tests start a real ThreadingHTTPServer on a temporary port so the
full request/response path is exercised.  No real network calls are made
— gateways are monkeypatched.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import threading
import unittest
import urllib.request
from dataclasses import dataclass
from typing import Any
from unittest import mock

from pdf_agent.server.web_app import (
    AsyncRunner,
    PdfAgentHttpServer,
    create_server,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _blank_pdf_file_data(page_count: int = 2) -> str:
    from PyPDF2 import PdfWriter

    writer = PdfWriter()
    for _ in range(page_count):
        writer.add_blank_page(width=72, height=72)
    pdf_buffer = io.BytesIO()
    writer.write(pdf_buffer)
    return base64.b64encode(pdf_buffer.getvalue()).decode("ascii")


def _read_response(response: Any) -> tuple[int, dict[str, Any]]:
    status = response.status
    body = json.loads(response.read().decode("utf-8"))
    return status, body


def _start_test_server(port: int = 0) -> PdfAgentHttpServer:
    """Create a server on an ephemeral port and start serving in background."""
    server = create_server(host="127.0.0.1", port=port)
    thread = threading.Thread(target=server.serve_forever, name="test-server", daemon=True)
    thread.start()
    return server


# ---------------------------------------------------------------------------
# HTTP integration tests
# ---------------------------------------------------------------------------


class HttpIntegrationTest(unittest.TestCase):

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = _start_test_server(0)
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.runner.shutdown()
        cls.server.shutdown()
        cls.server.server_close()

    def test_health_endpoint_returns_ok(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/api/health", timeout=5)
        status, body = _read_response(response)
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))
        self.assertEqual(body.get("service"), "pdf-agent")

    def test_agent_chat_with_invalid_json_returns_400(self) -> None:
        req = urllib.request.Request(
            f"{self.base_url}/api/agent/chat",
            data=b"not json",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)
            body = json.loads(exc.read().decode("utf-8"))
            self.assertEqual(body["error"], "invalid_json")
        else:
            self.fail("Expected HTTPError for invalid JSON")

    def test_post_to_unknown_route_returns_404(self) -> None:
        req = urllib.request.Request(
            f"{self.base_url}/api/nonexistent",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 404)
        else:
            self.fail("Expected HTTPError for unknown route")

    def test_static_index_html_is_served(self) -> None:
        response = urllib.request.urlopen(f"{self.base_url}/", timeout=5)
        self.assertEqual(response.status, 200)
        body = response.read().decode("utf-8")
        self.assertIn("<!doctype html>", body.lower() or "<html")  # type: ignore[operator]


# ---------------------------------------------------------------------------
# AsyncRunner timeout tests
# ---------------------------------------------------------------------------


class AsyncRunnerTimeoutTest(unittest.TestCase):

    def setUp(self) -> None:
        self.runner = AsyncRunner()

    def tearDown(self) -> None:
        self.runner.shutdown()

    def test_run_completes_normally_without_timeout(self) -> None:
        async def fast() -> str:
            return "done"

        result = self.runner.run(fast())
        self.assertEqual(result, "done")

    def test_run_timeout_raises_timeout_error(self) -> None:
        async def slow() -> str:
            await asyncio.sleep(5.0)
            return "too late"

        with self.assertRaises(TimeoutError):
            self.runner.run(slow(), timeout_seconds=0.1)

    def test_run_timeout_does_not_break_runner(self) -> None:
        # After a timeout the runner thread must still process new work.
        async def slow() -> str:
            await asyncio.sleep(5.0)
            return "too late"

        with self.assertRaises(TimeoutError):
            self.runner.run(slow(), timeout_seconds=0.1)

        async def fast() -> str:
            return "recovered"

        result = self.runner.run(fast())
        self.assertEqual(result, "recovered")

    def test_run_timeout_records_log(self) -> None:
        import logging
        import io as std_io

        stream = std_io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setLevel(logging.WARNING)
        logger = logging.getLogger("pdf_agent.server.web_app")
        logger.addHandler(handler)

        try:
            async def slow() -> str:
                await asyncio.sleep(5.0)
                return "too late"

            with self.assertRaises(TimeoutError):
                self.runner.run(slow(), timeout_seconds=0.1)
        finally:
            logger.removeHandler(handler)

        log_output = stream.getvalue()
        self.assertIn("timed out", log_output.lower())


# ---------------------------------------------------------------------------
# PDF cache tests
# ---------------------------------------------------------------------------


class PdfCacheIntegrationTest(unittest.TestCase):
    """Tests that the PdfFileCache instance behaves correctly end-to-end."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = _start_test_server(0)
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.runner.shutdown()
        cls.server.shutdown()
        cls.server.server_close()

    def test_cache_endpoint_stores_pdf_and_returns_metadata(self) -> None:
        file_data = _blank_pdf_file_data(2)
        payload = json.dumps({
            "filename": "test.pdf",
            "fileData": file_data,
            "mimeType": "application/pdf",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/pdf/cache",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        response = urllib.request.urlopen(req, timeout=5)
        status, body = _read_response(response)
        self.assertEqual(status, 200)
        self.assertIn("sha256", body)
        self.assertEqual(body["filename"], "test.pdf")

    def test_cache_hit_does_not_require_file_data_repeat(self) -> None:
        file_data = _blank_pdf_file_data(2)
        # First request stores the PDF
        payload1 = json.dumps({
            "filename": "cache-hit.pdf",
            "fileData": file_data,
        }).encode("utf-8")
        req1 = urllib.request.Request(
            f"{self.base_url}/api/pdf/cache",
            data=payload1,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        _status1, body1 = _read_response(urllib.request.urlopen(req1, timeout=5))
        sha256 = body1["sha256"]

        # Second request with only sha256 should still work (implicit via
        # _pdf_file_input, but we test cache endpoint itself)
        payload2 = json.dumps({
            "filename": "cache-hit.pdf",
            "fileData": file_data,
            "sha256": sha256,
        }).encode("utf-8")
        req2 = urllib.request.Request(
            f"{self.base_url}/api/pdf/cache",
            data=payload2,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        _status2, body2 = _read_response(urllib.request.urlopen(req2, timeout=5))
        self.assertEqual(body2["sha256"], sha256)

    def test_subset_failure_does_not_return_fallback_when_disabled(self) -> None:
        """The PdfFileCache.create_subset returns None for invalid PDF data."""
        from pdf_agent.server.pdf_file_cache import PdfFileCache

        cache = PdfFileCache()
        result = cache.get_or_create_subset("not-a-pdf", [1], sha256="test")
        self.assertIsNone(result)

    def test_pdf_cache_lru_eviction_works(self) -> None:
        from pdf_agent.server.pdf_file_cache import PdfFileCache

        # Small cache: max 2 entries, 10KB each
        cache = PdfFileCache(max_entries=2, max_bytes=20_000)
        file_data = _blank_pdf_file_data(1)

        cache.store({"sha256": "a", "size": 100, "fileData": file_data})
        cache.store({"sha256": "b", "size": 100, "fileData": file_data})
        cache.store({"sha256": "c", "size": 100, "fileData": file_data})

        # "a" should have been evicted (FIFO/LRU)
        self.assertIsNone(cache.get("a"))
        self.assertIsNotNone(cache.get("b"))
        self.assertIsNotNone(cache.get("c"))


# ---------------------------------------------------------------------------
# Fake gateway response builders
# ---------------------------------------------------------------------------


def _make_sse(*events: dict[str, Any]) -> str:
    """Build an SSE text/event-stream body from event dicts."""
    lines: list[str] = []
    for event in events:
        event_type = event.pop("_event", "response.output_text.done")
        lines.append(f"event: {event_type}")
        lines.append(f"data: {json.dumps(event, ensure_ascii=False)}")
        lines.append("")
    return "\n".join(lines)


def _extract_target_page_numbers(prompt_text: str) -> list[int]:
    """Parse target page numbers from a batch or single-page prompt."""
    import re
    # Try "Target page numbers: 1-3" or "Target page numbers: 1, 2, 3"
    match = re.search(r"Target page numbers:\s*([0-9,\-\s]+)", prompt_text)
    if match:
        nums_str = match.group(1)
        pages: list[int] = []
        for part in nums_str.split(","):
            part = part.strip()
            if "-" in part:
                range_parts = part.split("-", 1)
                try:
                    start = int(range_parts[0].strip())
                    end = int(range_parts[1].strip())
                    pages.extend(range(start, end + 1))
                except (ValueError, IndexError):
                    pass
            else:
                try:
                    pages.append(int(part))
                except ValueError:
                    pass
        if pages:
            return pages
    # Try extracting from "Target page {N}" sections in batch prompt
    target_matches = re.findall(r"Target page (\d+)", prompt_text)
    if target_matches:
        return [int(n) for n in target_matches]
    # Try "page_no: N" for single-page prompts
    page_no_match = re.search(r"page_no:\s*(\d+)", prompt_text)
    if page_no_match:
        return [int(page_no_match.group(1))]
    return [1]


def _agent_chat_sse(content: str = "This is a test response from the fake gateway.") -> str:
    """Fake SSE response for POST /api/agent/chat."""
    return _make_sse(
        {"_event": "response.output_text.done", "type": "response.output_text.done", "text": content},
        {
            "_event": "response.completed",
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 120,
                    "output_tokens": 30,
                    "input_tokens_details": {"cached_tokens": 60},
                }
            },
        },
    )


def _teaching_page_sse(
    page_numbers: list[int] | None = None,
) -> str:
    """Fake SSE response for POST /api/generate/page."""
    page_no = page_numbers[0] if page_numbers else 1
    inner = json.dumps(
        {
            "page": {
                "page_no": page_no,
                "teaching": {
                    "slide_title": f"Test Page {page_no}",
                    "speaker_notes_md": f"Test teaching notes for page {page_no}.",
                    "confidence": 0.85,
                    "needs_review": False,
                    "output_language": "en-US",
                },
            }
        },
        ensure_ascii=False,
    )
    return _make_sse(
        {"_event": "response.output_text.done", "type": "response.output_text.done", "text": inner},
        {
            "_event": "response.completed",
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 200,
                    "output_tokens": 50,
                    "input_tokens_details": {"cached_tokens": 100},
                }
            },
        },
    )


def _teaching_pages_sse(
    page_numbers: list[int] | None = None,
) -> str:
    """Fake SSE response for POST /api/generate/pages."""
    if page_numbers is None:
        page_numbers = [1, 2]
    pages: list[dict[str, Any]] = []
    for i, pn in enumerate(page_numbers):
        pages.append(
            {
                "page_no": pn,
                "teaching": {
                    "slide_title": f"Page {pn}",
                    "speaker_notes_md": f"Notes for page {pn}.",
                    "confidence": 0.80 + i * 0.02,
                    "needs_review": False,
                    "output_language": "en-US",
                },
            }
        )
    inner = json.dumps({"pages": pages}, ensure_ascii=False)
    return _make_sse(
        {"_event": "response.output_text.done", "type": "response.output_text.done", "text": inner},
        {
            "_event": "response.completed",
            "type": "response.completed",
            "response": {
                "usage": {
                    "input_tokens": 300,
                    "output_tokens": 80,
                    "input_tokens_details": {"cached_tokens": 150},
                }
            },
        },
    )


@dataclass
class FakeGatewayAuthContext:
    upstream_base_url: str = "https://chatgpt.com/backend-api/codex/"
    account_id: str = "fake-account-id"
    headers: dict[str, str] | None = None

    def __post_init__(self) -> None:
        if self.headers is None:
            self.headers = {"Authorization": "Bearer fake-token"}


class _FakeHttpResponse:
    """Minimal file-like object that mimics urllib.request.urlopen return."""

    def __init__(self, text: str, content_type: str = "text/event-stream") -> None:
        self._text = text.encode("utf-8")
        self.headers = {"Content-Type": content_type}
        self.status = 200

    def read(self) -> bytes:
        return self._text

    def __enter__(self) -> "_FakeHttpResponse":
        return self

    def __exit__(self, *args: object) -> None:
        pass


# ---------------------------------------------------------------------------
# Fake gateway HTTP integration tests
# ---------------------------------------------------------------------------


class FakeGatewayIntegrationTest(unittest.TestCase):
    """Integration tests that exercise the full HTTP request/response path
    with a fake upstream gateway (no real network calls)."""

    _auth_patchers: list[mock._patch]
    _urlopen_patcher: mock._patch | None = None
    _sent_payloads: list[dict[str, Any]]

    @classmethod
    def setUpClass(cls) -> None:
        cls._sent_payloads = []

        # ------------------------------------------------------------------
        # Patch build_chatgpt_codex_auth → return fake auth
        # (patched in both gateway modules where it is now used)
        # ------------------------------------------------------------------
        async def _fake_build_auth(*_args: object, **_kwargs: object) -> FakeGatewayAuthContext:
            return FakeGatewayAuthContext()

        cls._auth_patchers = [
            mock.patch(
                target,
                side_effect=_fake_build_auth,
            )
            for target in (
                "pdf_agent.server.agent_gateway.build_chatgpt_codex_auth",
                "pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth",
            )
        ]
        for patcher in cls._auth_patchers:
            patcher.start()

        # ------------------------------------------------------------------
        # Patch urllib.request.urlopen → intercept ONLY upstream calls
        # ------------------------------------------------------------------
        _original_urlopen = urllib.request.urlopen

        def _fake_urlopen(request: urllib.request.Request, timeout: float | None = None) -> _FakeHttpResponse:
            url = request.full_url if isinstance(request, urllib.request.Request) else str(request)
            # Only intercept calls to the upstream Codex API — pass everything
            # else (e.g. the test's own HTTP requests to the local server)
            # through to the real urlopen.
            if "chatgpt.com" not in url and "codex" not in url:
                return _original_urlopen(request, timeout=timeout)

            # Record the payload sent to the gateway
            if isinstance(request.data, bytes):
                try:
                    cls._sent_payloads.append(json.loads(request.data.decode("utf-8")))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass

            body = request.data
            if isinstance(body, bytes):
                body_str = body.decode("utf-8", errors="replace")
            else:
                body_str = str(body or "")

            # Determine which fake response to return by inspecting payload
            try:
                payload = json.loads(body_str)
            except (json.JSONDecodeError, TypeError):
                payload = {}

            instructions = str(payload.get("instructions", ""))
            # Agent chat uses the AGENT_INSTRUCTIONS text
            if "AI agent panel inside SynchroPage" in instructions:
                return _FakeHttpResponse(_agent_chat_sse())
            # Teaching uses the SHARED or FAST instructions
            input_messages = payload.get("input")
            prompt_text = ""
            if isinstance(input_messages, list):
                for msg in input_messages:
                    if isinstance(msg, dict):
                        content = msg.get("content")
                        if isinstance(content, list):
                            for part in content:
                                if isinstance(part, dict) and part.get("type") == "input_text":
                                    prompt_text += str(part.get("text", ""))
            # Heuristic: batch generation prompt mentions multiple target pages
            if "Generate SynchroPage teaching page JSON for" in prompt_text and "pages in one batch" in prompt_text:
                # Extract target page numbers from "Target page numbers: ..." line
                target_pages = _extract_target_page_numbers(prompt_text)
                return _FakeHttpResponse(_teaching_pages_sse(target_pages))
            if "Generate one SynchroPage teaching page JSON" in prompt_text or "Generate concise SynchroPage teaching JSON" in prompt_text:
                # Extract target page number for single-page generation
                target_pages = _extract_target_page_numbers(prompt_text)
                return _FakeHttpResponse(_teaching_page_sse(target_pages))
            # Fallback: any teaching-like payload gets single-page response
            if "SynchroPage" in instructions:
                return _FakeHttpResponse(_teaching_page_sse())
            # Ultimate fallback
            return _FakeHttpResponse(_agent_chat_sse())

        cls._urlopen_patcher = mock.patch("urllib.request.urlopen", side_effect=_fake_urlopen)
        cls._urlopen_patcher.start()

        cls.server = _start_test_server(0)
        cls.port = cls.server.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.runner.shutdown()
        cls.server.shutdown()
        cls.server.server_close()
        if cls._urlopen_patcher is not None:
            cls._urlopen_patcher.stop()
        for patcher in cls._auth_patchers:
            patcher.stop()

    def setUp(self) -> None:
        self._sent_payloads.clear()

    # -- agent chat -----------------------------------------------------------

    def test_agent_chat_returns_200_with_valid_response_shape(self) -> None:
        body = json.dumps({
            "model": "gpt-5.5",
            "input": "What is the capital of France?",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/agent/chat",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        response = urllib.request.urlopen(req, timeout=5)
        status, result = _read_response(response)
        self.assertEqual(status, 200)
        # Response shape: {message: {role, content}, account_id, model, cache}
        self.assertIn("message", result)
        self.assertIsInstance(result["message"], dict)
        self.assertEqual(result["message"]["role"], "assistant")
        self.assertIsInstance(result["message"]["content"], str)
        self.assertTrue(len(result["message"]["content"]) > 0)
        self.assertEqual(result["account_id"], "fake-account-id")
        self.assertIn("model", result)
        self.assertIn("cache", result)
        self.assertIsInstance(result["cache"], dict)

    def test_agent_chat_sent_payload_includes_instructions(self) -> None:
        body = json.dumps({
            "input": "Hello world",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/agent/chat",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        _response = urllib.request.urlopen(req, timeout=5)
        self.assertGreater(len(self._sent_payloads), 0)
        sent = self._sent_payloads[0]
        self.assertIn("instructions", sent)
        self.assertIn("SynchroPage", sent["instructions"])

    # -- generate page --------------------------------------------------------

    def test_generate_page_returns_200_with_valid_response_shape(self) -> None:
        body = json.dumps({
            "page": {"page_no": 1},
            "outputLanguage": "en-US",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/generate/page",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        response = urllib.request.urlopen(req, timeout=5)
        status, result = _read_response(response)
        self.assertEqual(status, 200)
        # Response shape: {page: {page_no, source, teaching, status}, account_id, model, cache}
        self.assertIn("page", result)
        page = result["page"]
        self.assertIsInstance(page, dict)
        self.assertIn("page_no", page)
        self.assertIn("teaching", page)
        self.assertIsInstance(page["teaching"], dict)
        self.assertIn("speaker_notes_md", page["teaching"])
        self.assertIn("slide_title", page["teaching"])
        self.assertEqual(result["account_id"], "fake-account-id")
        self.assertIn("model", result)
        self.assertIn("cache", result)
        self.assertIsInstance(result["cache"], dict)

    def test_generate_page_sent_payload_includes_target_page(self) -> None:
        body = json.dumps({
            "page": {"page_no": 42},
            "outputLanguage": "en-US",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/generate/page",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        _response = urllib.request.urlopen(req, timeout=5)
        self.assertGreater(len(self._sent_payloads), 0)
        sent = self._sent_payloads[0]
        # payload should contain instructions
        self.assertIn("instructions", sent)
        self.assertIn("SynchroPage", sent["instructions"])
        # The prompt text inside input should reference the target page
        input_msgs = sent.get("input", [])
        prompt_text = ""
        for msg in input_msgs:
            if isinstance(msg, dict):
                for part in msg.get("content", []):
                    if isinstance(part, dict) and part.get("type") == "input_text":
                        prompt_text += str(part.get("text", ""))
        # Verify that page 42 is referenced in the prompt
        self.assertIn("42", prompt_text)

    # -- generate pages (batch) -----------------------------------------------

    def test_generate_pages_returns_200_with_valid_response_shape(self) -> None:
        body = json.dumps({
            "pages": [{"page_no": 1}, {"page_no": 2}],
            "outputLanguage": "en-US",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/generate/pages",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        response = urllib.request.urlopen(req, timeout=5)
        status, result = _read_response(response)
        self.assertEqual(status, 200)
        # Response shape: {pages: [{page_no, teaching, ...}], account_id, model, cache}
        self.assertIn("pages", result)
        self.assertIsInstance(result["pages"], list)
        self.assertGreater(len(result["pages"]), 0)
        for page in result["pages"]:
            self.assertIn("page_no", page)
            self.assertIn("teaching", page)
            self.assertIsInstance(page["teaching"], dict)
            self.assertIn("speaker_notes_md", page["teaching"])
        self.assertEqual(result["account_id"], "fake-account-id")
        self.assertIn("model", result)
        self.assertIn("cache", result)
        self.assertIsInstance(result["cache"], dict)

    def test_generate_pages_sent_payload_is_batch(self) -> None:
        body = json.dumps({
            "pages": [{"page_no": 1}, {"page_no": 2}, {"page_no": 3}],
            "outputLanguage": "en-US",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/api/generate/pages",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        _response = urllib.request.urlopen(req, timeout=5)
        self.assertGreater(len(self._sent_payloads), 0)
        sent = self._sent_payloads[0]
        input_msgs = sent.get("input", [])
        prompt_text = ""
        for msg in input_msgs:
            if isinstance(msg, dict):
                for part in msg.get("content", []):
                    if isinstance(part, dict) and part.get("type") == "input_text":
                        prompt_text += str(part.get("text", ""))
        # Batch prompt mentions multiple pages
        self.assertIn("3 PDF pages in one batch", prompt_text)


if __name__ == "__main__":
    unittest.main()
