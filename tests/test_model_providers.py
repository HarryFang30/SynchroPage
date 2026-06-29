from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from pdf_agent.server.agent_gateway import AgentChatGateway
from pdf_agent.server.errors import HttpError
from pdf_agent.server.model_config import ModelConfigStore, default_model_config, normalize_model_config
from pdf_agent.server.model_gateway import (
    check_provider_model,
    extract_provider_text,
    provider_api_url,
    responses_payload_to_anthropic_messages,
    responses_payload_to_chat_completions,
    responses_payload_to_gemini_generate_content,
    responses_payload_to_ollama_chat,
)


def _runner(coro: Any) -> Any:
    return asyncio.run(coro)


class ModelProviderConfigTest(unittest.TestCase):
    def test_default_config_includes_cherry_catalog_providers(self) -> None:
        config = default_model_config()
        provider_ids = {provider["id"] for provider in config["providers"]}

        self.assertIn("openai", provider_ids)
        self.assertIn("anthropic", provider_ids)
        self.assertIn("gemini", provider_ids)
        self.assertIn("ollama", provider_ids)
        self.assertEqual(config["catalog"]["source"], "cherry-studio")

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
            self.assertEqual(private["providers"][0]["models"][0], "deepseek-reasoner")
            self.assertIn("deepseek-chat", private["providers"][0]["models"])

    def test_legacy_provider_ids_merge_into_cherry_catalog_ids(self) -> None:
        config = normalize_model_config(
            {
                "selectedProviderId": "openai_api",
                "providers": [
                    {
                        "id": "openai_api",
                        "name": "OpenAI API Key",
                        "type": "openai-responses",
                        "apiHost": "https://api.openai.com/v1",
                        "apiKey": "sk-openai",
                        "enabled": True,
                        "models": ["gpt-4.1-mini"],
                    },
                    {
                        "id": "siliconflow",
                        "name": "SiliconFlow",
                        "type": "openai-compatible",
                        "apiHost": "https://api.siliconflow.cn/v1",
                        "models": ["Qwen/Qwen2.5-72B-Instruct"],
                    },
                    {
                        "id": "ollama",
                        "name": "Ollama",
                        "type": "openai-compatible",
                        "apiHost": "http://127.0.0.1:11434/v1",
                        "models": ["llama3.1"],
                    },
                ],
                "defaults": {"assistant": {"providerId": "openai_api", "model": "gpt-4.1-mini"}},
            }
        )

        provider_ids = {provider["id"] for provider in config["providers"]}
        self.assertIn("openai", provider_ids)
        self.assertIn("silicon", provider_ids)
        self.assertNotIn("openai_api", provider_ids)
        self.assertNotIn("siliconflow", provider_ids)
        self.assertEqual(config["selectedProviderId"], "openai")
        self.assertEqual(config["defaults"]["assistant"], {"providerId": "openai", "model": "gpt-4.1-mini"})
        openai = next(provider for provider in config["providers"] if provider["id"] == "openai")
        silicon = next(provider for provider in config["providers"] if provider["id"] == "silicon")
        ollama = next(provider for provider in config["providers"] if provider["id"] == "ollama")
        self.assertEqual(openai["name"], "OpenAI")
        self.assertEqual(openai["apiKey"], "sk-openai")
        self.assertTrue(openai["enabled"])
        self.assertIn("Qwen/Qwen2.5-72B-Instruct", silicon["models"])
        self.assertEqual(ollama["type"], "ollama-chat")
        self.assertEqual(ollama["defaultChatEndpoint"], "ollama-chat")


class ModelProviderGatewayTest(unittest.TestCase):
    def test_provider_api_url_uses_deepseek_official_chat_path(self) -> None:
        self.assertEqual(
            provider_api_url({"type": "openai-compatible", "apiHost": "https://api.deepseek.com"}, "chat/completions"),
            "https://api.deepseek.com/chat/completions",
        )
        self.assertEqual(
            provider_api_url({"type": "openai-compatible", "apiHost": "https://api.deepseek.com/v1"}, "models"),
            "https://api.deepseek.com/v1/models",
        )

    def test_provider_api_url_appends_v1_for_generic_bare_origin(self) -> None:
        self.assertEqual(
            provider_api_url({"type": "openai-compatible", "apiHost": "https://api.example.com"}, "chat/completions"),
            "https://api.example.com/v1/chat/completions",
        )
        self.assertEqual(
            provider_api_url({"id": "deepseek", "type": "openai-compatible", "apiHost": "https://proxy.example.com"}, "chat/completions"),
            "https://proxy.example.com/v1/chat/completions",
        )
        self.assertEqual(
            provider_api_url({"type": "openai-compatible", "apiHost": "https://openrouter.ai/api/v1"}, "models"),
            "https://openrouter.ai/api/v1/models",
        )

    def test_provider_api_url_formats_native_endpoint_types(self) -> None:
        self.assertEqual(
            provider_api_url(
                {"type": "anthropic-messages", "defaultChatEndpoint": "anthropic-messages", "apiHost": "https://api.anthropic.com"},
                "messages",
            ),
            "https://api.anthropic.com/v1/messages",
        )
        self.assertEqual(
            provider_api_url(
                {"type": "google-generate-content", "defaultChatEndpoint": "google-generate-content", "apiHost": "https://generativelanguage.googleapis.com"},
                "models/gemini-2.5-flash:generateContent",
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        )
        self.assertEqual(
            provider_api_url(
                {"type": "ollama-chat", "defaultChatEndpoint": "ollama-chat", "apiHost": "http://127.0.0.1:11434"},
                "chat",
            ),
            "http://127.0.0.1:11434/api/chat",
        )
        self.assertEqual(
            provider_api_url(
                {"type": "openai-chat-completions", "defaultChatEndpoint": "ollama-chat", "apiHost": "http://127.0.0.1:11434/v1"},
                "chat",
            ),
            "http://127.0.0.1:11434/api/chat",
        )

    def test_provider_api_url_rejects_blocked_api_hosts(self) -> None:
        with self.assertRaises(HttpError) as ctx:
            provider_api_url({"type": "openai-compatible", "apiHost": "file:///tmp/socket"}, "models")
        self.assertEqual(ctx.exception.code, "model_api_host_invalid")

        with self.assertRaises(HttpError) as ctx:
            provider_api_url({"type": "openai-compatible", "apiHost": "http://169.254.169.254"}, "models")
        self.assertEqual(ctx.exception.code, "model_api_host_blocked")

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

    def test_responses_payload_converts_to_native_provider_payloads(self) -> None:
        source = {
            "model": "claude-sonnet-4-5",
            "instructions": "System rules",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "Say OK"}]}],
        }

        anthropic = responses_payload_to_anthropic_messages(source)
        self.assertEqual(anthropic["system"], "System rules")
        self.assertEqual(anthropic["messages"][0]["content"], "Say OK")
        self.assertEqual(anthropic["max_tokens"], 4096)

        gemini = responses_payload_to_gemini_generate_content({**source, "model": "gemini-2.5-flash"})
        self.assertEqual(gemini["systemInstruction"]["parts"][0]["text"], "System rules")
        self.assertEqual(gemini["contents"][0]["parts"][0]["text"], "Say OK")

        ollama = responses_payload_to_ollama_chat({**source, "model": "llama3.1"})
        self.assertEqual(ollama["model"], "llama3.1")
        self.assertEqual(ollama["messages"][0]["role"], "system")

    def test_extract_provider_text_supports_native_provider_shapes(self) -> None:
        self.assertEqual(
            extract_provider_text(json.dumps({"content": [{"type": "text", "text": "hello anthropic"}]}), "application/json"),
            "hello anthropic",
        )
        self.assertEqual(
            extract_provider_text(
                json.dumps({"candidates": [{"content": {"parts": [{"text": "hello gemini"}]}}]}),
                "application/json",
            ),
            "hello gemini",
        )
        self.assertEqual(
            extract_provider_text(json.dumps({"message": {"content": "hello ollama"}}), "application/json"),
            "hello ollama",
        )

    def test_deepseek_v4_chat_completion_uses_thinking_options(self) -> None:
        payload = responses_payload_to_chat_completions(
            {
                "model": "deepseek-v4-pro",
                "instructions": "System rules",
                "input": "Explain page 1",
                "reasoning": {"effort": "xhigh"},
            },
            provider={"id": "deepseek", "apiHost": "https://api.deepseek.com"},
        )

        self.assertEqual(payload["thinking"], {"type": "enabled"})
        self.assertEqual(payload["reasoning_effort"], "max")

    def test_deepseek_chat_disables_thinking_options(self) -> None:
        payload = responses_payload_to_chat_completions(
            {
                "model": "deepseek-chat",
                "input": "hello",
                "reasoning": {"effort": "high"},
            },
            provider={"id": "deepseek", "apiHost": "https://api.deepseek.com"},
        )

        self.assertEqual(payload["thinking"], {"type": "disabled"})
        self.assertNotIn("reasoning_effort", payload)

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
            self.assertEqual(calls[0][0], "https://api.deepseek.com/chat/completions")
            self.assertEqual(calls[0][1]["messages"][0]["role"], "system")
            self.assertEqual(calls[0][2]["Authorization"], "Bearer sk-secret")

    def test_agent_gateway_posts_to_anthropic_messages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ModelConfigStore(Path(tmp) / "models.json")
            store.save(
                {
                    "selectedProviderId": "anthropic",
                    "providers": [
                        {
                            "id": "anthropic",
                            "name": "Anthropic",
                            "type": "anthropic-messages",
                            "defaultChatEndpoint": "anthropic-messages",
                            "apiHost": "https://api.anthropic.com",
                            "apiKey": "sk-ant",
                            "apiKeyRequired": True,
                            "enabled": True,
                            "models": ["claude-sonnet-4-5"],
                        }
                    ],
                    "defaults": {"assistant": {"providerId": "anthropic", "model": "claude-sonnet-4-5"}},
                }
            )
            calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

            def _fake_post(url: str, payload: dict[str, Any], headers: dict[str, str], **_kwargs: Any) -> tuple[str, str]:
                calls.append((url, payload, headers))
                return json.dumps({"content": [{"type": "text", "text": "hello from claude"}]}), "application/json"

            gateway = AgentChatGateway(manager=mock.MagicMock(), config_store=store)
            with mock.patch("pdf_agent.server.agent_gateway.post_json_responses", side_effect=_fake_post):
                result = _runner(gateway.chat({"input": "hello", "modelProviderId": "anthropic", "model": "claude-sonnet-4-5"}))

            self.assertEqual(result["message"]["content"], "hello from claude")
            self.assertEqual(calls[0][0], "https://api.anthropic.com/v1/messages")
            self.assertEqual(calls[0][2]["x-api-key"], "sk-ant")
            self.assertEqual(calls[0][2]["anthropic-version"], "2023-06-01")

    def test_check_provider_model_uses_gemini_generate_content(self) -> None:
        calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

        async def _fake_post(url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[str, str]:
            calls.append((url, payload, headers))
            return json.dumps({"candidates": [{"content": {"parts": [{"text": "OK"}]}}]}), "application/json"

        result = _runner(check_provider_model(
            provider_value={
                "id": "gemini",
                "name": "Gemini",
                "type": "google-generate-content",
                "defaultChatEndpoint": "google-generate-content",
                "apiHost": "https://generativelanguage.googleapis.com",
                "apiKey": "gem-key",
                "apiKeyRequired": True,
                "models": ["gemini-2.5-flash"],
            },
            model="gemini-2.5-flash",
            post_with_retries=_fake_post,
        ))

        self.assertTrue(result["ok"])
        self.assertEqual(calls[0][0], "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent")
        self.assertEqual(calls[0][2]["x-goog-api-key"], "gem-key")

    def test_check_provider_model_reuses_saved_key_for_public_provider(self) -> None:
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
            provider = next(item for item in public["providers"] if item["id"] == "deepseek")
            calls: list[tuple[str, dict[str, Any], dict[str, str]]] = []

            async def _fake_post(url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[str, str]:
                calls.append((url, payload, headers))
                return json.dumps({"choices": [{"message": {"content": "OK"}}]}), "application/json"

            result = _runner(check_provider_model(
                provider_value=provider,
                model="deepseek-chat",
                config_store=store,
                post_with_retries=_fake_post,
            ))

            self.assertTrue(result["ok"])
            self.assertNotIn("apiKey", provider)
            self.assertEqual(calls[0][2]["Authorization"], "Bearer sk-secret")
