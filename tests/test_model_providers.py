from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from pdf_agent.server.agent_gateway import AgentChatGateway
from pdf_agent.server.model_config import ModelConfigStore
from pdf_agent.server.model_gateway import provider_api_url, responses_payload_to_chat_completions


def _runner(coro: Any) -> Any:
    return asyncio.run(coro)


class ModelProviderConfigTest(unittest.TestCase):
    def test_save_preserves_existing_api_key_when_public_config_omits_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ModelConfigStore(Path(tmp) / "models.json")
            public = store.save(
                {
                    "selectedProviderId": "deepseek",
                    "providers": [
                        {
                            "id": "deepseek",
                            "name": "DeepSeek",
                            "type": "openai-compatible",
                            "apiHost": "https://api.deepseek.com",
                            "apiKey": "sk-secret",
                            "apiKeyRequired": True,
                            "enabled": True,
                            "models": ["deepseek-chat"],
                        }
                    ],
                    "defaults": {"assistant": {"providerId": "deepseek", "model": "deepseek-chat"}},
                }
            )
            self.assertTrue(public["providers"][0]["hasApiKey"])
            self.assertNotIn("apiKey", public["providers"][0])

            store.save(
                {
                    **public,
                    "providers": [{**public["providers"][0], "models": ["deepseek-reasoner"]}],
                }
            )

            private = store.load_private()
            self.assertEqual(private["providers"][0]["apiKey"], "sk-secret")
            self.assertEqual(private["providers"][0]["models"], ["deepseek-reasoner"])


class ModelProviderGatewayTest(unittest.TestCase):
    def test_provider_api_url_appends_v1_when_host_is_bare_origin(self) -> None:
        self.assertEqual(
            provider_api_url({"type": "openai-compatible", "apiHost": "https://api.deepseek.com"}, "chat/completions"),
            "https://api.deepseek.com/v1/chat/completions",
        )
        self.assertEqual(
            provider_api_url({"type": "openai-compatible", "apiHost": "https://openrouter.ai/api/v1"}, "models"),
            "https://openrouter.ai/api/v1/models",
        )

    def test_responses_payload_converts_to_chat_completion_messages(self) -> None:
        payload = responses_payload_to_chat_completions(
            {
                "model": "deepseek-chat",
                "instructions": "System rules",
                "input": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "Explain page 1"},
                            {"type": "input_file", "filename": "course.pdf"},
                        ],
                    }
                ],
            }
        )

        self.assertEqual(payload["model"], "deepseek-chat")
        self.assertEqual(payload["messages"][0], {"role": "system", "content": "System rules"})
        self.assertIn("Explain page 1", payload["messages"][1]["content"])
        self.assertIn("course.pdf", payload["messages"][1]["content"])

    def test_agent_gateway_posts_to_openai_compatible_chat_completions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ModelConfigStore(Path(tmp) / "models.json")
            store.save(
                {
                    "selectedProviderId": "deepseek",
                    "providers": [
                        {
                            "id": "deepseek",
                            "name": "DeepSeek",
                            "type": "openai-compatible",
                            "apiHost": "https://api.deepseek.com",
                            "apiKey": "sk-secret",
                            "apiKeyRequired": True,
                            "enabled": True,
                            "models": ["deepseek-chat"],
                        }
                    ],
                    "defaults": {"assistant": {"providerId": "deepseek", "model": "deepseek-chat"}},
                }
            )
            calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

            def _fake_post(url: str, payload: dict[str, Any], headers: dict[str, str], **_kwargs: Any) -> tuple[str, str]:
                calls.append((url, payload, headers))
                return json.dumps({"choices": [{"message": {"content": "hello from deepseek"}}]}), "application/json"

            gateway = AgentChatGateway(manager=mock.MagicMock(), config_store=store)
            with mock.patch("pdf_agent.server.agent_gateway.post_json_responses", side_effect=_fake_post):
                result = _runner(gateway.chat({"input": "hello", "modelProviderId": "deepseek", "model": "deepseek-chat"}))

            self.assertEqual(result["message"]["content"], "hello from deepseek")
            self.assertEqual(calls[0][0], "https://api.deepseek.com/v1/chat/completions")
            self.assertEqual(calls[0][1]["messages"][0]["role"], "system")
            self.assertEqual(calls[0][2]["Authorization"], "Bearer sk-secret")
