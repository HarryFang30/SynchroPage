"""Pure JSON / Unicode utility functions extracted from web_app.py.

These functions are stateless and safe to import anywhere.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any


def repair_unicode_surrogates_text(value: str) -> str:
    """Replace lone/paired UTF-16 surrogates with their real characters."""
    if not any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        return value
    return value.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def repair_unicode_surrogates(value: Any) -> Any:
    """Recursively repair Unicode surrogates in strings, dicts, lists, and tuples."""
    if isinstance(value, str):
        return repair_unicode_surrogates_text(value)
    if isinstance(value, Mapping):
        return {
            repair_unicode_surrogates(key): repair_unicode_surrogates(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [repair_unicode_surrogates(item) for item in value]
    if isinstance(value, tuple):
        return tuple(repair_unicode_surrogates(item) for item in value)
    return value


def json_dumps_utf8_safe(value: Any, **kwargs: Any) -> str:
    """json.dumps with surrogate repair applied before serialization."""
    return json.dumps(repair_unicode_surrogates(value), **kwargs)


def json_bytes_utf8_safe(value: Any, **kwargs: Any) -> bytes:
    """json.dumps → utf-8 bytes with surrogate repair."""
    return json_dumps_utf8_safe(value, **kwargs).encode("utf-8")
