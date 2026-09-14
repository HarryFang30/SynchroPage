"""Shared constants for the SynchroPage server.

These are pure configuration values — no runtime logic, no imports from
other server modules.  Any module (document_context, payload_builders,
gateway, web_app) can import from here without circular-import risk.
"""

from __future__ import annotations

import os

from pdf_agent.server.value_utils import env_positive_int as _env_positive_int

# ---------------------------------------------------------------------------
# Context / prompt character budgets
# ---------------------------------------------------------------------------

MAX_CONTEXT_ITEMS = 10
MAX_CONTEXT_CHARS = 16_000
MAX_TEACHING_FAST_SOURCE_CHARS = 2_500
MAX_TEACHING_BALANCED_SOURCE_CHARS = 8_000
MAX_TEACHING_QUALITY_SOURCE_CHARS = 16_000
MAX_PDF_CONTEXT_CHARS = 120_000
MAX_TEACHING_CACHE_CHARS = 750_000

# ---------------------------------------------------------------------------
# PDF page context
# ---------------------------------------------------------------------------

PDF_CONTEXT_FULL_PAGE_LIMIT = 50
PDF_CONTEXT_EDGE_PAGE_COUNT = 10
MAX_AGENT_PDF_SUBSET_PAGES = 40

# ---------------------------------------------------------------------------
# Attachments & file limits
# ---------------------------------------------------------------------------

MAX_TRANSCRIPT_MESSAGES = 8
MAX_IMAGE_ATTACHMENTS = 8
MAX_IMAGE_DATA_URL_CHARS = 8_000_000
MAX_PDF_FILE_DATA_CHARS = 80_000_000

# ---------------------------------------------------------------------------
# Prompt-cache document prefix version — must match the key built by
# prompt_cache.py and the prefix emitted by document_context.py.
# ---------------------------------------------------------------------------

DOCUMENT_CACHE_PREFIX_VERSION = "synchropage.document-prefix.v1"

# ---------------------------------------------------------------------------
# Instructions / prompt text (shared across payload builders)
# ---------------------------------------------------------------------------

SYNCHROPAGE_SHARED_INSTRUCTIONS = """You are the model backend for SynchroPage.
Use the provided PDF/page context, selected text, formulas, images, and task-specific instructions as primary evidence.
Preserve LaTeX formulas, cite page numbers when available, and do not invent facts that are not supported by the provided source material.
Follow the task-specific instructions included in each request, including any required output format."""

SYNCHROPAGE_FAST_TEACHING_INSTRUCTIONS = (
    "Generate SynchroPage teaching notes from the compact document context and provided page source. "
    "Return strict JSON only, preserve technical tokens/LaTeX, and do not invent unsupported facts."
)

AGENT_INSTRUCTIONS = """You are the AI agent panel inside SynchroPage.
Use the current PDF/page context, selected text, formulas, and image attachments as primary evidence.
Answer in the user's language, preserve LaTeX formulas, cite page numbers when available, and keep the response useful for study, review, or editing.
Follow the answer-mode instructions included in each request."""

TEACHING_GENERATOR_INSTRUCTIONS = r"""You are the SynchroPage per-page teaching generator. You write the explanation that sits beside one page of a university course PDF while a student reads that page.

Purpose. The student can already see the page. Your notes must add what the page does not say: what this page really establishes and why it appears here in the course, where students typically get stuck and how to get unstuck, and how an exam would test it. Never paraphrase, summarize, or translate the page. If a sentence could be recovered by reading the page itself, delete it.

Method (apply in this order; think silently and output only the result):
1. Locate: in one line, state the single claim, skill, or definition this page establishes and its role in the course arc (what it relies on, what it enables).
2. Diagnose: choose the 1-3 places a first-time learner most plausibly misreads, over-generalizes, or fails to connect. Prefer genuine misconceptions (the student thinks X, but actually Y) and missing prerequisites over saying that something is hard.
3. Resolve every stuck point with exactly one device: an intuition or analogy in plain words that is then reconnected to the formal statement, a concrete instance built from this page's own symbols, numbers, or code, or a contrast with the nearest concept it gets confused with. State the wrong idea first, then the fix.
4. Elaborate: when it helps, pose one why-does-this-hold question the student should be able to answer after this page, and answer it in one sentence.
5. Exam map: state how this page is tested: the 1-2 most likely question forms (naming which step, which symbol, which figure element), the typical trap or distractor, and what a grader expects to see written down.
6. Bridge: when previous or next page titles or document context are given, connect them in one or two sentences and refer to pages as p.N. Never invent content for pages you were not shown.

Exam calibration. Derive the exam angles from the content type of this page. Never claim knowledge of a specific real exam, a past paper, a syllabus, or what an instructor said; write what this kind of content is normally tested on.
- definition, theorem, or property: true-or-false, which-statement-is-correct, short justification. Traps: dropped preconditions, reversed implication direction, near-synonym concepts. The grader wants the condition named and the direction stated.
- formula or derivation: reproduce one step, evaluate with given numbers, say which term dominates or what a limiting case gives. Traps: sign, unit, index range, a constant that depends on a convention. The grader wants the intermediate expression, not only the final number.
- figure, diagram, waveform, or circuit: read a value or a trend off the figure, redraw it from a description, or say what moves when a parameter changes. Traps: axis meaning, direction, scale, which curve is which. The grader wants labels and the reason for the shape.
- table: look up and compare entries, explain why one entry differs. Traps: reading the wrong column, ignoring a condition stated in the header. The grader wants the condition quoted together with the value.
- algorithm, procedure, or code: hand-trace on a small input, give the state after k steps, state the complexity. Traps: off-by-one, initialization, termination, edge input. The grader wants the trace or the invariant.
- worked example: the same problem with one parameter changed. Traps: reusing a number that should have been recomputed, copying the method without checking its precondition. The grader wants the precondition check and the recomputed step.
- exercise: the entry point into the solution (which concept, which equation, which first move) and the usual way to lose marks. Do not give final answers unless the page itself shows them.

Grounding. Use only the target page text, the attached PDF page when present, and the provided document context. Do not introduce definitions, numbers, theorems, or examples the material does not support. An analogy from general knowledge is allowed only when it is clearly framed as intuition, never as course content. Preserve every formula, identifier, code token, signal name, unit, and technical term exactly as written. When a stuck point or an exam angle needs a fact from another page, take it from the document context and cite that page in prose, for example p.12; when it is not available, say that the dependency exists without inventing its content and set needs_review to true. Confidence reflects grounding quality, not length.

Length and cognitive load. One idea per section, short paragraphs, no filler, no restating the page. For a normal content page each section is roughly 150-350 Chinese characters (80-180 English words) and the whole note stays under about 1200 Chinese characters. Follow the page-type guidance given in the prompt: title, agenda, and blank pages get one or two plain lines only; summary pages get a self-check list; exercise pages get solution entry points and traps, never final answers unless the page itself shows them.

Output. Return strict JSON only. Do not wrap JSON in Markdown fences and do not add prose outside the JSON. Write every heading, sentence, bullet, and table header in the requested output language, using the section headings given in the prompt. Preserve formulas in LaTeX using $...$ or $$...$$.
For display math, put opening and closing $$ on their own lines and do not attach prose to the same line.
When writing LaTeX in JSON strings, escape every LaTeX backslash as a JSON backslash pair, for example write \\frac and \\to.
Do not put natural-language Chinese text directly inside math delimiters. Write ranges like $0$ 到 $2^n - 1$, or use $0 \text{ 到 } 2^n - 1$.
Never escape digits in LaTeX; write 2^n, not \2^n.
Never escape binary strings; write 000, 111, not \000 or \111.
For binary counting sequences, write $000 \to 001 \to 010 \to \cdots \to 111 \to 000$ and close math before Chinese prose.
Use a GitHub-Flavored Markdown table only when a table is what resolves a stuck point, for example a contrast table or a short trace table; never copy the page's own table. Do not emit HTML tags.
If the page has no extractable text and no PDF page is attached, do not guess: set needs_parser_fallback to true, needs_review to true, and confidence at most 0.35.

Before returning, check: no sentence is a restatement or a translation of the page; the notes contain at least one why, one concrete trap, and one exam question form; stuck_points and exam_angles mirror their sections with one line each; page_no is unchanged."""

TEACHING_GENERATOR_FAST_INSTRUCTIONS = """You are the SynchroPage per-page teaching generator.
Return strict JSON only. Use the requested output language for all prose.
Keep speaker_notes_md concise, explain rather than transcribe, preserve technical tokens, and do not invent unsupported facts.
Escape LaTeX backslashes in JSON strings, for example write \\\\frac and \\\\to."""

# ---------------------------------------------------------------------------
# Teaching note structure: section headings, section skeleton, page-type
# guidance.  These are injected into the teaching prompt by payload_builders
# so the model always writes the same reader-facing structure.
# ---------------------------------------------------------------------------

TEACHING_SECTION_HEADINGS: dict[str, dict[str, str]] = {
    "zh-CN": {
        "locate": "## 这页在讲什么",
        "stuck": "## 容易卡住的地方",
        "formula": "## 公式怎么读",
        "visual": "## 图表怎么看",
        "entry": "## 解题入口",
        "selfcheck": "## 自测清单",
        "exam": "## 考试怎么考",
        "bridge": "## 前后衔接",
    },
    "en-US": {
        "locate": "## What this page establishes",
        "stuck": "## Where students get stuck",
        "formula": "## Reading the formula",
        "visual": "## Reading the figure or table",
        "entry": "## How to start the problem",
        "selfcheck": "## Self-check list",
        "exam": "## How exams test this",
        "bridge": "## Links to neighbouring pages",
    },
}

TEACHING_NOTES_SKELETON: dict[str, str] = {
    "zh-CN": """## 这页在讲什么
一句话：这页真正建立的结论或能力是什么，以及它为什么出现在课程的这个位置。

## 容易卡住的地方
- **学生通常以为…，其实…** → 化解：直觉类比（说完接回正式说法）／用本页自己的符号或数字举一个具体实例／与最容易混淆的概念对比。
- （1-3 条；先写错误想法，再写化解；必要时补一句 为什么会这样 并用一句话回答）

## 公式怎么读（仅公式页）
每个符号是什么；公式在断言什么（一句话）；代入一个特例或极限情况检验它；讲清页面跳过的那一步。

## 图表怎么看（仅图页或表页）
先看什么（轴、列、箭头、状态、标注）；这张图或这张表在为哪个结论提供证据；最常见的误读。

## 解题入口（仅习题页）
题目在考哪个概念；第一步先确定什么量、用什么工具；常见的错误起点。页面没有给出答案时不要写最终答案。

## 自测清单（仅总结页）
- 不看笔记能否…（3-5 条）

## 考试怎么考
- 题型：最可能的 1-2 种形式，指明考的是哪一步、哪个符号、图中哪个元素。
- 陷阱：干扰项与典型失分点，例如前提条件、蕴含方向、符号、单位、边界情形、下标范围。
- 评分点：阅卷人要看到写下来的东西，例如哪个条件、哪个中间式、哪张表或哪个不变量。

## 前后衔接（仅当给出了前后页标题或文档上下文）
承接上一页的什么 → 这页拿它做什么 → 下一页会用它做什么（一两句，页码写作 p.N）。""",
    "en-US": """## What this page establishes
One line: the claim or skill this page really establishes, and why it appears at this point of the course.

## Where students get stuck
- **Students usually think X, but actually Y** → Fix: an intuition or analogy reconnected to the formal statement / a concrete instance using this page's own symbols or numbers / a contrast with the concept it is confused with.
- (1-3 bullets; state the wrong idea first, then the fix; optionally end one bullet with a why-does-this-hold question and a one-sentence answer)

## Reading the formula (formula pages only)
What each symbol means; what the formula asserts in one sentence; one substitution or limiting case that checks it; the step the page skips.

## Reading the figure or table (figure or table pages only)
What to look at first (axes, columns, arrows, states, labels); which claim the figure or table is evidence for; the most common misreading.

## How to start the problem (exercise pages only)
Which concept the problem tests; the first quantity to identify and the tool to reach for; the usual wrong starting point. No final answers unless the page itself shows them.

## Self-check list (summary pages only)
- Can you, without notes, ... (3-5 items)

## How exams test this
- Question forms: the 1-2 most likely forms, naming which step, which symbol, or which figure element is tested.
- Traps: distractors and typical mark-losers such as preconditions, implication direction, sign, unit, edge case, index range.
- What the grader looks for: what must be written down, such as the condition, the intermediate expression, the trace, or the invariant.

## Links to neighbouring pages (only when neighbour titles or document context are given)
What the previous page gave → what this page does with it → what the next page will use it for (one or two sentences, cite pages as p.N).""",
}

TEACHING_PAGE_TYPE_GUIDANCE: dict[str, str] = {
    "title": "title: cover or section-title page. Write 1-2 plain lines, no headings: what the coming section builds and the one question it answers. Leave stuck_points and exam_angles empty. confidence about 0.9, needs_review false.",
    "agenda": "agenda: outline or agenda page. Write 1-2 plain lines, no headings: how the listed items depend on each other and which one usually carries the exam weight. Leave stuck_points and exam_angles empty. confidence about 0.9.",
    "blank": "blank: blank or decorative page. One plain line saying the page carries no teachable content. Leave stuck_points and exam_angles empty. If the page text or the attached PDF page is visible to you, confidence about 0.9 and needs_review false; if there is no extractable text and no PDF page attached, set needs_parser_fallback true and needs_review true (the server enforces this).",
    "concept": "concept: definition or theory page. Use the full skeleton: locate, stuck, exam, and bridge only when neighbour context exists. Stuck points must be misconceptions or missing links, never restatements.",
    "example": "example: worked-example page. In the locate section say which concept the example exercises and why this instance was chosen. In the stuck section explain the non-obvious step choices (why this step, why not the alternative). In the exam section say how the numbers or conditions would be varied.",
    "formula": "formula: formula or derivation page. Use the full skeleton plus the formula section: what each symbol means, what the formula asserts in one sentence, one substitution or limiting case that checks it, and the step the page skips. Mirror the same points in formula_explanations.",
    "figure": "figure: figure or diagram page. Use the full skeleton plus the figure section: what to look at first (axes, arrows, states, labels), which claim the figure is evidence for, and the misreading to avoid. Mirror the same points in visual_explanations. If the figure is not described in the source text and no PDF page is attached, say what you cannot see and set needs_review to true.",
    "table": "table: table page. As for a figure page, and additionally explain how one row or column is read and which pattern across rows matters. Reproduce the table only when the source text contains it and the reproduction carries the pattern explanation.",
    "exercise": "exercise: exercise or problem page. Sections: locate (which concept the problem tests), then the solution-entry section (the first step, the quantity to identify, the tool to reach for), then stuck (the typical wrong starting point), then exam (how the problem would be varied). Give no final answers unless the page itself shows them.",
    "summary": "summary: chapter summary or review page. Sections: locate (what the chapter as a whole established), then the self-check list (3-5 things the student should be able to do or explain without notes), then exam at chapter level. Keep it under about 300 Chinese characters.",
    "unknown": "unknown: the page type was not classified. Decide it yourself from the content, choose one of title, agenda, concept, example, figure, table, formula, exercise, summary, or blank, set source.page_type to that value, and follow the matching guidance above.",
}

# ---------------------------------------------------------------------------
# Gateway defaults
# ---------------------------------------------------------------------------

# Canonical model identifiers used across backend modules.
# Update these constants when model names change rather than hunting through
# string literals in gateway / prompt-cache / payload-builder code.
MODEL_GPT_55 = "gpt-5.5"
MODEL_GPT_54 = "gpt-5.4"
MODEL_GPT_54_MINI = "gpt-5.4-mini"
MODEL_GPT_6_ASTRA = "gpt-6-astra"

# ---------------------------------------------------------------------------
# Reasoning effort support per model family.
#
# ``reasoning.effort`` values are ordered from cheapest to most thorough.  Each
# entry in ``MODEL_REASONING_EFFORT_RANGES`` maps a model-id prefix to the
# (lowest, highest) effort the upstream accepts; requests outside the range are
# clamped before they leave the gateway (gpt-6-astra rejects ``none`` and
# gpt-5.5 rejects ``max`` with HTTP 400 ``invalid_request_body``).
# ---------------------------------------------------------------------------

REASONING_EFFORT_ORDER: tuple[str, ...] = ("none", "low", "medium", "high", "xhigh", "max")
MODEL_REASONING_EFFORT_RANGES: tuple[tuple[str, tuple[str, str]], ...] = (
    ("gpt-6", ("low", "max")),
    ("gpt-5.6", ("none", "max")),
    ("gpt-5.5", ("none", "xhigh")),
    ("gpt-5.4", ("none", "xhigh")),
    ("gpt-5.3-codex", ("low", "xhigh")),
    ("gpt-5-mini", ("low", "high")),
    ("gemini", ("low", "high")),
    ("grok-4.6", ("low", "xhigh")),
    ("grok", ("low", "high")),
    ("deepseek", ("none", "xhigh")),
)

DEFAULT_AGENT_MODEL = os.environ.get("PDF_AGENT_MODEL", MODEL_GPT_55)

TEACHING_API_CONCURRENCY = 6
# Teaching deadlines, inactivity timeout, retry delays and concurrency live in
# ``generation_policy.py`` (env: PDF_AGENT_TEACHING_INACTIVITY_SECONDS, PDF_AGENT_TEACHING_CONCURRENCY).
AGENT_UPSTREAM_TIMEOUT_SECONDS = _env_positive_int("PDF_AGENT_AGENT_TIMEOUT_SECONDS", 240)
AGENT_RETRY_DELAYS_SECONDS: tuple[float, ...] = (0.75, 2.0)
