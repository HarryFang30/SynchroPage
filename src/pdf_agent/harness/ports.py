from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .types import (
    AgentRunParams,
    AgentRunResult,
    HarnessInput,
    JournalEntry,
    PageResult,
    PageSource,
    ParserName,
    PdfReference,
    RunStatus,
)


class ModelPort(Protocol):
    async def run_agent(self, params: AgentRunParams, signal: Any) -> AgentRunResult:
        """Run one model-backed agent call through the OpenAI Gateway."""


class ParserPort(Protocol):
    async def parse_pages(
        self,
        *,
        document_id: str,
        pdf: PdfReference,
        pages: list[int],
        parser: ParserName,
        signal: Any,
    ) -> list[PageSource]:
        """Return deterministic Page JSON for selected pages."""


class ValidatorPort(Protocol):
    def validate(self, schema: dict[str, Any], value: Any) -> tuple[bool, dict[str, Any] | None, list[str]]:
        """Return (ok, normalized_value, errors)."""


class JournalStore(Protocol):
    async def read(self, run_id: str) -> list[JournalEntry]:
        """Read journal entries sorted by call sequence."""

    async def append(self, run_id: str, entry: JournalEntry) -> None:
        """Persist a successful or terminal agent result."""

    async def truncate_after(self, run_id: str, seq: int) -> None:
        """Drop entries after divergence during resume."""


class RunStore(Protocol):
    async def create(self, input: HarnessInput) -> tuple[str, Any]:
        """Create a run and return (run_id, cancellation signal)."""

    async def update_status(self, run_id: str, status: RunStatus, error: str | None = None) -> None:
        """Persist run status."""

    async def upsert_page(self, run_id: str, page: PageResult) -> None:
        """Persist a page result transactionally."""

    async def get(self, run_id: str) -> dict[str, Any] | None:
        """Return persisted run state."""

    async def cancel(self, run_id: str) -> None:
        """Abort a run."""


class ProgressBus(Protocol):
    def emit(self, event: dict[str, Any]) -> None:
        """Emit an append-only progress event."""

    def subscribe(self, run_id: str, listener: Any) -> Any:
        """Subscribe to events for SSE or tests."""


class PolicyGate(Protocol):
    async def assert_can_start_run(self, input: HarnessInput) -> None:
        """Fail closed before any model call."""

    async def assert_can_start_agent(self, params: AgentRunParams, spent_tokens: int) -> None:
        """Check budget, permissions, and concurrency policy."""

    def should_fallback(self, page: PageResult) -> bool:
        """Decide whether a page needs parser fallback."""


class TelemetryPort(Protocol):
    def event(self, name: str, attributes: dict[str, str | int | float | bool | None] | None = None) -> None:
        """Structured telemetry event."""

    def warn(self, message: str, attributes: dict[str, str | int | float | bool | None] | None = None) -> None:
        """Structured warning."""


@dataclass(frozen=True)
class HarnessPorts:
    model: ModelPort
    parser: ParserPort
    validator: ValidatorPort
    journal: JournalStore
    runs: RunStore
    progress: ProgressBus
    policy: PolicyGate
    telemetry: TelemetryPort

