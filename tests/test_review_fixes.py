"""Regression tests for the post-review fixes (batch budgets, retry classes,
cooldown gating, page_type round-trip, batch matching)."""

from __future__ import annotations

import asyncio
import json
import unittest
from typing import Any
from unittest import mock

from pdf_agent.server import generation_policy
from pdf_agent.server.errors import HttpError
from pdf_agent.server.generation_parsing import (
    _parse_generated_page,
    _parse_generated_pages_with_missing,
)
from pdf_agent.server.prompt_cache import (
    _should_retry_transient_upstream_error,
    _should_try_next_teaching_generation_candidate,
)
from pdf_agent.server.teaching_gateway import TeachingGenerationGateway, _RequestContext


class OutputBudgetTest(unittest.TestCase):
    def test_batch_budget_never_drops_below_single_page_budget(self) -> None:
        for effort in generation_policy.REASONING_EFFORT_ORDER:
            single = generation_policy.max_output_tokens_for(effort, 1)
            for pages in range(1, 7):
                self.assertGreaterEqual(
                    generation_policy.max_output_tokens_for(effort, pages),
                    single,
                    f"{effort} x {pages} pages",
                )
        self.assertEqual(generation_policy.max_output_tokens_for("xhigh", 2), 32000)
        self.assertEqual(generation_policy.max_output_tokens_for("medium", 3), 24000)
        self.assertEqual(generation_policy.max_output_tokens_for("high", 8), 48000)

    def test_every_effort_has_a_deadline_and_a_budget(self) -> None:
        efforts = set(generation_policy.REASONING_EFFORT_ORDER)
        self.assertEqual(set(generation_policy.REQUEST_DEADLINE_SECONDS_BY_EFFORT), efforts)
        self.assertEqual(set(generation_policy.MAX_OUTPUT_TOKENS_BY_EFFORT), efforts)
        self.assertEqual(generation_policy.request_deadline_seconds("none", 1), 180.0)


class RetryClassificationTest(unittest.TestCase):
    def test_output_truncated_is_never_resent(self) -> None:
        exc = HttpError(502, "hit max_output_tokens", code="output_truncated")
        self.assertFalse(_should_retry_transient_upstream_error(exc))
        self.assertFalse(_should_try_next_teaching_generation_candidate(exc, document_file_used=True))
        self.assertFalse(_should_try_next_teaching_generation_candidate(exc, document_file_used=False))

    def test_queue_timeout_does_not_arm_the_global_cooldown(self) -> None:
        gateway = TeachingGenerationGateway(manager=mock.MagicMock(), api_concurrency=1)  # type: ignore[arg-type]

        async def fake_post_once(*_args: Any, **_kwargs: Any) -> tuple[str, str]:
            raise HttpError(503, "Generation queue is full", code="queue_timeout", retry_after_seconds=10.0)

        async def run() -> None:
            with mock.patch.object(gateway, "_post_once", side_effect=fake_post_once):
                with self.assertRaises(HttpError) as ctx:
                    await gateway._post_with_retries("https://example.test/v1/responses", {}, {}, context=_RequestContext(60))
            self.assertEqual(ctx.exception.code, "queue_timeout")

        try:
            asyncio.run(run())
            self.assertEqual(gateway.status()["cooldown_until_ms"], 0)
        finally:
            gateway.close()

    def test_real_rate_limit_still_arms_the_cooldown(self) -> None:
        gateway = TeachingGenerationGateway(manager=mock.MagicMock(), api_concurrency=1)  # type: ignore[arg-type]
        gateway._note_rate_limit_cooldown(HttpError(429, "slow down", code="rate_limited", retry_after_seconds=7.0))
        try:
            self.assertGreater(gateway.status()["cooldown_until_ms"], 0)
        finally:
            gateway.close()


class PageTypeRoundTripTest(unittest.TestCase):
    def test_requested_page_type_survives_a_response_without_source(self) -> None:
        page = _parse_generated_page(
            json.dumps({"page": {"page_no": 1, "teaching": {"slide_title": "Cover", "speaker_notes_md": "One line.", "confidence": 0.9}}}),
            {"page": {"page_no": 1, "source": {"text_md": "Course title", "pdf_page_ref": "#page=1", "page_type": "title"}}},
        )
        self.assertEqual(page["source"]["page_type"], "title")

    def test_model_classification_wins_when_present(self) -> None:
        page = _parse_generated_page(
            json.dumps({"page": {"page_no": 1, "source": {"page_type": "formula"}, "teaching": {"slide_title": "F", "speaker_notes_md": "x", "confidence": 0.9}}}),
            {"page": {"page_no": 1, "source": {"text_md": "E = mc^2", "pdf_page_ref": "#page=1", "page_type": "unknown"}}},
        )
        self.assertEqual(page["source"]["page_type"], "formula")


def _batch_body(*page_numbers: int) -> dict[str, Any]:
    return {"pages": [{"page_no": n, "source": {"text_md": f"text {n}", "pdf_page_ref": f"#page={n}"}} for n in page_numbers]}


def _candidate(page_no: int | None, title: str) -> dict[str, Any]:
    candidate: dict[str, Any] = {"teaching": {"slide_title": title, "speaker_notes_md": f"notes for {title}", "confidence": 0.9}}
    if page_no is not None:
        candidate["page_no"] = page_no
    return candidate


class BatchMatchingTest(unittest.TestCase):
    def test_relative_labels_are_matched_positionally(self) -> None:
        content = json.dumps({"pages": [_candidate(1, "A"), _candidate(2, "B")]})
        pages, missing = _parse_generated_pages_with_missing(content, _batch_body(10, 11))
        self.assertEqual([page["page_no"] for page in pages], [10, 11])
        self.assertEqual([page["teaching"]["slide_title"] for page in pages], ["A", "B"])
        self.assertEqual(missing, [])

    def test_partially_labelled_batch_keeps_the_unlabelled_slot(self) -> None:
        content = json.dumps({"pages": [_candidate(10, "A"), _candidate(None, "B")]})
        pages, missing = _parse_generated_pages_with_missing(content, _batch_body(10, 11))
        self.assertEqual([page["page_no"] for page in pages], [10, 11])
        self.assertEqual(missing, [])

    def test_absolute_labels_report_the_truly_missing_page(self) -> None:
        content = json.dumps({"pages": [_candidate(11, "B")]})
        pages, missing = _parse_generated_pages_with_missing(content, _batch_body(10, 11))
        self.assertEqual([page["page_no"] for page in pages], [11])
        self.assertEqual(missing, [10])


if __name__ == "__main__":
    unittest.main()
