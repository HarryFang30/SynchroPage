"""Thread-safe LRU caches for PDF file data and page subsets.

Encapsulates the previously module-level mutable state (OrderedDict caches,
byte counters, and locks) into a single ``PdfFileCache`` class.

The class is designed to be instantiated once and shared — typically at
server creation time — so tests can create isolated instances.
"""

from __future__ import annotations

import base64
import io
import threading
from collections import OrderedDict
from collections.abc import Mapping, Sequence
from typing import Any

from pdf_agent.server.value_utils import int_value as _int_value, string_value as _string_value

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PDF_FILE_DATA_URL_PREFIX = "data:application/pdf;base64,"
PDF_FILE_CACHE_MAX_ENTRIES = 8
PDF_FILE_CACHE_MAX_BYTES = 240_000_000
PDF_FILE_SUBSET_CACHE_MAX_ENTRIES = 64
PDF_FILE_SUBSET_CACHE_MAX_BYTES = 120_000_000


# ---------------------------------------------------------------------------
# Pure helpers (no state, no web_app deps)
# ---------------------------------------------------------------------------


def raw_pdf_file_data(value: Any) -> str:
    """Strip ``data:...;base64,`` prefix from a data URL, returning raw base64."""
    file_data = str(value or "").strip()
    if file_data.startswith("data:") and "," in file_data:
        return file_data.split(",", 1)[1].strip()
    return file_data


def pdf_file_data_url(file_data: str) -> str:
    """Wrap raw base64 PDF data in a data URL."""
    raw = raw_pdf_file_data(file_data)
    return f"{PDF_FILE_DATA_URL_PREFIX}{raw}" if raw else ""


def normalized_pdf_subset_page_numbers(page_numbers: Sequence[int]) -> list[int]:
    """Deduplicate and validate page numbers."""
    requested_pages: list[int] = []
    seen: set[int] = set()
    for value in page_numbers:
        try:
            page_no = int(value)
        except (TypeError, ValueError):
            continue
        if page_no > 0 and page_no not in seen:
            seen.add(page_no)
            requested_pages.append(page_no)
    return requested_pages


def pdf_subset_cache_key(sha256: str, page_numbers: Sequence[int]) -> str:
    """Deterministic cache key for a PDF page subset."""
    return f"{sha256}:{','.join(str(pn) for pn in page_numbers)}"


# ---------------------------------------------------------------------------
# PdfFileCache
# ---------------------------------------------------------------------------


class PdfFileCache:
    """Thread-safe LRU cache for full PDF payloads and page subsets."""

    def __init__(
        self,
        *,
        max_entries: int = PDF_FILE_CACHE_MAX_ENTRIES,
        max_bytes: int = PDF_FILE_CACHE_MAX_BYTES,
        subset_max_entries: int = PDF_FILE_SUBSET_CACHE_MAX_ENTRIES,
        subset_max_bytes: int = PDF_FILE_SUBSET_CACHE_MAX_BYTES,
    ) -> None:
        self._lock = threading.Lock()
        self._cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._bytes = 0
        self._max_entries = max_entries
        self._max_bytes = max_bytes

        self._subset_lock = threading.Lock()
        self._subset_cache: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._subset_bytes = 0
        self._subset_max_entries = subset_max_entries
        self._subset_max_bytes = subset_max_bytes

    # -- full PDF payload ---------------------------------------------------

    def store(self, record: Mapping[str, Any]) -> None:
        """Cache a full PDF payload record (must have ``sha256`` and ``size``)."""
        sha256 = _string_value(record.get("sha256"), "")
        size = _int_value(record.get("size"), 0)
        if not sha256 or size <= 0:
            return
        with self._lock:
            previous = self._cache.pop(sha256, None)
            if previous:
                self._bytes -= _int_value(previous.get("size"), 0)
            self._cache[sha256] = dict(record)
            self._bytes += size
            self._evict_locked()

    def get(self, sha256: str) -> dict[str, Any] | None:
        """Retrieve a cached full PDF payload by SHA-256 (promotes to MRU)."""
        if not sha256:
            return None
        with self._lock:
            cached = self._cache.pop(sha256, None)
            if not cached:
                return None
            self._cache[sha256] = cached
            return dict(cached)

    # -- PDF page subset ----------------------------------------------------

    def get_or_create_subset(
        self,
        file_data: str,
        page_numbers: Sequence[int],
        *,
        sha256: str = "",
    ) -> str | None:
        """Return cached base64 page-subset, or create + cache it.

        Returns ``None`` when a subset cannot be created (e.g. all pages
        requested, or PyPDF2 fails).
        """
        requested_pages = normalized_pdf_subset_page_numbers(page_numbers)
        if not requested_pages:
            return None
        cache_key = pdf_subset_cache_key(sha256, requested_pages) if sha256 else ""
        if cache_key:
            cached = self._get_subset_locked(cache_key)
            if cached:
                return cached
        subset = self._create_subset(file_data, requested_pages)
        if subset and cache_key:
            self._store_subset_locked(cache_key, subset)
        return subset

    # -- internal -----------------------------------------------------------

    def _evict_locked(self) -> None:
        """Evict oldest entries until within limits.  Caller must hold ``_lock``."""
        while (
            len(self._cache) > self._max_entries or self._bytes > self._max_bytes
        ) and self._cache:
            _key, evicted = self._cache.popitem(last=False)
            self._bytes -= _int_value(evicted.get("size"), 0)

    def _get_subset_locked(self, cache_key: str) -> str | None:
        if not cache_key:
            return None
        with self._subset_lock:
            cached = self._subset_cache.pop(cache_key, None)
            if not cached:
                return None
            self._subset_cache[cache_key] = cached
            return str(cached.get("fileData") or "") or None

    def _store_subset_locked(self, cache_key: str, file_data: str) -> None:
        if not cache_key or not file_data:
            return
        size = len(file_data)
        with self._subset_lock:
            previous = self._subset_cache.pop(cache_key, None)
            if previous:
                self._subset_bytes -= _int_value(previous.get("size"), 0)
            self._subset_cache[cache_key] = {"fileData": file_data, "size": size}
            self._subset_bytes += size
            while (
                len(self._subset_cache) > self._subset_max_entries
                or self._subset_bytes > self._subset_max_bytes
            ) and self._subset_cache:
                _key, evicted = self._subset_cache.popitem(last=False)
                self._subset_bytes -= _int_value(evicted.get("size"), 0)

    @staticmethod
    def _create_subset(file_data: str, requested_pages: list[int]) -> str | None:
        """Create a PDF subset containing only *requested_pages* (1-based)."""
        try:
            from PyPDF2 import PdfReader, PdfWriter  # type: ignore[import-untyped]

            source_bytes = base64.b64decode(file_data, validate=False)
            reader = PdfReader(io.BytesIO(source_bytes))
            total_pages = len(reader.pages)
            page_indexes = [
                page_no - 1 for page_no in requested_pages if 1 <= page_no <= total_pages
            ]
            if not page_indexes or len(page_indexes) >= total_pages:
                return None
            writer = PdfWriter()
            for page_index in page_indexes:
                writer.add_page(reader.pages[page_index])
            output = io.BytesIO()
            writer.write(output)
            return base64.b64encode(output.getvalue()).decode("ascii")
        except Exception:
            return None
