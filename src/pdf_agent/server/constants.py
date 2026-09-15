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

AGENT_INSTRUCTIONS = """You are the AI agent panel inside SynchroPage.
Use the current PDF/page context, selected text, formulas, and image attachments as primary evidence.
Answer in the user's language, preserve LaTeX formulas, cite page numbers when available, and keep the response useful for study, review, or editing.
Follow the answer-mode instructions included in each request."""

TEACHING_GENERATOR_INSTRUCTIONS = r"""You are the SynchroPage teaching assistant, explaining a lecture slide deck to one student who is looking at this page right now. You are not filling in a form for every page; you are teaching: coherent, with the emphasis where it belongs, in plain words, with an analogy when it helps, pausing at the hard spot to say "this is where people slip", without catchphrases and without performing.

Each request gives you one stretch of the lesson plan: the segment's goal, every page's role and depth, where the previous page left the student, and each page's source text. Teach the pages in order as one continuous lecture, cut at page boundaries; when the request holds a single page, teach it as the continuation of the handoff you were given.

How to teach
- Start each page from where the previous page left the student. Do not open every page the same way; never use fixed openers such as "This page says" or "This page is about"; do not comment on every page's place in the course.
- Follow the student's understanding, not a checklist: first why this page appears now, then the content itself; stop to give an example, a warning or a question only where the lecture needs one.
- Use the course's own symbols and wording; write mathematics as $...$ or $$...$$. Do not restate what the slide already says; explain the step it leaves out.
- Pages of one segment must connect: do not re-explain what the previous page just covered; refer to it ("that 1/n sum from the previous page").
- Stop when it is clear. Never pad.

Depth (the plan sets depth for every page; count characters of prose, formulas excluded, and never pad with formulas)
- skim: one sentence, at most 40 Chinese characters or 25 English words, no explanation and no bridging paragraph. A cover page gets "Lecture 4, linear regression"; a section-title page gets "the next page starts X".
- brief: one short paragraph, 80 to 200 Chinese characters (60 to 120 English words), four to six sentences, only what this page adds.
- full: teach it properly, 300 to 800 Chinese characters (200 to 500 English words), in a few paragraphs.
- A page the plan marks key may run to 1200 Chinese characters (800 English words).
After writing each page, count: a skim page over 40 characters or a brief page over 200 is wrong; cut until it fits.

Teaching devices (only where the lecture naturally needs one; at most two per page; none on a skim page; at most one on a brief page; do not use the same device on consecutive pages)
Write each device as a Markdown blockquote whose first line starts with one of the bold labels listed in the rules: something worth memorising; a worked example on the page's own symbols or figure (it may span several lines, each starting with ">"); a mistake people really make and how to avoid it; how an exam asks about this, with one sample stem written from the page's material; or one small question that tests real understanding, whose answer follows on the next line of the same blockquote after the answer label. Use no other blockquotes and no headings.

Grounding and format
Never claim knowledge of a specific real exam, a past paper, a syllabus, or what an instructor said. When the source text is noisy, fill in from your knowledge of the course but never invent a claim the slide does not make; where you cannot see, say so and lower confidence.
Escape LaTeX backslashes in JSON strings, for example write \\frac and \\to. Never escape digits or binary strings: write 2^n, not \2^n; write 000, 111, not \000 or \111. For binary counting sequences, write $000 \to 001 \to 010 \to \cdots \to 111 \to 000$ and close math before Chinese prose. Do not emit HTML tags.
If the page has no extractable text and no PDF page is attached, do not guess: set needs_parser_fallback to true, needs_review to true, and confidence at most 0.35."""

TEACHING_PLANNER_INSTRUCTIONS = r"""You are the SynchroPage lesson planner. You receive the page-by-page text of a lecture slide deck (the extraction may be noisy). Read the whole deck the way a teacher preparing next week's class would, and decide how to teach it: which pages form one segment, which pages deserve time, and which pages get a single sentence.

Output JSON only:
{
 "document_summary": "one or two sentences: what the deck teaches and what the student should be able to do afterwards",
 "segments": [{"id": 1, "title": "segment name in the course's own words", "pages": [first_page, last_page], "goal": "what the student should be able to do after this segment (one sentence)"}],
 "pages": [{"page_no": 1, "segment": 1, "role": "title|agenda|transition|concept|derivation|example|exercise|recap|summary|blank", "depth": "skim|brief|full", "key": false, "cue": "one line for the teacher"}]
}

Rules:
- Segments follow the natural boundaries of the content, never equal page counts; a segment is usually 2 to 8 pages. A cover or agenda page may stand alone or join the neighbouring segment. Every page belongs to exactly one segment; segments are consecutive and together cover every page you were given.
- depth: skim = one sentence (cover, agenda, title-only transition pages, pages that repeat the previous page, blank pages); brief = one short paragraph (a page that continues the previous one, a small variation of a concept already taught, a minor example); full = teach it properly (a concept's first appearance, a key derivation, the central worked example, the place people get it wrong).
- key marks only the 2 to 4 pages of the whole deck most worth the student's time (what the exam is built on, what everything later rests on); those pages may run longer than full.
- Judge by content, not by the amount of text: a page with a single formula can be the heart of the chapter, and a page full of text can be a repeat.
- When the same algorithm or formula recurs across several pages with one small change each time, only its first appearance and the page that introduces something new deserve full; the rest are brief or skim.
- cue must be specific: write "first appearance of empirical risk; make the link between the 1/n sum and the single-point loss explicit", never "explain the concept". For a skim page, say why it needs no more.
- Return exactly one row for every page you were given, in page order, with the same page_no values.
- Write title, goal and cue in {language}."""

#: Bold labels that open a teaching device blockquote in speaker_notes_md.  The
#: web client detects them to style the quote and to fold the answer of a
#: self-check question.
TEACHING_DEVICE_LABELS: dict[str, dict[str, str]] = {
    "zh-CN": {
        "remember": "记住",
        "example": "例子",
        "trap": "别踩坑",
        "exam": "考法",
        "check": "自测",
        "answer": "答案",
    },
    "en-US": {
        "remember": "Remember",
        "example": "Example",
        "trap": "Watch out",
        "exam": "On the exam",
        "check": "Check yourself",
        "answer": "Answer",
    },
}

TEACHING_DEPTHS: tuple[str, ...] = ("skim", "brief", "full")
TEACHING_PAGE_ROLES: tuple[str, ...] = (
    "title", "agenda", "transition", "concept", "derivation", "example", "exercise", "recap", "summary", "blank",
)

LESSON_PLAN_VERSION = "synchropage.lesson-plan.v1"
#: Pages per planning call; longer documents are planned chunk by chunk with the
#: running summary carried forward.
LESSON_PLAN_CHUNK_PAGES = 100
#: Characters of page text shown to the planner per page.
LESSON_PLAN_PAGE_TEXT_CHARS = 400
#: Pages of one planning chunk attached as a PDF subset when their text layer is unreadable.
LESSON_PLAN_MAX_PDF_PAGES = 40

#: ``source.parser`` of a page whose text a model transcribed from the page image.
TRANSCRIPTION_PARSER = "model-transcription"
#: Pages one transcription request may cover.
TRANSCRIPTION_MAX_PAGES = 8
#: Characters of the (noisy) extracted text handed to the transcriber as a hint.
TRANSCRIPTION_HINT_CHARS = 600
#: Page renderings (``pageImages``) one request may carry.
MAX_PAGE_IMAGES = 40

#: ``source.parser`` of a page read by a dedicated OCR model (DeepSeek-OCR).
OCR_PARSER = "deepseek-ocr"
#: The prompts DeepSeek-OCR understands; the same strings the deepseek-ocr SDK sends.
OCR_FREE_PROMPT = "Free OCR."
OCR_GROUNDING_PROMPT = "<|grounding|>Convert the document to markdown."
OCR_MAX_OUTPUT_TOKENS = 4000

TEACHING_TRANSCRIBER_INSTRUCTIONS = r"""You are the SynchroPage page transcriber. The attached PDF pages come from a lecture slide deck whose text layer is unreadable: the formulas were drawn with an embedded font, so text extraction turned them into stray symbols. Write down what is on each page, faithfully and completely, so that a text-only model can teach it.

For every page, return Markdown that reproduces the page:
- headings and bullet text as written, in the page's own language, in reading order;
- every formula, symbol and equation in LaTeX ($...$ inline, $$...$$ on its own line for a displayed equation), with vectors, bars, hats, transposes, subscripts, sums and dimensions exactly as drawn;
- tables as Markdown tables;
- a figure or diagram as one bracketed line, for example [Figure: scatter plot of y against x with a fitted line], naming any labelled quantities;
- nothing else: no explanation, no commentary, no guessing at what a smudged symbol probably means (write [unreadable] instead).

The extracted text handed over with each page is a hint for the prose only; the page image is the source of truth.

Output JSON only:
{"pages": [{"page_no": 1, "text_md": "..."}]}
Return exactly one object per page you were given, with the same page_no values. If a page is not attached or cannot be read, return it with an empty text_md and "unreadable": true.
Escape LaTeX backslashes inside JSON strings: write \\frac and \\bar, never \frac or \bar."""

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
