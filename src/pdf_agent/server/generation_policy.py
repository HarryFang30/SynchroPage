"""Numeric policy for teaching-generation stability (long-PDF one-click runs).

Everything the backend needs to decide *how long to wait*, *how much output to
allow*, *when to retry* and *how many requests may be in flight* lives here so
the numbers can be reviewed (and tuned) in one place.  The module is pure
configuration plus small pure helpers: it imports only ``constants`` and
``value_utils`` so any server module can use it without circular imports.

Policy summary (gpt-6-astra class reasoning models, 30-300 s per request):

* streaming responses, socket timeout used as an *inactivity* timeout (120 s);
* an overall per-request deadline by reasoning effort, extended for batches;
* ``max_output_tokens`` by effort so reasoning cannot silently eat the JSON;
* transient retries 2/6/15 s with full jitter, ``Retry-After`` honoured to
  120 s, and a global 429 cooldown that also gates new requests;
* a bounded queue in front of the upstream semaphore so a full queue answers
  ``queue_timeout`` instead of hanging.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Sequence
from typing import Any

from pdf_agent.server.constants import REASONING_EFFORT_ORDER, TEACHING_API_CONCURRENCY
from pdf_agent.server.value_utils import env_positive_int, int_value, string_value

# ---------------------------------------------------------------------------
# Timeouts and deadlines
# ---------------------------------------------------------------------------

#: No bytes for this long on a streaming response → ``upstream_timeout``.
STREAM_INACTIVITY_TIMEOUT_SECONDS: float = float(
    env_positive_int("PDF_AGENT_TEACHING_INACTIVITY_SECONDS", 120)
)

#: Overall wall-clock budget for one client request, by reasoning effort.
REQUEST_DEADLINE_SECONDS_BY_EFFORT: dict[str, int] = {
    "none": 180,
    "low": 180,
    "medium": 300,
    "high": 480,
    "xhigh": 600,
    "max": 600,
}
DEFAULT_REQUEST_DEADLINE_SECONDS: int = 300

#: Batch pages beyond this many extend the deadline.
BATCH_DEADLINE_FREE_PAGES = 2
BATCH_DEADLINE_EXTRA_SECONDS_PER_PAGE = 60
#: Hard ceiling so a pathological batch cannot pin a worker forever.
MAX_REQUEST_DEADLINE_SECONDS = 1_800

# ---------------------------------------------------------------------------
# Output budgets (reasoning tokens count against max_output_tokens)
# ---------------------------------------------------------------------------

MAX_OUTPUT_TOKENS_BY_EFFORT: dict[str, int] = {
    "none": 16_000,
    "low": 16_000,
    "medium": 16_000,
    "high": 24_000,
    "xhigh": 32_000,
    "max": 32_000,
}
DEFAULT_MAX_OUTPUT_TOKENS = 16_000
BATCH_MAX_OUTPUT_TOKENS_PER_PAGE = 8_000
BATCH_MAX_OUTPUT_TOKENS_CAP = 48_000

# ---------------------------------------------------------------------------
# Retry policy
# ---------------------------------------------------------------------------

#: Base delays for transient upstream failures; the actual sleep is
#: ``random.uniform(0, base)`` (full jitter) unless ``Retry-After`` is known.
TEACHING_RETRY_DELAYS_SECONDS: tuple[float, ...] = (2.0, 6.0, 15.0)
#: Upper bound for any retry sleep, including a long ``Retry-After``.
TEACHING_MAX_RETRY_DELAY_SECONDS = 120.0
#: A 429 pauses *new* requests for at least this long.
RATE_LIMIT_MIN_COOLDOWN_SECONDS = 5.0
RATE_LIMIT_MAX_COOLDOWN_SECONDS = 120.0
#: Statuses worth retrying (plus ``network_error`` before the first byte).
RETRYABLE_UPSTREAM_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})
#: ``upstream_timeout`` gets at most this many retries, zero-bytes only.
MAX_TIMEOUT_RETRIES = 1

# ---------------------------------------------------------------------------
# Queue / concurrency
# ---------------------------------------------------------------------------

#: Longest a request may wait for an upstream slot before 503 queue_timeout.
QUEUE_WAIT_TIMEOUT_SECONDS = 30.0
#: ``Retry-After`` advertised with a queue_timeout response.
QUEUE_RETRY_AFTER_SECONDS = 10

TEACHING_CONCURRENCY_ENV_VAR = "PDF_AGENT_TEACHING_CONCURRENCY"


def teaching_concurrency() -> int:
    """Upstream generation concurrency (env override, default 6)."""
    return max(1, env_positive_int(TEACHING_CONCURRENCY_ENV_VAR, TEACHING_API_CONCURRENCY))


# ---------------------------------------------------------------------------
# Derived budgets
# ---------------------------------------------------------------------------


def normalized_effort(effort: Any) -> str:
    """Lower-cased reasoning effort, or ``""`` when unknown."""
    value = string_value(effort, "").lower()
    return value if value in REASONING_EFFORT_ORDER else ""


def request_deadline_seconds(effort: Any, page_count: int = 1) -> float:
    """Overall budget for one client request at *effort* over *page_count* pages."""
    base = REQUEST_DEADLINE_SECONDS_BY_EFFORT.get(
        normalized_effort(effort), DEFAULT_REQUEST_DEADLINE_SECONDS
    )
    extra_pages = max(0, int(page_count) - BATCH_DEADLINE_FREE_PAGES)
    total = base + extra_pages * BATCH_DEADLINE_EXTRA_SECONDS_PER_PAGE
    return float(min(total, MAX_REQUEST_DEADLINE_SECONDS))


def max_output_tokens_for(effort: Any, page_count: int = 1) -> int:
    """Output-token budget for *page_count* pages generated at *effort*.

    Reasoning tokens count against the budget, so a batch never gets *less*
    than a single page at the same effort would: the per-page batch allowance
    only raises the ceiling above the effort table, it never lowers it.
    """
    base = MAX_OUTPUT_TOKENS_BY_EFFORT.get(normalized_effort(effort), DEFAULT_MAX_OUTPUT_TOKENS)
    pages = max(1, int(page_count))
    if pages == 1:
        return base
    batch = min(pages * BATCH_MAX_OUTPUT_TOKENS_PER_PAGE, BATCH_MAX_OUTPUT_TOKENS_CAP)
    return max(base, batch)


def deadlines_seconds_payload() -> dict[str, int]:
    """The deadline table published by ``GET /api/generate/status``."""
    return dict(REQUEST_DEADLINE_SECONDS_BY_EFFORT)


def lower_reasoning_effort(effort: Any, supported: Sequence[str] | None = None) -> str:
    """Return the effort one step below *effort*, respecting *supported*.

    ``supported`` is the clamp table for the model (see
    ``model_gateway.supported_reasoning_efforts``); an empty list means the
    model is unknown and only the global order applies.  When *effort* is
    already the lowest usable value it is returned unchanged.
    """
    current = normalized_effort(effort)
    if not current:
        return ""
    allowed = [value for value in REASONING_EFFORT_ORDER if not supported or value in supported]
    if not allowed:
        return current
    if current not in allowed:
        # Unsupported value: the gateway clamp will pick the nearest anyway.
        return allowed[0]
    index = allowed.index(current)
    return allowed[max(0, index - 1)]


# ---------------------------------------------------------------------------
# Byte accounting on errors (drives the timeout / network retry decision)
# ---------------------------------------------------------------------------

RECEIVED_BYTES_ATTRIBUTE = "synchropage_received_bytes"


def mark_received_bytes(exc: BaseException, received_bytes: int) -> None:
    """Record how many response bytes had arrived when *exc* was raised."""
    try:
        setattr(exc, RECEIVED_BYTES_ATTRIBUTE, max(0, int(received_bytes)))
    except (AttributeError, TypeError, ValueError):
        # Exotic exception types (``__slots__``) simply keep the default 0.
        pass


def received_bytes(exc: BaseException) -> int:
    """Bytes received before *exc*; ``0`` when unknown (i.e. before first byte)."""
    return int_value(getattr(exc, RECEIVED_BYTES_ATTRIBUTE, 0), 0)


# ---------------------------------------------------------------------------
# Request coalescing key
# ---------------------------------------------------------------------------


def generation_request_key(
    *,
    kind: str,
    provider_id: str,
    model: str,
    document_id: str,
    page_numbers: Sequence[int],
    output_language: str,
    attempt: str,
    reasoning_effort: str,
    has_document_file: bool,
) -> str:
    """Stable identity of a generation request, for in-flight coalescing."""
    parts = [
        kind,
        provider_id,
        model,
        document_id,
        ",".join(str(number) for number in sorted(page_numbers)),
        output_language,
        attempt,
        normalized_effort(reasoning_effort) or string_value(reasoning_effort, ""),
        "file" if has_document_file else "nofile",
    ]
    return hashlib.sha256("".join(parts).encode("utf-8")).hexdigest()


def env_flag(name: str, default: bool = False) -> bool:
    """Read a boolean environment switch (``1/true/yes/on``)."""
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}
