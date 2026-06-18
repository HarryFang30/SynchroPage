from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from pdf_agent.server.web_app import (
    HttpError,
    _build_responses_payload,
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
        self.assertIn("# User selected source material", content[0]["text"])
        self.assertIn("D_i = Q_i^+", content[0]["text"])
        self.assertIn("$$Ax = \\lambda x$$", content[0]["text"])
        self.assertIn("上一轮问题", content[0]["text"])
        self.assertEqual(content[1], {"type": "input_image", "image_url": "data:image/png;base64,AAAA"})

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
