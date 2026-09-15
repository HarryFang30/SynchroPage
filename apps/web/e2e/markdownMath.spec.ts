import { test, expect } from "@playwright/test";
import { protectTableMathBars } from "../src/lib/markdown/mathMarkdown";
import { renderMarkdown } from "./helpers/renderMarkdown";

// The math pipeline is checked on the strings a model actually writes: the
// notes that used to break (well-formed LaTeX that the old string repair
// corrupted), the two delimiter dialects, currency, CJK punctuation, tables,
// and malformed input that must stay a local blemish.

const tex = (rendered: { formulas: { tex: string }[] }) => rendered.formulas.map((formula) => formula.tex);

test.describe("markdown math rendering", () => {
  test("a displayed equation on its own line renders as display math and the prose after it is intact", async () => {
    const rendered = await renderMarkdown(
      "The empirical risk is\n\n$$R_n(\\bar{\\theta}) = \\frac{1}{n}\\sum_{i=1}^{n} \\frac{(y^{(i)} - (\\bar{\\theta} \\cdot \\bar{x}^{(i)}))^2}{2}.$$\n\nThe $1/n$ is still just an average; it does not change the minimizing $\\bar{\\theta}$, but it keeps the risk scale comparable.",
    );
    expect(rendered.formulas.map((formula) => [formula.tex, formula.display])).toEqual([
      ["R_n(\\bar{\\theta}) = \\frac{1}{n}\\sum_{i=1}^{n} \\frac{(y^{(i)} - (\\bar{\\theta} \\cdot \\bar{x}^{(i)}))^2}{2}.", true],
      ["1/n", false],
      ["\\bar{\\theta}", false],
    ]);
    expect(rendered.prose).toBe("The empirical risk is The is still just an average; it does not change the minimizing , but it keeps the risk scale comparable.");
    expect(rendered.html).not.toContain("katex-error");
  });

  test("inline math followed by a closing parenthesis does not swallow the sentence", async () => {
    const rendered = await renderMarkdown(
      "Plot $\\mathrm{Loss}(z)$ against $z$. Near $z=0$ the curve is flat-ish and grows gently. So a residual of $1$ costs only $1/2$, while a residual of $10$ costs $50$. Large deviations dominate.",
    );
    expect(tex(rendered)).toEqual(["\\mathrm{Loss}(z)", "z", "z=0", "1", "1/2", "10", "50"]);
    expect(rendered.prose).toContain("the curve is flat-ish and grows gently");
    expect(rendered.prose).toContain("Large deviations dominate.");
  });

  test("TeX-style \\( \\) and \\[ \\] delimiters render, inline and on their own line", async () => {
    const inline = await renderMarkdown("Then \\(R_n(\\theta)\\) is minimized where \\[\\nabla R_n(\\theta) = 0.\\] holds.");
    expect(inline.formulas.map((formula) => [formula.tex, formula.display])).toEqual([
      ["R_n(\\theta)", false],
      ["\\nabla R_n(\\theta) = 0.", false],
    ]);
    expect(inline.prose).toBe("Then is minimized where holds.");

    const block = await renderMarkdown("The gradient vanishes:\n\n\\[\n\\nabla R_n(\\theta) = 0\n\\]\n\nand \\[a=b\\]");
    expect(block.formulas.map((formula) => [formula.tex, formula.display])).toEqual([
      ["\\nabla R_n(\\theta) = 0", true],
      ["a=b", false],
    ]);
  });

  test("a $$ fence interrupts a paragraph and lives inside a blockquote", async () => {
    const rendered = await renderMarkdown(
      "The risk is\n$$\nR_n = \\tfrac{1}{n}\\sum z_i^2\n$$\nnext line\n\n> **例子：** 残差从 1 变到 10：\n> $$\n> \\tfrac{1}{2}\\cdot 10^2 = 50\n> $$\n> 是一百倍。",
    );
    expect(rendered.formulas.map((formula) => [formula.tex, formula.display])).toEqual([
      ["R_n = \\tfrac{1}{n}\\sum z_i^2", true],
      ["\\tfrac{1}{2}\\cdot 10^2 = 50", true],
    ]);
    expect(rendered.html).toContain("<blockquote>");
    expect(rendered.prose).toContain("next line");
    expect(rendered.prose).toContain("是一百倍。");
  });

  test("a single-line $$ formula in a paragraph of its own is displayed, punctuation included", async () => {
    const rendered = await renderMarkdown("先看定义。\n\n$$z = y - \\bar{\\theta} \\cdot \\bar{x}$$。\n\n这就是残差。");
    expect(rendered.formulas.map((formula) => [formula.tex, formula.display])).toEqual([["z = y - \\bar{\\theta} \\cdot \\bar{x}。", true]]);
    expect(rendered.prose).toBe("先看定义。 这就是残差。");
  });

  test("$$ inside a sentence stays inline, as DeepSeek writes it", async () => {
    const rendered = await renderMarkdown("严格地说，应写作 $$T(n) \\in O(f(n))$$，表示 $T(n)$ 属于这个集合。");
    expect(rendered.formulas.map((formula) => [formula.tex, formula.display])).toEqual([
      ["T(n) \\in O(f(n))", false],
      ["T(n)", false],
    ]);
    expect(rendered.prose).toBe("严格地说，应写作 ，表示 属于这个集合。");
  });

  test("CJK punctuation right after a formula stays prose", async () => {
    const rendered = await renderMarkdown("在 $p$ 维空间里，$\\bar{\\theta} \\cdot \\bar{x}$ 是一个数。所以 $z=0$。若 $000 \\to 001 \\to \\cdots \\to 111$，则回到起点；");
    expect(tex(rendered)).toEqual(["p", "\\bar{\\theta} \\cdot \\bar{x}", "z=0", "000 \\to 001 \\to \\cdots \\to 111"]);
    expect(rendered.prose).toBe("在 维空间里， 是一个数。所以 。若 ，则回到起点；");
    expect(rendered.html).not.toContain("katex-error");
  });

  test("dollar amounts are not math", async () => {
    const plain = await renderMarkdown("It costs $5 and $10 later, but $x^2$ is math.");
    expect(tex(plain)).toEqual(["x^2"]);
    expect(plain.prose).toBe("It costs $5 and $10 later, but is math.");

    const mixed = await renderMarkdown("Pay $5, and $x$ is the rate; $ y $ and $ z$ are padded, $w $ is not.");
    // `$ z$` keeps its leading space (padding is stripped only when both sides
    // carry it, as for code spans); KaTeX ignores it.
    expect(tex(mixed)).toEqual(["x", "y", " z"]);
    expect(mixed.prose).toBe("Pay $5, and is the rate; and are padded, $w $ is not.");

    const escaped = await renderMarkdown("Write \\$5 for money and $5$ for the number.");
    expect(tex(escaped)).toEqual(["5"]);
    expect(escaped.prose).toBe("Write $5 for money and for the number.");
  });

  test("an unterminated delimiter is one literal character, not the rest of the page", async () => {
    const rendered = await renderMarkdown(
      "Open \\[ never closed, and $x also open here. The gradient $\\nabla R$ still renders.\n\nNext paragraph keeps $y$ and \\(z\\).",
    );
    expect(tex(rendered)).toEqual(["\\nabla R", "y", "z"]);
    expect(rendered.prose).toBe("Open [ never closed, and $x also open here. The gradient still renders. Next paragraph keeps and .");
  });

  test("a formula KaTeX cannot parse is marked as an error and the page goes on", async () => {
    const rendered = await renderMarkdown("Broken $\\frac{a$ here, fine $b^2$ there.");
    expect(rendered.formulas.map((formula) => [formula.tex, formula.error])).toEqual([
      ["\\frac{a", true],
      ["b^2", false],
    ]);
    expect(rendered.prose).toBe("Broken here, fine there.");
  });

  test("TeX line breaks and nested braces survive inside display math", async () => {
    const rendered = await renderMarkdown("\\[\na = b \\\\[1em]\nc = d\n\\]\n\n$$\n\\begin{cases} 1 & x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}\n$$");
    expect(rendered.formulas.map((formula) => [formula.tex, formula.display])).toEqual([
      ["a = b \\\\[1em]\nc = d", true],
      ["\\begin{cases} 1 & x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}", true],
    ]);
    expect(rendered.html).not.toContain("katex-error");
  });

  test("code spans and code blocks are never math, and math is never emphasis", async () => {
    const rendered = await renderMarkdown(
      "Use `$HOME` and `\\(x\\)` in code, and $y$ in math.\n\n```\n$not math$\n```\n\nso $a_1 x_2 y_3$ and *emph* and $a*b*c$ ok",
    );
    expect(tex(rendered)).toEqual(["y", "a_1 x_2 y_3", "a*b*c"]);
    expect(rendered.html).toContain("<code>$HOME</code>");
    expect(rendered.html).toContain("<code>\\(x\\)</code>");
    expect(rendered.html).toContain("$not math$");
    expect(rendered.html).toContain("<em>emph</em>");
  });

  test("vertical bars inside table-cell math do not split the table", async () => {
    const table = [
      "| 比较项 | $T = 3$ | $T = 7$ |",
      "| --- | --- | --- |",
      "| 能量密度 | $|X(\\omega)|^2$ | $|Y(\\omega)|^2$ |",
    ].join("\n");
    expect(protectTableMathBars(protectTableMathBars(table))).toBe(protectTableMathBars(table));
    expect(protectTableMathBars("no table here: $|x|$")).toBe("no table here: $|x|$");
    const rendered = await renderMarkdown(table);
    expect(tex(rendered)).toEqual(["T = 3", "T = 7", "\\lvert{}X(\\omega)\\rvert{}^2", "\\lvert{}Y(\\omega)\\rvert{}^2"]);
    expect((rendered.html.match(/<td>/g) || []).length).toBe(3);
    expect(rendered.html).not.toContain("katex-error");
  });

  test("inline contexts demote display math", async () => {
    const rendered = await renderMarkdown("Loss $$\\tfrac{1}{2}z^2$$ per point", { inline: true });
    expect(rendered.formulas.map((formula) => [formula.tex, formula.display])).toEqual([["\\tfrac{1}{2}z^2", false]]);
    // The paragraph element itself is dropped by the React component's `p` renderer.
    const block = await renderMarkdown("$$\nz^2\n$$", { inline: true });
    expect(block.formulas.map((formula) => [formula.tex, formula.display])).toEqual([["z^2", false]]);
  });

  test("well-formed notes pass through unchanged: every formula reaches KaTeX verbatim", async () => {
    const formulas = [
      "\\hat{y} = \\bar{\\theta}^{\\top} \\bar{x}",
      "\\nabla_{\\bar{\\theta}} R_n(\\bar{\\theta}) = -\\frac{1}{n}\\sum_{i=1}^{n} (y^{(i)} - \\bar{\\theta}\\cdot\\bar{x}^{(i)})\\,\\bar{x}^{(i)}",
      "\\mathbf{X}^{\\top}\\mathbf{X}\\,\\bar{\\theta} = \\mathbf{X}^{\\top}\\mathbf{y}",
      "\\lVert \\bar{x} \\rVert_2^2",
      "\\operatorname{Loss}(z) = \\tfrac{1}{2} z^2",
      "2^n",
      "0.5",
      "P(A \\mid B) = \\frac{P(B \\mid A) P(A)}{P(B)}",
    ];
    const text = formulas.map((formula, index) => (index % 2 ? `第 ${index} 步：$${formula}$，然后继续。` : `$$\n${formula}\n$$`)).join("\n\n");
    const rendered = await renderMarkdown(text);
    expect(tex(rendered)).toEqual(formulas);
    expect(rendered.formulas.map((formula) => formula.display)).toEqual(formulas.map((_, index) => index % 2 === 0));
    expect(rendered.html).not.toContain("katex-error");
  });
});
