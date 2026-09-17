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
    LESSON_PLAN_MAX_PDF_PAGES,
    LESSON_PLAN_PAGE_TEXT_CHARS,
    MAX_AGENT_PDF_SUBSET_PAGES,
    MAX_CONTEXT_CHARS,
    MAX_IMAGE_DATA_URL_CHARS,
    MAX_PAGE_IMAGES,
    MAX_TEACHING_BALANCED_SOURCE_CHARS,
    MAX_TEACHING_QUALITY_SOURCE_CHARS,
    OCR_FREE_PROMPT,
    OCR_GROUNDING_PROMPT,
    OCR_MAX_OUTPUT_TOKENS,
    OCR_PARSER,
    SYNCHROPAGE_SHARED_INSTRUCTIONS,
    TEACHING_DEPTHS,
    TEACHING_DEVICE_LABELS,
    TEACHING_GENERATOR_INSTRUCTIONS,
    TEACHING_PAGE_ROLES,
    TEACHING_PLANNER_INSTRUCTIONS,
    TEACHING_TRANSCRIBER_INSTRUCTIONS,
    TRANSCRIPTION_HINT_CHARS,
    TRANSCRIPTION_MAX_PAGES,
    TRANSCRIPTION_PARSER,
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
from pdf_agent.server.errors import HttpError
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
            "point": "one sentence: the claim the student must take away from this page",
            "gap": "what the slide leaves unsaid that the student needs, or none",
            "speaker_notes_md": "the explanation in Markdown: opens with the point, then closes the gap; labelled blockquotes are the only devices, no headings",
            "handoff": "one sentence: what the student now holds, so the next page does not explain it again",
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
        lines.append(f"student_already_holds (from the previous page; build on it, do not open by recapping it): {handoff}")
    else:
        lines.append(
            "student_already_holds: nothing from this run (this is the first page you teach; "
            "do not recap pages you were not shown)."
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
# Page images (renderings of PDF pages the client attaches)
# ---------------------------------------------------------------------------


def _page_images(body: Mapping[str, Any], page_numbers: Sequence[int] | None = None) -> dict[int, str]:
    """``pageImages`` of the request as {page_no: data URL}, page order, capped."""
    allowed = {int(page_no) for page_no in page_numbers} if page_numbers is not None else None
    images: dict[int, str] = {}
    for item in _iter_mapping_items(body.get("pageImages")):
        page_no = _int_value(item.get("page_no"), 0)
        data_url = str(item.get("data_url") or "")
        if page_no <= 0 or page_no in images or not data_url.startswith("data:image/"):
            continue
        if allowed is not None and page_no not in allowed:
            continue
        if len(data_url) > MAX_IMAGE_DATA_URL_CHARS:
            raise HttpError(413, f"Page image for p.{page_no} is too large", code="image_too_large")
        images[page_no] = data_url
        if len(images) >= MAX_PAGE_IMAGES:
            break
    return dict(sorted(images.items()))


def _page_image_parts(images: Mapping[int, str]) -> list[dict[str, Any]]:
    return [{"type": "input_image", "image_url": url} for _page_no, url in sorted(images.items())]


# ---------------------------------------------------------------------------
# Text layer notes (unreadable or transcribed source text)
# ---------------------------------------------------------------------------


def _source_is_transcribed(source: Mapping[str, Any]) -> bool:
    return _string_value(source.get("parser"), "") in {TRANSCRIPTION_PARSER, OCR_PARSER}


def _source_text_layer_lines(
    source: Mapping[str, Any],
    *,
    pdf_attached: bool = False,
    image_attached: bool = False,
) -> list[str]:
    """Tell the model when the extracted text is not the page.

    A slide whose formulas were drawn with an embedded font extracts as stray
    symbols; the client flags such pages with ``source.text_garbled``. When
    the PDF page or a rendering of it travels with the request the model reads
    it there; when a model already transcribed the page the text is
    trustworthy but unproofed; otherwise the model must teach around the hole
    instead of decoding noise.
    """
    parser = _string_value(source.get("parser"), "")
    if parser == OCR_PARSER:
        return [
            (
                "text_layer: read from the page image by an OCR model because the PDF's own text layer was unreadable; "
                "the layout and prose are faithful, but check formula details (subscripts, bars, transposes) against the context."
            )
        ]
    if _source_is_transcribed(source):
        return [
            (
                "text_layer: transcribed from the page image by a model because the PDF's own text layer was unreadable; "
                "treat its formulas as faithful but not proofread."
            )
        ]
    if not bool(source.get("text_garbled")):
        if image_attached:
            return ["page_image: a rendering of this page is attached; use it alongside the extracted text."]
        return []
    if pdf_attached:
        return [
            (
                "text_layer: unreadable (formulas drawn with an embedded font came out as stray symbols). "
                "The PDF page is attached: read every formula there and ignore the noise in source_text."
            )
        ]
    if image_attached:
        return [
            (
                "text_layer: unreadable (formulas drawn with an embedded font came out as stray symbols). "
                "A rendering of the page is attached as an image: read every formula there and ignore the noise in source_text."
            )
        ]
    return [
        (
            "text_layer: unreadable (formulas drawn with an embedded font came out as stray symbols) and no PDF page is attached. "
            "Teach from the title, the plan cue and the neighbouring pages; quote no formula you cannot see; say plainly which "
            "formula the slide shows that you could not read; set needs_review=true and confidence at most 0.6."
        )
    ]


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
        "- Write teaching.point and teaching.gap before teaching.speaker_notes_md, in that order; the first sentence of the explanation states the point and the rest closes the gap.",
        "- The depth the lesson plan gives a page is a ceiling on length, never a target: skim is one sentence, brief at most a short paragraph, full at most a few paragraphs; a key page may run longer when its gap is that large. Never pad, and never restate what the student can read on the slide.",
        "- Fill teaching.handoff with one sentence on what the student holds after this page; the request for the next page receives it so that it is not explained twice.",
        "- Fill teaching.concepts with 2-5 short terms named on this page (at most 12 characters each), teaching.stuck_points with 0-3 mistakes people really make on this page, and teaching.exam_angles with 0-2 angles only when the page is really examinable. All three stay empty on skim pages and are never repeated in the prose.",
        "- Also fill visual_explanations on figure and table pages, formula_explanations on formula pages, prerequisites with what the page silently assumes, and evidence with 1-4 short fragments visible on this page; leave an array empty when the page does not call for it.",
        "- Ground every claim in the target page text, the attached PDF page, or the document context; cite other pages as p.N and never invent numbers, definitions, or figure conclusions.",
        "- Put display math delimiters $$ on their own lines; keep prose outside math delimiters when possible.",
        "- Never escape digits or binary strings in LaTeX; use 2^n, 000, and 111.",
        "- Set confidence by grounding quality, not by length: 0.85-0.95 when the page text is clear and complete, 0.6-0.8 when figure content had to be inferred or the extraction looks partial; set needs_review=true whenever confidence is below 0.78.",
        "- Treat any existing notes as a draft to surpass rather than to copy.",
        "- When a page's text_layer is marked unreadable, the stray symbols in its source_text are not the formula: never transcribe, decode, or interpret them.",
        empty_source_rule,
    ]


# ---------------------------------------------------------------------------
# Teaching prompt (one page or a segment of pages)
# ---------------------------------------------------------------------------


def _build_teaching_generation_prompt(
    body: Mapping[str, Any],
    *,
    pdf_attached: bool = False,
    image_pages: Sequence[int] | Mapping[int, Any] = (),
) -> str:
    image_set = {int(page_no) for page_no in image_pages}
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
    if image_set:
        sections.append(
            f"Attached page images: {_format_page_ranges(sorted(image_set))} (renderings of those PDF pages, in page order; "
            "read each one as the page itself)."
        )

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
            *_source_text_layer_lines(source, pdf_attached=pdf_attached, image_attached=first_page_no in image_set),
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
            *_source_text_layer_lines(source, pdf_attached=pdf_attached, image_attached=page_no in image_set),
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


def _lesson_plan_page_garbled(item: Mapping[str, Any]) -> bool:
    source = item.get("source") if isinstance(item.get("source"), Mapping) else {}
    return bool(item.get("garbled")) or bool(source.get("text_garbled"))


def _lesson_plan_page_transcribed(item: Mapping[str, Any]) -> bool:
    source = item.get("source") if isinstance(item.get("source"), Mapping) else {}
    return bool(item.get("transcribed")) or _source_is_transcribed(source)


def _lesson_plan_attach_page_numbers(body: Mapping[str, Any]) -> list[int]:
    """Pages of this planning request whose PDF page travels with it.

    ``attachPages`` names them explicitly; without it every page flagged as
    garbled is attached. Only pages of this chunk count, capped so a long
    deck never attaches more than ``LESSON_PLAN_MAX_PDF_PAGES`` at once.
    """
    if not isinstance(body.get("documentFile"), Mapping) and not _page_images(body):
        return []
    pages = _lesson_plan_pages(body)
    in_request = {_int_value(item.get("page_no"), 0) for item in pages}
    requested = body.get("attachPages")
    if isinstance(requested, Sequence) and not isinstance(requested, str):
        numbers = [_int_value(value, 0) for value in requested]
    else:
        numbers = [_int_value(item.get("page_no"), 0) for item in pages if _lesson_plan_page_garbled(item)]
    ordered = sorted({page_no for page_no in numbers if page_no > 0 and page_no in in_request})
    return ordered[:LESSON_PLAN_MAX_PDF_PAGES]


def _build_lesson_plan_prompt(
    body: Mapping[str, Any],
    *,
    attached_pages: Sequence[int] = (),
    attached_as: str = "pdf",
) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    pages = _lesson_plan_pages(body)
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), len(pages)))
    _output_language_code, output_language_label = _teaching_output_language(body)
    chunk = body.get("chunk") if isinstance(body.get("chunk"), Mapping) else {}
    previous_summary = _string_value(body.get("previousSummary"), "")
    attached = set(attached_pages)
    sections = [
        "Task-specific instructions:",
        TEACHING_PLANNER_INSTRUCTIONS.replace("{language}", output_language_label),
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"page_count: {page_count}",
    ]
    if attached and attached_as == "images":
        sections.append(
            f"Attached page images: {_format_page_ranges(sorted(attached))}. Their text layer is unreadable (formulas drawn "
            "with an embedded font came out as stray symbols), so those pages are attached as images, one rendering per "
            "page in page order: read them there to judge what they teach. The other pages are text only."
        )
    elif attached:
        sections.append(
            f"Attached PDF pages: {_format_page_ranges(sorted(attached))}. Their text layer is unreadable (formulas drawn "
            "with an embedded font came out as stray symbols), so those pages are attached as an input_file: read them "
            "there to judge what they teach. The other pages are text only."
        )
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
        if page_no in attached:
            sections.append(
                "(text layer unreadable; read the attached page image)"
                if attached_as == "images"
                else "(text layer unreadable; read the attached PDF page)"
            )
        elif _lesson_plan_page_garbled(item):
            sections.append(
                "(text layer unreadable: the formulas came out as stray symbols and no PDF page is attached; "
                "judge this page's role from its title and its neighbours)"
            )
        elif _lesson_plan_page_transcribed(item):
            sections.append("(text transcribed from the page image by a model)")
        sections.append(_lesson_plan_page_text(item) or "(no extractable text on this page)")
    sections.extend(["", "Return the lesson plan JSON for exactly these pages."])
    return "\n".join(sections)


def _build_lesson_plan_payload(
    body: Mapping[str, Any],
    *,
    default_model: str,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any]:
    model = _clean_model(body.get("model")) or default_model
    attach_pages = _lesson_plan_attach_page_numbers(body)
    images = _page_images(body, page_numbers=attach_pages) if attach_pages else {}
    pdf_file = (
        _pdf_file_input(
            body.get("documentFile"),
            page_numbers=attach_pages,
            fallback_to_original_on_subset_failure=False,
            pdf_file_cache=pdf_file_cache,
        )
        if attach_pages and not images
        else None
    )
    content: list[dict[str, Any]] = []
    if images:
        content.extend(_page_image_parts(images))
        attached, attached_as = list(images), "images"
    elif pdf_file:
        content.append(pdf_file)
        attached, attached_as = list(attach_pages), "pdf"
    else:
        attached, attached_as = [], "pdf"
    content.append({
        "type": "input_text",
        "text": _build_lesson_plan_prompt(body, attached_pages=attached, attached_as=attached_as),
    })
    return {
        "model": model,
        "instructions": SYNCHROPAGE_SHARED_INSTRUCTIONS,
        "input": [{"role": "user", "content": content}],
        "reasoning": {"effort": _reasoning_effort(body)},
    }


# ---------------------------------------------------------------------------
# Page transcription prompt (pages whose text layer is unreadable)
# ---------------------------------------------------------------------------


def _transcription_pages(body: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    """The pages one transcription request covers, in page order."""
    return _lesson_plan_pages(body)[:TRANSCRIPTION_MAX_PAGES]


def _transcription_page_numbers(body: Mapping[str, Any]) -> list[int]:
    return [page_no for page_no in (_int_value(item.get("page_no"), 0) for item in _transcription_pages(body)) if page_no > 0]


def _build_transcription_prompt(body: Mapping[str, Any], *, attached_as: str = "pdf") -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    pages = _transcription_pages(body)
    page_numbers = _transcription_page_numbers(body)
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), 0))
    attached_line = (
        f"Attached page images: {_format_page_ranges(page_numbers)} (one rendering per page, in this order; "
        "page_no below refers to the original document)."
        if attached_as == "images"
        else f"Attached PDF pages: {_format_page_ranges(page_numbers)} (a subset of the original PDF, in this order; "
        "page_no below refers to the original document)."
    )
    sections = [
        "Task-specific instructions:",
        TEACHING_TRANSCRIBER_INSTRUCTIONS,
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"page_count: {page_count}",
        attached_line,
        "",
        "Pages:",
    ]
    for item in pages:
        page_no = _int_value(item.get("page_no"), 0)
        source = item.get("source") if isinstance(item.get("source"), Mapping) else {}
        hint = " ".join(str(item.get("text_md") or source.get("text_md") or "").split())
        sections.append(f"--- p{page_no} ---")
        sections.append(f"extracted_text_hint: {_truncate(hint, TRANSCRIPTION_HINT_CHARS) if hint else '(none)'}")
    sections.extend(["", "Return the transcription JSON for exactly these pages."])
    return "\n".join(sections)


def _build_transcription_payload(
    body: Mapping[str, Any],
    *,
    default_model: str,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any]:
    model = _clean_model(body.get("model")) or default_model
    page_numbers = _transcription_page_numbers(body)
    images = _page_images(body, page_numbers=page_numbers)
    if images:
        content: list[dict[str, Any]] = [
            *_page_image_parts(images),
            {"type": "input_text", "text": _build_transcription_prompt(body, attached_as="images")},
        ]
    else:
        pdf_file = _pdf_file_input(
            body.get("documentFile"),
            page_numbers=page_numbers,
            fallback_to_original_on_subset_failure=False,
            pdf_file_cache=pdf_file_cache,
        )
        if not pdf_file:
            raise HttpError(
                400,
                "Page transcription needs the pages: send pageImages, or documentFile with fileData or a cached sha256",
                code="transcription_needs_pdf",
            )
        content = [pdf_file, {"type": "input_text", "text": _build_transcription_prompt(body)}]
    return {
        "model": model,
        "instructions": SYNCHROPAGE_SHARED_INSTRUCTIONS,
        "input": [{"role": "user", "content": content}],
        "reasoning": {"effort": _reasoning_effort(body)},
    }


# ---------------------------------------------------------------------------
# OCR payload (a dedicated document model such as DeepSeek-OCR, one page image per call)
# ---------------------------------------------------------------------------


def _ocr_prompt(body: Mapping[str, Any]) -> str:
    return OCR_GROUNDING_PROMPT if _string_value(body.get("ocrMode"), "") == "grounding" else OCR_FREE_PROMPT


def _build_ocr_payload(
    body: Mapping[str, Any],
    *,
    default_model: str,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any]:
    """The request the deepseek-ocr SDK sends: one image, the OCR prompt, no system text."""
    del pdf_file_cache  # OCR models take page images, never PDF files
    model = _clean_model(body.get("model")) or default_model
    images = _page_images(body, page_numbers=_transcription_page_numbers(body))
    if len(images) != 1:
        raise HttpError(400, "OCR reads exactly one page image per request", code="ocr_needs_page_image")
    (_page_no, data_url), = images.items()
    return {
        "model": model,
        "instructions": "",
        "input": [{"role": "user", "content": [
            {"type": "input_image", "image_url": data_url},
            {"type": "input_text", "text": _ocr_prompt(body)},
        ]}],
        "reasoning": {"effort": "none"},
        "max_output_tokens": OCR_MAX_OUTPUT_TOKENS,
    }


# ---------------------------------------------------------------------------
# Agent interaction prompt
# ---------------------------------------------------------------------------


def _agent_answer_mode_prompt(mode: str) -> str:
    """How deep an ordinary answer goes.  A mode sets depth, never a template."""
    if mode == "detailed":
        return (
            "Mode: detailed\n"
            "- Answer first, then give the question the full treatment it deserves: what it rests on, the derivation or mechanism, "
            "a worked example on the page's own symbols, the edge cases.\n"
            "- Give a long answer short headings so it can be scanned; a short question still gets a short answer.\n"
            "- Everything must serve the question that was asked: no filler sections, no closing recap."
        )
    if mode == "guided":
        return (
            "Mode: guided\n"
            "- Answer first in one or two sentences, then walk the path to it step by step, so the learner could redo it alone.\n"
            "- Name the step where people usually slip, when there is one.\n"
            "- At most one check question at the end, and only when it really tests the point."
        )
    return (
        "Mode: concise\n"
        "- Give the shortest complete answer: usually one to five sentences, or a few short bullets for parallel points.\n"
        "- Add a formula or a one-line example only when the answer needs it.\n"
        "- Go longer only when the learner asks for more."
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
    """The chat prompt: what the learner can see, then the conversation, then the question.

    The question goes last, after everything it may refer to, so the model
    reads the context as context and answers what was actually asked.
    """
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    selected_context_value = body.get("selectedContext")
    selected_context = _selected_context(selected_context_value)
    contexts = [*_context_items(body.get("context")), *_context_parts(body.get("parts"))]
    raw_input = str(body.get("input") or "").strip() or _text_from_parts(body.get("parts"))
    input_text = _build_user_request(raw_input, selected_context_value, body.get("pdfContext"))
    messages = _transcript_messages(body.get("messages"), raw_input)
    answer_mode = _agent_answer_mode(body)

    sections = [
        "# Task-specific instructions",
        AGENT_INSTRUCTIONS,
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
            "# Page the learner is viewing now",
            f"Page: {_string_value(page.get('page_no'), 'unknown')}",
            f"Title: {_string_value(teaching.get('slide_title'), 'Untitled page')}",
        ]
    )
    if source.get("text_md"):
        sections.extend(["Source text:", _truncate(str(source.get("text_md")), MAX_CONTEXT_CHARS)])
    if teaching.get("speaker_notes_md"):
        sections.extend(
            [
                "Existing notes (the explanation of this page the learner has already read):",
                _truncate(str(teaching.get("speaker_notes_md")), MAX_CONTEXT_CHARS),
            ]
        )
    if selected_context:
        sections.extend(
            [
                "# User selected source material",
                "The user selected this source from the current workspace. Prioritize it when answering, quote it carefully, and say when the selected source is insufficient.",
                selected_context,
            ]
        )
    if contexts:
        sections.extend(["# Additional context", *contexts])
    if messages:
        sections.extend(
            [
                "# Conversation so far",
                "Oldest first. Each user turn is labelled with the page it was asked on. The question to answer now is not in this list.",
                *messages,
            ]
        )
    sections.extend(
        [
            "# Question to answer now",
            input_text or "Continue from the provided context.",
        ]
    )
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
    page_images = _page_images(body, page_numbers=_teaching_generation_page_numbers(body))
    if pdf_file:
        content.append(pdf_file)
    content.extend(_page_image_parts(page_images))
    content.append({
        "type": "input_text",
        "text": _build_teaching_generation_prompt(body, pdf_attached=bool(pdf_file), image_pages=page_images),
    })
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
        # A transcription is meaningless without the page, so it never falls
        # back to a text-only candidate.
        if not bool(body.get("requirePdfFile")):
            for candidate in model_bodies:
                without_file = dict(candidate)
                without_file.pop("documentFile", None)
                candidates.append((without_file, False))
    else:
        candidates.extend((candidate, False) for candidate in model_bodies)
    return candidates
