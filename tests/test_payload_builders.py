"""Unit tests for pdf_agent.server.payload_builders pure functions."""

from __future__ import annotations

import unittest

from pdf_agent.server.payload_builders import (
    _agent_answer_mode,
    _agent_answer_mode_effort,
    _build_responses_payload,
    _build_teaching_generation_payload,
    _is_fast_teaching_generation,
    _reasoning_effort,
    _teaching_generation_candidate_bodies,
    _teaching_generation_page_numbers,
    _teaching_generation_pages,
    _teaching_output_language,
    _teaching_source_text_limit,
)


class AgentAnswerModeTest(unittest.TestCase):

    def test_known_modes(self) -> None:
        self.assertEqual(_agent_answer_mode({"answerMode": "concise"}), "concise")
        self.assertEqual(_agent_answer_mode({"answerMode": "guided"}), "guided")
        self.assertEqual(_agent_answer_mode({"answerMode": "detailed"}), "detailed")

    def test_defaults_to_concise(self) -> None:
        self.assertEqual(_agent_answer_mode({}), "concise")
        self.assertEqual(_agent_answer_mode({"answerMode": "unknown"}), "concise")

    def test_effort_mappings(self) -> None:
        self.assertEqual(_agent_answer_mode_effort("concise"), "medium")
        self.assertEqual(_agent_answer_mode_effort("guided"), "high")
        self.assertEqual(_agent_answer_mode_effort("detailed"), "xhigh")


class ReasoningEffortTest(unittest.TestCase):

    def test_explicit_value(self) -> None:
        self.assertEqual(_reasoning_effort({"reasoningEffort": "xhigh"}), "xhigh")

    def test_from_nested_reasoning(self) -> None:
        self.assertEqual(_reasoning_effort({"reasoning": {"effort": "low"}}), "low")

    def test_from_quality_plan(self) -> None:
        self.assertEqual(_reasoning_effort({"qualityPlan": {"reasoningEffort": "high"}}), "high")

    def test_from_answer_mode(self) -> None:
        self.assertEqual(_reasoning_effort({"answerMode": "guided"}), "high")

    def test_default(self) -> None:
        self.assertEqual(_reasoning_effort({}), "medium")


class TeachingOutputLanguageTest(unittest.TestCase):

    def test_chinese(self) -> None:
        code, label = _teaching_output_language({"outputLanguage": "zh-CN"})
        self.assertEqual(code, "zh-CN")

    def test_english(self) -> None:
        code, label = _teaching_output_language({"outputLanguage": "en-US"})
        self.assertEqual(code, "en-US")

    def test_fallback_to_ui_language(self) -> None:
        code, label = _teaching_output_language({"uiLanguage": "en-US"})
        self.assertEqual(code, "en-US")

    def test_default_chinese(self) -> None:
        code, label = _teaching_output_language({})
        self.assertEqual(code, "zh-CN")


class TeachingGenerationPagesTest(unittest.TestCase):

    def test_single_page(self) -> None:
        result = _teaching_generation_pages({"page": {"page_no": 5}})
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["page_no"], 5)

    def test_multiple_pages(self) -> None:
        result = _teaching_generation_pages({"pages": [{"page_no": 1}, {"page_no": 2}]})
        self.assertEqual(len(result), 2)

    def test_pages_takes_priority(self) -> None:
        result = _teaching_generation_pages({"pages": [{"page_no": 1}], "page": {"page_no": 99}})
        self.assertEqual(result[0]["page_no"], 1)

    def test_empty(self) -> None:
        self.assertEqual(_teaching_generation_pages({}), [])

    def test_page_numbers_distinct(self) -> None:
        result = _teaching_generation_page_numbers({"pages": [{"page_no": 1}, {"page_no": 1}, {"page_no": 3}]})
        self.assertEqual(result, [1, 3])


class IsFastTeachingTest(unittest.TestCase):

    def test_no_plan_returns_false(self) -> None:
        self.assertFalse(_is_fast_teaching_generation({}))

    def test_mini_with_low_effort_and_no_pdf_returns_true(self) -> None:
        self.assertTrue(_is_fast_teaching_generation({
            "qualityPlan": {"model": "gpt-5.5-mini", "reasoningEffort": "low", "attachPdf": False}
        }))

    def test_mini_with_pdf_returns_false(self) -> None:
        self.assertFalse(_is_fast_teaching_generation({
            "qualityPlan": {"model": "gpt-5.5-mini", "reasoningEffort": "low", "attachPdf": True}
        }))

    def test_non_mini_returns_false(self) -> None:
        self.assertFalse(_is_fast_teaching_generation({
            "qualityPlan": {"model": "gpt-5.5", "reasoningEffort": "low", "attachPdf": False}
        }))


class SourceTextLimitTest(unittest.TestCase):

    def test_no_plan_returns_quality(self) -> None:
        limit = _teaching_source_text_limit({})
        self.assertGreater(limit, 0)

    def test_attach_pdf_returns_quality(self) -> None:
        limit = _teaching_source_text_limit({"qualityPlan": {"attachPdf": True, "model": "gpt-5.5", "reasoningEffort": "medium"}})
        self.assertEqual(limit, 16_000)

    def test_mini_low_returns_fast(self) -> None:
        limit = _teaching_source_text_limit({"qualityPlan": {"attachPdf": False, "model": "gpt-5.5-mini", "reasoningEffort": "low"}})
        self.assertEqual(limit, 2_500)

    def test_non_mini_low_returns_balanced(self) -> None:
        limit = _teaching_source_text_limit({"qualityPlan": {"attachPdf": False, "model": "gpt-5.5", "reasoningEffort": "low"}})
        self.assertEqual(limit, 8_000)


class BuildResponsesPayloadTest(unittest.TestCase):

    def test_agent_payload_shape(self) -> None:
        payload = _build_responses_payload(
            {
                "input": "Hello world",
                "model": "gpt-5.5",
                "documentFile": {"sha256": "abc123", "fileData": "data:application/pdf;base64,AAAA"},
            },
            default_model="gpt-5.5",
        )
        self.assertIn("model", payload)
        self.assertIn("instructions", payload)
        self.assertIn("input", payload)
        self.assertIn("reasoning", payload)
        self.assertIsInstance(payload["input"], list)
        self.assertEqual(payload["input"][0]["role"], "user")
        self.assertIn("content", payload["input"][0])
        # prompt cache fields are applied for supported models when documentFile present
        self.assertIn("prompt_cache_key", payload)

    def test_agent_payload_no_cache_for_unsupported_model(self) -> None:
        payload = _build_responses_payload(
            {"input": "Hello"},
            default_model="gpt-4o",
        )
        self.assertNotIn("prompt_cache_key", payload)

    def test_teaching_payload_shape(self) -> None:
        payload = _build_teaching_generation_payload(
            {"page": {"page_no": 1}, "outputLanguage": "en-US"},
            default_model="gpt-5.5",
        )
        self.assertIn("model", payload)
        self.assertIn("instructions", payload)
        self.assertIn("input", payload)
        self.assertEqual(payload["input"][0]["role"], "user")
        # content should include the prompt text
        text_parts = [p["text"] for p in payload["input"][0]["content"] if p.get("type") == "input_text"]
        self.assertGreater(len(text_parts), 0)
        self.assertIn("page_no", text_parts[-1])


class CandidateBodiesTest(unittest.TestCase):

    def test_single_model_no_pdf(self) -> None:
        bodies = _teaching_generation_candidate_bodies({"model": "gpt-5.5"})
        self.assertEqual(len(bodies), 1)
        _body, doc_file_used = bodies[0]
        self.assertFalse(doc_file_used)

    def test_with_fallback_model(self) -> None:
        bodies = _teaching_generation_candidate_bodies({"model": "gpt-5.5", "fallbackModel": "gpt-5.5-mini"})
        self.assertEqual(len(bodies), 2)

    def test_fallback_same_as_model_ignored(self) -> None:
        bodies = _teaching_generation_candidate_bodies({"model": "gpt-5.5", "fallbackModel": "gpt-5.5"})
        self.assertEqual(len(bodies), 1)


if __name__ == "__main__":
    unittest.main()
