import { test, expect } from "@playwright/test";
import { sourceTextLooksGarbled, sourceTextQuality } from "../src/lib/pdf/textQuality";

// Pure-function checks for the unreadable-text-layer detector. The garbled
// samples are PDF.js extractions of slides whose formulas are drawn with an
// embedded font (EECS 445 Lecture 4); the readable ones are prose, code and
// tables that legitimately leave symbols and digits standing alone.

test.describe("source text quality", () => {
  test("stray glyph symbols around formulas flag the page", () => {
    expect(sourceTextLooksGarbled("Gradient Descent (GD)\n! = 0 , ̅ & (\") = ' 0\nwhile convergence criteria is not met")).toBe(true);
    expect(sourceTextLooksGarbled("Least Squares Loss function\nIdea: permit small discrepancies\nSquared Loss:\nLoss(z) = 9 ! :")).toBe(true);
    expect(sourceTextLooksGarbled("Find gradient, set to 0 and solve for ̅ \"\n. / A\ndimension: d x 1 ̅\n\" ∗ = $ %& & '\ndimension: d x d")).toBe(true);
    const quality = sourceTextQuality("Loss(z) = 9 ! :");
    expect(quality.junkTokens).toBe(3);
    expect(quality.samples).toEqual(["9", "!", ":"]);
  });

  test("private-use glyphs and cid markers flag the page on their own", () => {
    expect(sourceTextLooksGarbled("(cid:12)(cid:40) (cid:3) hello")).toBe(true);
    expect(sourceTextLooksGarbled("  text")).toBe(true);
    expect(sourceTextQuality("  text").hardMarkers).toBe(3);
  });

  test("prose, code, tables and detached accents stay readable", () => {
    for (const text of [
      "Q & A",
      "C++ & Java: 50% faster & cheaper than # of Python tools",
      "if x > 0 then y < 10 else z = -1",
      "Step 1: read. Step 2: write! Step 3: test?",
      "Revenue 2019 2020 2021 10 20 30",
      "a) first b) second (1) third",
      "for (i = 0; i < n; i++) { sum += a[i]; }",
      "P(A | B) = P(A, B) / P(B) where B != 0",
      // PDF.js splits ĥ into a detached hat and its letter in perfectly good papers.
      "( ̂ H hist t , ̂ ℓ hist t , M t ) = HistoryHead ( O t , ̂ P t )",
      "",
    ]) {
      expect(sourceTextLooksGarbled(text), text).toBe(false);
    }
    expect(sourceTextQuality("").tokens).toBe(0);
  });
});
