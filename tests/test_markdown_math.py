"""Edge-case tests for markdown_math JSON/LaTeX repair utilities."""

from __future__ import annotations

import json
import unittest

from pdf_agent.server.json_utils import repair_unicode_surrogates_text
from pdf_agent.server.markdown_math import (
    json_loads_with_latex_repair,
    normalize_markdown_math,
    repair_json_string_backslashes,
)


class JsonLatexRepairTest(unittest.TestCase):
    """Tests for repair_json_string_backslashes and json_loads_with_latex_repair."""

    # -- escaped quote inside JSON string -----------------------------------

    def test_escaped_quote_inside_json_string_is_preserved(self) -> None:
        # Backslash-escaped quote should NOT be modified
        text = r'{"notes": "He said \"x\" and \frac{1}{2}"}'
        repaired = repair_json_string_backslashes(text)
        # The \" before and after x should stay
        self.assertIn(r'\"x\"', repaired)
        # \frac should be doubled to \\frac
        self.assertIn(r'\\frac', repaired)
        value = json.loads(repaired)
        self.assertIn(r"\frac{1}{2}", value["notes"])

    # -- valid JSON unicode escape (real 中 in source) -------------------

    def test_unicode_escape_u4e2d_preserved(self) -> None:
        # The source text has 中 as a 6-char ASCII JSON unicode escape
        # (NOT the literal character).  The repair must leave it untouched.
        # Use chr(92) for backslash so the \u sequence is never literal in
        # this source file, preventing toolchain interpretation.
        BS = chr(92)
        text = '{"char": "' + BS + 'u4e2d"}'
        repaired = repair_json_string_backslashes(text)
        self.assertIn(BS + "u4e2d", repaired)
        self.assertNotIn(BS + BS + "u4e2d", repaired)
        value = json.loads(repaired)
        self.assertEqual(value["char"], "中")

    # -- valid JSON escapes -------------------------------------------------

    def test_json_escape_newline_tab_backslash_not_broken(self) -> None:
        text = r'{"line": "a\nb\tc\\d"}'
        repaired = repair_json_string_backslashes(text)
        value = json.loads(repaired)
        self.assertEqual(value["line"], "a\nb\tc\\d")

    # -- lone surrogate -----------------------------------------------------

    def test_lone_surrogate_ud835_replaced(self) -> None:
        # A lone high surrogate that can't form a pair
        text = '{"math": "\\ud835"}'
        repaired = repair_json_string_backslashes(text)
        # \ud835 is 6 chars starting with \u and 4 hex digits — it matches
        # _is_json_unicode_escape, so it's preserved as-is in JSON repair.
        # The actual surrogate repair happens separately via
        # repair_unicode_surrogates_text.
        self.assertIn(r"\ud835", repaired)

    # -- surrogate pair -----------------------------------------------------

    def test_surrogate_pair_ud835_udc47_is_valid_unicode_escape(self) -> None:
        # 𝑇 is the JSON surrogate pair for MATHEMATICAL SCRIPT
        # CAPITAL T (U+1D447).  Both halves must survive JSON repair and
        # be combined into the real character by repair_unicode_surrogates_text.
        # Use chr(92) so the \u sequences are never literal in this source file.
        BS = chr(92)
        text = '{"math": "' + BS + 'ud835' + BS + 'udc47"}'
        # Step 1: JSON repair must preserve the surrogate escapes
        repaired = repair_json_string_backslashes(text)
        self.assertIn(BS + "ud835" + BS + "udc47", repaired)
        # Step 2: json.loads resolves the surrogate pair to 𝑇
        value = json.loads(repaired)
        self.assertEqual(value["math"], "\U0001D447")
        # Step 3: repair_unicode_surrogates_text is a no-op for already-valid chars
        self.assertEqual(repair_unicode_surrogates_text(value["math"]), "\U0001D447")

    # -- regression: LaTeX commands inside JSON strings ---------------------
    # These used to be silently corrupted because json_loads_with_latex_repair
    # tried json.loads first, and \times / \text / \frac / \theta / \tau /
    # \nabla etc. are syntactically valid JSON escape sequences.

    def test_latex_times_survives_json_parse(self) -> None:
        text = r'{"notes": "E $\times 16^2 + 3 \times 16^1$"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn(r"\times", value["notes"])
        self.assertNotIn("\t", value["notes"])
        self.assertIn("16^2", value["notes"])
        self.assertIn("16^1", value["notes"])

    def test_latex_text_survives_json_parse(self) -> None:
        text = r'{"notes": "$- \text{组合电路}$"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn(r"\text", value["notes"])
        self.assertNotIn("\t", value["notes"])
        self.assertIn("组合电路", value["notes"])

    def test_latex_frac_survives_json_parse(self) -> None:
        text = r'{"notes": "\frac{1}{T}"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn(r"\frac", value["notes"])
        self.assertNotIn("\f", value["notes"])
        self.assertIn("{1}", value["notes"])
        self.assertIn("{T}", value["notes"])

    def test_latex_theta_survives_json_parse(self) -> None:
        # \theta starts with \t which is a valid JSON tab escape
        text = r'{"notes": "\theta"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn(r"\theta", value["notes"])
        self.assertNotIn("\t", value["notes"])

    def test_latex_tau_survives_json_parse(self) -> None:
        text = r'{"notes": "\tau"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn(r"\tau", value["notes"])
        self.assertNotIn("\t", value["notes"])

    def test_latex_nabla_survives_json_parse(self) -> None:
        # \nabla starts with \n which is a valid JSON newline escape
        text = r'{"notes": "\nabla"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn(r"\nabla", value["notes"])
        self.assertNotIn("\n", value["notes"])

    # -- valid JSON escapes must still work ---------------------------------

    def test_json_newline_escape_still_works(self) -> None:
        # \n is a real JSON newline escape and must NOT be "repaired" to \\n
        text = r'{"notes": "\n real newline"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn("\n", value["notes"])
        self.assertNotIn(r"\n", value["notes"])

    def test_json_tab_escape_still_works(self) -> None:
        # Standalone \t (not followed by a LaTeX command) is a real JSON tab
        text = r'{"notes": "a\tb"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn("\t", value["notes"])
        self.assertNotIn(r"\t", value["notes"])

    # -- already-correct JSON must not be double-repaired -------------------

    def test_already_escaped_times_not_double_repaired(self) -> None:
        # \\times in JSON source = literal \times — must stay that way
        text = r'{"notes": "E $\\times 16^2$"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn(r"\times", value["notes"])
        self.assertNotIn(r"\\times", value["notes"])

    def test_already_escaped_frac_not_double_repaired(self) -> None:
        text = r'{"notes": "$\\frac{a}{b}$"}'
        value = json_loads_with_latex_repair(text)
        self.assertIn(r"\frac", value["notes"])
        self.assertNotIn(r"\\frac", value["notes"])

    # -- regression: formula examples from real user reports ---------------

    def test_regression_dollar_numbers_not_broken(self) -> None:
        text = '{"notes": "$0, 1, 2, 3, 4$"}'
        value = json_loads_with_latex_repair(text)
        self.assertEqual(value["notes"], "$0, 1, 2, 3, 4$")

    def test_regression_display_in_not_broken(self) -> None:
        text = r'{"notes": "$$\in$$"}'
        value = json_loads_with_latex_repair(text)
        self.assertEqual(value["notes"], r"$$\in$$")

    # -- empty / non-string edge cases --------------------------------------

    def test_normalize_markdown_math_empty_and_non_string(self) -> None:
        self.assertEqual(normalize_markdown_math(""), "")
        self.assertEqual(
            normalize_markdown_math("plain text no math"), "plain text no math"
        )

    # -- code fence preservation --------------------------------------------

    def test_normalize_markdown_math_preserves_code_fences(self) -> None:
        value = "```\n$not math$\n```\nreal $math$ here"
        result = normalize_markdown_math(value)
        self.assertIn("```\n$not math$\n```", result)
        self.assertIn("$math$", result)


if __name__ == "__main__":
    unittest.main()
