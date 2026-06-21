"""Pure value-extraction helpers shared across server modules.

Every function here is stateless and has no dependency on web_app.py,
making them safe to import from any module without circular-import risk.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any


def env_positive_int(name: str, default: int) -> int:
    """Read *name* from the environment, returning *default* on failure or <=0."""
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        return default
    return value if value > 0 else default


def clean_model(value: Any) -> str | None:
    """Return a non-empty, stripped model string, or ``None``."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned if cleaned else None


def string_or_none(value: Any) -> str | None:
    """Return a non-empty, stripped string, or ``None``."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def string_value(value: Any, default: str) -> str:
    """Return a non-empty string representation, or *default*."""
    if value is None:
        return default
    cleaned = str(value).strip()
    return cleaned or default


def int_value(value: Any, default: int) -> int:
    """Return *value* coerced to ``int``, or *default* on failure."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def float_value(value: Any, default: float) -> float:
    """Return *value* coerced to ``float``, or *default* on failure."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def string_list(value: Any) -> list[str]:
    """Return a list of non-empty, stripped strings from *value*."""
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def page_type_value(value: Any) -> str:
    """Normalise a page-type string, defaulting to ``"unknown"``."""
    allowed = {
        "title", "agenda", "concept", "example", "figure", "table",
        "formula", "exercise", "summary", "blank", "unknown",
    }
    cleaned = str(value or "").strip()
    return cleaned if cleaned in allowed else "unknown"


def evidence_list(value: Any) -> list[dict[str, str]]:
    """Normalise an evidence list, returning a safe default when empty."""
    allowed = {
        "title", "keyword", "formula", "figure", "table",
        "caption", "layout", "other",
    }
    if not isinstance(value, list):
        return [{"kind": "other", "quote_or_reference": "Generated from page source text"}]
    evidence: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        kind = str(item.get("kind") or "other").strip()
        quote = str(item.get("quote_or_reference") or "").strip()
        if quote:
            evidence.append({
                "kind": kind if kind in allowed else "other",
                "quote_or_reference": quote,
            })
    return evidence or [{"kind": "other", "quote_or_reference": "Generated from page source text"}]


def truncate(value: str, max_chars: int) -> str:
    """Truncate *value* to *max_chars*, appending ``…`` when truncated."""
    if len(value) <= max_chars:
        return value
    return f"{value[: max_chars - 1]}…"
