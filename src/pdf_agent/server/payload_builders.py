"""Agent and Teaching payload / prompt builders.

Pure functions that assemble gateway payloads and prompt text from
request bodies.  No dependency on ``web_app.py``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from pdf_agent.gateway import build_codex_responses_payload
from pdf_agent.server.constants import (
    AGENT_INSTRUCTIONS,
    LESSON_PLAN_PAGE_TEXT_CHARS,
    MAX_AGENT_PDF_SUBSET_PAGES,
    MAX_CONTEXT_CHARS,
    MAX_TEACHING_BALANCED_SOURCE_CHARS,
    MAX_TEACHING_QUALITY_SOURCE_CHARS,
    SYNCHROPAGE_SHARED_INSTRUCTIONS,
    TEACHING_DEPTHS,
    TEACHING_DEVICE_LABELS,
    TEACHING_GENERATOR_INSTRUCTIONS,
    TEACHING_PAGE_ROLES,
    TEACHING_PLANNER_INSTRUCTIONS,
)
from pdf_agent.server.document_context import (
    _append_page_number,
    _build_document_cache_prefix,
    _context_items,
    _context_parts,
    _format_page_ranges,
    _image_attachments,
    _iter_mapping_items,
    _normalized_document_cache_context,
    _pdf_file_input,
    _selected_context,
    _selected_context_source_type,
    _selected_context_text,
    _selected_pdf_source_text,
    _selected_source_lines,
    _text_from_parts,
    _transcript_messages,
)
from pdf_agent.server.json_utils import json_dumps_utf8_safe as _json_dumps_utf8_safe
from pdf_agent.server.pdf_file_cache import PdfFileCache
from pdf_agent.server.prompt_cache import (
    _apply_prompt_cache_fields as _apply_prompt_cache_fields_impl,
)
from pdf_agent.server.value_utils import (
    clean_model as _clean_model,
)
from pdf_agent.server.value_utils import (
    int_value as _int_value,
)
from pdf_agent.server.value_utils import (
    page_type_value as _page_type_value,
)
from pdf_agent.server.value_utils import (
    string_list as _string_list,
)
from pdf_agent.server.value_utils import (
    string_value as _string_value,
)
from pdf_agent.server.value_utils import (
    truncate as _truncate,
)

# ---------------------------------------------------------------------------
# Wrapper that closes over document_context (avoids dependency on web_app.py)
# ---------------------------------------------------------------------------

def _apply_prompt_cache_fields(
    payload: dict[str, Any], body: Mapping[str, Any], model: str
) -> None:
    _apply_prompt_cache_fields_impl(
        payload, body, model, context_fn=_normalized_document_cache_context
    )


# ---------------------------------------------------------------------------
# Agent answer modes
# ---------------------------------------------------------------------------


def _agent_answer_mode(body: Mapping[str, Any]) -> str:
    value = str(body.get("answerMode") or "").strip()
    if value in {"concise", "guided", "detailed"}:
        return value
    return "concise"


def _agent_answer_mode_effort(mode: str) -> str:
    if mode == "detailed":
        return "xhigh"
    if mode == "guided":
        return "high"
    return "medium"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _reasoning_effort(body: Mapping[str, Any]) -> str:
    reasoning = body.get("reasoning") if isinstance(body.get("reasoning"), Mapping) else {}
    quality_plan = body.get("qualityPlan") if isinstance(body.get("qualityPlan"), Mapping) else {}
    value = str(body.get("reasoningEffort") or reasoning.get("effort") or quality_plan.get("reasoningEffort") or "").strip()
    if value in {"none", "low", "medium", "high", "xhigh", "max"}:
        return value
    if body.get("answerMode"):
        return _agent_answer_mode_effort(_agent_answer_mode(body))
    return "medium"


def _teaching_output_language(body: Mapping[str, Any]) -> tuple[str, str]:
    value = str(body.get("outputLanguage") or "").strip()
    label = str(body.get("outputLanguageLabel") or "").strip()
    if value in {"zh-CN", "zh", "zh_CN"}:
        return "zh-CN", label or "Simplified Chinese"
    if value in {"en-US", "en", "en_US"}:
        return "en-US", label or "English"

    ui_language = str(body.get("uiLanguage") or "").strip()
    if ui_language == "en-US":
        return "en-US", "English"
    return "zh-CN", "Simplified Chinese"


# ---------------------------------------------------------------------------
# Teaching page helpers
# ---------------------------------------------------------------------------


def _teaching_generation_pages(body: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    pages = body.get("pages")
    if isinstance(pages, list):
        valid_pages = [page for page in pages if isinstance(page, Mapping)]
        if valid_pages:
            return valid_pages
    page = body.get("page")
    return [page] if isinstance(page, Mapping) else []


def _teaching_generation_page_numbers(body: Mapping[str, Any]) -> list[int]:
    numbers: list[int] = []
    seen: set[int] = set()
    for index, page in enumerate(_teaching_generation_pages(body), start=1):
        page_no = _int_value(page.get("page_no"), index)
        if page_no > 0 and page_no not in seen:
            seen.add(page_no)
            numbers.append(page_no)
    return numbers


# ---------------------------------------------------------------------------
# Teaching quality / fast flags
# ---------------------------------------------------------------------------


def _teaching_source_text_limit(body: Mapping[str, Any]) -> int:
    plan = body.get("qualityPlan")
    if not isinstance(plan, Mapping):
        return MAX_TEACHING_QUALITY_SOURCE_CHARS
    reasoning_effort = _string_value(plan.get("reasoningEffort"), _reasoning_effort(body))
    if bool(plan.get("attachPdf")) or reasoning_effort in {"high", "xhigh"}:
        return MAX_TEACHING_QUALITY_SOURCE_CHARS
    return MAX_TEACHING_BALANCED_SOURCE_CHARS


def _teaching_quality_plan_lines(body: Mapping[str, Any]) -> list[str]:
    plan = body.get("qualityPlan")
    if not isinstance(plan, Mapping):
        return []
    attempt = _string_value(plan.get("attempt"), "initial")
    mode = "quality retry" if attempt == "retry" else "pdf-grounded" if bool(plan.get("attachPdf")) else "balanced text"
    lines = [f"mode: {mode}; reasoning={_string_value(plan.get('reasoningEffort'), _reasoning_effort(body))}"]
    reasons = _string_list(plan.get("reasons"))
    if reasons:
        lines.append(f"reasons: {', '.join(reasons)}")
    if attempt == "retry":
        lines.append("This is a quality retry. Prefer more complete visual/source grounding over speed.")
    return lines


# ---------------------------------------------------------------------------
# Teaching output contract helpers
# ---------------------------------------------------------------------------


def _teaching_contract_json(value: Any) -> str:
    return _json_dumps_utf8_safe(value, ensure_ascii=False, separators=(",", ":"))


def _teaching_page_output_contract(page_no: Any) -> dict[str, Any]:
    return {
        "page_no": page_no,
        "source": {"page_type": "title|agenda|concept|example|figure|table|formula|exercise|summary|blank"},
        "teaching": {
            "output_language": "zh-CN|en-US",
            "slide_title": "the page's title in the source's own words",
            "speaker_notes_md": "the lecture for this page in Markdown; labelled blockquotes are the only devices, no headings",
            "handoff": "one or two sentences: what the student holds after this page, for the next page to pick up",
            "stuck_points": ["mistakes people really make on this page; 0-3 one-liners; empty on skim pages"],
            "exam_angles": ["only what is really examinable; 0-2 one-liners; empty on skim pages"],
            "confidence": 0.82,
            "needs_review": False,
            "needs_parser_fallback": False,
        },
    }


# ---------------------------------------------------------------------------
# Lesson plan helpers (page roles, depths, segment context)
# ---------------------------------------------------------------------------

_DEPTH_BY_PAGE_TYPE: dict[str, str] = {"title": "skim", "agenda": "skim", "blank": "skim", "summary": "brief"}
_ROLE_BY_PAGE_TYPE: dict[str, str] = {
    "title": "title",
    "agenda": "agenda",
    "blank": "blank",
    "summary": "summary",
    "example": "example",
    "exercise": "exercise",
    "formula": "derivation",
}


def _teaching_page_type(page: Mapping[str, Any]) -> str:
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    return _page_type_value(source.get("page_type"))


def _teaching_device_labels(output_language_code: str) -> dict[str, str]:
    return TEACHING_DEVICE_LABELS.get(output_language_code, TEACHING_DEVICE_LABELS["zh-CN"])


def _teaching_lesson_plan(body: Mapping[str, Any]) -> Mapping[str, Any]:
    plan = body.get("lessonPlan")
    return plan if isinstance(plan, Mapping) else {}


def _teaching_plan_rows(body: Mapping[str, Any], target_pages: Sequence[Mapping[str, Any]]) -> dict[int, dict[str, Any]]:
    """One plan row per target page, in request order.

    Rows come from ``body["lessonPlan"]["pages"]``; a page the plan does not
    cover (older clients, a failed planning pass) gets a default derived from
    its page_type so the teaching prompt always has a depth to follow.
    """
    provided: dict[int, Mapping[str, Any]] = {}
    for item in _iter_mapping_items(_teaching_lesson_plan(body).get("pages")):
        page_no = _int_value(item.get("page_no"), 0)
        if page_no > 0:
            provided[page_no] = item
    rows: dict[int, dict[str, Any]] = {}
    for index, page in enumerate(target_pages, start=1):
        page_no = _int_value(page.get("page_no"), index)
        page_type = _teaching_page_type(page)
        item = provided.get(page_no, {})
        role = _string_value(item.get("role"), "")
        depth = _string_value(item.get("depth"), "")
        rows[page_no] = {
            "role": role if role in TEACHING_PAGE_ROLES else _ROLE_BY_PAGE_TYPE.get(page_type, "concept"),
            "depth": depth if depth in TEACHING_DEPTHS else _DEPTH_BY_PAGE_TYPE.get(page_type, "full"),
            "key": bool(item.get("key")),
            "cue": _string_value(item.get("cue"), ""),
            "planned": bool(item),
        }
    return rows


def _teaching_lesson_plan_lines(body: Mapping[str, Any], target_pages: Sequence[Mapping[str, Any]]) -> list[str]:
    plan = _teaching_lesson_plan(body)
    rows = _teaching_plan_rows(body, target_pages)
    lines = ["Lesson plan for this request:"]
    summary = _string_value(plan.get("document_summary"), "")
    if summary:
        lines.append(f"document_summary: {summary}")
    segment = plan.get("segment") if isinstance(plan.get("segment"), Mapping) else {}
    if segment:
        pages = segment.get("pages") if isinstance(segment.get("pages"), Sequence) and not isinstance(segment.get("pages"), str) else []
        span = ""
        if len(pages) >= 2:
            span = f" (pages {_int_value(pages[0], 0)}-{_int_value(pages[1], 0)})"
        lines.append(f"segment: {_string_value(segment.get('title'), 'untitled')}{span}")
        goal = _string_value(segment.get("goal"), "")
        if goal:
            lines.append(f"segment_goal: {goal}")
    if not any(row["planned"] for row in rows.values()):
        lines.append(
            "No lesson plan was computed for this document. Judge each page's depth yourself with the same tiers: "
            "skim for covers, agendas, blank and title-only pages; brief for a page that only continues the previous one; "
            "full for anything that teaches something new."
        )
    lines.append("pages:")
    for page_no, row in rows.items():
        cue = f" — {row['cue']}" if row["cue"] else ""
        key = " key=true" if row["key"] else ""
        lines.append(f"- p{page_no}: role={row['role']} depth={row['depth']}{key}{cue}")
    handoff = _string_value(plan.get("handoff"), "")
    if handoff:
        lines.append(f"handoff_from_previous_page: {handoff}")
    else:
        lines.append(
            "handoff_from_previous_page: none (this is the first page you teach in this run; "
            "open naturally, without recapping pages you were not shown)."
        )
    return lines


def _teaching_document_context_titles(body: Mapping[str, Any]) -> dict[int, str]:
    context = body.get("documentContext")
    if not isinstance(context, Mapping):
        return {}
    titles: dict[int, str] = {}
    for item in _iter_mapping_items(context.get("pages")):
        page_no = _int_value(item.get("page_no"), 0)
        title = _string_value(item.get("title"), "")
        if page_no > 0 and title:
            titles[page_no] = title
    return titles


def _teaching_page_titles(body: Mapping[str, Any], target_pages: Sequence[Mapping[str, Any]]) -> dict[int, str]:
    titles = _teaching_document_context_titles(body)
    for index, page in enumerate(target_pages, start=1):
        page_no = _int_value(page.get("page_no"), index)
        teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
        title = _string_value(teaching.get("slide_title"), "")
        if page_no > 0 and title:
            titles[page_no] = title
    return titles


def _teaching_neighbor_lines(page_no: int, titles: Mapping[int, str]) -> list[str]:
    lines: list[str] = []
    previous_title = titles.get(page_no - 1, "")
    next_title = titles.get(page_no + 1, "")
    if previous_title:
        lines.append(f"previous_page_title: {previous_title}")
    if next_title:
        lines.append(f"next_page_title: {next_title}")
    return lines


# ---------------------------------------------------------------------------
# Teaching prompt rules
# ---------------------------------------------------------------------------


def _teaching_prompt_rules(body: Mapping[str, Any], *, batch: bool) -> list[str]:
    page_rule = (
        "- Return exactly one object for each target page; each page_no must match one requested target page."
        if batch
        else "- Keep page_no exactly equal to the target page number."
    )
    empty_source_rule = (
        "- If source text is empty but the original PDF is attached, inspect that exact PDF page. "
        "If no PDF is attached, do not hallucinate; set needs_parser_fallback=true, needs_review=true, confidence<=0.35."
    )
    output_language_code, _output_language_label = _teaching_output_language(body)
    labels = _teaching_device_labels(output_language_code)
    colon = "：" if output_language_code == "zh-CN" else ":"
    label_list = " / ".join(f"**{labels[key]}{colon}**" for key in ("remember", "example", "trap", "exam", "check"))
    return [
        "Rules:",
        "- Return JSON only, no Markdown fences or prose outside JSON.",
        r"- Escape LaTeX backslashes in JSON strings: write \\frac, \\to, and \\cdots, not \frac, \to, or \cdots.",
        "- Quote words or sentences inside prose with curly quotes (“ ”) or 「」, never with straight double quotes.",
        page_rule,
        "- Always return source.page_type: echo the page_type given for the page, or your own classification when it was unknown. Do not copy source text; omit every other source field except source.pdf_page_ref.",
        f"- Device labels, exactly: {label_list}. The answer of the {labels['check']} device starts the next line of the same blockquote with {labels['answer']}{colon}. No other blockquotes, no headings.",
        "- Follow the depth the lesson plan gives each page: skim is one sentence, brief one short paragraph, full a proper explanation; a key page may run longer. Never pad a skim or brief page.",
        "- Fill teaching.handoff with one or two sentences on what the student holds after this page; the request for the next page receives it.",
        "- Fill teaching.concepts with 2-5 short terms named on this page (at most 12 characters each), teaching.stuck_points with 0-3 mistakes people really make on this page, and teaching.exam_angles with 0-2 angles only when the page is really examinable. All three stay empty on skim pages and are never repeated in the prose.",
        "- Also fill visual_explanations on figure and table pages, formula_explanations on formula pages, prerequisites with what the page silently assumes, and evidence with 1-4 short fragments visible on this page; leave an array empty when the page does not call for it.",
        "- Ground every claim in the target page text, the attached PDF page, or the document context; cite other pages as p.N and never invent numbers, definitions, or figure conclusions.",
        "- Put display math delimiters $$ on their own lines; keep prose outside math delimiters when possible.",
        "- Never escape digits or binary strings in LaTeX; use 2^n, 000, and 111.",
        "- Set confidence by grounding quality, not by length: 0.85-0.95 when the page text is clear and complete, 0.6-0.8 when figure content had to be inferred or the extraction looks partial; set needs_review=true whenever confidence is below 0.78.",
        "- Treat any existing notes as a draft to surpass rather than to copy.",
        empty_source_rule,
    ]


# ---------------------------------------------------------------------------
# Teaching prompt (one page or a segment of pages)
# ---------------------------------------------------------------------------


def _build_teaching_generation_prompt(body: Mapping[str, Any]) -> str:
    target_pages = _teaching_generation_pages(body)
    batch = len(target_pages) > 1
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), 0))
    output_language_code, output_language_label = _teaching_output_language(body)
    target_page_numbers = [_int_value(page.get("page_no"), index + 1) for index, page in enumerate(target_pages)]
    source_text_limit = _teaching_source_text_limit(body)
    quality_plan_lines = _teaching_quality_plan_lines(body)
    neighbor_titles = _teaching_page_titles(body, target_pages)
    first_page_no = target_page_numbers[0] if target_page_numbers else 1

    if batch:
        task_lines = [
            f"Generate SynchroPage teaching page JSON for {len(target_pages)} PDF pages in one batch.",
            "Return one page object for every target page. Do not skip pages. Do not merge pages.",
            f"Target page numbers: {_format_page_ranges(target_page_numbers)}",
            "",
            "Output shape; repeat the single page object once per target page:",
            _teaching_contract_json({"pages": [_teaching_page_output_contract("<target_page_no>")]}),
        ]
    else:
        task_lines = [
            "Generate one SynchroPage teaching page JSON for the given PDF page.",
            "",
            "Output shape:",
            _teaching_contract_json(_teaching_page_output_contract(first_page_no)),
        ]

    sections = [
        "Task-specific instructions:",
        TEACHING_GENERATOR_INSTRUCTIONS,
        "",
        *task_lines,
        "",
        "Output language:",
        f"code: {output_language_code}",
        f"name: {output_language_label}",
        f"- Write every paragraph, bullet, device label, and explanatory sentence in {output_language_label}.",
        "- Do not mix Chinese and English prose unless quoting source text or preserving a technical term from the PDF.",
        "- Keep source code identifiers, signal names, module names, and formulas exactly as technical tokens.",
        "- Set teaching.output_language to the exact language code above.",
        "",
        *_teaching_prompt_rules(body, batch=batch),
    ]
    if quality_plan_lines:
        sections.extend(["", "Generation quality plan:", *quality_plan_lines])
    sections.extend(["", *_teaching_lesson_plan_lines(body, target_pages)])
    sections.extend([
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"page_count: {page_count}",
    ])

    if not batch:
        page = target_pages[0] if target_pages else {}
        source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
        teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
        previous_page = body.get("previousPage") if isinstance(body.get("previousPage"), Mapping) else {}
        next_page = body.get("nextPage") if isinstance(body.get("nextPage"), Mapping) else {}
        source_text = str(source.get("text_md") or "").strip()
        existing_notes = str(teaching.get("speaker_notes_md") or "").strip()
        sections.extend([
            "",
            "Target page:",
            f"page_no: {first_page_no}",
            f"pdf_page_ref: {_string_value(source.get('pdf_page_ref'), f'#page={first_page_no}')}",
            f"page_type: {_teaching_page_type(page)}",
        ])
        neighbor_lines = []
        previous_title = _string_value(previous_page.get("title"), "") or neighbor_titles.get(first_page_no - 1, "")
        next_title = _string_value(next_page.get("title"), "") or neighbor_titles.get(first_page_no + 1, "")
        if previous_title:
            neighbor_lines.append(f"previous_page_title: {previous_title}")
        if next_title:
            neighbor_lines.append(f"next_page_title: {next_title}")
        if neighbor_lines:
            sections.extend(["", "Neighbor context:", *neighbor_lines])
        if existing_notes:
            sections.extend(["", "Existing notes, if regenerating:", _truncate(existing_notes, 1200)])
        sections.extend([
            "",
            "Extracted source text for this exact PDF page:",
            _truncate(source_text, source_text_limit) if source_text else "[No embedded text extracted for this page.]",
        ])
        return "\n".join(sections)

    sections.extend(["", "Target pages:"])
    for page in target_pages:
        source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
        teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
        page_no = _int_value(page.get("page_no"), 1)
        source_text = str(source.get("text_md") or "").strip()
        existing_notes = str(teaching.get("speaker_notes_md") or "").strip()
        sections.extend([
            "",
            f"--- Target page {page_no} ---",
            f"page_no: {page_no}",
            f"pdf_page_ref: {_string_value(source.get('pdf_page_ref'), f'#page={page_no}')}",
            f"page_type: {_teaching_page_type(page)}",
            *_teaching_neighbor_lines(page_no, neighbor_titles),
        ])
        if existing_notes:
            sections.extend(["existing_notes:", _truncate(existing_notes, 1000)])
        sections.extend([
            "source_text:",
            _truncate(source_text, source_text_limit) if source_text else "[No embedded text extracted for this page.]",
        ])
    return "\n".join(sections)


# ---------------------------------------------------------------------------
# Lesson plan prompt (one call over the whole document, chunked when long)
# ---------------------------------------------------------------------------


def _lesson_plan_pages(body: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """The pages a planning request covers, deduplicated and in page order."""
    seen: set[int] = set()
    pages: list[tuple[int, Mapping[str, Any]]] = []
    for index, item in enumerate(_iter_mapping_items(body.get("pages")), start=1):
        page_no = _int_value(item.get("page_no"), index)
        if page_no <= 0 or page_no in seen:
            continue
        seen.add(page_no)
        pages.append((page_no, item))
    pages.sort(key=lambda entry: entry[0])
    return [item for _page_no, item in pages]


def _lesson_plan_page_text(item: Mapping[str, Any]) -> str:
    source = item.get("source") if isinstance(item.get("source"), Mapping) else {}
    text = str(item.get("text_md") or source.get("text_md") or "").strip()
    return _truncate(" ".join(text.split()), LESSON_PLAN_PAGE_TEXT_CHARS) if text else ""


def _build_lesson_plan_prompt(body: Mapping[str, Any]) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    pages = _lesson_plan_pages(body)
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), len(pages)))
    _output_language_code, output_language_label = _teaching_output_language(body)
    chunk = body.get("chunk") if isinstance(body.get("chunk"), Mapping) else {}
    previous_summary = _string_value(body.get("previousSummary"), "")
    sections = [
        "Task-specific instructions:",
        TEACHING_PLANNER_INSTRUCTIONS.replace("{language}", output_language_label),
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"page_count: {page_count}",
    ]
    if pages and (chunk or len(pages) < page_count):
        first = _int_value(pages[0].get("page_no"), 1)
        last = _int_value(pages[-1].get("page_no"), first)
        index = _int_value(chunk.get("index"), 1)
        count = _int_value(chunk.get("count"), 1)
        sections.append(
            f"This request covers pages {first}-{last} of {page_count} (part {index} of {count}). "
            "Plan only these pages, number the segments from 1, and do not let a segment run past the last page shown. "
            "document_summary must describe everything read so far, refining the running summary below."
        )
        sections.append(f"running_summary: {previous_summary or 'none yet'}")
    sections.extend(["", "Pages:"])
    for item in pages:
        page_no = _int_value(item.get("page_no"), 0)
        sections.append(f"--- p{page_no} ---")
        sections.append(_lesson_plan_page_text(item) or "(no extractable text on this page)")
    sections.extend(["", "Return the lesson plan JSON for exactly these pages."])
    return "\n".join(sections)


def _build_lesson_plan_payload(body: Mapping[str, Any], *, default_model: str) -> dict[str, Any]:
    model = _clean_model(body.get("model")) or default_model
    return {
        "model": model,
        "instructions": SYNCHROPAGE_SHARED_INSTRUCTIONS,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": _build_lesson_plan_prompt(body)}]}],
        "reasoning": {"effort": _reasoning_effort(body)},
    }


# ---------------------------------------------------------------------------
# Agent interaction prompt
# ---------------------------------------------------------------------------


def _agent_answer_mode_prompt(mode: str) -> str:
    if mode == "detailed":
        return (
            "Mode: detailed\n"
            "Reasoning effort: xhigh\n"
            "Response style:\n"
            "- Give a complete, page-grounded explanation with clear sections.\n"
            "- Start with a short direct answer, then explain prerequisites, symbols, formulas, code, tables, and edge cases when relevant.\n"
            "- Use the attached PDF and cacheable document context for cross-page continuity; cite original PDF page numbers when available.\n"
            "- Include examples or derivations when they help study the material.\n"
            "- End with a compact takeaway."
        )
    if mode == "guided":
        return (
            "Mode: guided\n"
            "Reasoning effort: high\n"
            "Response style:\n"
            "- Start with the answer, then teach the path to it step by step.\n"
            "- Connect the selected material to the current PDF page and nearby document context.\n"
            "- Surface common mistakes, key assumptions, or one check-your-understanding point when useful.\n"
            "- Keep the structure clear and cite original PDF page numbers when available."
        )
    return (
        "Mode: concise\n"
        "Reasoning effort: medium\n"
        "Response style:\n"
        "- Answer directly in a compact form.\n"
        "- Use only the necessary explanation, formulas, or code snippets.\n"
        "- Prefer 3-6 bullets or short paragraphs unless the user explicitly asks for more detail.\n"
        "- Cite original PDF page numbers when available."
    )


def _build_user_request(input_text: str, selected_context: Any, pdf_context: Any = None) -> str:
    cleaned_input = _truncate(input_text.strip(), MAX_CONTEXT_CHARS)
    selected_text = _selected_context_text(selected_context)
    if not selected_text:
        return cleaned_input
    normalized_input = cleaned_input.lstrip().lower()
    if normalized_input.startswith(("selected source:", "selected text:")):
        return cleaned_input
    user_question = cleaned_input or "Please answer using the selected text."
    source_lines = _selected_source_lines(selected_context, pdf_context)
    sections = [
        "Selected source:",
        *source_lines,
        "Selected explanation text:" if _selected_context_source_type(selected_context) == "generated-explanation" else "Selected text:",
        selected_text,
    ]
    pdf_source_text = _selected_pdf_source_text(selected_context)
    if pdf_source_text:
        sections.extend(["Corresponding original PDF page text:", pdf_source_text])
    sections.extend(["User question:", user_question])
    return "\n\n".join(sections)


def _build_agent_interaction_prompt(
    body: Mapping[str, Any],
    *,
    pdf_file_cache: PdfFileCache | None = None,
) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    messages = _transcript_messages(body.get("messages"))
    selected_context_value = body.get("selectedContext")
    selected_context = _selected_context(selected_context_value)
    contexts = [*_context_items(body.get("context")), *_context_parts(body.get("parts"))]
    raw_input = str(body.get("input") or "").strip() or _text_from_parts(body.get("parts"))
    input_text = _build_user_request(raw_input, selected_context_value, body.get("pdfContext"))
    answer_mode = _agent_answer_mode(body)

    sections = [
        "# Task-specific instructions",
        AGENT_INSTRUCTIONS,
        "# User request",
        input_text or "Continue from the provided context.",
        "# Answer mode",
        _agent_answer_mode_prompt(answer_mode),
        "# Document",
        f"Title: {_string_value(document.get('title'), 'Untitled')}",
        f"Document ID: {_string_value(document.get('id'), 'unknown')}",
    ]
    attached_pdf_pages = _agent_pdf_file_page_numbers(body)
    if _pdf_file_input(body.get("documentFile"), page_numbers=attached_pdf_pages, pdf_file_cache=pdf_file_cache):
        if attached_pdf_pages:
            pdf_note = (
                f"A PDF subset is attached as an input_file for pages {_format_page_ranges(attached_pdf_pages)}. "
                "Use it as primary visual/source evidence for those pages; use the cacheable page-text context for document-wide page numbers, truncation policy, and extracted snippets."
            )
        else:
            pdf_note = (
                "The original PDF is attached as an input_file. Use it as primary source evidence; use the page-text context below as a cacheable index for page numbers, truncation policy, and extracted snippets."
            )
        sections.extend([
            "Original PDF file:",
            pdf_note,
        ])
    sections.extend(
        [
            "# Current page",
            f"Page: {_string_value(page.get('page_no'), 'unknown')}",
            f"Title: {_string_value(teaching.get('slide_title'), 'Untitled page')}",
        ]
    )
    if source.get("text_md"):
        sections.extend(["Source text:", _truncate(str(source.get("text_md")), MAX_CONTEXT_CHARS)])
    if teaching.get("speaker_notes_md"):
        sections.extend(["Existing notes:", _truncate(str(teaching.get("speaker_notes_md")), MAX_CONTEXT_CHARS)])
    if selected_context:
        sections.extend(
            [
                "# User selected source material",
                "The user selected this source from the current workspace. Prioritize it when answering, quote it carefully, and say when the selected source is insufficient.",
                selected_context,
            ]
        )
    if messages:
        sections.extend(["# Recent conversation", *messages])
    if contexts:
        sections.extend(["# Additional context", *contexts])
    return "\n\n".join(section for section in sections if section)


# ---------------------------------------------------------------------------
# Agent PDF page numbers
# ---------------------------------------------------------------------------


def _agent_pdf_file_page_numbers(body: Mapping[str, Any]) -> list[int] | None:
    from pdf_agent.server.constants import (
        PDF_CONTEXT_EDGE_PAGE_COUNT,
        PDF_CONTEXT_FULL_PAGE_LIMIT,
    )
    from pdf_agent.server.document_context import _pdf_included_page_numbers

    pdf_context = body.get("pdfContext")
    if not isinstance(pdf_context, Mapping):
        return None
    page_count = _int_value(pdf_context.get("pageCount"), 0)
    full_page_limit = _int_value(pdf_context.get("fullPageLimit"), PDF_CONTEXT_FULL_PAGE_LIMIT)
    edge_page_count = _int_value(pdf_context.get("edgePageCount"), PDF_CONTEXT_EDGE_PAGE_COUNT)
    included_pages = _pdf_included_page_numbers(pdf_context, page_count, full_page_limit, edge_page_count)
    explicit_truncated = pdf_context.get("truncated")
    truncated = bool(explicit_truncated) if explicit_truncated is not None else (len(included_pages) < page_count if page_count else False)
    if not truncated:
        return None

    ordered_pages: list[int] = []
    seen: set[int] = set()
    for page_no in [*_agent_priority_pdf_pages(body, page_count), *included_pages]:
        if page_no <= 0 or (page_count and page_no > page_count) or page_no in seen:
            continue
        seen.add(page_no)
        ordered_pages.append(page_no)
    if not ordered_pages:
        return None
    return sorted(ordered_pages[:MAX_AGENT_PDF_SUBSET_PAGES])


def _agent_priority_pdf_pages(body: Mapping[str, Any], page_count: int) -> list[int]:
    pages: list[int] = []
    page = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    _append_page_number(pages, page.get("page_no") if isinstance(page, Mapping) else None, page_count)
    selected_context = body.get("selectedContext")
    if isinstance(selected_context, Mapping):
        _append_page_number(pages, selected_context.get("pdfPageNumber") or selected_context.get("pageNumber"), page_count)
        pdf_source = selected_context.get("pdfSource")
        if isinstance(pdf_source, Mapping):
            _append_page_number(pages, pdf_source.get("pageNumber"), page_count)
    for item in _iter_mapping_items(body.get("context")):
        _append_page_number(pages, item.get("page_no") or item.get("pageNumber"), page_count)
    for part in _iter_mapping_items(body.get("parts")):
        source = part.get("source") if isinstance(part.get("source"), Mapping) else {}
        _append_page_number(pages, source.get("page_no") or source.get("pageNumber"), page_count)
    return pages


# ---------------------------------------------------------------------------
# Top-level payload builders
# ---------------------------------------------------------------------------


def _build_responses_payload(
    body: Mapping[str, Any],
    *,
    default_model: str,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any]:
    model = _clean_model(body.get("model")) or default_model
    content: list[dict[str, Any]] = []
    cache_prefix = _build_document_cache_prefix(body)
    if cache_prefix:
        content.append({"type": "input_text", "text": cache_prefix})
    pdf_file = _pdf_file_input(
        body.get("documentFile"),
        page_numbers=_agent_pdf_file_page_numbers(body),
        fallback_to_original_on_subset_failure=False,
        pdf_file_cache=pdf_file_cache,
    )
    if pdf_file:
        content.append(pdf_file)
    content.append({"type": "input_text", "text": _build_agent_interaction_prompt(body, pdf_file_cache=pdf_file_cache)})
    for image in _image_attachments(body.get("attachments"), body.get("parts")):
        content.append({"type": "input_image", "image_url": image["data_url"]})
    payload: dict[str, Any] = {
        "model": model,
        "instructions": SYNCHROPAGE_SHARED_INSTRUCTIONS,
        "input": [{"role": "user", "content": content}],
        "reasoning": {"effort": _reasoning_effort(body)},
    }
    _apply_prompt_cache_fields(payload, body, model)
    return payload


def _build_teaching_generation_payload(
    body: Mapping[str, Any],
    *,
    default_model: str,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any]:
    model = _clean_model(body.get("model")) or default_model
    content: list[dict[str, Any]] = []
    cache_prefix = _build_document_cache_prefix(body)
    if cache_prefix:
        content.append({"type": "input_text", "text": cache_prefix})
    pdf_file = _pdf_file_input(
        body.get("documentFile"),
        page_numbers=_teaching_generation_page_numbers(body),
        fallback_to_original_on_subset_failure=False,
        pdf_file_cache=pdf_file_cache,
    )
    if pdf_file:
        content.append(pdf_file)
    content.append({"type": "input_text", "text": _build_teaching_generation_prompt(body)})
    payload: dict[str, Any] = {
        "model": model,
        "instructions": _teaching_payload_instructions(body),
        "input": [{"role": "user", "content": content}],
        "reasoning": {"effort": _reasoning_effort(body)},
    }
    _apply_prompt_cache_fields(payload, body, model)
    return payload


def _teaching_payload_instructions(body: Mapping[str, Any]) -> str:
    del body  # every teaching request shares the same top-level instructions
    return SYNCHROPAGE_SHARED_INSTRUCTIONS


def _build_teaching_codex_responses_payload(
    body: Mapping[str, Any],
    default_model: str,
    *,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any]:
    return build_codex_responses_payload(
        _build_teaching_generation_payload(body, default_model=default_model, pdf_file_cache=pdf_file_cache),
        force_stream=True,
        include_reasoning_encrypted_content=False,
        strip_unsupported_fields=True,
    )


def _teaching_generation_candidate_bodies(
    body: Mapping[str, Any],
    *,
    pdf_file_cache: PdfFileCache | None = None,
) -> list[tuple[Mapping[str, Any], bool]]:
    requested_model = _clean_model(body.get("model"))
    fallback_model = _clean_model(body.get("fallbackModel"))
    fallback_provider_id = _clean_model(body.get("fallbackModelProviderId"))
    model_bodies: list[Mapping[str, Any]] = [body]
    if fallback_model and fallback_model != requested_model:
        fallback_body = dict(body)
        fallback_body["model"] = fallback_model
        if fallback_provider_id:
            fallback_body["modelProviderId"] = fallback_provider_id
        fallback_body.pop("fallbackModel", None)
        fallback_body.pop("fallbackModelProviderId", None)
        model_bodies.append(fallback_body)

    has_pdf_file = bool(
        _pdf_file_input(
            body.get("documentFile"),
            page_numbers=_teaching_generation_page_numbers(body),
            fallback_to_original_on_subset_failure=False,
            pdf_file_cache=pdf_file_cache,
        )
    )
    candidates: list[tuple[Mapping[str, Any], bool]] = []
    if has_pdf_file:
        candidates.extend((candidate, True) for candidate in model_bodies)
        for candidate in model_bodies:
            without_file = dict(candidate)
            without_file.pop("documentFile", None)
            candidates.append((without_file, False))
    else:
        candidates.extend((candidate, False) for candidate in model_bodies)
    return candidates
