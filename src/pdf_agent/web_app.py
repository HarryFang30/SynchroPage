"""Backward-compatible module wrapper for the local web server.

Prefer importing from ``pdf_agent.server.web_app`` in new code.
"""

from pdf_agent.server.web_app import *  # noqa: F401,F403
from pdf_agent.server.web_app import main


if __name__ == "__main__":
    raise SystemExit(main())
