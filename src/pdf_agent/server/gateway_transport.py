"""Shared HTTP transport for gateway POST requests.

Encapsulates the low-level ``urllib.request.urlopen`` logic shared by
both ``AgentChatGateway`` and ``TeachingGenerationGateway``:
JSON serialisation, standard headers, error redaction, and optional
timeout / Retry-After handling.

Streaming responses (``stream: true`` on the Responses API) are read
incrementally, which turns the socket timeout into an *inactivity*
timeout — "no bytes for N seconds" instead of "the whole answer must
arrive within N seconds" — while an optional overall ``deadline_seconds``
bounds the request as a whole.  Both failure modes surface as
``upstream_timeout`` (504) and record whether any bytes had arrived, which
is what the retry policy keys on.
"""

from __future__ import annotations

import http.client
import inspect
import json
import socket
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

from pdf_agent.gateway import redacted_gateway_error
from pdf_agent.server.errors import HttpError
from pdf_agent.server.generation_policy import mark_received_bytes, received_bytes
from pdf_agent.server.json_utils import json_bytes_utf8_safe
from pdf_agent.server.prompt_cache import _retry_after_seconds
from pdf_agent.server.response_parsing import response_incomplete_reason

# Hard cap on raw upstream response text before redaction to prevent
# unbounded error-detail leaks (e.g. HTML error pages, non-JSON bodies).
_MAX_RAW_UPSTREAM_CHARS = 2000

# Streaming read size.  Small enough that the overall deadline is checked
# often, large enough that a long SSE body is not read byte by byte.
_READ_CHUNK_BYTES = 64 * 1024


def _redacted_upstream_detail(raw_text: str) -> str:
    """Truncate *raw_text* then apply gateway redaction."""
    truncated = raw_text[:_MAX_RAW_UPSTREAM_CHARS]
    return redacted_gateway_error(truncated)


def _chunk_reader(response: Any) -> Callable[[int], bytes] | None:
    """Return an incremental reader for *response*, or ``None``.

    ``None`` means the object only supports a single ``read()`` call (test
    doubles and other simple file-likes), in which case the body is read in
    one go and the socket timeout keeps its original meaning.
    """
    reader = getattr(response, "read1", None)
    if callable(reader):
        return reader
    reader = getattr(response, "read", None)
    if not callable(reader):
        return None
    try:
        inspect.signature(reader).bind(_READ_CHUNK_BYTES)
    except (TypeError, ValueError):
        return None
    return reader


def _timeout_error(
    received: int,
    *,
    waited_seconds: float,
    reason: str,
    message_prefix: str = "Model gateway request",
) -> HttpError:
    """Build an ``upstream_timeout`` error that records the bytes received."""
    detail = (
        "no response bytes were received"
        if received <= 0
        else f"{received} partial bytes were received before the stall"
    )
    error = HttpError(
        504,
        f"{message_prefix} timed out after {waited_seconds:.0f}s ({reason}; {detail})",
        code="upstream_timeout",
    )
    mark_received_bytes(error, received)
    return error


def _response_socket(response: Any) -> Any:
    """Best-effort handle on the socket behind an ``HTTPResponse`` (or ``None``)."""
    raw = getattr(getattr(response, "fp", None), "raw", None)
    sock = getattr(raw, "_sock", None)
    return sock if callable(getattr(sock, "settimeout", None)) else None


def _read_body(
    response: Any,
    *,
    deadline: float | None,
    started: float,
    socket_timeout: float | None = None,
) -> tuple[bytes, int]:
    """Read *response* incrementally, honouring an overall *deadline*.

    Each read blocks for at most ``min(socket_timeout, remaining budget)`` so a
    stream that stalls just before the deadline cannot overrun it by a whole
    inactivity timeout.
    """
    read_chunk = _chunk_reader(response)
    if read_chunk is None:
        data = response.read()
        return data, len(data)

    sock = _response_socket(response) if deadline is not None else None
    chunks: list[bytes] = []
    received = 0
    while True:
        now = time.monotonic()
        if deadline is not None and now >= deadline:
            raise _timeout_error(
                received,
                waited_seconds=now - started,
                reason="overall request deadline reached",
            )
        if sock is not None and deadline is not None and socket_timeout:
            try:
                sock.settimeout(max(0.5, min(float(socket_timeout), deadline - now)))
            except OSError:
                sock = None
        try:
            chunk = read_chunk(_READ_CHUNK_BYTES)
        except BaseException as exc:
            mark_received_bytes(exc, received)
            raise
        if not chunk:
            break
        chunks.append(chunk)
        received += len(chunk)
    return b"".join(chunks), received


def _raise_when_output_truncated(text: str, content_type: str) -> None:
    """Raise ``output_truncated`` when the model ran out of output tokens."""
    if response_incomplete_reason(text, content_type) == "max_output_tokens":
        raise HttpError(
            502,
            "Model provider stopped early: the response hit max_output_tokens "
            "before the JSON was complete",
            code="output_truncated",
        )


def post_json_responses(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    *,
    timeout_seconds: float,
    handle_timeout: bool = False,
    deadline_seconds: float | None = None,
) -> tuple[str, str]:
    """POST *payload* as JSON to *url*, returning ``(text, content_type)``.

    Parameters
    ----------
    timeout_seconds:
        Socket timeout.  With a streamed response this is an *inactivity*
        timeout: the upstream may take as long as it likes as long as it
        keeps emitting bytes.
    handle_timeout:
        When ``True``, ``TimeoutError`` / ``socket.timeout`` are caught
        and raised as ``upstream_timeout`` (504).  When ``False`` (the
        default, used by the agent gateway) they propagate as unhandled
        exceptions.
    deadline_seconds:
        Optional overall budget for this request.  When the body is still
        arriving after it, ``upstream_timeout`` (504) is raised.
    """
    data = json_bytes_utf8_safe(payload, ensure_ascii=False, separators=(",", ":"))
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Accept": "text/event-stream, application/json",
            "Content-Type": "application/json",
            **headers,
        },
        method="POST",
    )
    started = time.monotonic()
    socket_timeout = float(timeout_seconds)
    deadline: float | None = None
    if deadline_seconds is not None and deadline_seconds > 0:
        deadline = started + float(deadline_seconds)
        socket_timeout = max(1.0, min(socket_timeout, float(deadline_seconds)))
    try:
        with urllib.request.urlopen(request, timeout=socket_timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            body, _received = _read_body(
                response, deadline=deadline, started=started, socket_timeout=socket_timeout
            )
            text = body.decode("utf-8", errors="replace")
        _raise_when_output_truncated(text, content_type)
        return text, content_type
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HttpError(
            exc.code,
            _redacted_upstream_detail(detail),
            code="rate_limited" if exc.code == 429 else "upstream_error",
            retry_after_seconds=_retry_after_seconds(exc.headers.get("Retry-After")),
        ) from exc
    except (TimeoutError, socket.timeout) as exc:
        if not handle_timeout:
            raise
        raise _timeout_error(
            received_bytes(exc),
            waited_seconds=time.monotonic() - started,
            reason=(
                "overall request deadline reached"
                if deadline is not None and time.monotonic() >= deadline - 0.05
                else "no bytes from the model gateway"
            ),
        ) from exc
    except urllib.error.URLError as exc:
        error = HttpError(502, _redacted_upstream_detail(str(exc)), code="network_error")
        mark_received_bytes(error, received_bytes(exc))
        raise error from exc
    except (http.client.HTTPException, OSError) as exc:
        # Connection reset / incomplete chunked body while streaming.
        error = HttpError(502, _redacted_upstream_detail(str(exc)), code="network_error")
        mark_received_bytes(error, received_bytes(exc))
        raise error from exc


def get_json(
    url: str,
    headers: dict[str, str],
    *,
    timeout_seconds: float,
) -> Any:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            **headers,
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            text = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HttpError(
            exc.code,
            _redacted_upstream_detail(detail),
            code="rate_limited" if exc.code == 429 else "upstream_error",
            retry_after_seconds=_retry_after_seconds(exc.headers.get("Retry-After")),
        ) from exc
    except (TimeoutError, socket.timeout) as exc:
        raise HttpError(
            504,
            f"Model provider request timed out after {timeout_seconds:.0f}s",
            code="upstream_timeout",
        ) from exc
    except urllib.error.URLError as exc:
        raise HttpError(502, _redacted_upstream_detail(str(exc)), code="network_error") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise HttpError(502, _redacted_upstream_detail(text), code="invalid_upstream_json") from exc
