"""Unreadable text layers: prompt notes, PDF pages attached to the planner, page transcription."""

from __future__ import annotations

import base64
import json
import unittest
from typing import Any

from pdf_agent.server.constants import (
    TEACHING_TRANSCRIBER_INSTRUCTIONS,
    TRANSCRIPTION_MAX_PAGES,
    TRANSCRIPTION_PARSER,
)
from pdf_agent.server.errors import HttpError
from pdf_agent.server.generation_parsing import (
    _parse_generated_page,
    _parse_transcription,
)
from pdf_agent.server.model_config import default_model_config, normalize_model_config
from pdf_agent.server.payload_builders import (
    _build_lesson_plan_payload,
    _build_lesson_plan_prompt,
    _build_teaching_generation_prompt,
    _build_transcription_payload,
    _build_transcription_prompt,
    _lesson_plan_attach_page_numbers,
    _teaching_generation_candidate_bodies,
    _teaching_prompt_rules,
)

GARBLED = "Gradient Descent (GD)\n! = 0 , ̅ & (\") = ' 0\nwhile convergence criteria is not met"


def _pdf_base64(page_count: int = 3) -> str:
    # No PDF file cache is installed in these tests, so the file travels whole
    # and its bytes never have to parse as a real PDF.
    return base64.b64encode(f"%PDF-1.4 fake {page_count} pages".encode("ascii")).decode("ascii")


def _document_file(page_count: int = 3) -> dict[str, Any]:
    return {"filename": "lecture.pdf", "mimeType": "application/pdf", "fileData": _pdf_base64(page_count)}


def _page_body(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "outputLanguage": "zh-CN",
        "document": {"id": "doc_1", "title": "Lecture 4", "page_count": 3},
        "pageCount": 3,
        "page": {"page_no": 2, "source": {"pdf_page_ref": "#page=2", "page_type": "formula", **source}},
    }


def _plan_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "outputLanguage": "zh-CN",
        "document": {"id": "doc_1", "title": "Lecture 4", "page_count": 3},
        "pageCount": 3,
        "pages": [
            {"page_no": 1, "text_md": "EECS 445 Linear Regression"},
            {"page_no": 2, "text_md": GARBLED, "garbled": True},
            {"page_no": 3, "text_md": "Summary", "transcribed": True},
        ],
    }
    body.update(overrides)
    return body


class TeachingPromptTextLayerTest(unittest.TestCase):

    def test_garbled_page_without_pdf_is_taught_around_the_hole(self) -> None:
        prompt = _build_teaching_generation_prompt(_page_body({"text_md": GARBLED, "text_garbled": True}))
        self.assertIn("text_layer: unreadable", prompt)
        self.assertIn("no PDF page is attached", prompt)
        self.assertIn("set needs_review=true and confidence at most 0.6", prompt)

    def test_garbled_page_with_pdf_reads_the_page(self) -> None:
        prompt = _build_teaching_generation_prompt(_page_body({"text_md": GARBLED, "text_garbled": True}), pdf_attached=True)
        self.assertIn("The PDF page is attached: read every formula there", prompt)
        self.assertNotIn("no PDF page is attached. Teach from the title", prompt)

    def test_transcribed_page_is_marked_faithful_but_unproofed(self) -> None:
        prompt = _build_teaching_generation_prompt(
            _page_body({"text_md": "$$\\bar\\theta = (X^TX)^{-1}X^Ty$$", "parser": TRANSCRIPTION_PARSER, "ocr_used": True}),
        )
        self.assertIn("text_layer: transcribed from the page image by a model", prompt)

    def test_readable_page_carries_no_text_layer_line(self) -> None:
        prompt = _build_teaching_generation_prompt(_page_body({"text_md": "A plain slide about bias and variance."}))
        self.assertNotIn("text_layer:", prompt)

    def test_batch_prompt_marks_each_garbled_page(self) -> None:
        body = {
            "outputLanguage": "zh-CN",
            "document": {"id": "doc_1", "title": "Lecture 4", "page_count": 3},
            "pageCount": 3,
            "pages": [
                {"page_no": 1, "source": {"pdf_page_ref": "#page=1", "text_md": "Cover"}},
                {"page_no": 2, "source": {"pdf_page_ref": "#page=2", "text_md": GARBLED, "text_garbled": True}},
            ],
        }
        prompt = _build_teaching_generation_prompt(body)
        self.assertEqual(prompt.count("text_layer: unreadable"), 1)

    def test_rules_forbid_decoding_the_noise(self) -> None:
        rules = "\n".join(_teaching_prompt_rules(_page_body({"text_md": GARBLED}), batch=False))
        self.assertIn("never transcribe, decode, or interpret them", rules)


class GeneratedPageTextLayerTest(unittest.TestCase):

    def test_generated_page_keeps_the_garbled_flag(self) -> None:
        content = json.dumps({"page_no": 2, "source": {"page_type": "formula"}, "teaching": {"slide_title": "GD", "speaker_notes_md": "x" * 200, "confidence": 0.5}})
        page = _parse_generated_page(content, _page_body({"text_md": GARBLED, "text_garbled": True}))
        self.assertTrue(page["source"]["text_garbled"])
        clean = _parse_generated_page(content, _page_body({"text_md": "readable"}))
        self.assertNotIn("text_garbled", clean["source"])


class LessonPlanUnreadablePagesTest(unittest.TestCase):

    def test_prompt_flags_garbled_and_transcribed_pages(self) -> None:
        prompt = _build_lesson_plan_prompt(_plan_body())
        self.assertIn("--- p2 ---\n(text layer unreadable: the formulas came out as stray symbols and no PDF page is attached", prompt)
        self.assertIn("--- p3 ---\n(text transcribed from the page image by a model)", prompt)
        self.assertNotIn("Attached PDF pages", prompt)

    def test_prompt_points_at_attached_pages(self) -> None:
        prompt = _build_lesson_plan_prompt(_plan_body(), attached_pages=[2])
        self.assertIn("Attached PDF pages: 2.", prompt)
        self.assertIn("--- p2 ---\n(text layer unreadable; read the attached PDF page)", prompt)

    def test_attach_page_numbers_default_to_garbled_pages_of_the_request(self) -> None:
        self.assertEqual(_lesson_plan_attach_page_numbers(_plan_body()), [])
        with_file = _plan_body(documentFile=_document_file())
        self.assertEqual(_lesson_plan_attach_page_numbers(with_file), [2])
        explicit = _plan_body(documentFile=_document_file(), attachPages=[3, 2, 9])
        self.assertEqual(_lesson_plan_attach_page_numbers(explicit), [2, 3])

    def test_payload_attaches_the_pdf_subset_only_when_pages_are_flagged(self) -> None:
        payload = _build_lesson_plan_payload(_plan_body(documentFile=_document_file()), default_model="gpt-5.5")
        content = payload["input"][0]["content"]
        self.assertEqual([part["type"] for part in content], ["input_file", "input_text"])
        self.assertIn("Attached PDF pages: 2.", content[1]["text"])
        plain = _build_lesson_plan_payload(_plan_body(), default_model="gpt-5.5")
        self.assertEqual([part["type"] for part in plain["input"][0]["content"]], ["input_text"])


class TranscriptionTest(unittest.TestCase):

    def _body(self, **overrides: Any) -> dict[str, Any]:
        body: dict[str, Any] = {
            "modelProviderId": "coproxy",
            "model": "gpt-6-astra",
            "reasoningEffort": "low",
            "document": {"id": "doc_1", "title": "Lecture 4", "page_count": 3},
            "pageCount": 3,
            "documentFile": _document_file(),
            "pages": [{"page_no": 3, "text_md": "Summary ! \" $"}, {"page_no": 2, "text_md": GARBLED}],
        }
        body.update(overrides)
        return body

    def test_prompt_lists_pages_in_order_with_hints(self) -> None:
        prompt = _build_transcription_prompt(self._body())
        self.assertIn(TEACHING_TRANSCRIBER_INSTRUCTIONS, prompt)
        self.assertIn("Attached PDF pages: 2-3", prompt)
        self.assertLess(prompt.index("--- p2 ---"), prompt.index("--- p3 ---"))
        self.assertIn("extracted_text_hint: Gradient Descent (GD)", prompt)

    def test_payload_carries_the_page_subset_first(self) -> None:
        payload = _build_transcription_payload(self._body(), default_model="gpt-5.5")
        content = payload["input"][0]["content"]
        self.assertEqual([part["type"] for part in content], ["input_file", "input_text"])
        self.assertEqual(payload["model"], "gpt-6-astra")
        self.assertEqual(payload["reasoning"], {"effort": "low"})

    def test_payload_refuses_to_transcribe_without_the_pdf(self) -> None:
        with self.assertRaises(HttpError) as raised:
            _build_transcription_payload(self._body(documentFile=None), default_model="gpt-5.5")
        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.code, "transcription_needs_pdf")

    def test_candidates_never_drop_the_pdf_when_required(self) -> None:
        body = self._body(requirePdfFile=True)
        candidates = _teaching_generation_candidate_bodies(body)
        self.assertTrue(candidates)
        self.assertTrue(all(used for _candidate, used in candidates))
        relaxed = _teaching_generation_candidate_bodies(self._body())
        self.assertIn(False, [used for _candidate, used in relaxed])

    def test_parse_marks_missing_pages_unreadable(self) -> None:
        content = json.dumps({"pages": [{"page_no": 2, "text_md": "## GD\n$$\\theta \\leftarrow \\theta - \\eta \\nabla J$$"}]})
        result = _parse_transcription(content, self._body())
        pages = {page["page_no"]: page for page in result["pages"]}
        self.assertEqual(sorted(pages), [2, 3])
        self.assertFalse(pages[2]["unreadable"])
        self.assertTrue(pages[2]["ocr_used"])
        self.assertEqual(pages[2]["parser"], TRANSCRIPTION_PARSER)
        self.assertIn("\\nabla J", pages[2]["text_md"])
        self.assertTrue(pages[3]["unreadable"])
        self.assertEqual(pages[3]["text_md"], "")

    def test_parse_rejects_a_response_that_read_nothing(self) -> None:
        with self.assertRaises(HttpError) as raised:
            _parse_transcription(json.dumps({"pages": [{"page_no": 2, "unreadable": True}]}), self._body())
        self.assertEqual(raised.exception.code, "invalid_generation_json")

    def test_page_cap_is_documented(self) -> None:
        self.assertGreaterEqual(TRANSCRIPTION_MAX_PAGES, 4)


class TranscriptionDefaultTest(unittest.TestCase):

    def test_optional_transcription_default_is_kept_only_for_a_known_provider(self) -> None:
        config = default_model_config()
        config["defaults"]["transcription"] = {"providerId": "codex_oauth", "model": "gpt-5.5"}
        normalized = normalize_model_config(config)
        self.assertEqual(normalized["defaults"]["transcription"], {"providerId": "codex_oauth", "model": "gpt-5.5"})
        config["defaults"]["transcription"] = {"providerId": "no-such-provider", "model": "x"}
        self.assertNotIn("transcription", normalize_model_config(config)["defaults"])
        del config["defaults"]["transcription"]
        self.assertNotIn("transcription", normalize_model_config(config)["defaults"])


if __name__ == "__main__":
    unittest.main()
