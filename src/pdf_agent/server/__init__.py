"""HTTP server package for the SynchroPage web app.

Public API
----------
- ``create_server`` — factory for ``PdfAgentHttpServer``
- ``main`` — CLI entry point
- ``PdfAgentHttpServer`` — threaded HTTP server
- ``PdfAgentRequestHandler`` — per-request handler
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
