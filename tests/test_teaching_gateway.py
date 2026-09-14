"""Unit tests for TeachingGenerationGateway — fake upstream, no real network."""

from __future__ import annotations

import asyncio
import json
import time
import unittest
import urllib.request
from dataclasses import dataclass
from typing import Any, Self
from unittest import mock

from pdf_agent.server.errors import HttpError
from pdf_agent.server.gateway_transport import post_json_responses
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
        calls = 0

        def _timeout(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal calls
            calls += 1
            raise HttpError(504, "Model gateway request timed out after 5s", code="upstream_timeout")

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_timeout,
        ), mock.patch(
            "pdf_agent.server.teaching_gateway._transient_retry_delay_seconds",
            return_value=0.0,
        ), self.assertRaises(HttpError) as ctx:
            body = {"page": {"page_no": 1}, "outputLanguage": "en-US"}
            _runner(self.gateway.generate_page(body))
        self.assertEqual(ctx.exception.status, 504)
        self.assertEqual(ctx.exception.code, "upstream_timeout")
        # Exactly one retry for a zero-byte timeout.
        self.assertEqual(calls, 2)

    def test_timeout_after_partial_bytes_is_not_retried(self) -> None:
        from pdf_agent.server.generation_policy import mark_received_bytes

        calls = 0

        def _timeout(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal calls
            calls += 1
            error = HttpError(504, "timed out (2048 partial bytes ...)", code="upstream_timeout")
            mark_received_bytes(error, 2048)
            raise error

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_timeout,
        ), self.assertRaises(HttpError) as ctx:
            body = {"page": {"page_no": 1}, "outputLanguage": "en-US"}
            _runner(self.gateway.generate_page(body))
        self.assertEqual(ctx.exception.code, "upstream_timeout")
        self.assertEqual(calls, 1, "a half-streamed answer must not be re-asked")

    def test_upstream_payload_is_streamed_with_an_output_budget(self) -> None:
        seen: list[dict[str, Any]] = []

        def _capture(url: str, payload: dict[str, Any], headers: dict[str, str], **kwargs: Any) -> tuple[str, str]:
            seen.append(payload)
            return _make_page_sse(), "text/event-stream"

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_capture,
        ), mock.patch.dict("os.environ", {"COPROXY_API_KEY": "test-key"}):
            _runner(self.gateway.generate_page({
                "modelProviderId": "coproxy",
                "model": "gpt-6-astra",
                "page": {"page_no": 1},
                "outputLanguage": "en-US",
                "reasoningEffort": "high",
            }))
        self.assertTrue(seen[0]["stream"])
        self.assertEqual(seen[0]["max_output_tokens"], 24000)


# ---------------------------------------------------------------------------
# Rate-limit / Retry-After tests
# ---------------------------------------------------------------------------


class TeachingRateLimitTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=30.0,
            # Production waits >= 5 s after a 429; keep the unit test quick.
            rate_limit_min_cooldown_seconds=0.05,
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
            # Retry-After (0.1 s) is honoured exactly, and the global cooldown
            # gate is armed for new requests too.
            self.assertEqual(result["timing"]["attempts"], 2)

    def test_cooldown_is_max_of_retry_after_and_minimum(self) -> None:
        gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=30.0,
            rate_limit_min_cooldown_seconds=5.0,
        )
        gateway._note_rate_limit_cooldown(HttpError(429, "slow down", retry_after_seconds=0.5))
        first = gateway.status()["cooldown_until_ms"]
        self.assertGreater(first, 0)
        gateway._note_rate_limit_cooldown(HttpError(429, "slow down", retry_after_seconds=45.0))
        self.assertGreater(gateway.status()["cooldown_until_ms"], first)
        # Capped at 120 s even for an absurd Retry-After.
        gateway._note_rate_limit_cooldown(HttpError(429, "slow down", retry_after_seconds=10_000.0))
        self.assertLess(
            gateway.status()["cooldown_until_ms"] - time.time() * 1000,
            121_000,
        )


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


# ---------------------------------------------------------------------------
# Stability policy: timing, coalescing, queue bound, JSON repair, partials
# ---------------------------------------------------------------------------


class TeachingTimingAndStatusTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=30.0,
            api_concurrency=3,
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.gateway.close()

    def test_every_response_carries_timing_metadata(self) -> None:
        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=lambda *a, **kw: (_make_page_sse(), "text/event-stream"),
        ):
            result = _runner(self.gateway.generate_page({"page": {"page_no": 1}, "outputLanguage": "en-US"}))
        timing = result["timing"]
        self.assertIsInstance(timing["elapsed_ms"], int)
        self.assertGreaterEqual(timing["elapsed_ms"], 0)
        self.assertEqual(timing["attempts"], 1)
        self.assertIs(timing["coalesced"], False)

    def test_status_reports_the_contract_shape(self) -> None:
        status = self.gateway.status()
        self.assertEqual(
            sorted(status),
            ["active", "concurrency", "cooldown_until_ms", "deadlines_seconds", "queued"],
        )
        self.assertEqual(status["active"], 0)
        self.assertEqual(status["queued"], 0)
        self.assertEqual(status["cooldown_until_ms"], 0)
        self.assertEqual(status["concurrency"], 3)
        self.assertEqual(
            status["deadlines_seconds"],
            {"none": 180, "low": 180, "medium": 300, "high": 480, "xhigh": 600, "max": 600},
        )

    def test_concurrency_reads_the_environment_override(self) -> None:
        with mock.patch.dict("os.environ", {"PDF_AGENT_TEACHING_CONCURRENCY": "2"}):
            gateway = TeachingGenerationGateway(manager=mock.MagicMock())  # type: ignore[arg-type]
        try:
            self.assertEqual(gateway.status()["concurrency"], 2)
        finally:
            gateway.close()


class TeachingCoalescingTest(unittest.TestCase):

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
        self.gateway.close()

    def test_identical_in_flight_requests_share_one_upstream_call(self) -> None:
        calls = 0

        def _slow(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal calls
            calls += 1
            time.sleep(0.2)
            return _make_page_sse(), "text/event-stream"

        body = {
            "model": "gpt-5.5",
            "document": {"id": "doc_1"},
            "page": {"page_no": 7},
            "outputLanguage": "zh-CN",
        }

        async def _both() -> list[dict[str, Any]]:
            return list(await asyncio.gather(
                self.gateway.generate_page(body),
                self.gateway.generate_page(dict(body)),
            ))

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_slow,
        ):
            first, second = _runner(_both())

        self.assertEqual(calls, 1, "the second identical request must not hit the upstream")
        self.assertEqual(
            sorted([first["timing"]["coalesced"], second["timing"]["coalesced"]]),
            [False, True],
        )
        self.assertEqual(first["page"]["page_no"], second["page"]["page_no"])

    def test_different_pages_are_not_coalesced(self) -> None:
        calls = 0

        def _slow(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal calls
            calls += 1
            time.sleep(0.05)
            return _make_page_sse(), "text/event-stream"

        async def _both() -> Any:
            return await asyncio.gather(
                self.gateway.generate_page({"page": {"page_no": 1}, "outputLanguage": "en-US"}),
                self.gateway.generate_page({"page": {"page_no": 2}, "outputLanguage": "en-US"}),
            )

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_slow,
        ):
            _runner(_both())
        self.assertEqual(calls, 2)


class TeachingQueueBoundTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            timeout_seconds=30.0,
            api_concurrency=1,
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.gateway.close()

    def test_full_queue_answers_queue_timeout_with_retry_after(self) -> None:
        def _slow(*args: object, **kwargs: object) -> tuple[str, str]:
            time.sleep(0.4)
            return _make_page_sse(), "text/event-stream"

        async def _both() -> Any:
            return await asyncio.gather(
                self.gateway.generate_page({"page": {"page_no": 1}, "outputLanguage": "en-US"}),
                self.gateway.generate_page({"page": {"page_no": 2}, "outputLanguage": "en-US"}),
                return_exceptions=True,
            )

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_slow,
        ), mock.patch(
            "pdf_agent.server.teaching_gateway.QUEUE_WAIT_TIMEOUT_SECONDS",
            0.05,
        ):
            results = _runner(_both())

        errors = [result for result in results if isinstance(result, HttpError)]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].status, 503)
        self.assertEqual(errors[0].code, "queue_timeout")
        self.assertEqual(errors[0].retry_after_seconds, 10.0)


class TeachingJsonRepairTest(unittest.TestCase):

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
        self.gateway.close()

    @staticmethod
    def _text_sse(text: str) -> str:
        return (
            "event: response.output_text.done\n"
            f"data: {json.dumps({'type': 'response.output_text.done', 'text': text}, ensure_ascii=False)}\n"
            "\n"
        )

    def test_invalid_json_is_repaired_once_at_a_lower_effort(self) -> None:
        payloads: list[dict[str, Any]] = []

        def _broken_then_valid(url: str, payload: dict[str, Any], headers: dict[str, str], **kwargs: Any) -> tuple[str, str]:
            payloads.append(payload)
            if len(payloads) == 1:
                return self._text_sse("Sure! Here are your notes (not JSON)."), "text/event-stream"
            return _make_page_sse(), "text/event-stream"

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_broken_then_valid,
        ):
            result = _runner(self.gateway.generate_page({
                "model": "gpt-6-astra",
                "page": {"page_no": 1},
                "outputLanguage": "en-US",
                "reasoningEffort": "high",
            }))

        self.assertIn("page", result)
        self.assertEqual(len(payloads), 2)
        self.assertEqual(payloads[0]["reasoning"]["effort"], "high")
        self.assertEqual(payloads[1]["reasoning"]["effort"], "medium")
        self.assertTrue(str(payloads[1]["instructions"]).endswith("Return only the JSON object."))
        self.assertFalse(str(payloads[0]["instructions"]).endswith("Return only the JSON object."))

    def test_repair_retry_happens_only_once(self) -> None:
        calls = 0

        def _always_broken(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal calls
            calls += 1
            return self._text_sse("still not json"), "text/event-stream"

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_always_broken,
        ), self.assertRaises(HttpError) as ctx:
            _runner(self.gateway.generate_page({
                "model": "gpt-6-astra",
                "page": {"page_no": 1},
                "outputLanguage": "en-US",
            }))
        self.assertEqual(ctx.exception.code, "invalid_generation_json")
        self.assertEqual(calls, 2)


class TeachingBatchPartialTest(unittest.TestCase):

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
        self.gateway.close()

    def test_partial_batch_returns_parsed_pages_and_missing_list(self) -> None:
        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=lambda *a, **kw: (_make_pages_sse([1, 3]), "text/event-stream"),
        ):
            result = _runner(self.gateway.generate_pages({
                "pages": [{"page_no": 1}, {"page_no": 2}, {"page_no": 3}],
                "outputLanguage": "en-US",
            }))
        self.assertEqual([page["page_no"] for page in result["pages"]], [1, 3])
        self.assertEqual(result["missing"], [2])
        self.assertIn("timing", result)

    def test_complete_batch_reports_no_missing_pages(self) -> None:
        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=lambda *a, **kw: (_make_pages_sse([1, 2]), "text/event-stream"),
        ):
            result = _runner(self.gateway.generate_pages({
                "pages": [{"page_no": 1}, {"page_no": 2}],
                "outputLanguage": "en-US",
            }))
        self.assertEqual(result["missing"], [])

    def test_batch_output_budget_scales_with_page_count(self) -> None:
        seen: list[dict[str, Any]] = []

        def _capture(url: str, payload: dict[str, Any], headers: dict[str, str], **kwargs: Any) -> tuple[str, str]:
            seen.append(payload)
            return _make_pages_sse([1, 2, 3, 4]), "text/event-stream"

        with mock.patch(
            "pdf_agent.server.teaching_gateway.post_json_responses",
            side_effect=_capture,
        ), mock.patch.dict("os.environ", {"COPROXY_API_KEY": "test-key"}):
            _runner(self.gateway.generate_pages({
                "modelProviderId": "coproxy",
                "model": "gpt-6-astra",
                "pages": [{"page_no": index} for index in (1, 2, 3, 4)],
                "outputLanguage": "en-US",
                "reasoningEffort": "low",
            }))
        self.assertEqual(seen[0]["max_output_tokens"], 32000)


# ---------------------------------------------------------------------------
# Transport: streaming reads, inactivity timeout, truncation detection
# ---------------------------------------------------------------------------


class _StreamingResponse:
    """urlopen stand-in that hands out the body in chunks."""

    def __init__(self, text: str, *, content_type: str = "text/event-stream", stall_after: int | None = None) -> None:
        self._data = text.encode("utf-8")
        self._offset = 0
        self._stall_after = stall_after
        self.headers = {"Content-Type": content_type}
        self.status = 200

    def read1(self, size: int = -1) -> bytes:
        if self._stall_after is not None and self._offset >= self._stall_after:
            raise TimeoutError("timed out")
        end = len(self._data) if size is None or size < 0 else min(self._offset + size, len(self._data))
        if self._stall_after is not None:
            end = min(end, self._stall_after)
        chunk = self._data[self._offset : end]
        self._offset = end
        return chunk

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *args: object) -> None:
        return None


class TeachingTransportStreamingTest(unittest.TestCase):

    def test_streamed_body_is_read_incrementally(self) -> None:
        body = _make_page_sse()
        with mock.patch.object(
            urllib.request,
            "urlopen",
            side_effect=lambda *a, **kw: _StreamingResponse(body),
        ):
            text, content_type = post_json_responses(
                "https://example.invalid/v1/responses",
                {"model": "gpt-6-astra", "stream": True},
                {},
                timeout_seconds=5.0,
                handle_timeout=True,
                deadline_seconds=30.0,
            )
        self.assertEqual(text, body)
        self.assertEqual(content_type, "text/event-stream")

    def test_stall_after_partial_bytes_reports_partial_timeout(self) -> None:
        from pdf_agent.server.generation_policy import received_bytes

        body = _make_page_sse()
        with mock.patch.object(
            urllib.request,
            "urlopen",
            side_effect=lambda *a, **kw: _StreamingResponse(body, stall_after=32),
        ), self.assertRaises(HttpError) as ctx:
            post_json_responses(
                    "https://example.invalid/v1/responses",
                    {"model": "gpt-6-astra", "stream": True},
                    {},
                    timeout_seconds=1.0,
                    handle_timeout=True,
                    deadline_seconds=30.0,
                )
        self.assertEqual(ctx.exception.status, 504)
        self.assertEqual(ctx.exception.code, "upstream_timeout")
        self.assertIn("partial bytes", str(ctx.exception))
        self.assertEqual(received_bytes(ctx.exception), 32)

    def test_stall_before_first_byte_reports_zero_bytes(self) -> None:
        with mock.patch.object(
            urllib.request,
            "urlopen",
            side_effect=lambda *a, **kw: _StreamingResponse("body", stall_after=0),
        ), self.assertRaises(HttpError) as ctx:
            post_json_responses(
                    "https://example.invalid/v1/responses",
                    {"model": "gpt-6-astra", "stream": True},
                    {},
                    timeout_seconds=1.0,
                    handle_timeout=True,
                )
        self.assertEqual(ctx.exception.code, "upstream_timeout")
        self.assertIn("no response bytes", str(ctx.exception))

    def test_incomplete_response_raises_output_truncated(self) -> None:
        truncated = (
            "event: response.completed\n"
            'data: {"type": "response.completed", "response": {"status": "incomplete",'
            ' "incomplete_details": {"reason": "max_output_tokens"}}}\n\n'
        )
        with mock.patch.object(
            urllib.request,
            "urlopen",
            side_effect=lambda *a, **kw: _StreamingResponse(truncated),
        ), self.assertRaises(HttpError) as ctx:
            post_json_responses(
                    "https://example.invalid/v1/responses",
                    {"model": "gpt-6-astra", "stream": True},
                    {},
                    timeout_seconds=5.0,
                    handle_timeout=True,
                )
        self.assertEqual(ctx.exception.status, 502)
        self.assertEqual(ctx.exception.code, "output_truncated")


if __name__ == "__main__":
    unittest.main()
