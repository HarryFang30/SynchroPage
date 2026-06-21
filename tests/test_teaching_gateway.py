"""Unit tests for TeachingGenerationGateway — fake upstream, no real network."""

from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import dataclass
from typing import Any
from unittest import mock

from pdf_agent.server.errors import HttpError
from pdf_agent.server.teaching_gateway import TeachingGenerationGateway


@dataclass
class _FakeAuth:
    upstream_base_url: str = "https://chatgpt.com/backend-api/codex/"
    account_id: str = "test-account-id"
    headers: dict[str, str] | None = None

    def __post_init__(self) -> None:
        if self.headers is None:
            self.headers = {"Authorization": "Bearer sk-test"}


def _make_page_sse(page_no: int = 1, title: str = "Test Page", notes: str = "Test notes.") -> str:
    inner = json.dumps(
        {
            "page": {
                "page_no": page_no,
                "teaching": {
                    "slide_title": title,
                    "speaker_notes_md": notes,
                    "confidence": 0.85,
                    "needs_review": False,
                    "output_language": "en-US",
                },
            }
        },
        ensure_ascii=False,
    )
    return (
        "event: response.output_text.done\n"
        f"data: {json.dumps({'type': 'response.output_text.done', 'text': inner}, ensure_ascii=False)}\n"
        "\n"
        "event: response.completed\n"
        'data: {"type": "response.completed", "response": {"usage": {"input_tokens": 100, "output_tokens": 30}}}\n'
        "\n"
    )


def _make_pages_sse(page_numbers: list[int] | None = None) -> str:
    if page_numbers is None:
        page_numbers = [1, 2]
    pages = [
        {
            "page_no": pn,
            "teaching": {
                "slide_title": f"Page {pn}",
                "speaker_notes_md": f"Notes for page {pn}.",
                "confidence": 0.80,
                "needs_review": False,
                "output_language": "en-US",
            },
        }
        for pn in page_numbers
    ]
    inner = json.dumps({"pages": pages}, ensure_ascii=False)
    return (
        "event: response.output_text.done\n"
        f"data: {json.dumps({'type': 'response.output_text.done', 'text': inner}, ensure_ascii=False)}\n"
        "\n"
        "event: response.completed\n"
        'data: {"type": "response.completed", "response": {"usage": {"input_tokens": 200, "output_tokens": 60}}}\n'
        "\n"
    )


async def _fake_auth(*_args: object, **_kwargs: object) -> _FakeAuth:
    return _FakeAuth()


def _runner(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Success tests
# ---------------------------------------------------------------------------


class TeachingGeneratePageSuccessTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=30.0,
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()
        self.transport_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=lambda *a, **kw: (_make_page_sse(), "text/event-stream"),
        )
        self.transport_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.transport_patcher.stop()

    def test_generate_page_returns_valid_shape(self) -> None:
        body = {"page": {"page_no": 1}, "outputLanguage": "en-US"}
        result = _runner(self.gateway.generate_page(body))
        self.assertIn("page", result)
        page = result["page"]
        self.assertIn("page_no", page)
        self.assertIn("teaching", page)
        self.assertIn("speaker_notes_md", page["teaching"])
        self.assertEqual(result["account_id"], "test-account-id")
        self.assertIn("model", result)
        self.assertIn("cache", result)
        self.assertIsInstance(result["cache"], dict)

    def test_generate_page_empty_response_raises(self) -> None:
        def _empty(*args: object, **kwargs: object) -> tuple[str, str]:
            return "", "text/plain"

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_empty,
        ):
            body = {"page": {"page_no": 1}, "outputLanguage": "en-US"}
            with self.assertRaises(HttpError) as ctx:
                _runner(self.gateway.generate_page(body))
            self.assertEqual(ctx.exception.code, "empty_gateway_response")


class TeachingGeneratePagesSuccessTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=30.0,
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()
        self.transport_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=lambda *a, **kw: (_make_pages_sse([1, 2]), "text/event-stream"),
        )
        self.transport_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.transport_patcher.stop()

    def test_generate_pages_returns_valid_shape(self) -> None:
        body = {"pages": [{"page_no": 1}, {"page_no": 2}], "outputLanguage": "en-US"}
        result = _runner(self.gateway.generate_pages(body))
        self.assertIn("pages", result)
        self.assertIsInstance(result["pages"], list)
        self.assertGreater(len(result["pages"]), 0)
        for page in result["pages"]:
            self.assertIn("page_no", page)
            self.assertIn("teaching", page)
            self.assertIn("speaker_notes_md", page["teaching"])
        self.assertEqual(result["account_id"], "test-account-id")
        self.assertIn("cache", result)

    def test_generate_pages_empty_response_raises(self) -> None:
        def _empty(*args: object, **kwargs: object) -> tuple[str, str]:
            return "", "text/plain"

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_empty,
        ):
            body = {"pages": [{"page_no": 1}], "outputLanguage": "en-US"}
            with self.assertRaises(HttpError) as ctx:
                _runner(self.gateway.generate_pages(body))
            self.assertEqual(ctx.exception.code, "empty_gateway_response")


# ---------------------------------------------------------------------------
# Timeout / error tests
# ---------------------------------------------------------------------------


class TeachingTimeoutTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=5.0,
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()

    def test_timeout_raises_upstream_timeout(self) -> None:
        def _timeout(*args: object, **kwargs: object) -> tuple[str, str]:
            raise HttpError(504, "OpenAI gateway request timed out after 5s", code="upstream_timeout")

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_timeout,
        ):
            body = {"page": {"page_no": 1}, "outputLanguage": "en-US"}
            with self.assertRaises(HttpError) as ctx:
                _runner(self.gateway.generate_page(body))
            self.assertEqual(ctx.exception.status, 504)
            self.assertEqual(ctx.exception.code, "upstream_timeout")


# ---------------------------------------------------------------------------
# Rate-limit / Retry-After tests
# ---------------------------------------------------------------------------


class TeachingRateLimitTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=30.0,
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()

    def test_429_triggers_cooldown_then_succeeds(self) -> None:
        call_count = 0

        def _rate_limited_then_ok(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise HttpError(
                    429,
                    "Rate limited",
                    code="upstream_error",
                    retry_after_seconds=0.1,
                )
            return _make_page_sse(), "text/event-stream"

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_rate_limited_then_ok,
        ):
            body = {"page": {"page_no": 1}, "outputLanguage": "en-US"}
            result = _runner(self.gateway.generate_page(body))
            self.assertIn("page", result)
            self.assertGreaterEqual(call_count, 2)


# ---------------------------------------------------------------------------
# Candidate fallback tests
# ---------------------------------------------------------------------------


class TeachingCandidateFallbackTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=30.0,
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()

    def test_candidate_fallback_order_preserved(self) -> None:
        call_count = 0

        def _fail_all(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal call_count
            call_count += 1
            # Use status 400 which triggers _should_try_next_teaching_generation_candidate
            raise HttpError(400, "fail", code="upstream_error")

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_fail_all,
        ), mock.patch(
            "pdf_agent.server.teaching_gateway._should_retry_transient_upstream_error",
            return_value=False,
        ):
            body = {
                "page": {"page_no": 1},
                "model": "gpt-5.5",
                "fallbackModel": "gpt-5.5-mini",
                "outputLanguage": "en-US",
            }
            # All candidates fail → HttpError from the last one
            with self.assertRaises(HttpError):
                _runner(self.gateway.generate_page(body))
            # Both candidates were tried before falling through
            self.assertEqual(call_count, 2)


if __name__ == "__main__":
    unittest.main()
