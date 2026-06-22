from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from typing import Any

from pdf_agent.harness.agent_loop import CoursePdfHarness
from pdf_agent.harness.policy import DeterministicPolicyGate, PolicyError
from pdf_agent.harness.ports import HarnessPorts
from pdf_agent.harness.session_store import InMemoryProgressBus, InMemoryRunStore, JsonlJournalStore
from pdf_agent.harness.types import (
    AgentRunParams,
    AgentRunResult,
    AgentUsage,
    HarnessInput,
    JournalEntry,
    PageResult,
    PageSource,
    PdfReference,
)


class FakeModel:
    def __init__(self) -> None:
        self.calls: list[AgentRunParams] = []

    async def run_agent(self, params: AgentRunParams, signal: Any) -> AgentRunResult:
        self.calls.append(params)
        if params.role == "document_planner":
            return AgentRunResult(
                kind="ok",
                output={
                    "page_count": 2,
                    "page_inventory": [{"page_no": 1}, {"page_no": 2}],
                    "generation_strategy": {"recommended_batch_size": 2},
                },
                usage=AgentUsage(input_tokens=10, output_tokens=20),
            )
        if params.role == "page_teacher":
            return AgentRunResult(
                kind="ok",
                output={"pages": [_page_payload(page_no) for page_no in params.target_pages]},
                usage=AgentUsage(input_tokens=30, output_tokens=40),
            )
        if params.role == "page_reviewer":
            return AgentRunResult(
                kind="ok",
                output={"pass": True, "severity": "minor", "issues": []},
                usage=AgentUsage(input_tokens=5, output_tokens=6),
            )
        return AgentRunResult(kind="dead", reason="unexpected_role", detail=params.role)


class FakeParser:
    async def parse_pages(
        self,
        *,
        document_id: str,
        pdf: PdfReference,
        pages: list[int],
        parser: str,
        signal: Any,
    ) -> list[PageSource]:
        return []


class PassThroughValidator:
    def validate(self, schema: dict[str, Any], value: Any) -> tuple[bool, dict[str, Any] | None, list[str]]:
        if isinstance(value, dict) and isinstance(value.get("pages"), list):
            return True, value, []
        return False, None, ["expected page batch"]


class CollectingTelemetry:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, str | int | float | bool | None] | None]] = []
        self.warnings: list[tuple[str, dict[str, str | int | float | bool | None] | None]] = []

    def event(self, name: str, attributes: dict[str, str | int | float | bool | None] | None = None) -> None:
        self.events.append((name, attributes))

    def warn(self, message: str, attributes: dict[str, str | int | float | bool | None] | None = None) -> None:
        self.warnings.append((message, attributes))


class HarnessTest(unittest.TestCase):
    def test_policy_rejects_invalid_run_and_fallbacks_weak_pages(self) -> None:
        async def scenario() -> None:
            policy = DeterministicPolicyGate(allow_network_model_calls=False)
            with self.assertRaises(PolicyError):
                await policy.assert_can_start_run(_input(document_id=""))
            with self.assertRaises(PolicyError):
                await policy.assert_can_start_run(_input(document_sha256=""))
            with self.assertRaises(PolicyError):
                await policy.assert_can_start_run(_input(max_concurrency=0))
            with self.assertRaises(PolicyError):
                await policy.assert_can_start_run(_input())

            permissive = DeterministicPolicyGate(max_target_pages_per_call=1)
            await permissive.assert_can_start_run(_input())
            with self.assertRaises(PolicyError):
                await permissive.assert_can_start_agent(_agent_params([1, 2]), spent_tokens=0)
            with self.assertRaises(PolicyError):
                await permissive.assert_can_start_agent(_agent_params([1], schema={}), spent_tokens=0)

            self.assertFalse(permissive.should_fallback(_ready_page(confidence=0.95)))
            self.assertTrue(permissive.should_fallback(_ready_page(confidence=0.2)))
            self.assertTrue(permissive.should_fallback(_ready_page(evidence=[])))
            self.assertTrue(permissive.should_fallback(_ready_page(needs_parser_fallback=True)))

        asyncio.run(scenario())

    def test_jsonl_journal_round_trips_and_truncates_by_sequence(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                journal = JsonlJournalStore(Path(tmp))
                await journal.append("run_1", _journal_entry("second", seq=2, target_pages=[2]))
                await journal.append("run_1", _journal_entry("first", seq=1, target_pages=[1]))

                entries = await journal.read("run_1")
                self.assertEqual([entry.seq for entry in entries], [1, 2])
                self.assertEqual(entries[0].result.usage.output_tokens, 7)
                self.assertEqual(entries[1].target_pages, [2])

                await journal.truncate_after("run_1", 1)
                entries = await journal.read("run_1")
                self.assertEqual([entry.key for entry in entries], ["first"])

        asyncio.run(scenario())

    def test_agent_loop_generates_pages_and_persists_ready_run(self) -> None:
        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                model = FakeModel()
                runs = InMemoryRunStore()
                progress = InMemoryProgressBus()
                harness = CoursePdfHarness(
                    HarnessPorts(
                        model=model,
                        parser=FakeParser(),
                        validator=PassThroughValidator(),
                        journal=JsonlJournalStore(Path(tmp)),
                        runs=runs,
                        progress=progress,
                        policy=DeterministicPolicyGate(),
                        telemetry=CollectingTelemetry(),
                    ),
                    prompts={
                        "document_planner": "plan",
                        "page_teacher": "teach",
                        "page_reviewer": "review",
                        "page_repairer": "repair",
                    },
                    schemas={"document_plan": {"type": "object"}, "page_batch": {"type": "object"}},
                )

                run_id = await harness.run_to_completion(_input())
                stored = await runs.get(run_id)

                self.assertIsNotNone(stored)
                self.assertEqual(stored["status"], "ready")
                self.assertEqual(sorted(stored["pages"].keys()), [1, 2])
                self.assertEqual(stored["pages"][1]["teaching"]["slide_title"], "Page 1")
                self.assertEqual([call.role for call in model.calls], [
                    "document_planner",
                    "page_teacher",
                    "page_reviewer",
                    "page_reviewer",
                ])
                self.assertIn({"type": "run_done", "runId": run_id, "status": "ready"}, progress.events)
                journal_entries = await JsonlJournalStore(Path(tmp)).read(run_id)
                self.assertEqual([entry.role for entry in journal_entries], [
                    "document_planner",
                    "page_teacher",
                    "page_reviewer",
                    "page_reviewer",
                ])

        asyncio.run(scenario())


def _input(**overrides: Any) -> HarnessInput:
    values = {
        "document_id": "doc_1",
        "document_sha256": "a" * 64,
        "pdf": PdfReference(kind="local_path", value="/tmp/doc.pdf"),
        "prompt_version": "prompt.v1",
        "schema_version": "schema.v1",
        "max_concurrency": 2,
    }
    values.update(overrides)
    return HarnessInput(**values)


def _agent_params(target_pages: list[int], schema: dict[str, Any] | None = None) -> AgentRunParams:
    return AgentRunParams(
        role="page_teacher",
        prompt="teach",
        model="gpt-5.5",
        schema={"type": "object"} if schema is None else schema,
        pdf=PdfReference(kind="local_path", value="/tmp/doc.pdf"),
        target_pages=target_pages,
        metadata={},
    )


def _journal_entry(key: str, seq: int, target_pages: list[int]) -> JournalEntry:
    return JournalEntry(
        key=key,
        seq=seq,
        role="page_teacher",
        target_pages=target_pages,
        result=AgentRunResult(
            kind="ok",
            output={"pages": [_page_payload(target_pages[0])]},
            usage=AgentUsage(input_tokens=3, output_tokens=7),
            model="gpt-5.5",
        ),
    )


def _ready_page(
    *,
    confidence: float = 0.95,
    evidence: list[dict[str, str]] | None = None,
    needs_parser_fallback: bool = False,
) -> PageResult:
    payload = _page_payload(1)
    teaching = payload["teaching"]
    if evidence is not None:
        teaching["evidence"] = evidence
    teaching["confidence"] = confidence
    teaching["needs_parser_fallback"] = needs_parser_fallback
    harness = CoursePdfHarness(
        HarnessPorts(
            model=FakeModel(),
            parser=FakeParser(),
            validator=PassThroughValidator(),
            journal=JsonlJournalStore("/tmp"),
            runs=InMemoryRunStore(),
            progress=InMemoryProgressBus(),
            policy=DeterministicPolicyGate(),
            telemetry=CollectingTelemetry(),
        ),
        prompts={"document_planner": "", "page_teacher": "", "page_reviewer": "", "page_repairer": ""},
        schemas={"document_plan": {}, "page_batch": {}},
    )
    return harness._page_results_from_batch({"pages": [payload]}, [1])[0]


def _page_payload(page_no: int) -> dict[str, Any]:
    return {
        "page_no": page_no,
        "source": {
            "pdf_page_ref": f"#page={page_no}",
            "page_type": "concept",
            "text_md": f"Source text {page_no}",
            "parser": "gpt-5.5-direct",
            "ocr_used": False,
            "content_hash": f"hash-{page_no}",
        },
        "teaching": {
            "slide_title": f"Page {page_no}",
            "speaker_notes_md": f"Notes for page {page_no}",
            "concepts": ["concept"],
            "prerequisites": [],
            "contextual_bridge": "",
            "visual_explanations": [],
            "formula_explanations": [],
            "evidence": [{"kind": "keyword", "quote_or_reference": f"Source {page_no}"}],
            "confidence": 0.95,
            "needs_review": False,
            "needs_parser_fallback": False,
        },
    }


class FailingModel:
    """Model that always raises to exercise telemetry traceback collection."""

    async def run_agent(self, params: AgentRunParams, signal: Any) -> AgentRunResult:
        raise ValueError("simulated model crash")


class HarnessErrorObservabilityTest(unittest.TestCase):
    """Verify that harness errors produce telemetry with traceback info."""

    def test_run_failure_logs_error_type_and_traceback(self) -> None:
        async def scenario() -> None:
            telemetry = CollectingTelemetry()
            harness = CoursePdfHarness(
                HarnessPorts(
                    model=FailingModel(),
                    parser=FakeParser(),
                    validator=PassThroughValidator(),
                    journal=JsonlJournalStore("/tmp"),
                    runs=InMemoryRunStore(),
                    progress=InMemoryProgressBus(),
                    policy=DeterministicPolicyGate(),
                    telemetry=telemetry,
                ),
                prompts={
                    "document_planner": "plan",
                    "page_teacher": "teach",
                    "page_reviewer": "review",
                    "page_repairer": "repair",
                },
                schemas={"document_plan": {"type": "object"}, "page_batch": {"type": "object"}},
            )

            with self.assertRaises(ValueError):
                await harness.run_to_completion(_input())

            self.assertTrue(
                any(
                    name == "run_lifecycle_error" and attrs
                    and attrs.get("error_type") == "ValueError"
                    and "traceback" in attrs
                    and "simulated model crash" in str(attrs.get("error"))
                    for name, attrs in telemetry.warnings
                ),
                f"No run_lifecycle_error warning with traceback found in {telemetry.warnings}",
            )

        asyncio.run(scenario())
