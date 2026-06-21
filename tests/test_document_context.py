"""Unit tests for pdf_agent.server.document_context pure functions."""

from __future__ import annotations

import unittest

from pdf_agent.server.document_context import (
    _cacheable_document_context,
    _context_items,
    _context_parts,
    _format_page_ranges,
    _iter_mapping_items,
    _pdf_context_page_numbers,
    _pdf_included_page_numbers,
    _selected_context,
    _selected_context_source_type,
    _selected_context_text,
    _text_from_parts,
)


class PageNumbersTest(unittest.TestCase):

    def test_context_page_numbers_all_when_under_limit(self) -> None:
        self.assertEqual(_pdf_context_page_numbers(5, full_page_limit=50, edge_page_count=10), [1, 2, 3, 4, 5])

    def test_context_page_numbers_truncated_when_over_limit(self) -> None:
        result = _pdf_context_page_numbers(100, full_page_limit=50, edge_page_count=10)
        self.assertIn(1, result)
        self.assertIn(100, result)
        self.assertNotIn(50, result)
        self.assertEqual(len(result), 20)  # 10 from each edge

    def test_context_page_numbers_single_page(self) -> None:
        self.assertEqual(_pdf_context_page_numbers(1, full_page_limit=50, edge_page_count=10), [1])

    def test_context_page_numbers_zero_pages(self) -> None:
        self.assertEqual(_pdf_context_page_numbers(0, full_page_limit=50, edge_page_count=10), [])

    def test_included_page_numbers_uses_explicit_list(self) -> None:
        result = _pdf_included_page_numbers({"includedPageNumbers": [3, 5, 7]}, page_count=10, full_page_limit=5, edge_page_count=2)
        self.assertEqual(result, [3, 5, 7])

    def test_included_page_numbers_falls_back_to_computed(self) -> None:
        result = _pdf_included_page_numbers({}, page_count=5, full_page_limit=50, edge_page_count=10)
        self.assertEqual(result, [1, 2, 3, 4, 5])

    def test_included_page_numbers_filters_out_of_range(self) -> None:
        result = _pdf_included_page_numbers({"includedPageNumbers": [0, 1, 99, 100]}, page_count=5, full_page_limit=3, edge_page_count=1)
        self.assertEqual(result, [1])


class FormatPageRangesTest(unittest.TestCase):

    def test_empty(self) -> None:
        self.assertEqual(_format_page_ranges([]), "")

    def test_single(self) -> None:
        self.assertEqual(_format_page_ranges([1]), "1")

    def test_consecutive_range(self) -> None:
        self.assertEqual(_format_page_ranges([1, 2, 3, 4, 5]), "1-5")

    def test_mixed_ranges(self) -> None:
        self.assertEqual(_format_page_ranges([1, 2, 3, 7, 8, 10]), "1-3, 7-8, 10")


class IterMappingTest(unittest.TestCase):

    def test_filters_non_mappings(self) -> None:
        result = _iter_mapping_items([{"a": 1}, "string", 42, {"b": 2}, None])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], {"a": 1})
        self.assertEqual(result[1], {"b": 2})

    def test_non_list_returns_empty(self) -> None:
        self.assertEqual(_iter_mapping_items(None), [])
        self.assertEqual(_iter_mapping_items("string"), [])
        self.assertEqual(_iter_mapping_items({}), [])


class CacheableDocumentContextTest(unittest.TestCase):

    def test_prefers_document_context(self) -> None:
        body = {"documentContext": {"pages": [{"page_no": 1}]}, "pdfContext": {"key": "val"}}
        result = _cacheable_document_context(body)
        self.assertIn("pages", result)

    def test_falls_back_to_pdf_context(self) -> None:
        body = {"pdfContext": {"pages": [{"page_no": 1}]}}
        result = _cacheable_document_context(body)
        self.assertIn("pages", result)

    def test_returns_empty_when_none_present(self) -> None:
        self.assertEqual(_cacheable_document_context({}), {})


class SelectedContextTest(unittest.TestCase):

    def test_selected_context_text_truncates(self) -> None:
        long_text = "x" * 100_000
        result = _selected_context_text({"text": long_text})
        self.assertLess(len(result), len(long_text))

    def test_selected_context_text_empty(self) -> None:
        self.assertEqual(_selected_context_text(None), "")
        self.assertEqual(_selected_context_text({}), "")

    def test_source_type(self) -> None:
        self.assertEqual(_selected_context_source_type({"sourceType": "pdf"}), "pdf")
        self.assertEqual(_selected_context_source_type({}), "unknown")
        self.assertEqual(_selected_context_source_type(None), "unknown")

    def test_selected_context_full_block(self) -> None:
        result = _selected_context({"text": "Hello world", "sourceType": "pdf", "pdfPageNumber": "5", "documentTitle": "Test"})
        self.assertIn("Hello world", result)
        self.assertIn("type=pdf", result)
        self.assertIn("page=5", result)
        self.assertIn("document=Test", result)

    def test_selected_context_empty_when_no_text(self) -> None:
        self.assertEqual(_selected_context({}), "")
        self.assertEqual(_selected_context(None), "")
        self.assertEqual(_selected_context({"sourceType": "pdf"}), "")


class ContextItemsTest(unittest.TestCase):

    def test_formats_items(self) -> None:
        items = [{"title": "Topic A", "text": "Some context", "type": "note", "page_no": 3}]
        result = _context_items(items)
        self.assertEqual(len(result), 1)
        self.assertIn("Topic A", result[0])
        self.assertIn("Some context", result[0])
        self.assertIn("page 3", result[0])

    def test_skips_empty_text(self) -> None:
        items = [{"title": "Topic", "text": ""}, {"title": "Topic B", "text": "content"}]
        result = _context_items(items)
        self.assertEqual(len(result), 1)

    def test_non_list_returns_empty(self) -> None:
        self.assertEqual(_context_items(None), [])
        self.assertEqual(_context_items({}), [])


class ContextPartsTest(unittest.TestCase):

    def test_filters_quote_and_pdf_reference(self) -> None:
        parts = [
            {"type": "quote", "text": "Quote text", "title": "Q1"},
            {"type": "text", "text": "Plain text"},
            {"type": "pdf_reference", "text": "Ref text"},
        ]
        result = _context_parts(parts)
        self.assertEqual(len(result), 2)

    def test_non_list_returns_empty(self) -> None:
        self.assertEqual(_context_parts(None), [])


class TextFromPartsTest(unittest.TestCase):

    def test_extracts_text_parts(self) -> None:
        parts = [
            {"type": "text", "text": "Hello"},
            {"type": "image", "text": "not text"},
            {"type": "text", "text": "World"},
        ]
        result = _text_from_parts(parts)
        self.assertIn("Hello", result)
        self.assertIn("World", result)

    def test_returns_empty_for_non_list(self) -> None:
        self.assertEqual(_text_from_parts(None), "")
        self.assertEqual(_text_from_parts({"a": 1}), "")


if __name__ == "__main__":
    unittest.main()
