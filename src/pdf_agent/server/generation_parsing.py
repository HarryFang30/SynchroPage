"""Teaching generation response parsing.

Pure functions that extract and normalise page objects from model
JSON responses.  No dependency on ``web_app.py``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from pdf_agent.server.errors import HttpError
from pdf_agent.server.markdown_math import (
    json_loads_with_latex_repair as _json_loads_with_latex_repair,
    normalize_markdown_math as _normalize_markdown_math,
)
from pdf_agent.server.document_context import _pdf_file_input
from pdf_agent.server.payload_builders import (
    _is_fast_teaching_generation,
    _teaching_generation_pages,
    _teaching_output_language,
)
from pdf_agent.server.value_utils import (
    evidence_list as _evidence_list,
    float_value as _float_value,
    int_value as _int_value,
    page_type_value as _page_type_value,
    string_list as _string_list,
    string_value as _string_value,
)


def _parse_generated_page(content: str, body: Mapping[str, Any]) -> dict[str, Any]:
    value = _json_from_model_text(content)
    page_input = body.get("page") if isinstance(body.get("page"), Mapping) else {}
    candidate = _first_generated_page_candidate(value)
    if not isinstance(candidate, Mapping):
        raise HttpError(502, "Generation response did not contain a page JSON object", code="invalid_generation_json")
    return _normalize_generated_page_candidate(candidate, page_input, body)


def _parse_generated_pages(content: str, body: Mapping[str, Any]) -> list[dict[str, Any]]:
    value = _json_from_model_text(content)
    page_inputs = _teaching_generation_pages(body)
    if not page_inputs:
        raise HttpError(502, "Generation request did not contain target pages", code="invalid_generation_json")
    candidates = _generated_page_candidates(value)
    if not candidates:
        raise HttpError(502, "Generation response did not contain page JSON objects", code="invalid_generation_json")

    candidates_by_page_no: dict[int, Mapping[str, Any]] = {}
    for candidate in candidates:
        page_no = _int_value(candidate.get("page_no"), 0)
        if page_no > 0:
            candidates_by_page_no[page_no] = candidate

    pages: list[dict[str, Any]] = []
    for index, page_input in enumerate(page_inputs):
        page_no = _int_value(page_input.get("page_no"), index + 1)
        candidate = candidates_by_page_no.get(page_no)
        if candidate is None and index < len(candidates):
            candidate = candidates[index]
        if candidate is None:
            raise HttpError(502, f"Generation response did not contain page {page_no}", code="invalid_generation_json")
        pages.append(_normalize_generated_page_candidate(candidate, page_input, body))
    return pages


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
) -> dict[str, Any]:
    source_input = page_input.get("source") if isinstance(page_input.get("source"), Mapping) else {}
    page_no = _int_value(page_input.get("page_no"), 1)
    output_language_code, _output_language_label = _teaching_output_language(body)

    source = candidate.get("source") if isinstance(candidate.get("source"), Mapping) else {}
    teaching = candidate.get("teaching") if isinstance(candidate.get("teaching"), Mapping) else {}
    source_text = str(source.get("text_md") or source_input.get("text_md") or "").strip()
    has_pdf_file = bool(_pdf_file_input(body.get("documentFile")))
    no_source_available = not source_text and not has_pdf_file
    needs_fallback = bool(teaching.get("needs_parser_fallback")) or no_source_available
    fast_generation = _is_fast_teaching_generation(body)
    confidence_missing = teaching.get("confidence") is None
    needs_review = bool(teaching.get("needs_review")) or needs_fallback or (fast_generation and confidence_missing)
    default_confidence = 0.56 if fast_generation else 0.78
    confidence = _float_value(teaching.get("confidence"), 0.28 if no_source_available else default_confidence)
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
            "page_type": _page_type_value(source.get("page_type")),
        },
        "teaching": {
            "output_language": output_language_code,
            "slide_title": _string_value(teaching.get("slide_title"), f"PDF p.{page_no}"),
            "speaker_notes_md": notes,
            "concepts": _string_list(teaching.get("concepts")),
            "prerequisites": _string_list(teaching.get("prerequisites")),
            "contextual_bridge": _string_value(teaching.get("contextual_bridge"), ""),
            "visual_explanations": _string_list(teaching.get("visual_explanations")),
            "formula_explanations": _string_list(teaching.get("formula_explanations")),
            "evidence": _evidence_list(evidence),
            "confidence": max(0.0, min(confidence, 1.0)),
            "needs_review": needs_review,
            "needs_parser_fallback": needs_fallback,
        },
        "status": "needs_review" if needs_review else "ready",
    }


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
