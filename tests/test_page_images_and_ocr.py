"""Page images for models that read images but not PDFs, and the DeepSeek-OCR mode."""

from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import dataclass
from typing import Any
from unittest import mock

from pdf_agent.server.constants import OCR_FREE_PROMPT, OCR_PARSER
from pdf_agent.server.errors import HttpError
from pdf_agent.server.generation_parsing import _parse_ocr_page, clean_ocr_text
from pdf_agent.server.model_gateway import (
    _deepseek_chat_options,
    provider_model_reads_images,
    responses_payload_to_anthropic_messages,
    responses_payload_to_chat_completions,
)
from pdf_agent.server.payload_builders import (
    _build_lesson_plan_payload,
    _build_ocr_payload,
    _build_teaching_generation_payload,
    _build_transcription_payload,
    _page_images,
)
from pdf_agent.server.teaching_gateway import TeachingGenerationGateway

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
GARBLED = "Least Squares Loss function\nSquared Loss:\nLoss(z) = 9 ! :"


def _provider(**overrides: Any) -> dict[str, Any]:
    provider = {"id": "deepseek", "name": "DeepSeek", "type": "openai-chat-completions", "apiHost": "https://api.deepseek.com", "enabled": True, "models": ["deepseek-flash", "deepseek-v4-pro"], "apiFeatures": {}}
    provider.update(overrides)
    return provider


def _responses_payload(model: str, *, image: bool = True) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "input_text", "text": "Read the page."}]
    if image:
        content.append({"type": "input_image", "image_url": PNG})
    content.append({"type": "input_text", "text": "What is Loss(z)?"})
    return {"model": model, "instructions": "You teach.", "input": [{"role": "user", "content": content}], "reasoning": {"effort": "none"}}


class ImageCapabilityTest(unittest.TestCase):

    def test_known_vision_models_and_flags(self) -> None:
        provider = _provider()
        self.assertTrue(provider_model_reads_images(provider, "deepseek-flash"))
        self.assertFalse(provider_model_reads_images(provider, "deepseek-v4-pro"))
        self.assertTrue(provider_model_reads_images(_provider(id="silicon", models=["deepseek-ai/DeepSeek-OCR"]), "deepseek-ai/DeepSeek-OCR"))
        self.assertTrue(provider_model_reads_images(_provider(apiFeatures={"visionModels": ["v4-pro"]}), "deepseek-v4-pro"))
        self.assertFalse(provider_model_reads_images(_provider(apiFeatures={"models": {"deepseek-flash": {"imageInput": False}}}), "deepseek-flash"))
        self.assertTrue(provider_model_reads_images(_provider(apiFeatures={"imageInput": True}), "mystery-model"))
        self.assertFalse(provider_model_reads_images(None, "deepseek-flash"))


class ChatCompletionsImageTest(unittest.TestCase):

    def test_flash_gets_a_multimodal_content_array(self) -> None:
        chat = responses_payload_to_chat_completions(_responses_payload("deepseek-flash"), provider=_provider())
        user = chat["messages"][-1]
        self.assertEqual(chat["messages"][0], {"role": "system", "content": "You teach."})
        self.assertEqual([part["type"] for part in user["content"]], ["text", "image_url", "text"])
        self.assertEqual(user["content"][1]["image_url"]["url"], PNG)
        self.assertEqual(chat["thinking"], {"type": "disabled"})

    def test_v4_pro_keeps_the_flat_text_and_a_note(self) -> None:
        chat = responses_payload_to_chat_completions(_responses_payload("deepseek-v4-pro"), provider=_provider())
        user = chat["messages"][-1]
        self.assertIsInstance(user["content"], str)
        self.assertIn("[Attached image omitted", user["content"])

    def test_text_only_requests_stay_strings_even_for_flash(self) -> None:
        chat = responses_payload_to_chat_completions(_responses_payload("deepseek-flash", image=False), provider=_provider())
        self.assertIsInstance(chat["messages"][-1]["content"], str)

    def test_flash_thinking_is_only_switched_off_for_effort_none(self) -> None:
        self.assertEqual(_deepseek_chat_options({"reasoning": {"effort": "none"}}, "deepseek-flash"), {"thinking": {"type": "disabled"}})
        self.assertEqual(_deepseek_chat_options({"reasoning": {"effort": "low"}}, "deepseek-flash"), {})

    def test_anthropic_messages_get_image_blocks_for_vision_models(self) -> None:
        provider = _provider(id="anthropic", type="anthropic-messages", models=["claude-sonnet-4-5"])
        message = responses_payload_to_anthropic_messages(_responses_payload("claude-sonnet-4-5"), provider=provider)
        blocks = message["messages"][0]["content"]
        self.assertEqual([block["type"] for block in blocks], ["text", "image", "text"])
        self.assertEqual(blocks[1]["source"]["media_type"], "image/png")
        self.assertEqual(message["system"], "You teach.")
        plain = responses_payload_to_anthropic_messages(_responses_payload("claude-sonnet-4-5"))
        self.assertIsInstance(plain["messages"][0]["content"], str)


class PageImagePayloadTest(unittest.TestCase):

    def test_page_images_are_validated_and_filtered(self) -> None:
        body = {"pageImages": [
            {"page_no": 2, "data_url": PNG},
            {"page_no": 3, "data_url": "data:application/pdf;base64,AAAA"},
            {"page_no": 0, "data_url": PNG},
            {"page_no": 2, "data_url": PNG},
            {"page_no": 5, "data_url": PNG},
        ]}
        self.assertEqual(list(_page_images(body)), [2, 5])
        self.assertEqual(list(_page_images(body, page_numbers=[5])), [5])

    def test_teaching_payload_attaches_the_target_page_image(self) -> None:
        body = {
            "outputLanguage": "zh-CN",
            "document": {"id": "doc", "title": "Lecture 4", "page_count": 28},
            "page": {"page_no": 15, "source": {"pdf_page_ref": "#page=15", "text_md": GARBLED, "text_garbled": True}},
            "pageImages": [{"page_no": 15, "data_url": PNG}, {"page_no": 16, "data_url": PNG}],
        }
        payload = _build_teaching_generation_payload(body, default_model="deepseek-flash")
        content = payload["input"][0]["content"]
        self.assertEqual([part["type"] for part in content], ["input_image", "input_text"])
        prompt = content[-1]["text"]
        self.assertIn("Attached page images: 15", prompt)
        self.assertIn("A rendering of the page is attached as an image", prompt)

    def test_plan_payload_attaches_page_images_for_flagged_pages(self) -> None:
        body = {
            "outputLanguage": "zh-CN",
            "document": {"id": "doc", "title": "Lecture 4", "page_count": 3},
            "pageCount": 3,
            "pages": [{"page_no": 1, "text_md": "cover"}, {"page_no": 2, "text_md": GARBLED, "garbled": True}, {"page_no": 3, "text_md": "end"}],
            "pageImages": [{"page_no": 2, "data_url": PNG}],
            "attachPages": [2],
        }
        payload = _build_lesson_plan_payload(body, default_model="deepseek-flash")
        content = payload["input"][0]["content"]
        self.assertEqual([part["type"] for part in content], ["input_image", "input_text"])
        self.assertIn("Attached page images: 2.", content[-1]["text"])
        self.assertIn("--- p2 ---\n(text layer unreadable; read the attached page image)", content[-1]["text"])

    def test_transcription_payload_prefers_page_images(self) -> None:
        body = {
            "document": {"id": "doc", "title": "Lecture 4", "page_count": 28},
            "pages": [{"page_no": 21, "text_md": "noise"}, {"page_no": 15, "text_md": GARBLED}],
            "pageImages": [{"page_no": 15, "data_url": PNG}, {"page_no": 21, "data_url": PNG}],
            "reasoningEffort": "none",
        }
        payload = _build_transcription_payload(body, default_model="deepseek-flash")
        content = payload["input"][0]["content"]
        self.assertEqual([part["type"] for part in content], ["input_image", "input_image", "input_text"])
        self.assertIn("Attached page images: 15, 21", content[-1]["text"])
        self.assertEqual(payload["reasoning"], {"effort": "none"})


class OcrTest(unittest.TestCase):

    def test_ocr_payload_is_one_image_and_the_sdk_prompt(self) -> None:
        body = {"model": "deepseek-ai/DeepSeek-OCR", "pages": [{"page_no": 15}], "pageImages": [{"page_no": 15, "data_url": PNG}]}
        payload = _build_ocr_payload(body, default_model="x")
        content = payload["input"][0]["content"]
        self.assertEqual(content[0], {"type": "input_image", "image_url": PNG})
        self.assertEqual(content[1], {"type": "input_text", "text": OCR_FREE_PROMPT})
        self.assertEqual(payload["instructions"], "")
        self.assertEqual(payload["max_output_tokens"], 4000)
        with self.assertRaises(HttpError) as raised:
            _build_ocr_payload({"pages": [{"page_no": 1}, {"page_no": 2}], "pageImages": [{"page_no": 1, "data_url": PNG}, {"page_no": 2, "data_url": PNG}]}, default_model="x")
        self.assertEqual(raised.exception.code, "ocr_needs_page_image")

    def test_grounding_markup_is_stripped(self) -> None:
        raw = "<|ref|>Least Squares<|/ref|><|det|>[[10, 20, 300, 40]]<|/det|>\n\n\n\nLoss(z) = z^2/2"
        self.assertEqual(clean_ocr_text(raw), "Least Squares\n\nLoss(z) = z^2/2")
        page = _parse_ocr_page(raw, 15)
        self.assertEqual(page["parser"], OCR_PARSER)
        self.assertTrue(page["ocr_used"])
        self.assertFalse(page["unreadable"])
        self.assertTrue(_parse_ocr_page("   ", 15)["unreadable"])


@dataclass
class _FakeAuth:
    upstream_base_url: str = "https://chatgpt.com/backend-api/codex/"
    account_id: str = "test-account-id"
    headers: dict[str, str] | None = None

    def __post_init__(self) -> None:
        if self.headers is None:
            self.headers = {"Authorization": "Bearer sk-test"}


async def _fake_auth(*_args: object, **_kwargs: object) -> _FakeAuth:
    return _FakeAuth()


def _sse(text: str) -> str:
    return (
        "event: response.output_text.done\n"
        f"data: {json.dumps({'type': 'response.output_text.done', 'text': text}, ensure_ascii=False)}\n\n"
        "event: response.completed\n"
        'data: {"type": "response.completed", "response": {"usage": {"input_tokens": 10, "output_tokens": 5}}}\n\n'
    )


class OcrGatewayTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = TeachingGenerationGateway(manager=mock.MagicMock(), timeout_seconds=30.0)  # type: ignore[arg-type]
        self.auth_patcher = mock.patch("pdf_agent.server.teaching_gateway.build_chatgpt_codex_auth", side_effect=_fake_auth)
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.gateway.close()

    def test_ocr_reads_each_page_image_and_marks_the_rest_unreadable(self) -> None:
        payloads: list[dict[str, Any]] = []

        def _upstream(url: str, payload: dict[str, Any], headers: dict[str, str], **kwargs: Any) -> tuple[str, str]:
            payloads.append(payload)
            return _sse("<|ref|>Squared Loss<|/ref|><|det|>[[1,2,3,4]]<|/det|>\n$$\\mathrm{Loss}(z)=\\frac{z^2}{2}$$"), "text/event-stream"

        body = {
            "mode": "ocr",
            "model": "gpt-6-astra",
            "document": {"id": "doc", "title": "Lecture 4", "page_count": 28},
            "pages": [{"page_no": 15, "text_md": GARBLED}, {"page_no": 16, "text_md": "no image"}],
            "pageImages": [{"page_no": 15, "data_url": PNG}],
        }
        with mock.patch("pdf_agent.server.teaching_gateway.post_json_responses", side_effect=_upstream):
            result = asyncio.run(self.gateway.generate_transcription(body))
        self.assertEqual(len(payloads), 1)
        content = payloads[0]["input"][0]["content"]
        self.assertEqual(content[0]["type"], "input_image")
        self.assertEqual(content[1]["text"], OCR_FREE_PROMPT)
        rows = {row["page_no"]: row for row in result["pages"]}
        self.assertEqual(rows[15]["parser"], OCR_PARSER)
        self.assertIn("\\frac{z^2}{2}", rows[15]["text_md"])
        self.assertNotIn("<|det|>", rows[15]["text_md"])
        self.assertTrue(rows[16]["unreadable"])
        self.assertIn("timing", result)

    def test_ocr_without_images_is_a_bad_request(self) -> None:
        with self.assertRaises(HttpError) as raised:
            asyncio.run(self.gateway.generate_transcription({"mode": "ocr", "pages": [{"page_no": 1}]}))
        self.assertEqual(raised.exception.code, "ocr_needs_page_image")


if __name__ == "__main__":
    unittest.main()
