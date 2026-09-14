"""Tests for the teaching prompt: instructions, section skeleton, page-type guidance.

These cover pain point 3 — per-page explanations must diagnose where a learner
gets stuck and how the material is examined, instead of restating the page.
"""

from __future__ import annotations

import unittest

from pdf_agent.server.constants import (
    TEACHING_GENERATOR_INSTRUCTIONS,
    TEACHING_NOTES_SKELETON,
    TEACHING_PAGE_TYPE_GUIDANCE,
    TEACHING_SECTION_HEADINGS,
)
from pdf_agent.server.payload_builders import (
    _build_teaching_generation_prompt,
    _teaching_page_output_contract,
    _teaching_page_titles,
    _teaching_page_type,
    _teaching_page_type_guidance_lines,
    _teaching_prompt_rules,
)


def _single_page_body(**overrides):
    body = {
        "outputLanguage": "zh-CN",
        "document": {"id": "doc_1", "title": "Control Systems", "page_count": 12},
        "pageCount": 12,
        "page": {
            "page_no": 5,
            "source": {
                "page_type": "formula",
                "pdf_page_ref": "#page=5",
                "text_md": "1 + K G(s)H(s) = 0",
            },
        },
    }
    body.update(overrides)
    return body


class TeachingInstructionsTest(unittest.TestCase):

    def test_states_the_no_restatement_purpose(self) -> None:
        self.assertIn("Never paraphrase, summarize, or translate the page", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("where students typically get stuck", TEACHING_GENERATOR_INSTRUCTIONS)

    def test_carries_the_exam_calibration_table(self) -> None:
        for content_type in ("definition, theorem, or property", "formula or derivation", "table", "exercise"):
            self.assertIn(content_type, TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("The grader wants", TEACHING_GENERATOR_INSTRUCTIONS)

    def test_forbids_claiming_knowledge_of_a_real_exam(self) -> None:
        self.assertIn(
            "Never claim knowledge of a specific real exam, a past paper, a syllabus, or what an instructor said",
            TEACHING_GENERATOR_INSTRUCTIONS,
        )

    def test_preserves_the_legacy_latex_json_escaping_rules(self) -> None:
        # The model must keep seeing double-escaped backslashes for JSON strings
        # and single backslashes in the literal LaTeX examples.
        self.assertIn(r"for example write \\frac and \\to.", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn(r"$0 \text{ 到 } 2^n - 1$", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn(r"write 2^n, not \2^n", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn(r"write 000, 111, not \000 or \111", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn(
            r"$000 \to 001 \to 010 \to \cdots \to 111 \to 000$",
            TEACHING_GENERATOR_INSTRUCTIONS,
        )

    def test_does_not_collide_with_the_json_contract_keys(self) -> None:
        # test_web_app asserts these quoted keys appear at most once in a prompt.
        for quoted_key in ('"concepts"', '"evidence"', '"speaker_notes_md"'):
            self.assertNotIn(quoted_key, TEACHING_GENERATOR_INSTRUCTIONS)


class TeachingStructureConstantsTest(unittest.TestCase):

    def test_headings_exist_for_both_languages(self) -> None:
        self.assertEqual(set(TEACHING_SECTION_HEADINGS), {"zh-CN", "en-US"})
        self.assertEqual(
            set(TEACHING_SECTION_HEADINGS["zh-CN"]),
            set(TEACHING_SECTION_HEADINGS["en-US"]),
        )
        self.assertEqual(TEACHING_SECTION_HEADINGS["zh-CN"]["stuck"], "## 容易卡住的地方")
        self.assertEqual(TEACHING_SECTION_HEADINGS["zh-CN"]["exam"], "## 考试怎么考")

    def test_skeleton_uses_the_declared_headings(self) -> None:
        for code, skeleton in TEACHING_NOTES_SKELETON.items():
            for heading in TEACHING_SECTION_HEADINGS[code].values():
                self.assertIn(heading, skeleton)

    def test_guidance_covers_every_page_type(self) -> None:
        self.assertEqual(
            set(TEACHING_PAGE_TYPE_GUIDANCE),
            {
                "title", "agenda", "blank", "concept", "example",
                "formula", "figure", "table", "exercise", "summary", "unknown",
            },
        )
        self.assertIn("Leave stuck_points and exam_angles empty", TEACHING_PAGE_TYPE_GUIDANCE["title"])
        self.assertIn(
            "no final answers unless the page itself shows them",
            TEACHING_PAGE_TYPE_GUIDANCE["exercise"],
        )
        self.assertIn("set source.page_type", TEACHING_PAGE_TYPE_GUIDANCE["unknown"])


class TeachingOutputContractTest(unittest.TestCase):

    def test_contract_declares_the_two_new_arrays_and_page_type(self) -> None:
        contract = _teaching_page_output_contract(5)
        self.assertEqual(contract["source"]["page_type"].split("|")[0], "title")
        self.assertIn("stuck_points", contract["teaching"])
        self.assertIn("exam_angles", contract["teaching"])

    def test_contract_stays_minimal(self) -> None:
        contract = _teaching_page_output_contract(5)
        self.assertNotIn("concepts", contract["teaching"])
        self.assertNotIn("evidence", contract["teaching"])


class TeachingPromptRulesTest(unittest.TestCase):

    def test_chinese_rules_reference_the_chinese_headings(self) -> None:
        rules = "\n".join(_teaching_prompt_rules({"outputLanguage": "zh-CN"}, batch=False))
        self.assertIn("- 容易卡住的地方:", rules)
        self.assertIn("题型 / 陷阱 / 评分点", rules)
        self.assertIn("misconception or breakpoint", rules)

    def test_english_rules_reference_the_english_headings(self) -> None:
        rules = "\n".join(_teaching_prompt_rules({"outputLanguage": "en-US"}, batch=False))
        self.assertIn("- Where students get stuck:", rules)
        self.assertIn("Question forms / Traps / What the grader looks for", rules)

    def test_rules_allow_returning_source_page_type(self) -> None:
        rules = "\n".join(_teaching_prompt_rules({}, batch=False))
        self.assertIn("Always return source.page_type", rules)

    def test_rules_bound_the_two_arrays(self) -> None:
        rules = "\n".join(_teaching_prompt_rules({}, batch=False))
        self.assertIn("teaching.stuck_points holds 1-3 one-line items", rules)
        self.assertIn("teaching.exam_angles holds 1-4 one-line items", rules)

    def test_fast_rules_are_untouched(self) -> None:
        body = {"qualityPlan": {"model": "gpt-5.4-mini", "reasoningEffort": "low", "attachPdf": False}}
        rules = "\n".join(_teaching_prompt_rules(body, batch=False))
        self.assertIn("4-7 focused bullets", rules)
        self.assertNotIn("容易卡住的地方", rules)


class TeachingPageTypeHelpersTest(unittest.TestCase):

    def test_page_type_defaults_to_unknown(self) -> None:
        self.assertEqual(_teaching_page_type({"source": {"page_type": "figure"}}), "figure")
        self.assertEqual(_teaching_page_type({"source": {}}), "unknown")
        self.assertEqual(_teaching_page_type({"source": {"page_type": "nonsense"}}), "unknown")

    def test_known_types_emit_only_their_own_guidance(self) -> None:
        lines = _teaching_page_type_guidance_lines(["formula"])
        self.assertEqual(len(lines), 1)
        self.assertTrue(lines[0].startswith("formula:"))

    def test_unknown_type_emits_the_whole_table(self) -> None:
        lines = _teaching_page_type_guidance_lines(["unknown", "concept"])
        self.assertEqual(len(lines), len(TEACHING_PAGE_TYPE_GUIDANCE))

    def test_titles_come_from_document_context_and_target_pages(self) -> None:
        titles = _teaching_page_titles(
            {"documentContext": {"pages": [{"page_no": 4, "title": "Routh"}, {"page_no": 6, "title": "Rules"}]}},
            [{"page_no": 5, "teaching": {"slide_title": "Root locus"}}],
        )
        self.assertEqual(titles, {4: "Routh", 5: "Root locus", 6: "Rules"})


class TeachingSinglePagePromptTest(unittest.TestCase):

    def test_prompt_carries_skeleton_page_type_and_guidance(self) -> None:
        prompt = _build_teaching_generation_prompt(_single_page_body())
        self.assertIn("## 这页在讲什么", prompt)
        self.assertIn("## 考试怎么考", prompt)
        self.assertIn("page_type: formula", prompt)
        self.assertIn("formula: formula or derivation page.", prompt)
        # a known page type must not drag the whole guidance table into the prompt
        self.assertNotIn("blank: blank or decorative page.", prompt)

    def test_unknown_page_type_asks_the_model_to_classify(self) -> None:
        body = _single_page_body()
        body["page"]["source"].pop("page_type")
        prompt = _build_teaching_generation_prompt(body)
        self.assertIn("page_type: unknown", prompt)
        self.assertIn("blank: blank or decorative page.", prompt)
        self.assertIn("return your classification as source.page_type", prompt)

    def test_english_prompt_uses_english_headings(self) -> None:
        prompt = _build_teaching_generation_prompt(_single_page_body(outputLanguage="en-US"))
        self.assertIn("## Where students get stuck", prompt)
        self.assertNotIn("## 容易卡住的地方", prompt)

    def test_neighbor_titles_fall_back_to_document_context(self) -> None:
        body = _single_page_body(
            documentContext={"pages": [{"page_no": 4, "title": "Routh-Hurwitz"}, {"page_no": 6, "title": "Root locus rules"}]}
        )
        prompt = _build_teaching_generation_prompt(body)
        self.assertIn("previous_page_title: Routh-Hurwitz", prompt)
        self.assertIn("next_page_title: Root locus rules", prompt)


class TeachingBatchPromptTest(unittest.TestCase):

    def _batch_prompt(self) -> str:
        return _build_teaching_generation_prompt(
            {
                "outputLanguage": "zh-CN",
                "pageCount": 12,
                "documentContext": {"pages": [{"page_no": 4, "title": "Routh"}, {"page_no": 7, "title": "Exercises"}]},
                "pages": [
                    {"page_no": 5, "source": {"page_type": "concept", "text_md": "first target text"}},
                    {"page_no": 6, "source": {"page_type": "figure", "text_md": "second target text"}},
                ],
            }
        )

    def test_skeleton_is_emitted_once_for_the_whole_batch(self) -> None:
        prompt = self._batch_prompt()
        self.assertEqual(prompt.count("## 这页在讲什么"), 1)
        self.assertEqual(prompt.count("## 考试怎么考"), 1)

    def test_each_target_page_declares_its_page_type(self) -> None:
        prompt = self._batch_prompt()
        self.assertIn("page_type: concept", prompt)
        self.assertIn("page_type: figure", prompt)
        self.assertEqual(prompt.count("concept: definition or theory page."), 1)
        self.assertEqual(prompt.count("figure: figure or diagram page."), 1)

    def test_batch_pages_get_neighbor_titles(self) -> None:
        prompt = self._batch_prompt()
        self.assertIn("previous_page_title: Routh", prompt)
        self.assertIn("next_page_title: Exercises", prompt)

    def test_batch_prompt_keeps_the_single_json_contract(self) -> None:
        prompt = self._batch_prompt()
        self.assertEqual(prompt.count('"page_no":"<target_page_no>"'), 1)
        self.assertEqual(prompt.count('"speaker_notes_md"'), 1)
        self.assertEqual(prompt.count('"stuck_points"'), 1)
        self.assertEqual(prompt.count('"exam_angles"'), 1)
        self.assertNotIn('"concepts"', prompt)
        self.assertNotIn('"evidence"', prompt)


class TeachingFastPathUnchangedTest(unittest.TestCase):

    def test_fast_prompt_has_no_skeleton_or_guidance(self) -> None:
        prompt = _build_teaching_generation_prompt(
            {
                "model": "gpt-5.4-mini",
                "qualityPlan": {
                    "model": "gpt-5.4-mini",
                    "reasoningEffort": "none",
                    "attachPdf": False,
                    "batchable": True,
                },
                "page": {"page_no": 1, "source": {"text_md": "overview", "pdf_page_ref": "#page=1"}},
            }
        )
        self.assertIn("Pages JSONL:", prompt)
        self.assertNotIn("## 容易卡住的地方", prompt)
        self.assertNotIn("Page-type guidance", prompt)
        self.assertNotIn("Document:", prompt)


if __name__ == "__main__":
    unittest.main()
