/**
 * Runs the app's exact Markdown + math pipeline (same remark and rehype
 * plugins as `MarkdownRenderer`) outside the browser and reports what a
 * reader would see: the LaTeX source of every rendered formula, whether it is
 * displayed, and the prose around them.
 */
import type { Element, ElementContent, Root as HastRoot } from "hast";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import {
  markdownRehypePlugins,
  markdownRemarkPlugins,
  prepareMarkdownForRendering,
} from "../../src/lib/markdown/mathMarkdown";

export type RenderedFormula = { tex: string; display: boolean; error: boolean };

export type RenderedMarkdown = {
  html: string;
  formulas: RenderedFormula[];
  /** Text outside every formula, whitespace collapsed. */
  prose: string;
  tree: HastRoot;
};

export async function renderMarkdown(text: string, options: { inline?: boolean } = {}): Promise<RenderedMarkdown> {
  const processor = unified()
    .use(remarkParse)
    .use(markdownRemarkPlugins(options.inline))
    .use(remarkRehype)
    .use(markdownRehypePlugins);
  const source = prepareMarkdownForRendering(text);
  const tree = (await processor.run(processor.parse(source), source)) as HastRoot;
  const html = unified().use(rehypeStringify).stringify(tree);
  const formulas: RenderedFormula[] = [];
  const proseParts: string[] = [];
  walk(tree.children, formulas, proseParts, false);
  return { html, formulas, prose: proseParts.join("").replace(/\s+/g, " ").trim(), tree };
}

function classes(node: Element): string[] {
  const value = node.properties?.className;
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\s+/) : [];
}

function walk(nodes: ElementContent[], formulas: RenderedFormula[], prose: string[], insideMath: boolean) {
  for (const node of nodes) {
    if (node.type === "text") {
      if (!insideMath) prose.push(node.value);
      continue;
    }
    if (node.type !== "element") continue;
    const names = classes(node);
    if (names.includes("katex")) {
      formulas.push({
        tex: annotation(node) ?? "",
        display: false,
        error: false,
      });
      continue;
    }
    if (names.includes("katex-display")) {
      const before = formulas.length;
      walk(node.children, formulas, prose, insideMath);
      for (let index = before; index < formulas.length; index += 1) formulas[index].display = true;
      continue;
    }
    if (names.includes("katex-error")) {
      formulas.push({ tex: textOf(node), display: false, error: true });
      continue;
    }
    if (node.tagName === "p" || node.tagName === "li" || node.tagName === "td" || node.tagName === "th" || node.tagName === "pre") {
      prose.push(" ");
    }
    walk(node.children, formulas, prose, insideMath);
    if (node.tagName === "p" || node.tagName === "li" || node.tagName === "td" || node.tagName === "th" || node.tagName === "pre") {
      prose.push(" ");
    }
  }
}

function annotation(node: Element): string | undefined {
  if (node.tagName === "annotation") return textOf(node);
  for (const child of node.children) {
    if (child.type !== "element") continue;
    const found = annotation(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function textOf(node: Element): string {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "element") out += textOf(child);
  }
  return out;
}
