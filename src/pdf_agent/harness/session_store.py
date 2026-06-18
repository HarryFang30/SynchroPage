from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any
from uuid import uuid4

from .types import AgentRunResult, AgentUsage, HarnessInput, JournalEntry, PageResult, RunStatus


class JsonlJournalStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)

    def _path(self, run_id: str) -> Path:
        return self.root / run_id / "journal.jsonl"

    async def read(self, run_id: str) -> list[JournalEntry]:
        path = self._path(run_id)
        if not path.exists():
            return []
        entries = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            raw = json.loads(line)
            result_raw = raw["result"]
            usage_raw = result_raw.get("usage") or {}
            entries.append(
                JournalEntry(
                    key=raw["key"],
                    seq=int(raw["seq"]),
                    role=raw["role"],
                    target_pages=list(raw["target_pages"]),
                    result=AgentRunResult(
                        kind=result_raw["kind"],
                        output=result_raw.get("output"),
                        usage=AgentUsage(
                            input_tokens=usage_raw.get("input_tokens"),
                            output_tokens=int(usage_raw.get("output_tokens") or 0),
                        ),
                        model=result_raw.get("model"),
                        reason=result_raw.get("reason"),
                        detail=result_raw.get("detail"),
                    ),
                )
            )
        return sorted(entries, key=lambda item: item.seq)

    async def append(self, run_id: str, entry: JournalEntry) -> None:
        path = self._path(run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")

    async def truncate_after(self, run_id: str, seq: int) -> None:
        entries = [entry for entry in await self.read(run_id) if entry.seq <= seq]  # type: ignore[attr-defined]
        path = self._path(run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "".join(json.dumps(asdict(entry), ensure_ascii=False) + "\n" for entry in entries),
            encoding="utf-8",
        )


class InMemoryRunStore:
    def __init__(self) -> None:
        self.runs: dict[str, dict[str, Any]] = {}

    async def create(self, input: HarnessInput) -> tuple[str, Any]:
        run_id = f"run_{uuid4().hex}"
        self.runs[run_id] = {"status": "queued", "input": asdict(input), "pages": {}}
        return run_id, None

    async def update_status(self, run_id: str, status: RunStatus, error: str | None = None) -> None:
        self.runs[run_id]["status"] = status
        if error:
            self.runs[run_id]["error"] = error

    async def upsert_page(self, run_id: str, page: PageResult) -> None:
        self.runs[run_id]["pages"][page.page_no] = asdict(page)

    async def get(self, run_id: str) -> dict[str, Any] | None:
        return self.runs.get(run_id)

    async def cancel(self, run_id: str) -> None:
        if run_id in self.runs:
            self.runs[run_id]["status"] = "canceled"


class InMemoryProgressBus:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.listeners: dict[str, list[Any]] = {}

    def emit(self, event: dict[str, Any]) -> None:
        self.events.append(event)
        for listener in self.listeners.get(event.get("runId", ""), []):
            listener(event)

    def subscribe(self, run_id: str, listener: Any) -> Any:
        self.listeners.setdefault(run_id, []).append(listener)

        def unsubscribe() -> None:
            self.listeners.get(run_id, []).remove(listener)

        return unsubscribe
