/**
 * Markdown + LaTeX for text written by a language model.
 *
 * Math boundaries are found by the markdown tokenizer, not by string repair:
 * `micromark-extension-math-extended` handles `$$ ... $$` fences, `$$x$$`
 * inline and `\( ... \)`; `llmMathText` adds single-dollar math with Pandoc's
 * currency guards and `\[ ... \]` inside a sentence. What the tokenizer marks
 * as math is passed to KaTeX untouched; what it does not is prose. A stray
 * delimiter therefore costs one literal character, never the rest of a page.
 *
 * Two mdast passes finish the job: a paragraph that is nothing but one
 * `$$ ... $$` (or `\[ ... \]`) formula becomes display math, which is how
 * models write displayed equations; in inline contexts (a heading, a chip)
 * display math is demoted to inline.
 *
 * The one string-level step left is `protectTableMathBars`: GFM splits table
 * cells on `|` before inline parsing runs, so a `|x|` inside a table cell has
 * to become `\lvert x \rvert` before the parser sees it.
 */
import { math } from "micromark-extension-math-extended";
import { mathFromMarkdown, mathToMarkdown } from "mdast-util-math";
import type { InlineMath, Math as MathNode } from "mdast-util-math";
import type { Root, RootContent } from "mdast";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import type { PluggableList, Plugin } from "unified";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { llmMathText } from "./llmMathText";

type RemarkData = {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
  toMarkdownExtensions?: unknown[];
};

export const remarkLlmMath: Plugin<[], Root> = function () {
  const data = this.data() as RemarkData;
  (data.micromarkExtensions ??= []).push(math({ singleDollarTextMath: false }), llmMathText());
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdown());
  (data.toMarkdownExtensions ??= []).push(mathToMarkdown({ singleDollarTextMath: true }));
};

const trailingPunctuation = /^[\s.,;:!?。，；：！？]*$/;

/**
 * A paragraph holding a single `$$ ... $$` or `\[ ... \]` formula (optionally
 * followed by a sentence-ending punctuation mark, which moves into the
 * formula the way TeX sets it) is a displayed equation.
 */
export const remarkDisplayMathParagraphs: Plugin<[], Root> = function () {
  return (tree: Root, file: VFile) => {
    const source = String(file);
    visit(tree, "paragraph", (node, index, parent) => {
      if (!parent || index === undefined) return;
      const [first, second, ...rest] = node.children;
      if (!first || first.type !== "inlineMath" || rest.length) return;
      if (second && (second.type !== "text" || !trailingPunctuation.test(second.value))) return;
      const offset = first.position?.start.offset;
      if (offset === undefined) return;
      const opener = source.slice(offset, offset + 2);
      if (opener !== "$$" && opener !== "\\[") return;
      const value = first.value + (second ? second.value.trim() : "");
      parent.children[index] = displayMathNode(value, node);
    });
  };
};

/** Inline contexts cannot hold a block: every displayed formula becomes inline math. */
export const remarkInlineMathOnly: Plugin<[], Root> = function () {
  return (tree: Root) => {
    visit(tree, "math", (node, index, parent) => {
      if (!parent || index === undefined) return;
      parent.children[index] = inlineMathNode(node.value, node) as never;
    });
  };
};

function displayMathNode(value: string, from: RootContent): MathNode {
  return {
    type: "math",
    meta: null,
    value,
    position: from.position,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value }],
        },
      ],
    },
  };
}

function inlineMathNode(value: string, from: RootContent): InlineMath {
  return {
    type: "inlineMath",
    value,
    position: from.position,
    data: {
      hName: "code",
      hProperties: { className: ["language-math", "math-inline"] },
      hChildren: [{ type: "text", value }],
    },
  };
}

const tableRow = /^\s*\|/;
const codeFence = /^\s*(```|~~~)/;
const mathSpanInLine = /\$\$[^\n]*?\$\$|\$(?!\$)(?:\\.|[^$\n])*?\$/g;

/**
 * Inside table rows, turns the `|` of a math span into `\lvert{}` / `\rvert{}`
 * (or `\vert{}` when unpaired) so GFM does not read it as a cell boundary.
 * Rows outside code fences only; idempotent, since the result has no `|`
 * left to replace.
 */
export function protectTableMathBars(text: string): string {
  if (!text.includes("|")) return text;
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (codeFence.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || !tableRow.test(line)) return line;
      return line.replace(mathSpanInLine, replaceBarsInSpan);
    })
    .join("\n");
}

function replaceBarsInSpan(span: string) {
  const positions: number[] = [];
  for (let index = 0; index < span.length; index += 1) {
    if (span[index] === "|" && !isEscapedAt(span, index)) positions.push(index);
  }
  if (!positions.length) return span;
  const paired = positions.length % 2 === 0;
  let output = "";
  let barIndex = 0;
  for (let index = 0; index < span.length; index += 1) {
    if (span[index] === "|" && !isEscapedAt(span, index)) {
      output += paired ? (barIndex % 2 === 0 ? "\\lvert{}" : "\\rvert{}") : "\\vert{}";
      barIndex += 1;
    } else {
      output += span[index];
    }
  }
  return output;
}

function isEscapedAt(text: string, index: number) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

/** The only transformation applied to the source string before parsing. */
export function prepareMarkdownForRendering(text: string): string {
  return protectTableMathBars(text);
}

const blockRemarkPlugins: PluggableList = [remarkGfm, remarkLlmMath, remarkDisplayMathParagraphs];
const inlineRemarkPlugins: PluggableList = [remarkGfm, remarkLlmMath, remarkInlineMathOnly];

export function markdownRemarkPlugins(inline = false): PluggableList {
  return inline ? inlineRemarkPlugins : blockRemarkPlugins;
}

// KaTeX renders a formula it cannot parse as its source, marked `.katex-error`,
// and the rest of the page is unaffected (rehype-katex retries with
// `throwOnError: false`). `strict: false` lets CJK characters and their
// punctuation stand inside math.
export const markdownRehypePlugins: PluggableList = [[rehypeKatex, { errorColor: "currentColor", strict: false }]];
