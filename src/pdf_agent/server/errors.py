"""Lightweight HTTP error type shared across server modules.

This module exists to avoid circular imports — any module can import
``HttpError`` without pulling in ``web_app.py`` or its dependencies.
"""

from __future__ import annotations


class HttpError(RuntimeError):
    """Raised to signal an HTTP-level error from request handlers or gateways.

    Callers higher in the call stack (e.g. ``PdfAgentRequestHandler``) catch
    ``HttpError`` and translate it into an appropriate HTTP response.
    """

    def __init__(
        self,
        status: int,
        message: str,
        *,
        code: str = "http_error",
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after_seconds = retry_after_seconds
