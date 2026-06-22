"""Document-context helpers: PDF page numbers, selected text, context items.

Pure functions that build the cacheable document context prefix, extract
selected-source and attachment data, and normalise page-number lists.

``_pdf_file_input`` accepts a ``PdfFileCache`` instance for request-scoped
server paths.  ``set_pdf_file_cache()`` remains for direct helper callers.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from pdf_agent.server.constants import (
    DOCUMENT_CACHE_PREFIX_VERSION,
    MAX_CONTEXT_CHARS,
    MAX_CONTEXT_ITEMS,
    MAX_IMAGE_ATTACHMENTS,
    MAX_IMAGE_DATA_URL_CHARS,
    MAX_PDF_CONTEXT_CHARS,
    MAX_PDF_FILE_DATA_CHARS,
    MAX_TEACHING_CACHE_CHARS,
    MAX_TRANSCRIPT_MESSAGES,
    PDF_CONTEXT_EDGE_PAGE_COUNT,
    PDF_CONTEXT_FULL_PAGE_LIMIT,
)
from pdf_agent.server.pdf_file_cache import (
    PdfFileCache,
    pdf_file_data_url as _pdf_file_data_url,
    raw_pdf_file_data as _raw_pdf_file_data,
)
from pdf_agent.server.value_utils import (
    int_value as _int_value,
    string_value as _string_value,
    truncate as _truncate,
)

# ---------------------------------------------------------------------------
# Module-level cache reference (set by web_app.py at startup)
# ---------------------------------------------------------------------------

_pdf_file_cache: PdfFileCache | None = None


def set_pdf_file_cache(cache: PdfFileCache) -> None:
    """Register the shared ``PdfFileCache`` instance."""
    global _pdf_file_cache
    _pdf_file_cache = cache


# ---------------------------------------------------------------------------
# Page-number helpers
# ---------------------------------------------------------------------------


def _pdf_context_page_numbers(
    page_count: int,
    full_page_limit: int = PDF_CONTEXT_FULL_PAGE_LIMIT,
    edge_page_count: int = PDF_CONTEXT_EDGE_PAGE_COUNT,
) -> list[int]:
    """Return the page numbers that should be included in a truncated context."""
    total = max(0, page_count)
    limit = max(1, full_page_limit)
    edge = max(1, edge_page_count)
    if total <= limit:
        return list(range(1, total + 1))
    pages = set(range(1, min(edge, total) + 1))
    pages.update(range(max(1, total - edge + 1), total + 1))
    return sorted(pages)


def _format_page_ranges(pages: list[int]) -> str:
    """Format a sorted list of page numbers into a human-readable range string."""
    if not pages:
        return ""
    ranges: list[str] = []
    start = pages[0]
    previous = pages[0]
    for page_no in pages[1:]:
        if page_no == previous + 1:
            previous = page_no
            continue
        ranges.append(f"{start}" if start == previous else f"{start}-{previous}")
        start = previous = page_no
    ranges.append(f"{start}" if start == previous else f"{start}-{previous}")
    return ", ".join(ranges)


def _pdf_included_page_numbers(
    value: Mapping[str, Any],
    page_count: int,
    full_page_limit: int,
    edge_page_count: int,
) -> list[int]:
    """Return the effective included-page list, preferring an explicit
    ``includedPageNumbers`` field."""
    included = value.get("includedPageNumbers")
    if isinstance(included, list):
        page_numbers = sorted(
            {
                page_no
                for page_no in (_int_value(item, 0) for item in included)
                if 1 <= page_no <= max(page_count, 1)
            }
        )
        if page_numbers:
            return page_numbers
    return _pdf_context_page_numbers(page_count, full_page_limit, edge_page_count)


# ---------------------------------------------------------------------------
# Iteration helpers
# ---------------------------------------------------------------------------


def _iter_mapping_items(value: Any) -> list[Mapping[str, Any]]:
    """Filter a list to only ``Mapping`` items."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, Mapping)]


def _append_page_number(pages: list[int], value: Any, page_count: int) -> None:
    """Append a page number after validation, avoiding duplicates."""
    page_no = _int_value(value, 0)
    if page_no <= 0 or (page_count and page_no > page_count) or page_no in pages:
        return
    pages.append(page_no)


# ---------------------------------------------------------------------------
# Cacheable document context
# ---------------------------------------------------------------------------


def _cacheable_document_context(body: Mapping[str, Any]) -> Mapping[str, Any]:
    """Return the best document-context dict from *body*."""
    document_context = body.get("documentContext")
    if isinstance(document_context, Mapping):
        return document_context
    pdf_context = body.get("pdfContext")
    if isinstance(pdf_context, Mapping):
        return pdf_context
    return {}


def _normalized_document_cache_context(body: Mapping[str, Any]) -> dict[str, Any]:
    """Build a normalised cache-context dict suitable for building cache keys
    and the cacheable document prefix."""
    document = body.get("document") if isinstance(body.get("document"), Mapping) else {}
    context = _cacheable_document_context(body)
    pages = context.get("pages")
    raw_pages = pages if isinstance(pages, list) else []
    page_count = _int_value(context.get("pageCount") or document.get("page_count"), len(raw_pages))
    full_page_limit = _int_value(context.get("fullPageLimit"), page_count or PDF_CONTEXT_FULL_PAGE_LIMIT)
    edge_page_count = _int_value(context.get("edgePageCount"), page_count or PDF_CONTEXT_EDGE_PAGE_COUNT)
    included_pages = _pdf_included_page_numbers(context, page_count, full_page_limit, edge_page_count)
    allowed_pages = set(included_pages)
    explicit_truncated = context.get("truncated")
    truncated = bool(explicit_truncated) if explicit_truncated is not None else len(included_pages) < page_count
    normalized_pages: list[dict[str, Any]] = []
    for item in raw_pages:
        if not isinstance(item, Mapping):
            continue
        page_no = _int_value(item.get("page_no"), 0)
        if page_no <= 0 or page_no not in allowed_pages:
            continue
        normalized_pages.append(
            {
                "page_no": page_no,
                "title": _string_value(item.get("title"), f"PDF p.{page_no}"),
                "text_md": str(item.get("text_md") or "").strip() or "[No embedded text extracted for this page.]",
            }
        )
    normalized_pages.sort(key=lambda item: item["page_no"])
    return {
        "cacheVersion": DOCUMENT_CACHE_PREFIX_VERSION,
        "documentId": _string_value(document.get("id") or context.get("documentId"), "unknown"),
        "documentTitle": _string_value(document.get("title") or context.get("documentTitle"), "Untitled PDF"),
        "pageCount": page_count,
        "fullPageLimit": full_page_limit,
        "edgePageCount": edge_page_count,
        "truncated": truncated,
        "includedPageNumbers": included_pages,
        "pages": normalized_pages,
    }


def _build_document_cache_prefix(body: Mapping[str, Any]) -> str:
    """Build the ``SYNCHROPAGE CACHEABLE DOCUMENT CONTEXT`` text block."""
    context = _normalized_document_cache_context(body)
    if not context["pages"]:
        return ""
    chunks = [
        "SYNCHROPAGE CACHEABLE DOCUMENT CONTEXT",
        f"cache_version: {context['cacheVersion']}",
        "This section is intentionally identical for repeated requests for this PDF so prompt caching can reuse it.",
        "Use this compact document context to understand course structure, symbols, terminology, and cross-page dependencies.",
        "When answering a question or explaining a target page, prioritize the user's current request and selected source, but use this document context for prerequisites and continuity.",
        "",
        f"document_id: {context['documentId']}",
        f"document_title: {context['documentTitle']}",
        f"page_count: {context['pageCount']}",
        f"truncated_context: {'yes' if context['truncated'] else 'no'}",
        f"included_original_pdf_pages: {_format_page_ranges(context['includedPageNumbers']) or 'none'}",
        "",
        "FULL PDF TEXT CONTEXT BY ORIGINAL PAGE NUMBER:",
    ]
    for item in context["pages"]:
        chunks.append(f"\n[p.{item['page_no']}] {item['title']}\n{item['text_md']}")
    return _truncate("\n".join(chunks), MAX_TEACHING_CACHE_CHARS)


# ---------------------------------------------------------------------------
# PDF document context (agent panel use)
# ---------------------------------------------------------------------------


def _pdf_document_context(value: Any) -> str:
    """Build a human-readable PDF document context string for the agent panel."""
    if not isinstance(value, Mapping):
        return ""
    pages = value.get("pages")
    if not isinstance(pages, list):
        return ""

    page_count = _int_value(value.get("pageCount"), len(pages))
    full_page_limit = _int_value(value.get("fullPageLimit"), PDF_CONTEXT_FULL_PAGE_LIMIT)
    edge_page_count = _int_value(value.get("edgePageCount"), PDF_CONTEXT_EDGE_PAGE_COUNT)
    included_pages = _pdf_included_page_numbers(value, page_count, full_page_limit, edge_page_count)
    allowed_pages = set(included_pages)
    explicit_truncated = value.get("truncated")
    truncated = bool(explicit_truncated) if explicit_truncated is not None else len(included_pages) < page_count
    policy = f"first {edge_page_count} and last {edge_page_count} pages" if truncated else "all pages"

    chunks = [
        f"Document title: {_string_value(value.get('documentTitle'), 'Untitled')}",
        f"Page count: {page_count}",
        f"Full-context page limit: {full_page_limit}",
        f"Edge pages per side when truncated: {edge_page_count}",
        f"Truncated PDF context: {'yes' if truncated else 'no'}",
        f"Included pages: {policy}",
        f"Included original PDF page numbers: {_format_page_ranges(included_pages) or 'none'}",
    ]
    remaining = MAX_PDF_CONTEXT_CHARS - sum(len(chunk) for chunk in chunks)
    included = 0
    for item in pages:
        if not isinstance(item, Mapping):
            continue
        page_no = _int_value(item.get("page_no"), 0)
        if page_no <= 0 or page_no not in allowed_pages:
            continue
        title = _string_value(item.get("title"), f"PDF p.{page_no}")
        text = str(item.get("text_md") or "").strip()
        if not text:
            text = "[No embedded text extracted for this page.]"
        prefix = f"[p.{page_no}] {title}\n"
        available_for_text = remaining - len(prefix)
        if available_for_text <= 0:
            chunks.append("[PDF context truncated by server character budget.]")
            break
        truncated_by_budget = len(text) > available_for_text
        block = f"{prefix}{_truncate(text, available_for_text) if truncated_by_budget else text}"
        if truncated_by_budget:
            chunks.extend([block, "[PDF context truncated by server character budget.]"])
            break
        if remaining - len(block) < 0:
            chunks.append("[PDF context truncated by server character budget.]")
            break
        chunks.append(block)
        remaining -= len(block)
        included += 1
        if not truncated and included >= full_page_limit:
            break
    return "\n\n".join(chunks if included else [])


# ---------------------------------------------------------------------------
# PDF file input (shared across agent / teaching payloads)
# ---------------------------------------------------------------------------


def _pdf_file_input(
    value: Any,
    *,
    page_numbers: Sequence[int] | None = None,
    fallback_to_original_on_subset_failure: bool = True,
    pdf_file_cache: PdfFileCache | None = None,
) -> dict[str, Any] | None:
    """Build an ``input_file`` content part for a gateway payload."""
    if not isinstance(value, Mapping):
        return None
    cache = pdf_file_cache or _pdf_file_cache
    file_data = _raw_pdf_file_data(value.get("fileData") or value.get("file_data"))
    sha256 = _string_value(value.get("sha256"), "")
    if not file_data and sha256 and cache is not None:
        cached = cache.get(sha256)
        if cached:
            value = {**cached, **value}
            file_data = _raw_pdf_file_data(cached.get("fileData"))
    if not file_data or len(file_data) > MAX_PDF_FILE_DATA_CHARS:
        return None
    filename = _string_value(value.get("filename") or value.get("fileName"), "document.pdf")
    if not filename.lower().endswith(".pdf"):
        filename = f"{filename}.pdf"
    if page_numbers and cache is not None:
        subset_file_data = cache.get_or_create_subset(file_data, page_numbers, sha256=sha256)
        if not subset_file_data:
            if not fallback_to_original_on_subset_failure:
                return None
        else:
            file_data = subset_file_data
    return {
        "type": "input_file",
        "filename": filename,
        "file_data": _pdf_file_data_url(file_data),
    }


# ---------------------------------------------------------------------------
# Selected context
# ---------------------------------------------------------------------------


def _selected_context_text(value: Any) -> str:
    """Extract the ``text`` field from a selected-context object."""
    if not isinstance(value, Mapping):
        return ""
    return _truncate(str(value.get("text") or "").strip(), MAX_CONTEXT_CHARS)


def _selected_context_source_type(value: Any) -> str:
    """Return the source type of a selected-context object."""
    if not isinstance(value, Mapping):
        return "unknown"
    return _string_value(value.get("sourceType"), "unknown")


def _selected_pdf_source_text(value: Any) -> str:
    """Extract the PDF source text from a selected-context object."""
    if not isinstance(value, Mapping):
        return ""
    pdf_source = value.get("pdfSource")
    if not isinstance(pdf_source, Mapping):
        return ""
    return _truncate(str(pdf_source.get("text") or "").strip(), MAX_CONTEXT_CHARS)


def _selected_source_lines(selected_context: Any, pdf_context: Any) -> list[str]:
    """Build metadata lines describing the selected source."""
    if not isinstance(selected_context, Mapping):
        return []
    source_type = _selected_context_source_type(selected_context)
    generated_page_no = _int_value(selected_context.get("generatedPageNumber"), 0)
    pdf_source = selected_context.get("pdfSource") if isinstance(selected_context.get("pdfSource"), Mapping) else {}
    pdf_source_page_no = _int_value(pdf_source.get("pageNumber") if isinstance(pdf_source, Mapping) else None, 0)
    page_no = _int_value(
        selected_context.get("pdfPageNumber")
        or pdf_source_page_no
        or selected_context.get("generatedPageNumber")
        or selected_context.get("pageNumber"),
        0,
    )
    lines: list[str] = []
    if source_type == "generated-explanation" and generated_page_no:
        lines.append(f"Selected explanation page: {generated_page_no}")
    if page_no:
        lines.append(f"Corresponding original PDF page: {page_no}" if source_type == "generated-explanation" else f"PDF page: {page_no}")
    section = _string_value(selected_context.get("sectionTitle"), "")
    if section:
        lines.append(f"Source: {section}")
    if isinstance(pdf_source, Mapping):
        title = _string_value(pdf_source.get("title"), "")
        ref = _string_value(pdf_source.get("ref"), "")
        if title:
            lines.append(f"PDF page title: {title}")
        if ref:
            lines.append(f"PDF page reference: {ref}")
    if not isinstance(pdf_context, Mapping):
        return lines

    page_count = _int_value(pdf_context.get("pageCount"), 0)
    full_page_limit = _int_value(pdf_context.get("fullPageLimit"), PDF_CONTEXT_FULL_PAGE_LIMIT)
    edge_page_count = _int_value(pdf_context.get("edgePageCount"), PDF_CONTEXT_EDGE_PAGE_COUNT)
    included_pages = _pdf_included_page_numbers(pdf_context, page_count, full_page_limit, edge_page_count)
    explicit_truncated = pdf_context.get("truncated")
    truncated = bool(explicit_truncated) if explicit_truncated is not None else (len(included_pages) < page_count if page_count else False)
    if truncated:
        included = _format_page_ranges(included_pages)
        lines.append(
            f"PDF context is truncated: original PDF has {page_count} pages, configured full-context limit is {full_page_limit} pages, and the model received pages {included or 'none'} ({edge_page_count} pages from each edge)."
        )
        if page_no:
            if page_no in set(included_pages):
                lines.append(f"The selected text is on PDF page {page_no}, which is included in the truncated PDF context.")
            else:
                lines.append(
                    f"The selected text is on PDF page {page_no}, which is outside the truncated PDF context; use the selected text as the exact evidence for that page."
                )
    return lines


def _selected_context(value: Any) -> str:
    """Build the full selected-context prompt block."""
    if not isinstance(value, Mapping):
        return ""
    text = _selected_context_text(value)
    if not text:
        return ""
    source_type = _string_value(value.get("sourceType"), "unknown")
    document_title = _string_value(value.get("documentTitle"), "")
    section_title = _string_value(value.get("sectionTitle"), "")
    pdf_source = value.get("pdfSource") if isinstance(value.get("pdfSource"), Mapping) else {}
    pdf_source_page = _string_value(pdf_source.get("pageNumber") if isinstance(pdf_source, Mapping) else "", "")
    page_number = _string_value(
        value.get("pdfPageNumber") or value.get("generatedPageNumber") or value.get("pageNumber"),
        "",
    )
    meta = [f"type={source_type}"]
    if page_number:
        meta.append(f"page={page_number}")
    if source_type == "generated-explanation" and pdf_source_page:
        meta.append(f"corresponding_pdf_page={pdf_source_page}")
    if document_title:
        meta.append(f"document={document_title}")
    if section_title:
        meta.append(f"section={section_title}")
    result = f"Selected context ({', '.join(meta)})\n{text}"
    pdf_source_text = _selected_pdf_source_text(value)
    if pdf_source_text:
        pdf_source_title = _string_value(pdf_source.get("title") if isinstance(pdf_source, Mapping) else "", "")
        pdf_label = "Corresponding PDF source"
        if pdf_source_page:
            pdf_label += f" p.{pdf_source_page}"
        if pdf_source_title:
            pdf_label += f" · {pdf_source_title}"
        result += f"\n\n{pdf_label}\n{pdf_source_text}"
    return result


# ---------------------------------------------------------------------------
# Context items & parts
# ---------------------------------------------------------------------------


def _context_items(value: Any) -> list[str]:
    """Build prompt blocks from ``context`` list items."""
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for index, item in enumerate(value[:MAX_CONTEXT_ITEMS], start=1):
        if not isinstance(item, Mapping):
            continue
        label = _string_value(item.get("title") or item.get("source"), f"Context {index}")
        kind = _string_value(item.get("type"), "text")
        page_no = _string_value(item.get("page_no"), "")
        text = _truncate(str(item.get("text") or ""), MAX_CONTEXT_CHARS)
        if not text:
            continue
        page_suffix = f", page {page_no}" if page_no else ""
        items.append(f"[{index}] {label} ({kind}{page_suffix})\n{text}")
    return items


def _context_parts(value: Any) -> list[str]:
    """Build prompt blocks from ``parts`` list items."""
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for index, part in enumerate(value[:MAX_CONTEXT_ITEMS], start=1):
        if not isinstance(part, Mapping):
            continue
        part_type = _string_value(part.get("type"), "text")
        if part_type not in {"quote", "pdf_reference"}:
            continue
        text = _truncate(str(part.get("text") or ""), MAX_CONTEXT_CHARS)
        if not text:
            continue
        source = part.get("source") if isinstance(part.get("source"), Mapping) else {}
        page_no = _string_value(source.get("page_no"), "")
        title = _string_value(part.get("title"), f"Reference {index}")
        page_suffix = f", page {page_no}" if page_no else ""
        items.append(f"[part {index}] {title} ({part_type}{page_suffix})\n{text}")
    return items


def _text_from_parts(value: Any) -> str:
    """Concatenate text from a list of ``text``-type parts."""
    if not isinstance(value, list):
        return ""
    texts: list[str] = []
    for part in value:
        if not isinstance(part, Mapping):
            continue
        if part.get("type") != "text":
            continue
        text = str(part.get("text") or "").strip()
        if text:
            texts.append(text)
    return "\n\n".join(texts)


# ---------------------------------------------------------------------------
# Transcript messages
# ---------------------------------------------------------------------------


def _transcript_messages(value: Any) -> list[str]:
    """Format recent transcript messages as prompt blocks."""
    if not isinstance(value, list):
        return []
    messages: list[str] = []
    for item in value[-MAX_TRANSCRIPT_MESSAGES:]:
        if not isinstance(item, Mapping):
            continue
        role = _string_value(item.get("role"), "message")
        content = _truncate(_message_content(item), 4000)
        if content:
            status = _string_value(item.get("status"), "success")
            status_suffix = f" [{status}]" if status not in {"", "success"} else ""
            messages.append(f"{role}{status_suffix}: {content}")
    return messages


def _message_content(message: Mapping[str, Any]) -> str:
    """Extract text content from a transcript message."""
    content = str(message.get("content") or "").strip()
    parts_text = _message_parts_content(message.get("parts"))
    if parts_text:
        return parts_text
    return content


def _message_parts_content(value: Any) -> str:
    """Extract text from a message's ``parts`` list."""
    if not isinstance(value, list):
        return ""
    segments: list[str] = []
    for part in value:
        if not isinstance(part, Mapping):
            continue
        part_type = _string_value(part.get("type"), "text")
        if part_type == "file":
            continue
        text = str(part.get("text") or "").strip()
        if not text:
            continue
        if part_type in {"quote", "pdf_reference"}:
            source = part.get("source") if isinstance(part.get("source"), Mapping) else {}
            page_no = _string_value(source.get("page_no"), "")
            page_suffix = f" p.{page_no}" if page_no else ""
            segments.append(f"[{part_type}{page_suffix}] {text}")
        else:
            segments.append(text)
    return "\n\n".join(segments)


# ---------------------------------------------------------------------------
# Image attachments
# ---------------------------------------------------------------------------


def _image_attachments(value: Any, parts: Any = None) -> list[dict[str, str]]:
    """Collect ``data:image/...`` URLs from attachments and file parts."""
    from pdf_agent.server.errors import HttpError

    candidates: list[Any] = []
    if isinstance(value, list):
        candidates.extend(value)
    if isinstance(parts, list):
        candidates.extend(part for part in parts if isinstance(part, Mapping) and part.get("type") == "file")
    images: list[dict[str, str]] = []
    for item in candidates[:MAX_IMAGE_ATTACHMENTS]:
        if not isinstance(item, Mapping):
            continue
        data_url = str(item.get("data_url") or "")
        if not data_url.startswith("data:image/"):
            continue
        if len(data_url) > MAX_IMAGE_DATA_URL_CHARS:
            raise HttpError(413, "Image attachment is too large", code="image_too_large")
        images.append({"data_url": data_url})
    return images
