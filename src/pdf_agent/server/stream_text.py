"""Incremental text extraction from a streamed upstream response.

A provider streams its answer as Server-Sent Events (OpenAI Responses, Chat
Completions, Anthropic Messages, Gemini ``alt=sse``) or as one JSON object per
line (Ollama).  ``StreamTextDecoder`` is fed the body as it arrives and reports
each piece of answer text the moment its line is complete, so the chat route
can pass it on to the browser instead of waiting for the whole answer.

Stateless helpers, no dependency on ``web_app.py``.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any

_TEXT_EVENT_TYPES = frozenset({"response.output_text.delta", "response.refusal.delta"})
_FAILURE_EVENT_TYPES = frozenset({"response.failed", "response.error", "error"})


class StreamTextDecoder:
    """Turns the bytes of a streamed model response into text deltas.

    ``on_text`` receives every piece of answer text in order; ``on_thinking``
    fires while a reasoning model is still thinking (its reasoning text is not
    forwarded); ``on_start`` fires once, with the first bytes.
    """

    def __init__(
        self,
        *,
        on_text: Callable[[str], None],
        on_thinking: Callable[[], None] | None = None,
        on_start: Callable[[], None] | None = None,
    ) -> None:
        self._on_text = on_text
        self._on_thinking = on_thinking
        self._on_start = on_start
        self._buffer = b""
        self._parts: list[str] = []
        self.received = False
        self.truncated = False
        self.failure: Mapping[str, Any] | None = None

    @property
    def text(self) -> str:
        return "".join(self._parts)

    @property
    def emitted(self) -> bool:
        """True once answer text reached the client: a retry would repeat it."""
        return bool(self._parts)

    def feed(self, chunk: bytes) -> None:
        if not chunk:
            return
        if not self.received:
            self.received = True
            if self._on_start is not None:
                self._on_start()
        # Lines are cut on the byte level so a multi-byte character split
        # across two chunks is decoded whole.
        self._buffer += chunk
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            self._feed_line(line.decode("utf-8", errors="replace"))

    def finish(self) -> None:
        """Handle a last line that arrived without its newline."""
        line, self._buffer = self._buffer, b""
        if line:
            self._feed_line(line.decode("utf-8", errors="replace"))

    def _feed_line(self, line: str) -> None:
        line = line.strip()
        if line.startswith("data:"):
            data = line[5:].strip()
        elif line.startswith("{"):
            data = line
        else:
            return
        if not data or data == "[DONE]":
            return
        try:
            event = json.loads(data)
        except json.JSONDecodeError:
            return
        if not isinstance(event, Mapping):
            return
        text, thinking = _event_delta(event)
        if _event_truncated(event):
            self.truncated = True
        failure = _event_failure(event)
        if failure is not None:
            self.failure = failure
        if text:
            self._parts.append(text)
            self._on_text(text)
        elif thinking and self._on_thinking is not None:
            self._on_thinking()


def _event_delta(event: Mapping[str, Any]) -> tuple[str, bool]:
    """``(answer text, is reasoning)`` carried by one streamed event."""
    event_type = event.get("type")
    if isinstance(event_type, str):
        if event_type in _TEXT_EVENT_TYPES:
            return _string(event.get("delta")), False
        if event_type == "content_block_delta":  # Anthropic Messages
            delta = event.get("delta")
            if isinstance(delta, Mapping):
                if delta.get("type") == "text_delta":
                    return _string(delta.get("text")), False
                return "", delta.get("type") in {"thinking_delta", "signature_delta"}
            return "", False
        if "reasoning" in event_type:
            return "", True

    choices = event.get("choices")  # Chat Completions
    if isinstance(choices, list) and choices and isinstance(choices[0], Mapping):
        delta = choices[0].get("delta")
        if isinstance(delta, Mapping):
            text = _string(delta.get("content"))
            if text:
                return text, False
            return "", bool(_string(delta.get("reasoning_content")) or _string(delta.get("reasoning")))
        return "", False

    candidates = event.get("candidates")  # Gemini streamGenerateContent
    if isinstance(candidates, list):
        texts: list[str] = []
        thinking = False
        for candidate in candidates:
            content = candidate.get("content") if isinstance(candidate, Mapping) else None
            for part in (content.get("parts") or []) if isinstance(content, Mapping) else []:
                if not isinstance(part, Mapping) or not isinstance(part.get("text"), str):
                    continue
                if part.get("thought"):
                    thinking = True
                else:
                    texts.append(part["text"])
        return "".join(texts), thinking and not texts

    if "done" in event:  # Ollama: one JSON object per line
        message = event.get("message")
        if isinstance(message, Mapping):
            text = _string(message.get("content"))
            return text, not text and bool(_string(message.get("thinking")))
        return _string(event.get("response")), False
    return "", False


def _event_truncated(event: Mapping[str, Any]) -> bool:
    """True when the event says the answer stopped at the output-token limit."""
    choices = event.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], Mapping) and choices[0].get("finish_reason") == "length":
        return True
    if event.get("done_reason") == "length":
        return True
    delta = event.get("delta")
    if event.get("type") == "message_delta" and isinstance(delta, Mapping):
        return delta.get("stop_reason") == "max_tokens"
    candidates = event.get("candidates")
    if isinstance(candidates, list):
        return any(isinstance(item, Mapping) and item.get("finishReason") == "MAX_TOKENS" for item in candidates)
    response = event.get("response")
    if isinstance(response, Mapping) and str(response.get("status") or "").lower() == "incomplete":
        details = response.get("incomplete_details")
        return isinstance(details, Mapping) and details.get("reason") == "max_output_tokens"
    return False


def _event_failure(event: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """The error an upstream reports in the middle of a stream, or ``None``."""
    error = event.get("error")
    if event.get("type") in _FAILURE_EVENT_TYPES:
        if isinstance(error, Mapping):
            return error
        response = event.get("response")
        if isinstance(response, Mapping) and isinstance(response.get("error"), Mapping):
            return response["error"]
        return event
    if "choices" in event or "candidates" in event:
        return None
    if isinstance(error, Mapping):
        return error
    if isinstance(error, str) and error.strip():  # Ollama and some proxies: {"error": "..."}
        return {"message": error}
    return None


def _string(value: Any) -> str:
    return value if isinstance(value, str) else ""
