from __future__ import annotations

from dataclasses import dataclass

from .types import AgentRunParams, HarnessInput, PageResult


class PolicyError(RuntimeError):
    pass


@dataclass(frozen=True)
class DeterministicPolicyGate:
    low_confidence_threshold: float = 0.78
    max_target_pages_per_call: int = 5
    allow_network_model_calls: bool = True

    async def assert_can_start_run(self, input: HarnessInput) -> None:
        if not input.document_id:
            raise PolicyError("document_id is required")
        if not input.document_sha256:
            raise PolicyError("document_sha256 is required")
        if input.max_concurrency < 1:
            raise PolicyError("max_concurrency must be >= 1")
        if not self.allow_network_model_calls:
            raise PolicyError("network model calls are disabled by policy")

    async def assert_can_start_agent(self, params: AgentRunParams, spent_tokens: int) -> None:
        if len(params.target_pages) > self.max_target_pages_per_call:
            raise PolicyError("too many pages in one agent call")
        if not params.schema:
            raise PolicyError("agent call requires a JSON schema")

    def should_fallback(self, page: PageResult) -> bool:
        if page.teaching is None:
            return True
        if page.teaching.needs_parser_fallback:
            return True
        if not page.teaching.evidence:
            return True
        if page.teaching.confidence < self.low_confidence_threshold:
            return True
        return False

