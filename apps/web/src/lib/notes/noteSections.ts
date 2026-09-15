/**
 * Split a page's teaching notes (speaker_notes_md) into the sections the
 * backend skeleton defines, so the reader can style each one: the plain
 * one-sentence lead as a callout, the "one thing to remember" as a marked
 * line, the self-check answer folded away. Notes without headings (older
 * generations, fast-path output, the no-text fallback) come back as a single
 * untyped section and render exactly as before.
 *
 * Pure module: no React, no DOM.
 */

export type NoteSectionKey =
  | "lead"
  | "symbols"
  | "example"
  | "keep"
  | "stuck"
  | "formula"
  | "visual"
  | "entry"
  | "selfcheck"
  | "exam"
  | "check"
  | "bridge";

export type NoteSection = {
  key: NoteSectionKey | null;
  /** Heading text without the leading "## " and without a trailing qualifier such as "（公式页）". */
  heading: string;
  /** Markdown body of the section. */
  body: string;
  /** For the self-check section: the answer markdown, shown folded. */
  answer?: string;
};

const HEADING_KEYS: Array<[string, NoteSectionKey]> = [
  ["一句话", "lead"],
  ["In one sentence", "lead"],
  ["符号与术语", "symbols"],
  ["Symbols and terms", "symbols"],
  ["举个例子", "example"],
  ["Try it on an example", "example"],
  ["记住这一条", "keep"],
  ["The one thing to remember", "keep"],
  ["容易错的地方", "stuck"],
  ["Easy to get wrong", "stuck"],
  ["公式怎么读", "formula"],
  ["Reading the formula", "formula"],
  ["图怎么看", "visual"],
  ["Reading the figure or table", "visual"],
  ["解题入口", "entry"],
  ["How to start the problem", "entry"],
  ["自测清单", "selfcheck"],
  ["Self-check list", "selfcheck"],
  ["考试怎么考", "exam"],
  ["How exams test this", "exam"],
  ["自测一问", "check"],
  ["Check yourself", "check"],
  ["和前后页的关系", "bridge"],
  ["Links to neighbouring pages", "bridge"],
  // Headings written by the previous prompt; keep older notes styled.
  ["这页在讲什么", "lead"],
  ["What this page establishes", "lead"],
  ["容易卡住的地方", "stuck"],
  ["Where students get stuck", "stuck"],
  ["图表怎么看", "visual"],
  ["前后衔接", "bridge"],
];

const ANSWER_LINE = /^(答案[:：]|Answer:)\s*/;

export function noteSectionKey(headingText: string): NoteSectionKey | null {
  const text = headingText.trim();
  for (const [prefix, key] of HEADING_KEYS) {
    if (text.toLowerCase().startsWith(prefix.toLowerCase())) return key;
  }
  return null;
}

function cleanHeading(headingText: string) {
  return headingText.replace(/\s*[（(][^）)]*[）)]\s*$/, "").trim();
}

export function splitNoteSections(markdown: string): NoteSection[] {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const sections: NoteSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  let inFence = false;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if (!current.heading && !body) {
      current = null;
      return;
    }
    const key = current.heading ? noteSectionKey(current.heading) : null;
    const section: NoteSection = { key, heading: cleanHeading(current.heading), body };
    if (key === "check") {
      const bodyLines = body.split("\n");
      const answerAt = bodyLines.findIndex((line) => ANSWER_LINE.test(line.trim()));
      if (answerAt >= 0) {
        section.body = bodyLines.slice(0, answerAt).join("\n").trim();
        section.answer = [bodyLines[answerAt].trim().replace(ANSWER_LINE, ""), ...bodyLines.slice(answerAt + 1)]
          .join("\n")
          .trim();
      }
    }
    sections.push(section);
    current = null;
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence && /^##\s+\S/.test(line) && !/^###/.test(line) ? line.replace(/^##\s+/, "").trim() : null;
    if (heading !== null) {
      flush();
      current = { heading, lines: [] };
      continue;
    }
    if (!current) current = { heading: "", lines: [] };
    current.lines.push(line);
  }
  flush();
  return sections;
}

const ANSWER_QUOTE_LINE = /^>\s*(答案|Answer)\s*[:：]/;

/**
 * Make the answer of a self-check device its own paragraph inside the quote:
 * "> **自测：** q\n> 答案：a" becomes "> **自测：** q\n>\n> 答案：a", so the
 * renderer can fold the answer without splitting text nodes.
 */
export function prepareNoteMarkdown(markdown: string) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  for (const line of lines) {
    const previous = output[output.length - 1] ?? "";
    if (ANSWER_QUOTE_LINE.test(line) && /^>\s*\S/.test(previous)) output.push(">");
    output.push(line);
  }
  return output.join("\n");
}
