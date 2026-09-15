"""Teaching generation response parsing.

Pure functions that extract and normalise page objects from model
JSON responses.  No dependency on ``web_app.py``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from pdf_agent.server.constants import (
    TEACHING_DEPTHS,
    TEACHING_PAGE_ROLES,
    TRANSCRIPTION_PARSER,
)
from pdf_agent.server.document_context import _pdf_file_input
from pdf_agent.server.errors import HttpError
from pdf_agent.server.markdown_math import (
    json_loads_with_latex_repair as _json_loads_with_latex_repair,
)
from pdf_agent.server.markdown_math import (
    normalize_markdown_math as _normalize_markdown_math,
)
from pdf_agent.server.payload_builders import (
    _lesson_plan_pages,
    _teaching_generation_pages,
    _teaching_output_language,
    _transcription_pages,
)
from pdf_agent.server.pdf_file_cache import PdfFileCache
from pdf_agent.server.value_utils import (
    evidence_list as _evidence_list,
)
from pdf_agent.server.value_utils import (
    float_value as _float_value,
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


def _parse_generated_page(
    content: str,
    body: Mapping[str, Any],
    *,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any]:
    value = _json_from_model_text(content)
    page_input = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    candidate = _first_generated_page_candidate(value)
    if not isinstance(candidate, Mapping):
        raise HttpError(502, "Generation response did not contain a page JSON object", code="invalid_generation_json")
    return _normalize_generated_page_candidate(candidate, page_input, body, pdf_file_cache=pdf_file_cache)


def _parse_generated_pages(
    content: str,
    body: Mapping[str, Any],
    *,
    pdf_file_cache: PdfFileCache | None = None,
) -> list[dict[str, Any]]:
    """Parse a batch response, requiring every requested page to be present."""
    pages, missing = _parse_generated_pages_with_missing(
        content, body, pdf_file_cache=pdf_file_cache
    )
    if missing:
        raise HttpError(
            502,
            f"Generation response did not contain page {missing[0]}",
            code="invalid_generation_json",
        )
    return pages


def _parse_generated_pages_with_missing(
    content: str,
    body: Mapping[str, Any],
    *,
    pdf_file_cache: PdfFileCache | None = None,
) -> tuple[list[dict[str, Any]], list[int]]:
    """Parse a batch response into ``(pages, missing_page_numbers)``.

    A batch where the model skipped one page is a partial success, not a
    failure: the caller returns what parsed and lets the client re-ask only
    for ``missing``.  ``invalid_generation_json`` is raised only when nothing
    at all could be parsed.
    """
    value = _json_from_model_text(content)
    page_inputs = _teaching_generation_pages(body)
    if not page_inputs:
        raise HttpError(502, "Generation request did not contain target pages", code="invalid_generation_json")
    candidates = _generated_page_candidates(value)
    if not candidates:
        raise HttpError(502, "Generation response did not contain page JSON objects", code="invalid_generation_json")

    requested = [_int_value(page_input.get("page_no"), index + 1) for index, page_input in enumerate(page_inputs)]
    candidates_by_page_no: dict[int, Mapping[str, Any]] = {}
    for candidate in candidates:
        page_no = _int_value(candidate.get("page_no"), 0)
        if page_no > 0 and page_no not in candidates_by_page_no:
            candidates_by_page_no[page_no] = candidate
    # Labels that do not intersect the request (e.g. 1..N relative to the batch)
    # are treated as positional when the counts line up.
    positional = len(candidates) == len(page_inputs) and not (set(candidates_by_page_no) & set(requested))

    consumed: set[int] = set()
    pages: list[dict[str, Any]] = []
    missing: list[int] = []
    for index, page_input in enumerate(page_inputs):
        page_no = requested[index]
        candidate: Mapping[str, Any] | None = None
        if positional:
            candidate = candidates[index]
        else:
            candidate = candidates_by_page_no.get(page_no)
            if candidate is None and index < len(candidates):
                slot = candidates[index]
                # An unlabelled candidate in this slot is taken positionally.
                if _int_value(slot.get("page_no"), 0) <= 0 and id(slot) not in consumed:
                    candidate = slot
        if candidate is None or id(candidate) in consumed:
            missing.append(page_no)
            continue
        consumed.add(id(candidate))
        pages.append(_normalize_generated_page_candidate(candidate, page_input, body, pdf_file_cache=pdf_file_cache))
    return pages, missing


def _first_generated_page_candidate(value: Any) -> Mapping[str, Any] | None:
    candidates = _generated_page_candidates(value)
    return candidates[0] if candidates else None


def _generated_page_candidates(value: Any) -> list[Mapping[str, Any]]:
    if isinstance(value, Mapping) and isinstance(value.get("page"), Mapping):
        return [value["page"]]
    if isinstance(value, Mapping) and isinstance(value.get("pages"), list):
        return [candidate for candidate in value["pages"] if isinstance(candidate, Mapping)]
    if isinstance(value, list):
        return [candidate for candidate in value if isinstance(candidate, Mapping)]
    return [value] if isinstance(value, Mapping) else []


def _normalize_generated_page_candidate(
    candidate: Mapping[str, Any],
    page_input: Mapping[str, Any],
    body: Mapping[str, Any],
    *,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any]:
    source_input = page_input.get("source") if isinstance(page_input.get("source"), Mapping) else {}
    page_no = _int_value(page_input.get("page_no"), 1)
    output_language_code, _output_language_label = _teaching_output_language(body)

    source = candidate.get("source") if isinstance(candidate.get("source"), Mapping) else {}
    teaching = candidate.get("teaching") if isinstance(candidate.get("teaching"), Mapping) else {}
    source_text = str(source.get("text_md") or source_input.get("text_md") or "").strip()
    has_pdf_file = bool(_pdf_file_input(body.get("documentFile"), pdf_file_cache=pdf_file_cache))
    no_source_available = not source_text and not has_pdf_file
    needs_fallback = bool(teaching.get("needs_parser_fallback")) or no_source_available
    needs_review = bool(teaching.get("needs_review")) or needs_fallback
    confidence = _float_value(teaching.get("confidence"), 0.28 if no_source_available else 0.78)
    if needs_fallback:
        confidence = min(confidence, 0.35)

    notes = str(teaching.get("speaker_notes_md") or "").strip()
    if no_source_available and not notes:
        if output_language_code == "en-US":
            notes = (
                "## This page cannot be explained reliably yet\n\n"
                "This page has no extractable PDF text layer. SynchroPage will not invent content; add OCR or page text, then regenerate."
            )
        else:
            notes = (
                "## 当前页暂无法生成可靠讲解\n\n"
                "这一页没有可提取的 PDF 文本层。本轮不会编造内容；请后续接入 OCR 或手动补充页面文本后再重新生成。"
            )
    notes = _normalize_markdown_math(notes)

    evidence = teaching.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        evidence = [{
            "kind": "other",
            "quote_or_reference": (
                "PDF.js extracted page text"
                if source_text
                else "Original PDF file input"
                if has_pdf_file
                else "No embedded text layer"
            ),
        }]

    return {
        "page_no": page_no,
        "source": {
            "pdf_page_ref": _string_value(source.get("pdf_page_ref") or source_input.get("pdf_page_ref"), f"#page={page_no}"),
            "text_md": source_text,
            "ocr_used": bool(source.get("ocr_used") or source_input.get("ocr_used") or False),
            "parser": _string_value(source.get("parser") or source_input.get("parser"), "pdfjs"),
            "page_type": _page_type_value(source.get("page_type") or source_input.get("page_type")),
            **({"text_garbled": True} if bool(source_input.get("text_garbled")) else {}),
        },
        "teaching": {
            "output_language": output_language_code,
            "slide_title": _string_value(teaching.get("slide_title"), f"PDF p.{page_no}"),
            "speaker_notes_md": notes,
            "handoff": " ".join(_string_value(teaching.get("handoff"), "").split()),
            "concepts": _string_list(teaching.get("concepts")),
            "prerequisites": _string_list(teaching.get("prerequisites")),
            "contextual_bridge": _string_value(teaching.get("contextual_bridge"), ""),
            "visual_explanations": _string_list(teaching.get("visual_explanations")),
            "formula_explanations": _string_list(teaching.get("formula_explanations")),
            "stuck_points": _string_list(teaching.get("stuck_points")),
            "exam_angles": _string_list(teaching.get("exam_angles")),
            "evidence": _evidence_list(evidence),
            "confidence": max(0.0, min(confidence, 1.0)),
            "needs_review": needs_review,
            "needs_parser_fallback": needs_fallback,
        },
        "status": "needs_review" if needs_review else "ready",
    }


# ---------------------------------------------------------------------------
# Lesson plan parsing
# ---------------------------------------------------------------------------

_SKIM_ROLES = {"title", "agenda", "blank", "transition"}


def _parse_lesson_plan(content: str, body: Mapping[str, Any]) -> dict[str, Any]:
    value = _json_from_model_text(content)
    page_numbers = [_int_value(item.get("page_no"), 0) for item in _lesson_plan_pages(body)]
    page_numbers = [page_no for page_no in page_numbers if page_no > 0]
    if not page_numbers:
        raise HttpError(400, "Lesson plan request did not contain pages", code="invalid_request")
    if not isinstance(value, Mapping):
        raise HttpError(502, "Lesson plan response was not a JSON object", code="invalid_generation_json")
    plan = normalize_lesson_plan(value, page_numbers)
    if not plan["pages"]:
        raise HttpError(502, "Lesson plan response did not cover any page", code="invalid_generation_json")
    return plan


def normalize_lesson_plan(value: Mapping[str, Any], page_numbers: list[int]) -> dict[str, Any]:
    """Coerce a model plan into contiguous segments that cover *page_numbers*.

    Every requested page gets a row (defaults when the model skipped it);
    segments are rebuilt by walking the pages in order, so they are always
    consecutive and non-overlapping even when the model's numbering was not.
    """
    raw_segments: dict[int, Mapping[str, Any]] = {}
    for item in value.get("segments") if isinstance(value.get("segments"), list) else []:
        if isinstance(item, Mapping):
            segment_id = _int_value(item.get("id"), 0)
            if segment_id > 0 and segment_id not in raw_segments:
                raw_segments[segment_id] = item
    raw_rows: dict[int, Mapping[str, Any]] = {}
    for item in value.get("pages") if isinstance(value.get("pages"), list) else []:
        if isinstance(item, Mapping):
            page_no = _int_value(item.get("page_no"), 0)
            if page_no > 0 and page_no not in raw_rows:
                raw_rows[page_no] = item

    rows: list[dict[str, Any]] = []
    last_segment_id = 0
    for page_no in sorted(set(page_numbers)):
        item = raw_rows.get(page_no, {})
        role = _string_value(item.get("role"), "")
        if role not in TEACHING_PAGE_ROLES:
            role = "concept"
        depth = _string_value(item.get("depth"), "")
        if depth not in TEACHING_DEPTHS:
            depth = "skim" if role in _SKIM_ROLES else "full"
        segment_id = _int_value(item.get("segment"), 0)
        if segment_id <= 0:
            segment_id = last_segment_id or 1
        rows.append(
            {
                "page_no": page_no,
                "segment": segment_id,
                "role": role,
                "depth": depth,
                "key": bool(item.get("key")) and depth == "full",
                "cue": " ".join(_string_value(item.get("cue"), "").split()),
            }
        )
        last_segment_id = segment_id

    segments: list[dict[str, Any]] = []
    current_source_id: int | None = None
    for row in rows:
        if current_source_id is None or row["segment"] != current_source_id:
            current_source_id = row["segment"]
            source = raw_segments.get(current_source_id, {})
            segments.append(
                {
                    "id": len(segments) + 1,
                    "title": _string_value(source.get("title"), f"Part {len(segments) + 1}"),
                    "goal": " ".join(_string_value(source.get("goal"), "").split()),
                    "pages": [row["page_no"], row["page_no"]],
                }
            )
        segments[-1]["pages"][1] = row["page_no"]
        row["segment"] = segments[-1]["id"]

    return {
        "document_summary": " ".join(_string_value(value.get("document_summary"), "").split()),
        "segments": segments,
        "pages": rows,
    }


# ---------------------------------------------------------------------------
# Page transcription parsing
# ---------------------------------------------------------------------------


def _parse_transcription(content: str, body: Mapping[str, Any]) -> dict[str, Any]:
    """One row per requested page; a page the model skipped or could not read is ``unreadable``."""
    requested = [page_no for page_no in (_int_value(item.get("page_no"), 0) for item in _transcription_pages(body)) if page_no > 0]
    if not requested:
        raise HttpError(400, "Transcription request did not contain pages", code="invalid_request")
    value = _json_from_model_text(content)
    rows = value.get("pages") if isinstance(value, Mapping) else value
    if not isinstance(rows, list):
        raise HttpError(502, "Transcription response did not contain pages", code="invalid_generation_json")
    by_page: dict[int, Mapping[str, Any]] = {}
    for item in rows:
        if isinstance(item, Mapping):
            page_no = _int_value(item.get("page_no"), 0)
            if page_no in requested and page_no not in by_page:
                by_page[page_no] = item
    pages: list[dict[str, Any]] = []
    for page_no in requested:
        item = by_page.get(page_no, {})
        text = _normalize_markdown_math(str(item.get("text_md") or "").strip())
        unreadable = bool(item.get("unreadable")) or not text
        pages.append(
            {
                "page_no": page_no,
                "text_md": "" if unreadable else text,
                "unreadable": unreadable,
                "ocr_used": not unreadable,
                "parser": TRANSCRIPTION_PARSER if not unreadable else "pdfjs",
            }
        )
    if all(page["unreadable"] for page in pages):
        raise HttpError(502, "Transcription response did not transcribe any page", code="invalid_generation_json")
    return {"pages": pages}


def _json_from_model_text(content: str) -> Any:
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    try:
        return _json_loads_with_latex_repair(text)
    except json.JSONDecodeError:
        start_candidates = [index for index in (text.find("{"), text.find("[")) if index >= 0]
        if not start_candidates:
            raise HttpError(502, "Generation response was not valid JSON", code="invalid_generation_json")
        start = min(start_candidates)
        end = max(text.rfind("}"), text.rfind("]"))
        if end <= start:
            raise HttpError(502, "Generation response was not valid JSON", code="invalid_generation_json")
        try:
            return _json_loads_with_latex_repair(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise HttpError(502, f"Generation response was not valid JSON: {exc}", code="invalid_generation_json") from exc
