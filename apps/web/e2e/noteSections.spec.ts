import { test, expect } from "@playwright/test";
import { noteSectionKey, prepareNoteMarkdown, splitNoteSections } from "../src/lib/notes/noteSections";

// Pure-function checks for the notes-pane section splitter.

test.describe("note sections", () => {
  test("notes without headings stay one untyped section", () => {
    const sections = splitNoteSections("These are mocked teaching notes for page 1.");
    expect(sections).toEqual([{ key: null, heading: "", body: "These are mocked teaching notes for page 1." }]);
  });

  test("headings map to section keys in both languages, qualifiers stripped", () => {
    const zh = splitNoteSections("## 一句话\n讲什么。\n\n## 公式怎么读（仅公式页）\n每个符号。\n\n## 考试怎么考\n- 题型\n");
    expect(zh.map((section) => section.key)).toEqual(["lead", "formula", "exam"]);
    expect(zh[1].heading).toBe("公式怎么读");
    const en = splitNoteSections("## In one sentence\nPlain.\n\n## Easy to get wrong\n- **You might think**\n\n## Links to neighbouring pages (only when given)\np.12");
    expect(en.map((section) => section.key)).toEqual(["lead", "stuck", "bridge"]);
    expect(en[2].heading).toBe("Links to neighbouring pages");
    expect(noteSectionKey("Where students get stuck")).toBe("stuck");
    expect(noteSectionKey("这页在讲什么")).toBe("lead");
    expect(noteSectionKey("Something else")).toBeNull();
  });

  test("the self-check answer is split off so the UI can fold it", () => {
    const [check] = splitNoteSections("## 自测一问\n标签连续叫什么？\n答案：回归，记作 $f: \\mathbb{R}^d \\to \\mathbb{R}$。");
    expect(check.key).toBe("check");
    expect(check.body).toBe("标签连续叫什么？");
    expect(check.answer).toBe("回归，记作 $f: \\mathbb{R}^d \\to \\mathbb{R}$。");
    const [english] = splitNoteSections("## Check yourself\nWhich type?\nAnswer: classification.\nBecause labels are discrete.");
    expect(english.answer).toBe("classification.\nBecause labels are discrete.");
    const [noAnswer] = splitNoteSections("## Check yourself\nWhich type?");
    expect(noAnswer.answer).toBeUndefined();
  });

  test("text before the first heading and ## inside code fences are kept intact", () => {
    const sections = splitNoteSections("intro line\n\n## 举个例子\n```python\n## not a heading\nx = 1\n```\nafter");
    expect(sections.map((section) => section.key)).toEqual([null, "example"]);
    expect(sections[0].body).toBe("intro line");
    expect(sections[1].body).toContain("## not a heading");
    expect(sections[1].body.endsWith("after")).toBe(true);
  });

  test("### subheadings do not start a section", () => {
    const sections = splitNoteSections("## 举个例子\n### 步骤一\n做。\n### 步骤二\n再做。");
    expect(sections.length).toBe(1);
    expect(sections[0].body).toContain("### 步骤二");
  });

  test("the answer line of a self-check quote becomes its own paragraph", () => {
    const prepared = prepareNoteMarkdown("> **自测：** 问题？\n> 答案：回答。\n\n正文。");
    expect(prepared).toBe("> **自测：** 问题？\n>\n> 答案：回答。\n\n正文。");
    expect(prepareNoteMarkdown("> **Check yourself:** q\n>\n> Answer: a")).toBe("> **Check yourself:** q\n>\n> Answer: a");
    expect(prepareNoteMarkdown("plain\n答案：not a quote")).toBe("plain\n答案：not a quote");
  });
});
