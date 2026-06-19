from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from pdf_agent.server.web_app import (
    HttpError,
    _build_responses_payload,
    _build_teaching_generation_payload,
    _extract_gateway_text,
    _resolve_static_path,
)


class WebAppTest(unittest.TestCase):
    def test_agent_payload_preserves_context_formula_and_image(self) -> None:
        payload = _build_responses_payload(
            {
                "model": "gpt-5.5",
                "document": {"id": "doc_1", "title": "Linear Algebra"},
                "page": {
                    "page_no": 7,
                    "source": {"text_md": "Eigenvectors and $Ax = \\lambda x$."},
                    "teaching": {"slide_title": "Eigenvectors", "speaker_notes_md": "Use $\\lambda$."},
                },
                "input": "解释这个公式",
                "selectedContext": {
                    "text": "D_i = Q_i^+",
                    "sourceType": "generated-explanation",
                    "documentTitle": "Linear Algebra",
                    "pageNumber": 7,
                    "sectionTitle": "讲解区选区",
                },
                "pdfContext": {
                    "documentTitle": "Linear Algebra",
                    "pageCount": 3,
                    "truncated": False,
                    "truncationPolicy": "all-pages",
                    "pages": [
                        {"page_no": 1, "title": "Intro", "text_md": "Vector spaces"},
                        {"page_no": 2, "title": "Basis", "text_md": "Basis and span"},
                        {"page_no": 3, "title": "Eigenvectors", "text_md": "Eigenvectors"},
                    ],
                },
                "parts": [
                    {"type": "text", "text": "解释这个公式"},
                    {
                        "type": "quote",
                        "title": "选区",
                        "text": "$$Ax = \\lambda x$$",
                        "source": {"page_no": 7, "document_id": "doc_1"},
                    },
                    {
                        "type": "file",
                        "name": "plot.png",
                        "mime": "image/png",
                        "data_url": "data:image/png;base64,AAAA",
                    },
                ],
                "messages": [
                    {
                        "role": "user",
                        "status": "success",
                        "parts": [{"type": "text", "text": "上一轮问题"}],
                    }
                ],
            },
            default_model="fallback-model",
        )

        self.assertEqual(payload["model"], "gpt-5.5")
        content = payload["input"][0]["content"]
        self.assertEqual(content[0]["type"], "input_text")
        self.assertIn("Selected source:", content[0]["text"])
        self.assertIn("PDF page: 7", content[0]["text"])
        self.assertIn("Selected text:\n\nD_i = Q_i^+", content[0]["text"])
        self.assertIn("User question:\n\n解释这个公式", content[0]["text"])
        self.assertIn("# PDF document context", content[0]["text"])
        self.assertIn("Truncated PDF context: no", content[0]["text"])
        self.assertIn("[p.1] Intro", content[0]["text"])
        self.assertIn("[p.3] Eigenvectors", content[0]["text"])
        self.assertIn("# User selected source material", content[0]["text"])
        self.assertIn("D_i = Q_i^+", content[0]["text"])
        self.assertIn("$$Ax = \\lambda x$$", content[0]["text"])
        self.assertIn("上一轮问题", content[0]["text"])
        self.assertEqual(content[1], {"type": "input_image", "image_url": "data:image/png;base64,AAAA"})

    def test_agent_payload_truncates_large_pdf_context_to_edges(self) -> None:
        payload = _build_responses_payload(
            {
                "document": {"id": "doc_big", "title": "Large PDF"},
                "page": {"page_no": 30, "source": {}, "teaching": {"slide_title": "Middle"}},
                "input": "解释这段",
                "selectedContext": {
                    "text": "selected middle text",
                    "sourceType": "pdf-page",
                    "documentTitle": "Large PDF",
                    "pdfPageNumber": 30,
                },
                "pdfContext": {
                    "documentTitle": "Large PDF",
                    "pageCount": 60,
                    "truncated": True,
                    "truncationPolicy": "first-last-10",
                    "fullPageLimit": 50,
                    "edgePageCount": 10,
                    "includedPageNumbers": [*range(1, 11), *range(51, 61)],
                    "pages": [
                        {"page_no": page_no, "title": f"Page {page_no}", "text_md": f"Body {page_no}"}
                        for page_no in range(1, 61)
                    ],
                },
            },
            default_model="fallback-model",
        )

        prompt = payload["input"][0]["content"][0]["text"]
        self.assertIn("Included pages: first 10 and last 10 pages", prompt)
        self.assertIn("Included original PDF page numbers: 1-10, 51-60", prompt)
        self.assertIn("PDF context is truncated: original PDF has 60 pages", prompt)
        self.assertIn("[p.1] Page 1", prompt)
        self.assertIn("[p.10] Page 10", prompt)
        self.assertIn("[p.51] Page 51", prompt)
        self.assertIn("[p.60] Page 60", prompt)
        self.assertIn("PDF page: 30", prompt)
        self.assertIn("outside the truncated PDF context", prompt)
        self.assertIn("Selected text:\n\nselected middle text", prompt)
        self.assertIn("User question:\n\n解释这段", prompt)
        self.assertNotIn("[p.11] Page 11", prompt)
        self.assertNotIn("[p.30] Page 30", prompt)

    def test_teaching_generation_payload_uses_stable_cache_prefix_before_target_page(self) -> None:
        payload = _build_teaching_generation_payload(
            {
                "model": "gpt-5.5",
                "document": {"id": "doc_1", "title": "T7 Verilog HDL", "page_count": 2},
                "documentFile": {
                    "filename": "t7.pdf",
                    "fileData": "JVBERi0x",
                    "sha256": "a" * 64,
                },
                "documentContext": {
                    "documentId": "doc_1",
                    "documentTitle": "T7 Verilog HDL",
                    "pageCount": 2,
                    "pages": [
                        {"page_no": 1, "title": "Intro", "text_md": "counter overview"},
                        {"page_no": 2, "title": "Enable", "text_md": "count enable signal"},
                    ],
                },
                "pageCount": 2,
                "page": {
                    "page_no": 2,
                    "source": {"text_md": "count enable signal", "pdf_page_ref": "#page=2"},
                    "teaching": {"slide_title": "Enable", "speaker_notes_md": ""},
                },
            },
            default_model="fallback",
        )

        self.assertEqual(payload["model"], "gpt-5.5")
        self.assertEqual(payload["prompt_cache_retention"], "24h")
        self.assertTrue(str(payload["prompt_cache_key"]).startswith("pagepair:doc_1:"))
        content = payload["input"][0]["content"]
        self.assertEqual(content[0]["type"], "input_file")
        self.assertEqual(content[0]["filename"], "t7.pdf")
        self.assertEqual(content[1]["type"], "input_text")
        self.assertIn("PAGEPAIR CACHEABLE DOCUMENT CONTEXT", content[1]["text"])
        self.assertIn("[p.1] Intro", content[1]["text"])
        self.assertIn("[p.2] Enable", content[1]["text"])
        self.assertEqual(content[2]["type"], "input_text")
        self.assertIn("Target page:", content[2]["text"])
        self.assertIn("page_no: 2", content[2]["text"])

    def test_extracts_streaming_response_text(self) -> None:
        stream = "\n".join(
            [
                'data: {"type":"response.output_text.delta","delta":"hello "}',
                'data: {"type":"response.output_text.delta","delta":"world"}',
                "data: [DONE]",
            ]
        )
        self.assertEqual(_extract_gateway_text(stream, "text/event-stream"), "hello world")

    def test_extracts_json_response_text(self) -> None:
        text = json.dumps(
            {
                "output": [
                    {
                        "content": [
                            {"type": "output_text", "text": "json reply"},
                        ]
                    }
                ]
            }
        )
        self.assertEqual(_extract_gateway_text(text, "application/json"), "json reply")

    def test_static_path_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "index.html").write_text("ok")
            self.assertEqual(_resolve_static_path(root, "/").name, "index.html")
            with self.assertRaises(HttpError):
                _resolve_static_path(root, "/../secret.txt")


if __name__ == "__main__":
    unittest.main()
