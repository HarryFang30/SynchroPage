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
    _parse_generated_page,
    _request_etag_matches,
    _resolve_static_path,
    _static_cache_control,
    _static_file_etag,
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
        self.assertTrue(str(payload["prompt_cache_key"]).startswith("pagepair:doc_1:"))
        self.assertEqual(payload["prompt_cache_retention"], "24h")
        content = payload["input"][0]["content"]
        self.assertEqual(content[0]["type"], "input_text")
        self.assertIn("PAGEPAIR CACHEABLE DOCUMENT CONTEXT", content[0]["text"])
        self.assertIn("truncated_context: no", content[0]["text"])
        self.assertIn("[p.1] Intro", content[0]["text"])
        self.assertIn("[p.3] Eigenvectors", content[0]["text"])
        self.assertEqual(content[1]["type"], "input_text")
        self.assertIn("Selected source:", content[1]["text"])
        self.assertIn("PDF page: 7", content[1]["text"])
        self.assertIn("Selected explanation text:\n\nD_i = Q_i^+", content[1]["text"])
        self.assertIn("User question:\n\n解释这个公式", content[1]["text"])
        self.assertIn("# User selected source material", content[1]["text"])
        self.assertIn("D_i = Q_i^+", content[1]["text"])
        self.assertIn("$$Ax = \\lambda x$$", content[1]["text"])
        self.assertIn("上一轮问题", content[1]["text"])
        self.assertEqual(content[2], {"type": "input_image", "image_url": "data:image/png;base64,AAAA"})

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

        cache_prefix = payload["input"][0]["content"][0]["text"]
        prompt = payload["input"][0]["content"][1]["text"]
        self.assertIn("truncated_context: yes", cache_prefix)
        self.assertIn("included_original_pdf_pages: 1-10, 51-60", cache_prefix)
        self.assertIn("[p.1] Page 1", cache_prefix)
        self.assertIn("[p.10] Page 10", cache_prefix)
        self.assertIn("[p.51] Page 51", cache_prefix)
        self.assertIn("[p.60] Page 60", cache_prefix)
        self.assertIn("PDF context is truncated: original PDF has 60 pages", prompt)
        self.assertIn("PDF page: 30", prompt)
        self.assertIn("outside the truncated PDF context", prompt)
        self.assertIn("Selected text:\n\nselected middle text", prompt)
        self.assertIn("User question:\n\n解释这段", prompt)
        self.assertNotIn("[p.11] Page 11", cache_prefix)
        self.assertNotIn("[p.30] Page 30", cache_prefix)

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
        self.assertEqual(content[0]["type"], "input_text")
        self.assertIn("PAGEPAIR CACHEABLE DOCUMENT CONTEXT", content[0]["text"])
        self.assertIn("[p.1] Intro", content[0]["text"])
        self.assertIn("[p.2] Enable", content[0]["text"])
        self.assertEqual(content[1]["type"], "input_file")
        self.assertEqual(content[1]["filename"], "t7.pdf")
        self.assertEqual(content[2]["type"], "input_text")
        self.assertIn("Target page:", content[2]["text"])
        self.assertIn("page_no: 2", content[2]["text"])

    def test_agent_and_teaching_share_document_cache_prefix(self) -> None:
        body = {
            "model": "gpt-5.5",
            "document": {"id": "doc_shared", "title": "Shared PDF", "page_count": 2},
            "pdfContext": {
                "documentId": "doc_shared",
                "documentTitle": "Shared PDF",
                "pageCount": 2,
                "pages": [
                    {"page_no": 1, "title": "Intro", "text_md": "overview"},
                    {"page_no": 2, "title": "Counters", "text_md": "counter details"},
                ],
            },
            "documentContext": {
                "documentId": "doc_shared",
                "documentTitle": "Shared PDF",
                "pageCount": 2,
                "pages": [
                    {"page_no": 1, "title": "Intro", "text_md": "overview"},
                    {"page_no": 2, "title": "Counters", "text_md": "counter details"},
                ],
            },
            "page": {
                "page_no": 2,
                "source": {"text_md": "counter details", "pdf_page_ref": "#page=2"},
                "teaching": {"slide_title": "Counters", "speaker_notes_md": ""},
            },
            "input": "解释这一页",
        }

        agent_payload = _build_responses_payload(body, default_model="fallback")
        teaching_payload = _build_teaching_generation_payload(body, default_model="fallback")

        self.assertEqual(
            agent_payload["input"][0]["content"][0]["text"],
            teaching_payload["input"][0]["content"][0]["text"],
        )
        self.assertEqual(agent_payload["prompt_cache_key"], teaching_payload["prompt_cache_key"])

    def test_document_cache_prefix_is_stable_for_page_order(self) -> None:
        base = {
            "model": "gpt-5.5",
            "document": {"id": "doc_order", "title": "Ordered PDF", "page_count": 2},
            "page": {
                "page_no": 1,
                "source": {"text_md": "intro", "pdf_page_ref": "#page=1"},
                "teaching": {"slide_title": "Intro", "speaker_notes_md": ""},
            },
            "input": "总结",
        }
        body_a = {
            **base,
            "pdfContext": {
                "documentId": "doc_order",
                "documentTitle": "Ordered PDF",
                "pageCount": 2,
                "pages": [
                    {"page_no": 2, "title": "Second", "text_md": "second page"},
                    {"page_no": 1, "title": "First", "text_md": "first page"},
                ],
            },
        }
        body_b = {
            **base,
            "pdfContext": {
                "documentId": "doc_order",
                "documentTitle": "Ordered PDF",
                "pageCount": 2,
                "pages": [
                    {"page_no": 1, "title": "First", "text_md": "first page"},
                    {"page_no": 2, "title": "Second", "text_md": "second page"},
                ],
            },
        }

        payload_a = _build_responses_payload(body_a, default_model="fallback")
        payload_b = _build_responses_payload(body_b, default_model="fallback")
        prefix_a = payload_a["input"][0]["content"][0]["text"]
        prefix_b = payload_b["input"][0]["content"][0]["text"]

        self.assertEqual(payload_a["prompt_cache_key"], payload_b["prompt_cache_key"])
        self.assertEqual(prefix_a, prefix_b)
        self.assertIn("cache_version: pagepair.document-prefix.v2", prefix_a)
        self.assertLess(prefix_a.index("[p.1] First"), prefix_a.index("[p.2] Second"))

    def test_generated_page_normalizes_mixed_language_latex_ranges(self) -> None:
        bad_notes = (
            r"计数范围是 $0 到 \2^n-1$。"
            "\n"
            r"三位计数器会 $000 数到 \111，然后回到 \000$。"
            "\n"
            r"状态转移：$000 \to 001 \to 010 \to \cdots \to 111 \to 000"
            "\n。表中的状态如下。"
        )
        page = _parse_generated_page(
            json.dumps(
                {
                    "page_no": 1,
                    "source": {"text_md": "n-bit counter range", "pdf_page_ref": "#page=1"},
                    "teaching": {
                        "slide_title": "Counter range",
                        "speaker_notes_md": bad_notes,
                        "concepts": ["counter"],
                        "confidence": 0.9,
                    },
                }
            ),
            {
                "page": {
                    "page_no": 1,
                    "source": {"text_md": "n-bit counter range", "pdf_page_ref": "#page=1"},
                }
            },
        )

        self.assertIn("$0 \\text{到} 2^n-1$", page["teaching"]["speaker_notes_md"])
        self.assertIn("$000 \\text{数到} 111\\text{，然后回到} 000$", page["teaching"]["speaker_notes_md"])
        self.assertIn(
            "$000 \\to 001 \\to 010 \\to \\cdots \\to 111 \\to 000$\n。表中的",
            page["teaching"]["speaker_notes_md"],
        )

    def test_generated_page_repairs_unescaped_latex_backslashes_in_json(self) -> None:
        content = r'''
{
  "page_no": 2,
  "source": {
    "text_md": "counter state transition",
    "pdf_page_ref": "#page=2"
  },
  "teaching": {
    "slide_title": "Counter states",
    "speaker_notes_md": "第一行\n状态转移：$000 \to 001 \to \cdots \to 111$，特征值 $\lambda$，分式 $\frac{a}{b}$。",
    "concepts": ["counter"],
    "confidence": 0.91
  },
  "status": "ready"
}
'''
        page = _parse_generated_page(
            content,
            {
                "page": {
                    "page_no": 2,
                    "source": {"text_md": "counter state transition", "pdf_page_ref": "#page=2"},
                }
            },
        )

        notes = page["teaching"]["speaker_notes_md"]
        self.assertIn("第一行\n状态转移", notes)
        self.assertIn("$000 \\to 001 \\to \\cdots \\to 111$", notes)
        self.assertIn("$\\lambda$", notes)
        self.assertIn("$\\frac{a}{b}$", notes)
        self.assertNotIn("\t", notes)
        self.assertNotIn("\f", notes)

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

    def test_static_cache_headers_support_revalidation_and_immutable_assets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            assets = root / "assets"
            assets.mkdir()
            index = root / "index.html"
            app = assets / "app.abcdef12.js"
            plain = root / "manifest.json"
            index.write_text("ok")
            app.write_text("console.log('ok')")
            plain.write_text("{}")

            etag = _static_file_etag(index.stat())
            self.assertTrue(_request_etag_matches(etag, etag))
            self.assertTrue(_request_etag_matches(f'"other", {etag}', etag))
            self.assertFalse(_request_etag_matches('"other"', etag))
            self.assertEqual(_static_cache_control(root, index), "no-cache")
            self.assertEqual(_static_cache_control(root, app), "public, max-age=31536000, immutable")
            self.assertEqual(_static_cache_control(root, plain), "no-cache")


if __name__ == "__main__":
    unittest.main()
