"""Tests for the teaching prompt: teacher instructions, lesson-plan context, devices.

A page is taught as part of a segment of the lesson plan, at the depth the plan
assigned, as continuous prose with at most two labelled teaching devices.
"""

from __future__ import annotations

import unittest

from pdf_agent.server.constants import (
    TEACHING_DEVICE_LABELS,
    TEACHING_GENERATOR_INSTRUCTIONS,
    TEACHING_PLANNER_INSTRUCTIONS,
)
from pdf_agent.server.payload_builders import (
    _build_teaching_generation_prompt,
    _teaching_lesson_plan_lines,
    _teaching_page_output_contract,
    _teaching_page_titles,
    _teaching_page_type,
    _teaching_plan_rows,
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


def _lesson_plan(**overrides):
    plan = {
        "document_summary": "Root locus for closed-loop stability.",
        "segment": {"id": 2, "title": "Characteristic equation", "pages": [4, 6], "goal": "Derive the locus condition."},
        "pages": [
            {"page_no": 4, "role": "concept", "depth": "brief", "key": False, "cue": "recap of 1+KGH=0"},
            {"page_no": 5, "role": "derivation", "depth": "full", "key": True, "cue": "first derivation; show the angle condition"},
            {"page_no": 6, "role": "transition", "depth": "skim", "key": False, "cue": "section title only"},
        ],
        "handoff": "The student can write 1+KGH=0 and knows K is the free gain.",
    }
    plan.update(overrides)
    return plan


class TeachingInstructionsTest(unittest.TestCase):

    def test_frames_the_task_as_teaching_not_form_filling(self) -> None:
        self.assertIn("You are the SynchroPage teaching assistant", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("not filling in a form for every page", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("never use fixed openers", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("do not comment on every page's place in the course", TEACHING_GENERATOR_INSTRUCTIONS)

    def test_states_the_three_depths_and_the_key_allowance(self) -> None:
        for tier in ("- skim:", "- brief:", "- full:"):
            self.assertIn(tier, TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("at most 40 Chinese characters", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("80 to 200 Chinese characters", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("300 to 800 Chinese characters", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("marks key may run to 1200", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("cut until it fits", TEACHING_GENERATOR_INSTRUCTIONS)

    def test_bounds_the_devices(self) -> None:
        self.assertIn("at most two per page; none on a skim page; at most one on a brief page", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn("Use no other blockquotes and no headings.", TEACHING_GENERATOR_INSTRUCTIONS)

    def test_forbids_claiming_knowledge_of_a_real_exam(self) -> None:
        self.assertIn(
            "Never claim knowledge of a specific real exam, a past paper, a syllabus, or what an instructor said",
            TEACHING_GENERATOR_INSTRUCTIONS,
        )

    def test_preserves_the_latex_json_escaping_rules(self) -> None:
        self.assertIn(r"for example write \\frac and \\to.", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn(r"write 2^n, not \2^n", TEACHING_GENERATOR_INSTRUCTIONS)
        self.assertIn(r"$000 \to 001 \to 010 \to \cdots \to 111 \to 000$", TEACHING_GENERATOR_INSTRUCTIONS)

    def test_does_not_collide_with_the_json_contract_keys(self) -> None:
        for quoted_key in ('"concepts"', '"evidence"', '"speaker_notes_md"'):
            self.assertNotIn(quoted_key, TEACHING_GENERATOR_INSTRUCTIONS)


class PlannerInstructionsTest(unittest.TestCase):

    def test_describes_segments_depths_and_key_pages(self) -> None:
        self.assertIn("which pages form one segment", TEACHING_PLANNER_INSTRUCTIONS)
        self.assertIn('"depth": "skim|brief|full"', TEACHING_PLANNER_INSTRUCTIONS)
        self.assertIn("key marks only the 2 to 4 pages", TEACHING_PLANNER_INSTRUCTIONS)
        self.assertIn("Return exactly one row for every page", TEACHING_PLANNER_INSTRUCTIONS)
        self.assertIn("{language}", TEACHING_PLANNER_INSTRUCTIONS)


class DeviceLabelsTest(unittest.TestCase):

    def test_both_languages_declare_the_same_devices(self) -> None:
        self.assertEqual(set(TEACHING_DEVICE_LABELS), {"zh-CN", "en-US"})
        self.assertEqual(set(TEACHING_DEVICE_LABELS["zh-CN"]), {"remember", "example", "trap", "exam", "check", "answer"})
        self.assertEqual(set(TEACHING_DEVICE_LABELS["zh-CN"]), set(TEACHING_DEVICE_LABELS["en-US"]))
        self.assertEqual(TEACHING_DEVICE_LABELS["zh-CN"]["remember"], "记住")
        self.assertEqual(TEACHING_DEVICE_LABELS["en-US"]["answer"], "Answer")


class TeachingOutputContractTest(unittest.TestCase):

    def test_contract_declares_handoff_and_the_quiz_arrays(self) -> None:
        contract = _teaching_page_output_contract(5)
        self.assertEqual(contract["source"]["page_type"].split("|")[0], "title")
        self.assertIn("handoff", contract["teaching"])
        self.assertIn("stuck_points", contract["teaching"])
        self.assertIn("exam_angles", contract["teaching"])

    def test_contract_stays_minimal(self) -> None:
        contract = _teaching_page_output_contract(5)
        self.assertNotIn("concepts", contract["teaching"])
        self.assertNotIn("evidence", contract["teaching"])


class TeachingPromptRulesTest(unittest.TestCase):

    def test_chinese_rules_name_the_chinese_labels(self) -> None:
        rules = "\n".join(_teaching_prompt_rules({"outputLanguage": "zh-CN"}, batch=False))
        self.assertIn("**记住：** / **例子：** / **别踩坑：** / **考法：** / **自测：**", rules)
        self.assertIn("with 答案：", rules)
        self.assertIn("never with straight double quotes", rules)

    def test_english_rules_name_the_english_labels(self) -> None:
        rules = "\n".join(_teaching_prompt_rules({"outputLanguage": "en-US"}, batch=False))
        self.assertIn("**Remember:** / **Example:** / **Watch out:** / **On the exam:** / **Check yourself:**", rules)
        self.assertIn("with Answer:", rules)

    def test_rules_keep_page_type_handoff_and_the_hidden_arrays(self) -> None:
        rules = "\n".join(_teaching_prompt_rules({}, batch=False))
        self.assertIn("Always return source.page_type", rules)
        self.assertIn("Fill teaching.handoff", rules)
        self.assertIn("teaching.stuck_points with 0-3", rules)
        self.assertIn("teaching.exam_angles with 0-2", rules)
        self.assertIn("never repeated in the prose", rules)

    def test_batch_rule_demands_one_object_per_page(self) -> None:
        rules = "\n".join(_teaching_prompt_rules({}, batch=True))
        self.assertIn("Return exactly one object for each target page", rules)


class LessonPlanRowsTest(unittest.TestCase):

    def test_rows_come_from_the_plan_when_present(self) -> None:
        body = {"lessonPlan": _lesson_plan()}
        rows = _teaching_plan_rows(body, [{"page_no": 5, "source": {"page_type": "formula"}}])
        self.assertEqual(rows[5]["depth"], "full")
        self.assertEqual(rows[5]["role"], "derivation")
        self.assertTrue(rows[5]["key"])
        self.assertTrue(rows[5]["planned"])

    def test_rows_default_from_page_type_without_a_plan(self) -> None:
        rows = _teaching_plan_rows({}, [
            {"page_no": 1, "source": {"page_type": "title"}},
            {"page_no": 2, "source": {"page_type": "formula"}},
            {"page_no": 3, "source": {}},
        ])
        self.assertEqual((rows[1]["role"], rows[1]["depth"]), ("title", "skim"))
        self.assertEqual((rows[2]["role"], rows[2]["depth"]), ("derivation", "full"))
        self.assertEqual((rows[3]["role"], rows[3]["depth"]), ("concept", "full"))
        self.assertFalse(rows[3]["planned"])

    def test_invalid_plan_values_fall_back(self) -> None:
        body = {"lessonPlan": {"pages": [{"page_no": 5, "role": "nonsense", "depth": "huge", "key": True}]}}
        rows = _teaching_plan_rows(body, [{"page_no": 5, "source": {"page_type": "summary"}}])
        self.assertEqual(rows[5]["role"], "summary")
        self.assertEqual(rows[5]["depth"], "brief")

    def test_lines_carry_summary_segment_rows_and_handoff(self) -> None:
        body = {"lessonPlan": _lesson_plan()}
        lines = "\n".join(_teaching_lesson_plan_lines(body, [{"page_no": 5, "source": {}}, {"page_no": 6, "source": {}}]))
        self.assertIn("document_summary: Root locus for closed-loop stability.", lines)
        self.assertIn("segment: Characteristic equation (pages 4-6)", lines)
        self.assertIn("segment_goal: Derive the locus condition.", lines)
        self.assertIn("- p5: role=derivation depth=full key=true — first derivation; show the angle condition", lines)
        self.assertIn("- p6: role=transition depth=skim — section title only", lines)
        self.assertIn("handoff_from_previous_page: The student can write 1+KGH=0", lines)
        self.assertNotIn("No lesson plan was computed", lines)

    def test_lines_explain_the_missing_plan(self) -> None:
        lines = "\n".join(_teaching_lesson_plan_lines({}, [{"page_no": 5, "source": {"page_type": "figure"}}]))
        self.assertIn("No lesson plan was computed for this document.", lines)
        self.assertIn("- p5: role=concept depth=full", lines)
        self.assertIn("handoff_from_previous_page: none", lines)


class TeachingPageTypeHelpersTest(unittest.TestCase):

    def test_page_type_defaults_to_unknown(self) -> None:
        self.assertEqual(_teaching_page_type({"source": {"page_type": "figure"}}), "figure")
        self.assertEqual(_teaching_page_type({"source": {}}), "unknown")
        self.assertEqual(_teaching_page_type({"source": {"page_type": "nonsense"}}), "unknown")

    def test_titles_come_from_document_context_and_target_pages(self) -> None:
        titles = _teaching_page_titles(
            {"documentContext": {"pages": [{"page_no": 4, "title": "Routh"}, {"page_no": 6, "title": "Rules"}]}},
            [{"page_no": 5, "teaching": {"slide_title": "Root locus"}}],
        )
        self.assertEqual(titles, {4: "Routh", 5: "Root locus", 6: "Rules"})


class TeachingSinglePagePromptTest(unittest.TestCase):

    def test_prompt_carries_instructions_plan_and_page(self) -> None:
        prompt = _build_teaching_generation_prompt(_single_page_body(lessonPlan=_lesson_plan()))
        self.assertIn("You are the SynchroPage teaching assistant", prompt)
        self.assertIn("Lesson plan for this request:", prompt)
        self.assertIn("- p5: role=derivation depth=full key=true", prompt)
        self.assertIn("handoff_from_previous_page: The student can write", prompt)
        self.assertIn("Target page:", prompt)
        self.assertIn("page_no: 5", prompt)
        self.assertIn("page_type: formula", prompt)
        self.assertIn("1 + K G(s)H(s) = 0", prompt)
        self.assertNotIn("Section skeleton", prompt)
        self.assertNotIn("Page-type guidance", prompt)
        self.assertNotIn("##", prompt.split("Task-specific instructions:")[1].split("Output language:")[0])

    def test_prompt_without_a_plan_asks_the_model_to_judge_depth(self) -> None:
        prompt = _build_teaching_generation_prompt(_single_page_body())
        self.assertIn("No lesson plan was computed for this document.", prompt)
        self.assertIn("- p5: role=derivation depth=full", prompt)

    def test_english_prompt_uses_english_labels(self) -> None:
        prompt = _build_teaching_generation_prompt(_single_page_body(outputLanguage="en-US"))
        self.assertIn("**Watch out:**", prompt)
        self.assertNotIn("**别踩坑：**", prompt)

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
                "lessonPlan": _lesson_plan(),
                "documentContext": {"pages": [{"page_no": 4, "title": "Routh"}, {"page_no": 7, "title": "Exercises"}]},
                "pages": [
                    {"page_no": 5, "source": {"page_type": "concept", "text_md": "first target text"}},
                    {"page_no": 6, "source": {"page_type": "figure", "text_md": "second target text"}},
                ],
            }
        )

    def test_plan_block_appears_once_with_every_target_row(self) -> None:
        prompt = self._batch_prompt()
        self.assertEqual(prompt.count("Lesson plan for this request:"), 1)
        self.assertIn("- p5: role=derivation depth=full key=true", prompt)
        self.assertIn("- p6: role=transition depth=skim", prompt)
        self.assertNotIn("- p4:", prompt)

    def test_each_target_page_declares_its_page_type(self) -> None:
        prompt = self._batch_prompt()
        self.assertIn("--- Target page 5 ---", prompt)
        self.assertIn("page_type: concept", prompt)
        self.assertIn("page_type: figure", prompt)

    def test_batch_pages_get_neighbor_titles(self) -> None:
        prompt = self._batch_prompt()
        self.assertIn("previous_page_title: Routh", prompt)
        self.assertIn("next_page_title: Exercises", prompt)

    def test_batch_prompt_keeps_the_single_json_contract(self) -> None:
        prompt = self._batch_prompt()
        self.assertEqual(prompt.count('"page_no":"<target_page_no>"'), 1)
        self.assertEqual(prompt.count('"speaker_notes_md"'), 1)
        self.assertEqual(prompt.count('"handoff"'), 1)
        self.assertNotIn('"concepts"', prompt)
        self.assertNotIn('"evidence"', prompt)


if __name__ == "__main__":
    unittest.main()
