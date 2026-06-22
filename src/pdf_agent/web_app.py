"""Backward-compatible module wrapper for the local web server.

Prefer importing from ``pdf_agent.server.web_app`` in new code.
"""

from pdf_agent.server.web_app import (
    PdfAgentHttpServer,
    PdfAgentRequestHandler,
    create_server,
    main,
)

__all__ = [
    "PdfAgentHttpServer",
    "PdfAgentRequestHandler",
    "create_server",
    "main",
]

if __name__ == "__main__":
    raise SystemExit(main())
