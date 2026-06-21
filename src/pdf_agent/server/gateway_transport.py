"""Shared HTTP transport for gateway POST requests.

Encapsulates the low-level ``urllib.request.urlopen`` logic shared by
both ``AgentChatGateway`` and ``TeachingGenerationGateway``:
JSON serialisation, standard headers, error redaction, and optional
timeout / Retry-After handling.
"""

from __future__ import annotations

import socket
import urllib.error
import urllib.request
from typing import Any

from pdf_agent.gateway import redacted_gateway_error
from pdf_agent.server.errors import HttpError
from pdf_agent.server.json_utils import json_bytes_utf8_safe
from pdf_agent.server.prompt_cache import _retry_after_seconds


def post_json_responses(
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
    *,
    timeout_seconds: float,
    handle_timeout: bool = False,
) -> tuple[str, str]:
    """POST *payload* as JSON to *url*, returning ``(text, content_type)``.

    Parameters
    ----------
    handle_timeout:
        When ``True``, ``TimeoutError`` / ``socket.timeout`` are caught
        and raised as ``upstream_timeout`` (504).  When ``False`` (the
        default, used by the agent gateway) they propagate as unhandled
        exceptions.
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
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            text = response.read().decode("utf-8", errors="replace")
            return text, response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HttpError(
            exc.code,
            redacted_gateway_error(detail),
            code="upstream_error",
            retry_after_seconds=_retry_after_seconds(exc.headers.get("Retry-After")),
        ) from exc
    except (TimeoutError, socket.timeout) as exc:
        if not handle_timeout:
            raise
        raise HttpError(
            504,
            f"OpenAI gateway request timed out after {timeout_seconds:.0f}s",
            code="upstream_timeout",
        ) from exc
    except urllib.error.URLError as exc:
        raise HttpError(502, redacted_gateway_error(str(exc)), code="network_error") from exc
