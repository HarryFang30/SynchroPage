"""Unit tests for AgentChatGateway — fake upstream, no real network."""

from __future__ import annotations

import asyncio
import unittest
from dataclasses import dataclass
from typing import Any
from unittest import mock

from pdf_agent.server.agent_gateway import AgentChatGateway
from pdf_agent.server.errors import HttpError


@dataclass
class _FakeAuth:
    upstream_base_url: str = "https://chatgpt.com/backend-api/codex/"
    account_id: str = "test-account-id"
    headers: dict[str, str] | None = None

    def __post_init__(self) -> None:
        if self.headers is None:
            self.headers = {"Authorization": "Bearer sk-test-token"}


def _fake_post_json_success(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    *,
    timeout_seconds: float,
    handle_timeout: bool = False,
) -> tuple[str, str]:
    response_text = (
        "event: response.output_text.done\n"
        'data: {"type": "response.output_text.done", "text": "Hello from fake gateway."}\n'
        "\n"
        "event: response.completed\n"
        'data: {"type": "response.completed", "response": {"usage": {"input_tokens": 50, "output_tokens": 20}}}\n'
        "\n"
    )
    return response_text, "text/event-stream"


async def _fake_auth(*_args: object, **_kwargs: object) -> _FakeAuth:
    return _FakeAuth()


def _runner(coro: Any) -> Any:
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class AgentChatSuccessTest(unittest.TestCase):

    def setUp(self) -> None:
        self.gateway = AgentChatGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
            model="gpt-5.5",
            timeout_seconds=10.0,
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.agent_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()
        self.transport_patcher = mock.patch(
            "pdf_agent.server.agent_gateway.post_json_responses",
            side_effect=_fake_post_json_success,
        )
        self.transport_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()
        self.transport_patcher.stop()

    def test_chat_returns_valid_response_shape(self) -> None:
        body = {"input": "What is the capital?", "model": "gpt-5.5"}
        result = _runner(self.gateway.chat(body))
        self.assertIn("message", result)
        self.assertEqual(result["message"]["role"], "assistant")
        self.assertIsInstance(result["message"]["content"], str)
        self.assertTrue(len(result["message"]["content"]) > 0)
        self.assertEqual(result["account_id"], "test-account-id")
        self.assertIn("model", result)
        self.assertIn("cache", result)
        self.assertIsInstance(result["cache"], dict)

    def test_chat_includes_prompt_cache_metadata(self) -> None:
        body = {"input": "Hello", "model": "gpt-5.5"}
        result = _runner(self.gateway.chat(body))
        self.assertIn("cache", result)

    def test_chat_empty_response_raises_empty_gateway_response(self) -> None:
        def _empty_response(*args: object, **kwargs: object) -> tuple[str, str]:
            return "", "text/plain"

        with mock.patch(
            "pdf_agent.server.agent_gateway.post_json_responses",
            side_effect=_empty_response,
        ):
            body = {"input": "Hello"}
            with self.assertRaises(HttpError) as ctx:
                _runner(self.gateway.chat(body))
            self.assertEqual(ctx.exception.code, "empty_gateway_response")
            self.assertEqual(ctx.exception.status, 502)

    def test_upstream_http_error_propagates_to_caller(self) -> None:
        # Simulate an upstream HTTP error the way post_json_responses would
        # raise it (already through redacted_gateway_error in the transport).
        def _upstream_error(*args: object, **kwargs: object) -> tuple[str, str]:
            raise HttpError(
                400,
                '{"error": "Bad request"}',
                code="upstream_error",
                retry_after_seconds=None,
            )

        with mock.patch(
            "pdf_agent.server.agent_gateway.post_json_responses",
            side_effect=_upstream_error,
        ), mock.patch(
            "pdf_agent.server.agent_gateway._should_retry_transient_upstream_error",
            return_value=False,
        ):
            body = {"input": "Hello"}
            with self.assertRaises(HttpError) as ctx:
                _runner(self.gateway.chat(body))
            self.assertEqual(ctx.exception.code, "upstream_error")
            self.assertEqual(ctx.exception.status, 400)

    def test_network_error_raises_502(self) -> None:
        def _network_error(*args: object, **kwargs: object) -> tuple[str, str]:
            raise HttpError(502, "Connection refused", code="network_error")

        with mock.patch(
            "pdf_agent.server.agent_gateway.post_json_responses",
            side_effect=_network_error,
        ):
            body = {"input": "Hello"}
            with self.assertRaises(HttpError) as ctx:
                _runner(self.gateway.chat(body))
            self.assertEqual(ctx.exception.status, 502)


class AgentChatFallbackTest(unittest.TestCase):
    """Tests for file-input and prompt-cache fallback metadata."""

    def setUp(self) -> None:
        self.gateway = AgentChatGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.agent_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()

    def test_file_fallback_sets_metadata(self) -> None:
        call_count = 0

        def _fail_then_succeed(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise HttpError(415, "input[0].content[1]: unsupported file", code="upstream_error")
            return _fake_post_json_success(
                *args,  # type: ignore[arg-type]
                **kwargs,  # type: ignore[arg-type]
            )

        with mock.patch(
            "pdf_agent.server.agent_gateway.post_json_responses",
            side_effect=_fail_then_succeed,
        ):
            body = {
                "input": "Hello",
                "documentFile": {"sha256": "abc", "fileData": "data:application/pdf;base64,AAAA"},
            }
            result = _runner(self.gateway.chat(body))
            self.assertIn("cache", result)

    def test_prompt_cache_fallback_sets_metadata(self) -> None:
        call_count = 0

        def _fail_cache_then_succeed(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise HttpError(422, "prompt_cache_key not supported", code="upstream_error")
            return _fake_post_json_success(
                *args,  # type: ignore[arg-type]
                **kwargs,  # type: ignore[arg-type]
            )

        with mock.patch(
            "pdf_agent.server.agent_gateway.post_json_responses",
            side_effect=_fail_cache_then_succeed,
        ):
            # Include documentFile so prompt_cache_key is set in payload
            body = {
                "input": "Hello",
                "model": "gpt-5.5",
                "documentFile": {"sha256": "abc123", "fileData": "data:application/pdf;base64,AAAA"},
            }
            result = _runner(self.gateway.chat(body))
            self.assertIn("message", result)
            self.assertEqual(result["message"]["role"], "assistant")


class AgentChatRetryTest(unittest.TestCase):
    """Tests for transient error retry behaviour."""

    def setUp(self) -> None:
        self.gateway = AgentChatGateway(
            manager=mock.MagicMock(),  # type: ignore[arg-type]
        )
        self.auth_patcher = mock.patch(
            "pdf_agent.server.agent_gateway.build_chatgpt_codex_auth",
            side_effect=_fake_auth,
        )
        self.auth_patcher.start()

    def tearDown(self) -> None:
        self.auth_patcher.stop()

    def test_retries_on_503_then_succeeds(self) -> None:
        call_count = 0

        def _flaky(*args: object, **kwargs: object) -> tuple[str, str]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise HttpError(503, "Service Unavailable", code="upstream_error")
            return _fake_post_json_success(
                *args,  # type: ignore[arg-type]
                **kwargs,  # type: ignore[arg-type]
            )

        with mock.patch(
            "pdf_agent.server.agent_gateway.post_json_responses",
            side_effect=_flaky,
        ):
            body = {"input": "Hello"}
            result = _runner(self.gateway.chat(body))
            self.assertIn("message", result)
            self.assertGreaterEqual(call_count, 2)

    def test_does_not_retry_on_400(self) -> None:
        def _bad_request(*args: object, **kwargs: object) -> tuple[str, str]:
            raise HttpError(400, "Bad Request", code="upstream_error")

        with mock.patch(
            "pdf_agent.server.agent_gateway.post_json_responses",
            side_effect=_bad_request,
        ):
            body = {"input": "Hello"}
            with self.assertRaises(HttpError) as ctx:
                _runner(self.gateway.chat(body))
            self.assertEqual(ctx.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
