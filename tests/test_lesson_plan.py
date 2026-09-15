"""Lesson plan: planner prompt, plan normalisation, prose-quote JSON repair, chunked gateway call."""

from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import dataclass
from typing import Any
from unittest import mock

from pdf_agent.server.generation_parsing import (
    _parse_lesson_plan,
    normalize_lesson_plan,
)
from pdf_agent.server.markdown_math import (
    json_loads_with_latex_repair,
    repair_json_prose_quotes,
)
from pdf_agent.server.payload_builders import (
    _build_lesson_plan_payload,
    _build_lesson_plan_prompt,
)
from pdf_agent.server.teaching_gateway import TeachingGenerationGateway


@dataclass
class _FakeAuth:
    upstream_base_url: str = "https://chatgpt.com/backend-api/codex/"
    account_id: str = "test-account-id"
    headers: dict[str, str] | None = None

    def __post_init__(self) -> None:
        if self.headers is None:
            self.headers = {"Authorization": "Bearer sk-test"}


async def _fake_auth(*_args: object, **_kwargs: object) -> _FakeAuth:
    return _FakeAuth()


def _sse(text: str) -> str:
    return (
        "event: response.output_text.done\n"
        f"data: {json.dumps({'type': 'response.output_text.done', 'text': text}, ensure_ascii=False)}\n"
        "\n"
        "event: response.completed\n"
        'data: {"type": "response.completed", "response": {"usage": {"input_tokens": 10, "output_tokens": 5}}}\n'
        "\n"
    )


def _plan_body(page_count: int = 4) -> dict[str, Any]:
    return {
        "outputLanguage": "zh-CN",
        "document": {"id": "doc_plan", "title": "Lecture 4", "page_count": page_count},
        "pageCount": page_count,
        "pages": [{"page_no": index + 1, "text_md": f"page {index + 1} text"} for index in range(page_count)],
    }


class PlannerPromptTest(unittest.TestCase):

    def test_prompt_lists_every_page_with_truncated_text(self) -> None:
        body = _plan_body(3)
        body["pages"][1]["text_md"] = "x" * 900
        prompt = _build_lesson_plan_prompt(body)
        self.assertIn("You are the SynchroPage lesson planner.", prompt)
        self.assertIn("Simplified Chinese", prompt)
        self.assertNotIn("{language}", prompt)
        self.assertIn("title: Lecture 4", prompt)
        self.assertIn("--- p1 ---\npage 1 text", prompt)
        self.assertIn("--- p3 ---", prompt)
        self.assertNotIn("x" * 500, prompt)
        self.assertNotIn("This request covers pages", prompt)

    def test_prompt_marks_a_chunk_and_carries_the_running_summary(self) -> None:
        body = _plan_body(6)
        body["pages"] = body["pages"][3:]
        body["chunk"] = {"index": 2, "count": 2}
        body["previousSummary"] = "First half: gradient descent."
        prompt = _build_lesson_plan_prompt(body)
        self.assertIn("This request covers pages 4-6 of 6 (part 2 of 2).", prompt)
        self.assertIn("running_summary: First half: gradient descent.", prompt)

    def test_empty_page_text_is_labelled(self) -> None:
        body = _plan_body(2)
        body["pages"][0]["text_md"] = ""
        self.assertIn("(no extractable text on this page)", _build_lesson_plan_prompt(body))

    def test_payload_shape(self) -> None:
        payload = _build_lesson_plan_payload({**_plan_body(2), "model": "deepseek-v4-pro", "reasoningEffort": "high"}, default_model="fallback")
        self.assertEqual(payload["model"], "deepseek-v4-pro")
        self.assertEqual(payload["reasoning"], {"effort": "high"})
        self.assertIn("lesson planner", payload["input"][0]["content"][0]["text"])


class NormalizeLessonPlanTest(unittest.TestCase):

    def test_well_formed_plan_passes_through(self) -> None:
        plan = normalize_lesson_plan(
            {
                "document_summary": "  Two   segments. ",
                "segments": [
                    {"id": 1, "title": "Opening", "pages": [1, 2], "goal": "Know the goal."},
                    {"id": 2, "title": "Core", "pages": [3, 4], "goal": "Derive it."},
                ],
                "pages": [
                    {"page_no": 1, "segment": 1, "role": "title", "depth": "skim", "cue": "cover"},
                    {"page_no": 2, "segment": 1, "role": "agenda", "depth": "skim", "cue": "agenda"},
                    {"page_no": 3, "segment": 2, "role": "concept", "depth": "full", "key": True, "cue": "definition"},
                    {"page_no": 4, "segment": 2, "role": "derivation", "depth": "full", "cue": "proof"},
                ],
            },
            [1, 2, 3, 4],
        )
        self.assertEqual(plan["document_summary"], "Two segments.")
        self.assertEqual([segment["pages"] for segment in plan["segments"]], [[1, 2], [3, 4]])
        self.assertEqual(plan["segments"][1]["title"], "Core")
        self.assertTrue(plan["pages"][2]["key"])
        self.assertEqual([row["segment"] for row in plan["pages"]], [1, 1, 2, 2])

    def test_missing_rows_and_bad_values_get_defaults(self) -> None:
        plan = normalize_lesson_plan(
            {
                "segments": [{"id": 7, "title": "Only", "pages": [1, 3]}],
                "pages": [
                    {"page_no": 1, "segment": 7, "role": "transition", "depth": "enormous"},
                    {"page_no": 3, "segment": 7, "role": "nonsense", "depth": "brief", "key": True},
                ],
            },
            [1, 2, 3],
        )
        rows = {row["page_no"]: row for row in plan["pages"]}
        self.assertEqual(set(rows), {1, 2, 3})
        self.assertEqual((rows[1]["role"], rows[1]["depth"]), ("transition", "skim"))
        self.assertEqual((rows[2]["role"], rows[2]["depth"]), ("concept", "full"))
        self.assertEqual(rows[3]["role"], "concept")
        self.assertFalse(rows[3]["key"], "key is only honoured on full pages")
        self.assertEqual(plan["segments"], [{"id": 1, "title": "Only", "goal": "", "pages": [1, 3]}])

    def test_segments_are_rebuilt_contiguously_from_the_rows(self) -> None:
        plan = normalize_lesson_plan(
            {
                "segments": [{"id": 1, "title": "A"}, {"id": 2, "title": "B"}],
                "pages": [
                    {"page_no": 1, "segment": 1},
                    {"page_no": 2, "segment": 2},
                    {"page_no": 3, "segment": 1},
                    {"page_no": 4},
                ],
            },
            [1, 2, 3, 4],
        )
        self.assertEqual([(segment["id"], segment["title"], segment["pages"]) for segment in plan["segments"]],
                         [(1, "A", [1, 1]), (2, "B", [2, 2]), (3, "A", [3, 4])])
        self.assertEqual([row["segment"] for row in plan["pages"]], [1, 2, 3, 3])

    def test_parse_rejects_non_object_responses(self) -> None:
        with self.assertRaises(Exception) as ctx:
            _parse_lesson_plan("[1, 2]", _plan_body(2))
        self.assertEqual(getattr(ctx.exception, "code", ""), "invalid_generation_json")


class ProseQuoteRepairTest(unittest.TestCase):

    def test_valid_json_is_untouched(self) -> None:
        text = '{"a": "x", "b": ["y", "z"], "c": {"d": "e \\"quoted\\" f"}, "n": 1}'
        self.assertEqual(repair_json_prose_quotes(text), text)

    def test_prose_quotes_become_curly(self) -> None:
        text = '{"notes": "常考"单点梯度"的简答，然后"再来一次"。", "k": "v"}'
        self.assertEqual(
            json.loads(repair_json_prose_quotes(text)),
            {"notes": "常考“单点梯度”的简答，然后“再来一次”。", "k": "v"},
        )

    def test_repair_only_runs_when_the_first_parse_fails(self) -> None:
        broken = '{"notes": "> **别踩坑：** "SGD 更快"说的是 $\\theta$", "n": 2}'
        parsed = json_loads_with_latex_repair(broken)
        self.assertEqual(parsed["notes"], "> **别踩坑：** “SGD 更快”说的是 $\\theta$")
        self.assertEqual(parsed["n"], 2)


class GeneratePlanGatewayTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(manager=mock.MagicMock(), timeout_seconds=30.0)  # type: ignore[arg-type]
        self.auth_patcher = mock.patch("pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth", side_effect=_fake_auth)
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.gateway.close()

    def test_plan_is_chunked_and_segments_renumbered(self) -> None:
        payloads: list[dict[str, Any]] = []

        def _upstream(url: str, payload: dict[str, Any], headers: dict[str, str], **kwargs: Any) -> tuple[str, str]:
            payloads.append(payload)
            prompt = payload["input"][0]["content"][0]["text"]
            pages = [int(token) for token in __import__("re").findall(r"--- p(\d+) ---", prompt)]
            plan = {
                "document_summary": f"summary through p{pages[-1]}",
                "segments": [{"id": 1, "title": f"seg {pages[0]}-{pages[-1]}", "pages": [pages[0], pages[-1]], "goal": "g"}],
                "pages": [{"page_no": page_no, "segment": 1, "role": "concept", "depth": "full", "cue": f"cue {page_no}"} for page_no in pages],
            }
            return _sse(json.dumps(plan)), "text/event-stream"

        with mock.patch("pdf_agent.server.teaching_gateway.post_json_responses", side_effect=_upstream), \
             mock.patch("pdf_agent.server.teaching_gateway.LESSON_PLAN_CHUNK_PAGES", 2):
            result = asyncio.run(self.gateway.generate_plan({**_plan_body(5), "model": "gpt-6-astra"}))

        self.assertEqual(len(payloads), 3)
        self.assertIn("running_summary: summary through p2", payloads[1]["input"][0]["content"][0]["text"])
        plan = result["plan"]
        self.assertEqual(plan["version"], "synchropage.lesson-plan.v1")
        self.assertEqual(plan["document_summary"], "summary through p5")
        self.assertEqual([segment["pages"] for segment in plan["segments"]], [[1, 2], [3, 4], [5, 5]])
        self.assertEqual([row["segment"] for row in plan["pages"]], [1, 1, 2, 2, 3])
        self.assertEqual(result["timing"]["attempts"], 3)
        self.assertIn("model", result)

    def test_plan_without_pages_is_a_bad_request(self) -> None:
        with self.assertRaises(Exception) as ctx:
            asyncio.run(self.gateway.generate_plan({"document": {"id": "d"}}))
        self.assertEqual(getattr(ctx.exception, "status", 0), 400)


if __name__ == "__main__":
    unittest.main()
