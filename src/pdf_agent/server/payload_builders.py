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
    MAX_AGENT_PDF_SUBSET_PAGES,
    MAX_CONTEXT_CHARS,
    MAX_TEACHING_BALANCED_SOURCE_CHARS,
    MAX_TEACHING_FAST_SOURCE_CHARS,
    MAX_TEACHING_QUALITY_SOURCE_CHARS,
    SYNCHROPAGE_FAST_TEACHING_INSTRUCTIONS,
    SYNCHROPAGE_SHARED_INSTRUCTIONS,
    TEACHING_GENERATOR_FAST_INSTRUCTIONS,
    TEACHING_GENERATOR_INSTRUCTIONS,
    TEACHING_NOTES_SKELETON,
    TEACHING_PAGE_TYPE_GUIDANCE,
    TEACHING_SECTION_HEADINGS,
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


def _is_fast_teaching_generation(body: Mapping[str, Any]) -> bool:
    plan = body.get("qualityPlan")
    if not isinstance(plan, Mapping):
        return False
    model = _string_value(plan.get("model") or body.get("model"), "")
    reasoning_effort = _string_value(plan.get("reasoningEffort"), _reasoning_effort(body))
    return "mini" in model and reasoning_effort in {"none", "low"} and not bool(plan.get("attachPdf"))


def _teaching_source_text_limit(body: Mapping[str, Any]) -> int:
    plan = body.get("qualityPlan")
    if not isinstance(plan, Mapping):
        return MAX_TEACHING_QUALITY_SOURCE_CHARS
    model = _string_value(plan.get("model") or body.get("model"), "")
    reasoning_effort = _string_value(plan.get("reasoningEffort"), _reasoning_effort(body))
    attach_pdf = bool(plan.get("attachPdf"))
    if attach_pdf or reasoning_effort in {"high", "xhigh"}:
        return MAX_TEACHING_QUALITY_SOURCE_CHARS
    if "mini" in model and reasoning_effort in {"none", "low"}:
        return MAX_TEACHING_FAST_SOURCE_CHARS
    return MAX_TEACHING_BALANCED_SOURCE_CHARS


def _teaching_quality_plan_lines(body: Mapping[str, Any]) -> list[str]:
    plan = body.get("qualityPlan")
    if not isinstance(plan, Mapping):
        return []
    if _is_fast_teaching_generation(body):
        return ["mode: fast text-page path; concise output preferred."]
    attempt = _string_value(plan.get("attempt"), "initial")
    mode = "quality retry" if attempt == "retry" else "pdf-grounded" if bool(plan.get("attachPdf")) else "balanced text"
    lines = [f"mode: {mode}; reasoning={_string_value(plan.get('reasoningEffort'), _reasoning_effort(body))}"]
    reasons = _string_list(plan.get("reasons"))
    if reasons:
        lines.append(f"reasons: {', '.join(reasons)}")
    if attempt == "retry":
        lines.append("This is a quality retry. Prefer more complete visual/source grounding over speed.")
    elif bool(plan.get("batchable")):
        lines.append("This path can be batched. Keep the output concise and do not over-expand.")
    return lines


def _teaching_generator_instructions(body: Mapping[str, Any]) -> str:
    return TEACHING_GENERATOR_FAST_INSTRUCTIONS if _is_fast_teaching_generation(body) else TEACHING_GENERATOR_INSTRUCTIONS


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
            "slide_title": "short page title in the output language",
            "speaker_notes_md": "Markdown notes using the section skeleton headings; LaTeX and Markdown tables when they resolve a stuck point",
            "stuck_points": ["misconception or breakpoint -> one-line fix; 1-3 items; empty for title, agenda, and blank pages"],
            "exam_angles": ["question form -> trap -> what the grader wants; 1-4 items; empty for title, agenda, and blank pages"],
            "confidence": 0.82,
            "needs_review": False,
            "needs_parser_fallback": False,
        },
    }


def _teaching_fast_page_output_contract(page_no: Any) -> dict[str, Any]:
    return {
        "page_no": page_no,
        "teaching": {
            "slide_title": "short page title",
            "speaker_notes_md": "concise Markdown teaching notes",
            "confidence": 0.72,
            "needs_review": False,
        },
    }


# ---------------------------------------------------------------------------
# Teaching note structure (section headings, skeleton, page-type guidance)
# ---------------------------------------------------------------------------


def _teaching_section_headings(output_language_code: str) -> dict[str, str]:
    return TEACHING_SECTION_HEADINGS.get(output_language_code, TEACHING_SECTION_HEADINGS["zh-CN"])


def _teaching_notes_skeleton(output_language_code: str) -> str:
    return TEACHING_NOTES_SKELETON.get(output_language_code, TEACHING_NOTES_SKELETON["zh-CN"])


def _teaching_page_type(page: Mapping[str, Any]) -> str:
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    return _page_type_value(source.get("page_type"))


def _teaching_page_type_guidance_lines(page_types: Sequence[str]) -> list[str]:
    ordered: list[str] = []
    for page_type in page_types:
        if page_type in TEACHING_PAGE_TYPE_GUIDANCE and page_type not in ordered:
            ordered.append(page_type)
    if "unknown" in ordered or not ordered:
        ordered = list(TEACHING_PAGE_TYPE_GUIDANCE)
    return [TEACHING_PAGE_TYPE_GUIDANCE[page_type] for page_type in ordered]


def _teaching_structure_lines(output_language_code: str, page_types: Sequence[str]) -> list[str]:
    lines = [
        "",
        "Section skeleton for speaker_notes_md; use these exact headings, in this order, and omit sections that do not apply to the page type:",
        _teaching_notes_skeleton(output_language_code),
        "",
        "Page-type guidance for the target page(s):",
        *_teaching_page_type_guidance_lines(page_types),
    ]
    if any(page_type == "unknown" for page_type in page_types):
        lines.append(
            "- At least one target page has page_type unknown: classify it yourself from its content, "
            "return your classification as source.page_type, and follow the matching guidance."
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
    if _is_fast_teaching_generation(body):
        return [
            "Rules:",
            "- Return JSON only, no Markdown fences or prose outside JSON.",
            r"- Escape LaTeX backslashes in JSON strings: write \\frac, \\to, and \\cdots, not \frac, \to, or \cdots.",
            page_rule,
            "- Do not copy source text into the response; omit source unless setting source.pdf_page_ref.",
            "- Keep speaker_notes_md concise: 4-7 focused bullets or short sections, explaining rather than transcribing.",
            "- Use Markdown tables or LaTeX only when the page source clearly needs them.",
            empty_source_rule,
        ]
    output_language_code, _output_language_label = _teaching_output_language(body)
    headings = _teaching_section_headings(output_language_code)
    lead, symbols, keep, stuck, exam, check, bridge = (
        headings[key].removeprefix("## ")
        for key in ("lead", "symbols", "keep", "stuck", "exam", "check", "bridge")
    )
    exam_labels = (
        "题型 / 示例题干 / 失分点"
        if output_language_code == "zh-CN"
        else "Question form / Sample stem / Where marks go"
    )
    answer_prefix = "答案：" if output_language_code == "zh-CN" else "Answer:"
    return [
        "Rules:",
        "- Return JSON only, no Markdown fences or prose outside JSON.",
        r"- Escape LaTeX backslashes in JSON strings: write \\frac, \\to, and \\cdots, not \frac, \to, or \cdots.",
        page_rule,
        "- Always return source.page_type: echo the page_type given for the page, or your own classification when it was unknown. Do not copy source text; omit every other source field except source.pdf_page_ref.",
        "- Write to the reader in the second person. Explain the page in plainer words than the page uses, decode its notation, and give a concrete instance; do not copy the page's own sentences and never write about students in the third person or about what the page establishes.",
        f"- {lead}: 1-2 plain sentences that someone who has not yet understood the page can follow; always present on content pages.",
        f"- {symbols}: a table of at most 8 rows covering the symbols and terms the page uses without explaining, including what it assumes the reader already knows; omit the section when the page has none.",
        f"- {keep}: one sentence the reader can repeat from memory.",
        f"- {stuck}: 0-3 bullets shaped as **you might think X, but actually Y** followed by the fix; only mistakes a real first-time reader would make on this page; omit the section rather than invent one.",
        f"- {exam}: write it only when the page carries something an exam plausibly asks about (a definition, formula, method, result, or distinction); omit it on transitional, motivational, or purely illustrative pages. When present, 1-2 bullets labelled exactly {exam_labels}, the stem written from this page's material with no answer. Never claim knowledge of a specific real exam or past paper.",
        f"- {check}: one question answerable without the notes, then the answer on the next line starting with {answer_prefix}",
        f"- {bridge}: write it only when neighbour page titles or document context are given; cite pages as p.N and never invent content for pages you were not shown; this is the only place for remarks about the page's role in the course.",
        "- Use exactly the section headings of the skeleton above, in that order, omitting the sections that do not apply; do not invent other top-level headings.",
        "- Follow the page-type guidance for each target page. Title, agenda, and blank pages get 1-2 plain lines, no headings, and empty stuck_points and exam_angles.",
        "- Exercise pages: give the solution entry point and the usual way to lose marks; do not give final answers unless the page itself shows them.",
        "- Ground every claim in the target page text, the attached PDF page, or the document context; cite other pages by number when you use them and never invent numbers, definitions, or figure conclusions.",
        f"- Mirror the sections into the arrays: teaching.stuck_points holds the {stuck} items as one-liners (0-3, empty when the section is omitted) and teaching.exam_angles holds the {exam} items as one-liners (0-3, empty when the section is omitted), adding nothing the notes do not contain; both stay empty for title, agenda, and blank pages.",
        "- Also fill concepts with 2-5 short terms named on this page (chips of at most 12 characters, not sentences), contextual_bridge with a one-sentence version of the neighbouring-pages section whenever you wrote that section, visual_explanations on figure and table pages, formula_explanations on formula pages, prerequisites with what the page silently assumes, and evidence with 1-4 short fragments actually visible on this page. Leave an array empty only when the page type does not call for it; never pad it.",
        "- Use headings, short paragraphs, bullets, bold for the wrong-idea label, a Markdown table for the symbol section and otherwise only when a table is what explains something, and LaTeX math.",
        "- Put display math delimiters $$ on their own lines; keep prose outside math delimiters when possible.",
        "- Never escape digits or binary strings in LaTeX; use 2^n, 000, and 111.",
        "- Length follows how much explaining the page needs, not a quota: an easy page gets a few lines, a dense page more; usually 300-600 Chinese characters (200-400 English words) in total and never above about 1000 Chinese characters. Delete any sentence that only repeats the page in its own words or pads a section.",
        "- Set confidence by grounding quality, not by length: 0.85-0.95 when the page text is clear and complete, 0.6-0.8 when figure content had to be inferred or the extraction looks partial; set needs_review=true whenever confidence is below 0.78.",
        "- Treat any existing notes as a draft to surpass rather than to copy: keep what is correct, replace commentary about the page's role with plain explanation of its content, and fix grounding or formula errors.",
        empty_source_rule,
    ]


# ---------------------------------------------------------------------------
# Fast teaching prompt
# ---------------------------------------------------------------------------


def _teaching_fast_output_shape(page_numbers: Sequence[int], *, batch: bool) -> str:
    if batch:
        return _teaching_contract_json({"pages": [_teaching_fast_page_output_contract("<requested_page_no>")]})
    page_no = page_numbers[0] if page_numbers else 1
    return _teaching_contract_json({"page": _teaching_fast_page_output_contract(page_no)})


def _teaching_fast_page_jsonl(page: Mapping[str, Any], source_text_limit: int) -> str:
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    page_no = _int_value(page.get("page_no"), 1)
    source_text = str(source.get("text_md") or "").strip()
    return _json_dumps_utf8_safe(
        {
            "page_no": page_no,
            "pdf_page_ref": _string_value(source.get("pdf_page_ref"), f"#page={page_no}"),
            "source_text": _truncate(source_text, source_text_limit)
            if source_text
            else "[No embedded text extracted for this page.]",
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _build_fast_teaching_generation_prompt(body: Mapping[str, Any], target_pages: list[Mapping[str, Any]]) -> str:
    output_language_code, output_language_label = _teaching_output_language(body)
    target_page_numbers = [_int_value(page.get("page_no"), index + 1) for index, page in enumerate(target_pages)]
    source_text_limit = _teaching_source_text_limit(body)
    batch = len(target_pages) > 1
    sections = [
        f"Generate concise SynchroPage teaching JSON for PDF page(s): {_format_page_ranges(target_page_numbers)}.",
        f"Output shape: {_teaching_fast_output_shape(target_page_numbers, batch=batch)}",
        f"Language: {output_language_label} ({output_language_code}); write all prose in this language and preserve technical tokens.",
        "Rules: JSON only; no Markdown fences; escape LaTeX backslashes as \\\\frac and \\\\to; do not copy source text; use 3-5 focused bullets/short sections.",
        "Set teaching.confidence between 0 and 1. If the page seems underspecified or notes may be incomplete, set teaching.needs_review=true and confidence<=0.55.",
        "If source_text is empty, keep notes brief; the server will mark parser fallback when needed.",
        "Pages JSONL:",
    ]
    sections.extend(_teaching_fast_page_jsonl(page, source_text_limit) for page in target_pages)
    return "\n".join(sections)


# ---------------------------------------------------------------------------
# Regular teaching prompts (single + batch)
# ---------------------------------------------------------------------------


def _build_teaching_generation_prompt(body: Mapping[str, Any]) -> str:
    target_pages = _teaching_generation_pages(body)
    if _is_fast_teaching_generation(body):
        return _build_fast_teaching_generation_prompt(body, target_pages)
    if len(target_pages) > 1:
        return _build_teaching_batch_generation_prompt(body, target_pages)

    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page = target_pages[0] if target_pages else {}
    source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
    teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
    previous_page = body.get("previousPage") if isinstance(body.get("previousPage"), Mapping) else {}
    next_page = body.get("nextPage") if isinstance(body.get("nextPage"), Mapping) else {}
    page_no = _int_value(page.get("page_no"), 1)
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), 0))
    output_language_code, output_language_label = _teaching_output_language(body)
    source_text = str(source.get("text_md") or "").strip()
    source_text_limit = _teaching_source_text_limit(body)
    existing_notes = str(teaching.get("speaker_notes_md") or "").strip()
    quality_plan_lines = _teaching_quality_plan_lines(body)
    page_type = _teaching_page_type(page)
    neighbor_titles = _teaching_page_titles(body, target_pages)

    sections = [
        "Task-specific instructions:",
        _teaching_generator_instructions(body),
        "",
        "Generate one SynchroPage teaching page JSON for the given PDF page.",
        "",
        "Output shape:",
        _teaching_contract_json(_teaching_page_output_contract(page_no)),
        "",
        "Output language:",
        f"code: {output_language_code}",
        f"name: {output_language_label}",
        f"- Write every heading, paragraph, bullet, table heading, and explanatory sentence in {output_language_label}.",
        "- Do not mix Chinese and English prose unless quoting source text or preserving a technical term from the PDF.",
        "- Keep source code identifiers, Verilog keywords, signal names, module names, and formulas exactly as technical tokens.",
        "- Set teaching.output_language to the exact language code above.",
        *_teaching_structure_lines(output_language_code, [page_type]),
        "",
        *_teaching_prompt_rules(body, batch=False),
    ]
    if quality_plan_lines:
        sections.extend(["", "Generation quality plan:", *quality_plan_lines])
    sections.extend([
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"page_count: {page_count}",
        "",
        "Target page:",
        f"page_no: {page_no}",
        f"pdf_page_ref: {_string_value(source.get('pdf_page_ref'), f'#page={page_no}')}",
        f"page_type: {page_type}",
    ])
    neighbor_lines = []
    previous_title = _string_value(previous_page.get("title"), "") or neighbor_titles.get(page_no - 1, "")
    next_title = _string_value(next_page.get("title"), "") or neighbor_titles.get(page_no + 1, "")
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


def _build_teaching_batch_generation_prompt(body: Mapping[str, Any], target_pages: list[Mapping[str, Any]]) -> str:
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    page_count = _int_value(body.get("pageCount"), _int_value(document.get("page_count"), 0))
    output_language_code, output_language_label = _teaching_output_language(body)
    target_page_numbers = [_int_value(page.get("page_no"), index + 1) for index, page in enumerate(target_pages)]
    quality_plan_lines = _teaching_quality_plan_lines(body)
    source_text_limit = _teaching_source_text_limit(body)
    page_types = [_teaching_page_type(page) for page in target_pages]
    neighbor_titles = _teaching_page_titles(body, target_pages)
    sections = [
        "Task-specific instructions:",
        _teaching_generator_instructions(body),
        "",
        f"Generate SynchroPage teaching page JSON for {len(target_pages)} PDF pages in one batch.",
        "Return one page object for every target page. Do not skip pages. Do not merge pages.",
        f"Target page numbers: {_format_page_ranges(target_page_numbers)}",
        "",
        "Output shape; repeat the single page object once per target page:",
        _teaching_contract_json({"pages": [_teaching_page_output_contract("<target_page_no>")]}),
        "",
        "Output language:",
        f"code: {output_language_code}",
        f"name: {output_language_label}",
        f"- Write every heading, paragraph, bullet, table heading, and explanatory sentence in {output_language_label}.",
        "- Set every teaching.output_language to the exact language code above.",
        *_teaching_structure_lines(output_language_code, page_types),
        "",
        *_teaching_prompt_rules(body, batch=True),
    ]
    if quality_plan_lines:
        sections.extend(["", "Generation quality plan:", *quality_plan_lines])
    sections.extend([
        "",
        "Document:",
        f"title: {_string_value(document.get('title'), 'Untitled PDF')}",
        f"page_count: {page_count}",
        "",
        "Target pages:",
    ])
    for page in target_pages:
        source = page.get("source") if isinstance(page.get("source"), Mapping) else {}
        teaching = page.get("teaching") if isinstance(page.get("teaching"), Mapping) else {}
        page_no = _int_value(page.get("page_no"), 1)
        source_text = str(source.get("text_md") or "").strip()
        existing_notes = str(teaching.get("speaker_notes_md") or "").strip()
        sections.extend(
            [
                "",
                f"--- Target page {page_no} ---",
                f"page_no: {page_no}",
                f"pdf_page_ref: {_string_value(source.get('pdf_page_ref'), f'#page={page_no}')}",
                f"page_type: {_teaching_page_type(page)}",
                *_teaching_neighbor_lines(page_no, neighbor_titles),
            ]
        )
        if existing_notes:
            sections.extend(["existing_notes:", _truncate(existing_notes, 1000)])
        sections.extend([
            "source_text:",
            _truncate(source_text, source_text_limit) if source_text else "[No embedded text extracted for this page.]",
        ])
    return "\n".join(sections)


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
    return SYNCHROPAGE_FAST_TEACHING_INSTRUCTIONS if _is_fast_teaching_generation(body) else SYNCHROPAGE_SHARED_INSTRUCTIONS


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
