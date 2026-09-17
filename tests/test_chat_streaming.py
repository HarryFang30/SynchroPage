"""Streaming of assistant answers: the decoder, and the whole HTTP path.

The end-to-end tests run the real SynchroPage HTTP server against a real local
upstream that writes its answer piece by piece, so they fail if any layer in
between waits for the whole answer.
"""

from __future__ import annotations

import json
import socket
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest import mock

from pdf_agent.auth import OpenAIOAuthApi
from pdf_agent.server.agent_gateway import AgentChatGateway
from pdf_agent.server.model_config import ModelConfigStore
from pdf_agent.server.pdf_file_cache import PdfFileCache
from pdf_agent.server.stream_text import StreamTextDecoder
from pdf_agent.server.teaching_gateway import TeachingGenerationGateway
from pdf_agent.server.web_app import (
    AsyncRunner,
    PdfAgentHttpServer,
    PdfAgentRequestHandler,
)


def _decode(*chunks: bytes) -> tuple[StreamTextDecoder, list[str], list[str]]:
    texts: list[str] = []
    marks: list[str] = []
    decoder = StreamTextDecoder(
        on_text=texts.append,
        on_thinking=lambda: marks.append("thinking"),
        on_start=lambda: marks.append("start"),
    )
    for chunk in chunks:
        decoder.feed(chunk)
    decoder.finish()
    return decoder, texts, marks


def _sse(*events: Any) -> bytes:
    return "".join(f"data: {event if isinstance(event, str) else json.dumps(event, ensure_ascii=False)}\n\n" for event in events).encode()


class StreamTextDecoderTest(unittest.TestCase):
    def test_chat_completions_deltas_and_reasoning(self) -> None:
        decoder, texts, marks = _decode(
            _sse(
                {"choices": [{"delta": {"role": "assistant", "content": ""}}]},
                {"choices": [{"delta": {"reasoning_content": "let me think"}}]},
                {"choices": [{"delta": {"content": "岭回归"}}]},
                {"choices": [{"delta": {"content": "加了惩罚项"}, "finish_reason": None}]},
                {"choices": [], "usage": {"prompt_tokens": 9}},
                "[DONE]",
            )
        )
        self.assertEqual(texts, ["岭回归", "加了惩罚项"])
        self.assertEqual(decoder.text, "岭回归加了惩罚项")
        self.assertEqual(marks, ["start", "thinking"])
        self.assertFalse(decoder.truncated)

    def test_responses_api_deltas(self) -> None:
        decoder, texts, marks = _decode(
            b"event: response.created\n" + _sse({"type": "response.created", "response": {"status": "in_progress"}}),
            _sse({"type": "response.reasoning_summary_text.delta", "delta": "thinking"}),
            _sse({"type": "response.output_text.delta", "delta": "Hello"}, {"type": "response.output_text.delta", "delta": " there"}),
            _sse({"type": "response.output_text.done", "text": "Hello there"}, {"type": "response.completed", "response": {"status": "completed"}}),
        )
        self.assertEqual(texts, ["Hello", " there"])
        self.assertEqual(marks, ["start", "thinking"])
        self.assertIsNone(decoder.failure)

    def test_anthropic_gemini_and_ollama_streams(self) -> None:
        _, anthropic, _ = _decode(
            _sse(
                {"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "hm"}},
                {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Bonjour"}},
            )
        )
        self.assertEqual(anthropic, ["Bonjour"])
        _, gemini, _ = _decode(_sse({"candidates": [{"content": {"parts": [{"text": "Hal"}, {"text": "lo"}]}}]}))
        self.assertEqual(gemini, ["Hallo"])
        _, ollama, _ = _decode(b'{"message":{"content":"Ciao"},"done":false}\n{"message":{"content":""},"done":true}\n')
        self.assertEqual(ollama, ["Ciao"])

    def test_character_split_across_chunks_is_decoded_whole(self) -> None:
        body = _sse({"choices": [{"delta": {"content": "偏差"}}]})
        cut = body.index("偏".encode()) + 1  # in the middle of a three-byte character
        _, texts, _ = _decode(body[:cut], body[cut:])
        self.assertEqual(texts, ["偏差"])

    def test_answer_that_is_not_streamed_yields_no_delta(self) -> None:
        decoder, texts, marks = _decode(json.dumps({"choices": [{"message": {"content": "whole answer"}, "finish_reason": "stop"}]}).encode())
        self.assertEqual(texts, [])
        self.assertEqual(marks, ["start"])
        self.assertFalse(decoder.emitted)

    def test_truncation_and_midstream_failure_are_recorded(self) -> None:
        decoder, _, _ = _decode(_sse({"choices": [{"delta": {"content": "a"}, "finish_reason": "length"}]}))
        self.assertTrue(decoder.truncated)
        decoder, _, _ = _decode(_sse({"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}}))
        self.assertTrue(decoder.truncated)
        decoder, texts, _ = _decode(_sse({"type": "response.output_text.delta", "delta": "par"}, {"type": "error", "code": "api_error", "message": "quota exceeded"}))
        self.assertEqual(texts, ["par"])
        self.assertEqual(decoder.failure, {"type": "error", "code": "api_error", "message": "quota exceeded"})


class _Upstream:
    """A Chat Completions upstream whose answer the test releases piece by piece."""

    def __init__(self) -> None:
        self.payloads: list[dict[str, Any]] = []
        self.release = threading.Event()
        self.reader_left = threading.Event()
        self.status = 200
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", "0"))
                upstream.payloads.append(json.loads(self.rfile.read(length)))
                if upstream.status != 200:
                    body = json.dumps({"error": {"message": "invalid api key"}}).encode()
                    self.send_response(upstream.status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if not upstream.payloads[-1].get("stream"):
                    body = json.dumps({"choices": [{"message": {"content": "whole answer"}}]}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                try:
                    self.wfile.write(_sse({"choices": [{"delta": {"content": "第一句。"}}]}))
                    self.wfile.flush()
                    # The rest is only written once the test has seen the first piece.
                    if not upstream.release.wait(timeout=10):
                        return
                    for _ in range(200):
                        self.wfile.write(_sse({"choices": [{"delta": {"content": "第二句。"}}]}))
                        self.wfile.flush()
                        if upstream.release.wait(timeout=0) and not upstream.endless:
                            break
                        threading.Event().wait(0.02)
                    self.wfile.write(_sse({"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}}, "[DONE]"))
                except OSError:
                    upstream.reader_left.set()

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self.endless = False
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def close(self) -> None:
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


class ChatStreamingHttpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.upstream = _Upstream()
        self.tmp = tempfile.TemporaryDirectory()
        store = ModelConfigStore(Path(self.tmp.name) / "models.json")
        store.save(
            {
                "selectedProviderId": "local",
                "providers": [
                    {
                        "id": "local",
                        "name": "Local",
                        "type": "openai-compatible",
                        "apiHost": self.upstream.url,
                        "apiKey": "sk-test",
                        "enabled": True,
                        "models": ["test-model"],
                    }
                ],
                "defaults": {"assistant": {"providerId": "local", "model": "test-model"}},
            }
        )
        manager = mock.MagicMock()
        cache = PdfFileCache()
        self.server = PdfAgentHttpServer(
            ("127.0.0.1", 0),
            PdfAgentRequestHandler,
            web_root=Path(self.tmp.name),
            oauth_api=OpenAIOAuthApi(manager),
            chat_gateway=AgentChatGateway(manager, config_store=store, pdf_file_cache=cache),
            teaching_gateway=TeachingGenerationGateway(manager, config_store=store, pdf_file_cache=cache),
            model_config_store=store,
            runner=AsyncRunner(),
            pdf_file_cache=cache,
        )
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/agent/chat"

    def tearDown(self) -> None:
        self.upstream.close()
        self.server.runner.shutdown()
        self.server.teaching_gateway.close()
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def _open(self, **extra: Any) -> Any:
        body = json.dumps({"modelProviderId": "local", "model": "test-model", "input": "hello", **extra}).encode()
        request = urllib.request.Request(self.url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        return urllib.request.urlopen(request, timeout=10)

    @staticmethod
    def _next_event(response: Any) -> dict[str, Any]:
        while True:
            line = response.readline()
            if not line:
                raise AssertionError("the stream ended without the expected event")
            if line.startswith(b"data:"):
                return json.loads(line[5:])

    def test_first_words_reach_the_client_while_the_upstream_is_still_writing(self) -> None:
        with self._open(stream=True) as response:
            self.assertIn("text/event-stream", response.headers.get("Content-Type", ""))
            self.assertEqual(self._next_event(response)["type"], "start")
            # The upstream is blocked until `release`: this delta can only be
            # here if nothing on the way waited for the whole answer.
            self.assertEqual(self._next_event(response), {"type": "delta", "text": "第一句。"})
            self.assertFalse(self.upstream.release.is_set())
            self.upstream.release.set()
            events = []
            while not events or events[-1]["type"] != "done":
                events.append(self._next_event(response))
        done = events[-1]
        self.assertEqual(done["message"]["content"], "第一句。第二句。")
        self.assertEqual(done["provider_id"], "local")
        self.assertEqual(done["cache"]["usage"]["input_tokens"], 12)
        sent = self.upstream.payloads[0]
        self.assertIs(sent["stream"], True)
        self.assertEqual(sent["stream_options"], {"include_usage": True})

    def test_request_without_stream_still_gets_one_json_answer(self) -> None:
        with self._open() as response:
            self.assertIn("application/json", response.headers.get("Content-Type", ""))
            result = json.loads(response.read())
        self.assertEqual(result["message"]["content"], "whole answer")
        self.assertIs(self.upstream.payloads[0]["stream"], False)

    def test_failure_before_the_answer_starts_keeps_its_http_status(self) -> None:
        self.upstream.status = 401
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self._open(stream=True)
        self.assertEqual(raised.exception.code, 401)
        self.assertEqual(json.loads(raised.exception.read())["error"], "upstream_error")

    def test_reader_that_leaves_stops_the_upstream_request(self) -> None:
        self.upstream.endless = True
        response = self._open(stream=True)
        self.assertEqual(self._next_event(response)["type"], "start")
        self.assertEqual(self._next_event(response)["type"], "delta")
        self.upstream.release.set()
        self.assertEqual(self._next_event(response)["type"], "delta")
        # Hang up in the middle of the answer, the way the Stop button does.
        response.fp.raw._sock.shutdown(socket.SHUT_RDWR)
        response.close()
        self.assertTrue(self.upstream.reader_left.wait(timeout=10), "the upstream request kept running after the reader left")


if __name__ == "__main__":
    unittest.main()
