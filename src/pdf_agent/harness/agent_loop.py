from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import asdict
from typing import Any

from .ports import HarnessPorts
from .types import (
    AgentRunParams,
    AgentRunResult,
    AgentUsage,
    Evidence,
    HarnessInput,
    JournalEntry,
    PageResult,
    PageSource,
    PageTeaching,
)


class HarnessError(RuntimeError):
    pass


class CoursePdfHarness:
    """Deterministic planner -> teacher -> reviewer -> repair harness.

    The model is powerful, but this loop owns stability: resume, page isolation,
    schema validation, policy gates, progress events, and partial completion.
    """

    def __init__(
        self,
        ports: HarnessPorts,
        *,
        prompts: dict[str, str],
        schemas: dict[str, dict[str, Any]],
        low_confidence_threshold: float = 0.78,
        max_repair_attempts: int = 2,
        max_concurrency_cap: int = 8,
    ) -> None:
        self.ports = ports
        self.prompts = prompts
        self.schemas = schemas
        self.low_confidence_threshold = low_confidence_threshold
        self.max_repair_attempts = max_repair_attempts
        self.max_concurrency_cap = max(1, max_concurrency_cap)

    async def launch(self, input: HarnessInput) -> str:
        """Start a run in the background and return its run id immediately."""
        await self.ports.policy.assert_can_start_run(input)
        run_id, signal = await self.ports.runs.create(input)
        self.ports.progress.emit({"type": "run_started", "runId": run_id, "workflowName": "course_pdf_pairpack"})
        asyncio.create_task(self._run_lifecycle(run_id, signal, input, raise_errors=False))
        return run_id

    async def run_to_completion(self, input: HarnessInput) -> str:
        """Run synchronously. Useful for queue workers and tests."""
        await self.ports.policy.assert_can_start_run(input)
        run_id, signal = await self.ports.runs.create(input)
        self.ports.progress.emit({"type": "run_started", "runId": run_id, "workflowName": "course_pdf_pairpack"})
        await self._run_lifecycle(run_id, signal, input, raise_errors=True)
        return run_id

    async def _run_lifecycle(self, run_id: str, signal: Any, input: HarnessInput, *, raise_errors: bool) -> None:
        try:
            await self._run(run_id, signal, input)
        except asyncio.CancelledError:
            await self.ports.runs.update_status(run_id, "canceled")
            self.ports.progress.emit({"type": "run_done", "runId": run_id, "status": "canceled"})
        except Exception as exc:
            await self.ports.runs.update_status(run_id, "failed", str(exc))
            self.ports.progress.emit({"type": "run_done", "runId": run_id, "status": "failed", "error": str(exc)})
            if raise_errors:
                raise

    async def _run(self, run_id: str, signal: Any, input: HarnessInput) -> None:
        spent_tokens = 0
        max_concurrency = min(max(1, input.max_concurrency), self.max_concurrency_cap)
        semaphore = asyncio.Semaphore(max_concurrency)
        journal = await self.ports.journal.read(run_id)
        journal_by_key = {entry.key: entry for entry in journal}
        seq = len(journal)

        async def call_agent(params: AgentRunParams) -> AgentRunResult:
            nonlocal seq, spent_tokens
            key = self._agent_key(input, params)
            hit = journal_by_key.get(key)
            if hit:
                self.ports.progress.emit({
                    "type": "agent_done",
                    "runId": run_id,
                    "agentId": hit.seq,
                    "role": params.role,
                    "targetPages": params.target_pages,
                    "result": asdict(hit.result),
                    "journalHit": True,
                })
                return hit.result

            async with semaphore:
                await self.ports.policy.assert_can_start_agent(params, spent_tokens)
                agent_id = seq
                seq += 1
                self.ports.progress.emit({
                    "type": "agent_started",
                    "runId": run_id,
                    "agentId": agent_id,
                    "role": params.role,
                    "targetPages": params.target_pages,
                })
                result = await self._run_with_retry(params, signal)
                if result.kind == "ok":
                    spent_tokens += result.usage.output_tokens
                entry = JournalEntry(key=key, seq=agent_id, role=params.role, target_pages=params.target_pages, result=result)
                await self.ports.journal.append(run_id, entry)
                self.ports.progress.emit({
                    "type": "agent_done",
                    "runId": run_id,
                    "agentId": agent_id,
                    "role": params.role,
                    "targetPages": params.target_pages,
                    "result": asdict(result),
                })
                return result

        await self._phase(run_id, "planning")
        planner = await call_agent(self._params(input, run_id, "document_planner", []))
        if planner.kind != "ok" or planner.output is None:
            raise HarnessError(planner.detail or "document planner failed")
        document_plan = planner.output
        pages = self._target_pages(input, document_plan)
        await self._phase_done(run_id, "planning")

        await self._phase(run_id, "generating")
        batches = self._batches(pages, self._batch_size(document_plan))
        page_results: list[PageResult] = []

        async def generate_batch(batch: list[int]) -> list[PageResult]:
            for page_no in batch:
                self.ports.progress.emit({"type": "page_started", "runId": run_id, "pageNo": page_no})
            params = self._params(input, run_id, "page_teacher", batch, document_plan=document_plan)
            result = await call_agent(params)
            if result.kind != "ok" or result.output is None:
                return [self._failed_page(page_no, result.detail or result.reason or "generation failed") for page_no in batch]
            ok, normalized, errors = self.ports.validator.validate(self.schemas["page_batch"], result.output)
            if not ok or normalized is None:
                self.ports.telemetry.warn("page_batch_schema_failed", {"run_id": run_id, "errors": "; ".join(errors)[:300]})
                return [self._failed_page(page_no, "schema validation failed") for page_no in batch]
            return self._page_results_from_batch(normalized, batch)

        generated_nested = await asyncio.gather(*(generate_batch(batch) for batch in batches))
        for group in generated_nested:
            for page in group:
                await self.ports.runs.upsert_page(run_id, page)
                self.ports.progress.emit({"type": "page_done", "runId": run_id, "page": self._page_event(page)})
                page_results.append(page)
        await self._phase_done(run_id, "generating")

        await self._phase(run_id, "reviewing")
        final_pages: list[PageResult] = []
        for page in page_results:
            reviewed = await self._review_or_repair(call_agent, input, run_id, document_plan, page)
            await self.ports.runs.upsert_page(run_id, reviewed)
            final_pages.append(reviewed)
        await self._phase_done(run_id, "reviewing")

        status = "needs_review" if any(page.status in {"needs_review", "failed", "needs_parser_fallback"} for page in final_pages) else "ready"
        await self.ports.runs.update_status(run_id, status)
        self.ports.progress.emit({"type": "run_done", "runId": run_id, "status": status})

    async def _run_with_retry(self, params: AgentRunParams, signal: Any) -> AgentRunResult:
        first = await self.ports.model.run_agent(params, signal)
        if first.kind == "ok":
            return first
        self.ports.telemetry.warn("agent_dead_retrying", {"role": params.role, "reason": first.reason})
        try:
            second = await self.ports.model.run_agent(params, signal)
            return second
        except Exception as exc:
            return AgentRunResult(kind="dead", usage=AgentUsage(output_tokens=0), reason="model_error", detail=str(exc))

    async def _review_or_repair(self, call_agent: Any, input: HarnessInput, run_id: str, document_plan: dict[str, Any], page: PageResult) -> PageResult:
        if page.status != "ready" or page.teaching is None:
            return page
        if self.ports.policy.should_fallback(page):
            return PageResult(page_no=page.page_no, source=page.source, teaching=page.teaching, status="needs_parser_fallback")

        review = await call_agent(self._params(input, run_id, "page_reviewer", [page.page_no], document_plan=document_plan, page_json=asdict(page)))
        if review.kind != "ok" or not review.output:
            return PageResult(page_no=page.page_no, source=page.source, teaching=page.teaching, status="needs_review", error=review.detail)
        passed = bool(review.output.get("pass"))
        if passed and page.teaching.confidence >= self.low_confidence_threshold:
            return page

        self.ports.progress.emit({
            "type": "review_issue",
            "runId": run_id,
            "pageNo": page.page_no,
            "severity": review.output.get("severity", "major"),
            "issues": review.output.get("issues", []),
        })
        repaired = await call_agent(self._params(input, run_id, "page_repairer", [page.page_no], document_plan=document_plan, page_json=asdict(page)))
        if repaired.kind != "ok" or not repaired.output:
            return PageResult(page_no=page.page_no, source=page.source, teaching=page.teaching, status="needs_review", error=repaired.detail)
        ok, normalized, errors = self.ports.validator.validate(self.schemas["page_batch"], repaired.output)
        if not ok or normalized is None:
            return PageResult(page_no=page.page_no, source=page.source, teaching=page.teaching, status="needs_review", error="repair schema failed: " + "; ".join(errors))
        repaired_pages = self._page_results_from_batch(normalized, [page.page_no])
        return repaired_pages[0] if repaired_pages else page

    def _params(
        self,
        input: HarnessInput,
        run_id: str,
        role: str,
        target_pages: list[int],
        *,
        document_plan: dict[str, Any] | None = None,
        page_json: dict[str, Any] | None = None,
    ) -> AgentRunParams:
        schema_name = "document_plan" if role == "document_planner" else "page_batch"
        return AgentRunParams(
            role=role,  # type: ignore[arg-type]
            prompt=self.prompts[role],
            model=input.model,
            schema=self.schemas[schema_name],
            pdf=input.pdf,
            target_pages=target_pages,
            document_plan=document_plan,
            page_json=page_json,
            metadata={
                "runId": run_id,
                "documentId": input.document_id,
                "promptVersion": input.prompt_version,
                "schemaVersion": input.schema_version,
            },
        )

    async def _phase(self, run_id: str, name: str) -> None:
        await self.ports.runs.update_status(run_id, name if name in {"planning", "reviewing"} else "generating")  # type: ignore[arg-type]
        self.ports.progress.emit({"type": "phase_started", "runId": run_id, "phase": name})

    async def _phase_done(self, run_id: str, name: str) -> None:
        self.ports.progress.emit({"type": "phase_done", "runId": run_id, "phase": name})

    def _agent_key(self, input: HarnessInput, params: AgentRunParams) -> str:
        payload = {
            "document_sha256": input.document_sha256,
            "role": params.role,
            "prompt_version": input.prompt_version,
            "model": params.model,
            "schema_version": input.schema_version,
            "target_pages": params.target_pages,
            "page_json": params.page_json,
        }
        raw = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _target_pages(self, input: HarnessInput, plan: dict[str, Any]) -> list[int]:
        if input.target_pages:
            return input.target_pages[: input.page_budget]
        inventory = plan.get("page_inventory") or []
        pages = [int(item["page_no"]) for item in inventory if "page_no" in item]
        if not pages:
            count = int(plan.get("page_count") or 0)
            pages = list(range(1, count + 1))
        return pages[: input.page_budget] if input.page_budget else pages

    def _batch_size(self, plan: dict[str, Any]) -> int:
        strategy = plan.get("generation_strategy") or {}
        value = int(strategy.get("recommended_batch_size") or 3)
        return max(1, min(value, 5))

    def _batches(self, pages: list[int], size: int) -> list[list[int]]:
        return [pages[i : i + size] for i in range(0, len(pages), size)]

    def _failed_page(self, page_no: int, error: str) -> PageResult:
        source = PageSource(
            page_no=page_no,
            pdf_page_ref=f"#page={page_no}",
            page_type="unknown",
            text_md="",
            parser="gpt-5.5-direct",
            ocr_used=False,
            content_hash="",
        )
        return PageResult(page_no=page_no, source=source, teaching=None, status="needs_review", error=error)

    def _page_results_from_batch(self, normalized: dict[str, Any], expected_pages: list[int]) -> list[PageResult]:
        expected = set(expected_pages)
        pages = normalized.get("pages") or []
        out: list[PageResult] = []
        for raw in pages:
            page_no = int(raw.get("page_no"))
            if page_no not in expected:
                self.ports.telemetry.warn("page_number_mismatch", {"page_no": page_no})
                continue
            source_raw = raw.get("source") or {}
            teaching_raw = raw.get("teaching") or {}
            source = PageSource(
                page_no=page_no,
                pdf_page_ref=source_raw.get("pdf_page_ref", f"#page={page_no}"),
                page_type=source_raw.get("page_type", "unknown"),
                text_md=source_raw.get("text_md", ""),
                parser=source_raw.get("parser", "gpt-5.5-direct"),
                ocr_used=bool(source_raw.get("ocr_used", False)),
                content_hash=source_raw.get("content_hash", ""),
            )
            evidence = [
                item if isinstance(item, dict) else {}
                for item in teaching_raw.get("evidence", [])
            ]
            teaching = PageTeaching(
                slide_title=teaching_raw.get("slide_title", ""),
                speaker_notes_md=teaching_raw.get("speaker_notes_md", ""),
                concepts=list(teaching_raw.get("concepts", [])),
                prerequisites=list(teaching_raw.get("prerequisites", [])),
                contextual_bridge=teaching_raw.get("contextual_bridge", ""),
                visual_explanations=list(teaching_raw.get("visual_explanations", [])),
                formula_explanations=list(teaching_raw.get("formula_explanations", [])),
                evidence=[
                    Evidence(
                        kind=item.get("kind", "other"),
                        quote_or_reference=item.get("quote_or_reference", ""),
                    )
                    for item in evidence
                ],
                confidence=float(teaching_raw.get("confidence", 0)),
                needs_review=bool(teaching_raw.get("needs_review", False)),
                needs_parser_fallback=bool(teaching_raw.get("needs_parser_fallback", False)),
            )
            status = "needs_parser_fallback" if teaching.needs_parser_fallback else "needs_review" if teaching.needs_review else "ready"
            out.append(PageResult(page_no=page_no, source=source, teaching=teaching, status=status))
        return out

    def _page_event(self, page: PageResult) -> dict[str, Any]:
        return asdict(page)
