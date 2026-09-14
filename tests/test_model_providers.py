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
from pdf_agent.server.model_config import (
    ModelConfigStore,
    default_model_config,
    normalize_model_config,
)
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


class CoproxyProviderPresetTest(unittest.TestCase):
    def test_default_config_includes_coproxy_responses_preset(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=False):
            for name in ("PDF_AGENT_COPROXY_API_KEY", "COPROXY_API_KEY", "COPROXY_TOKEN"):
                import os

                os.environ.pop(name, None)
            config = default_model_config()
        coproxy = next(provider for provider in config["providers"] if provider["id"] == "coproxy")
        self.assertEqual(coproxy["type"], "openai-responses")
        self.assertEqual(coproxy["defaultChatEndpoint"], "openai-responses")
        self.assertTrue(coproxy["apiHost"].endswith("/v1"))
        self.assertIn("gpt-6-astra", coproxy["models"])
        self.assertTrue(coproxy["apiKeyRequired"])
        self.assertFalse(coproxy["enabled"], "must stay disabled without a key")
        self.assertNotIn("apiKey", coproxy)
        # Prompt caching is advertised as a provider capability so the
        # document prefix is not re-uploaded with every per-page request.
        self.assertTrue(coproxy["apiFeatures"]["promptCache"])

    def test_environment_key_enables_coproxy_and_is_reported_as_present(self) -> None:
        with mock.patch.dict("os.environ", {"COPROXY_API_KEY": "env-secret"}):
            config = normalize_model_config(None)
            coproxy = next(provider for provider in config["providers"] if provider["id"] == "coproxy")
            self.assertTrue(coproxy["enabled"])
            self.assertEqual(coproxy["apiKey"], "")
            from pdf_agent.server.model_config import (
                provider_api_key,
                public_model_config,
            )

            self.assertEqual(provider_api_key(coproxy), "env-secret")
            public = public_model_config(config)
            public_coproxy = next(provider for provider in public["providers"] if provider["id"] == "coproxy")
            self.assertTrue(public_coproxy["hasApiKey"])
            self.assertNotIn("apiKey", public_coproxy)

    def test_stored_provider_inherits_new_preset_capability_flags(self) -> None:
        # A config written before a capability existed must still pick it up,
        # while an explicit user override keeps winning.
        config = normalize_model_config(
            {
                "selectedProviderId": "coproxy",
                "providers": [
                    {
                        "id": "coproxy",
                        "apiKey": "stored-secret",
                        "enabled": True,
                        "apiFeatures": {"pdfInputFile": False},
                    }
                ],
            }
        )
        coproxy = next(provider for provider in config["providers"] if provider["id"] == "coproxy")
        self.assertTrue(coproxy["apiFeatures"]["promptCache"])
        self.assertFalse(coproxy["apiFeatures"]["pdfInputFile"])

    def test_stored_key_survives_public_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = ModelConfigStore(Path(tmp) / "models.json")
            public = store.save(
                {
                    "selectedProviderId": "coproxy",
                    "providers": [{"id": "coproxy", "apiKey": "stored-secret", "enabled": True}],
                    "defaults": {"teachingQuality": {"providerId": "coproxy", "model": "gpt-6-astra"}},
                }
            )
            self.assertEqual(public["selectedProviderId"], "coproxy")
            self.assertEqual(public["defaults"]["teachingQuality"], {"providerId": "coproxy", "model": "gpt-6-astra"})
            store.save({**public, "providers": [{**next(p for p in public["providers"] if p["id"] == "coproxy"), "models": ["gpt-6-astra"]}]})
            private = store.load_private()
            coproxy = next(provider for provider in private["providers"] if provider["id"] == "coproxy")
            self.assertEqual(coproxy["apiKey"], "stored-secret")
            self.assertEqual(coproxy["type"], "openai-responses")


class ReasoningEffortClampTest(unittest.TestCase):
    def test_supported_efforts_by_model_family(self) -> None:
        from pdf_agent.server.model_gateway import supported_reasoning_efforts

        self.assertEqual(supported_reasoning_efforts("gpt-6-astra"), ["low", "medium", "high", "xhigh", "max"])
        self.assertEqual(supported_reasoning_efforts("gpt-5.5"), ["none", "low", "medium", "high", "xhigh"])
        self.assertEqual(supported_reasoning_efforts("gemini-3.8-flash"), ["low", "medium", "high"])
        self.assertEqual(supported_reasoning_efforts("some-unknown-model"), [])

    def test_clamp_rewrites_unsupported_effort_to_nearest(self) -> None:
        from pdf_agent.server.model_gateway import clamp_reasoning_effort_for_model

        self.assertEqual(clamp_reasoning_effort_for_model({"model": "gpt-6-astra", "reasoning": {"effort": "none"}})["reasoning"]["effort"], "low")
        self.assertEqual(clamp_reasoning_effort_for_model({"model": "gpt-5.5", "reasoning": {"effort": "max"}})["reasoning"]["effort"], "xhigh")
        self.assertEqual(clamp_reasoning_effort_for_model({"model": "gemini-3.8-flash", "reasoning": {"effort": "xhigh"}})["reasoning"]["effort"], "high")
        self.assertEqual(clamp_reasoning_effort_for_model({"model": "gpt-6-astra", "reasoning": {"effort": "high", "summary": "auto"}})["reasoning"], {"effort": "high", "summary": "auto"})
        self.assertEqual(clamp_reasoning_effort_for_model({"model": "mystery", "reasoning": {"effort": "none"}})["reasoning"]["effort"], "none")
        self.assertNotIn("reasoning", clamp_reasoning_effort_for_model({"model": "gpt-6-astra"}))

    def test_gateway_retries_once_with_effort_from_upstream_error(self) -> None:
        from pdf_agent.server.model_gateway import post_responses_payload_for_body

        calls: list[dict[str, Any]] = []

        async def fake_post(url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[str, str]:
            calls.append(payload)
            if payload["reasoning"]["effort"] == "xhigh":
                raise HttpError(
                    400,
                    "Unsupported value: 'xhigh' is not supported with the 'mystery-model' model. Supported values are: 'low', 'medium', and 'high'.",
                    code="upstream_error",
                )
            return json.dumps({"output": [{"type": "message", "content": [{"type": "output_text", "text": "OK"}]}]}), "application/json"

        with mock.patch.dict("os.environ", {"COPROXY_API_KEY": "env-secret"}):
            result = _runner(
                post_responses_payload_for_body(
                    manager=mock.MagicMock(),
                    config_store=None,
                    body={"modelProviderId": "coproxy", "model": "mystery-model"},
                    default_key="teachingQuality",
                    legacy_model="gpt-5.5",
                    responses_payload={"model": "mystery-model", "input": "hi", "reasoning": {"effort": "xhigh"}},
                    post_with_retries=fake_post,
                    codex_include_reasoning_encrypted_content=False,
                )
            )
        self.assertEqual([call["reasoning"]["effort"] for call in calls], ["xhigh", "high"])
        self.assertEqual(calls[0]["store"], False)
        self.assertEqual(result.provider_id, "coproxy")
        self.assertTrue(result.payload.get("_synchropage_reasoning_effort_fallback"))
        self.assertEqual(extract_provider_text(result.text, result.content_type), "OK")

    def test_gateway_sends_bearer_key_from_environment(self) -> None:
        from pdf_agent.server.model_gateway import post_responses_payload_for_body

        seen: dict[str, Any] = {}

        async def fake_post(url: str, payload: dict[str, Any], headers: dict[str, str]) -> tuple[str, str]:
            seen["url"] = url
            seen["headers"] = headers
            seen["payload"] = payload
            return json.dumps({"output": [{"type": "message", "content": [{"type": "output_text", "text": "OK"}]}]}), "application/json"

        with mock.patch.dict("os.environ", {"COPROXY_API_KEY": "env-secret"}):
            _runner(
                post_responses_payload_for_body(
                    manager=mock.MagicMock(),
                    config_store=None,
                    body={"modelProviderId": "coproxy", "model": "gpt-6-astra", "reasoningEffort": "none"},
                    default_key="teachingQuality",
                    legacy_model="gpt-5.5",
                    responses_payload={"model": "gpt-6-astra", "input": "hi", "reasoning": {"effort": "none"}, "prompt_cache_key": "k"},
                    post_with_retries=fake_post,
                    codex_include_reasoning_encrypted_content=False,
                )
            )
        self.assertTrue(seen["url"].startswith("https://us.taohuang.info/v1/responses"))
        self.assertEqual(seen["headers"], {"Authorization": "Bearer env-secret"})
        self.assertEqual(seen["payload"]["reasoning"]["effort"], "low")
        # coproxy advertises apiFeatures.promptCache, so the cache fields stay
        # on the payload (the 400/422 strip-and-retry fallback still covers a
        # gateway that changes its mind).
        self.assertEqual(seen["payload"]["prompt_cache_key"], "k")
        # Long-PDF stability: responses are streamed and output-bounded.
        self.assertTrue(seen["payload"]["stream"])
        self.assertEqual(seen["payload"]["max_output_tokens"], 16000)

    def test_prompt_cache_fields_are_stripped_for_providers_without_the_capability(self) -> None:
        from pdf_agent.server.model_gateway import _strip_nonportable_responses_fields

        payload = {
            "model": "gpt-6-astra",
            "input": "hi",
            "reasoning": {"effort": "high"},
            "prompt_cache_key": "k",
            "prompt_cache_retention": "24h",
            "include": ["reasoning.encrypted_content"],
        }
        without_capability = _strip_nonportable_responses_fields(payload, provider={"id": "other"})
        self.assertNotIn("prompt_cache_key", without_capability)
        self.assertNotIn("prompt_cache_retention", without_capability)
        self.assertNotIn("include", without_capability)
        self.assertTrue(without_capability["stream"])
        self.assertFalse(without_capability["store"])
        self.assertEqual(without_capability["max_output_tokens"], 24000)

        with_capability = _strip_nonportable_responses_fields(
            payload, provider={"id": "coproxy", "apiFeatures": {"promptCache": True}}
        )
        self.assertEqual(with_capability["prompt_cache_key"], "k")
        self.assertEqual(with_capability["prompt_cache_retention"], "24h")

        # An explicit budget (e.g. a batch budget set by the teaching gateway)
        # is never overwritten.
        preset = _strip_nonportable_responses_fields(
            {**payload, "max_output_tokens": 48000}, provider=None
        )
        self.assertEqual(preset["max_output_tokens"], 48000)
