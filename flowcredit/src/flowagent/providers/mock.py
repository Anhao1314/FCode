"""A deterministic offline model.

This is not a stand-in for a language model; it is a stand-in for *the shape of
a model's output*. It reads only the context it is given — the same observation
summary a real model would see — and it never looks at the world directly. That
restriction is what makes the demo honest: if the mock can decide the next action
from the observations alone, then the observation design is sufficient, and the
question of whether a real model helps becomes an empirical one rather than a
structural one.

The policy is a fixed priority list. It is intentionally simple, because the
demo's claim is about the runtime's guarantees, not about model quality.
"""

from __future__ import annotations

from typing import Any

from ..core.contracts import PLAN_VERSION
from .base import Proposal

__all__ = ["MockProvider"]


class MockProvider:
    """Offline, deterministic, zero-dependency proposal source."""

    name = "offline-mock"
    model = "offline-deterministic-mock-v1"

    #: Synthetic accounting so the demo can show a budget being consumed.
    TOKENS_PER_CALL = 880
    COST_PER_CALL_MICROUSD = 420

    def propose(self, context: dict[str, Any]) -> Proposal:
        """Choose exactly one next action from the observation summary."""
        state = context["state"]
        step = self._next_step(state)
        plan = {"version": PLAN_VERSION, "steps": [step]}
        return Proposal(
            plan=plan,
            provider=self.name,
            model=self.model,
            tokens=self.TOKENS_PER_CALL,
            cost_microusd=self.COST_PER_CALL_MICROUSD,
            latency_ms=0,
            metadata={"policy": "deterministic-priority-v1", "round": context.get("round", 0)},
        )

    # ------------------------------------------------------------------ policy

    def _next_step(self, state: dict[str, Any]) -> dict[str, Any]:
        read = set(state.get("read_documents", []))
        normalised = set(state.get("normalised_documents", []))
        reconciled_periods = set(state.get("reconciled_periods", []))
        computed = bool(state.get("computed"))

        if not state.get("listed_documents"):
            return self._step("s1", "list_documents", {})
        if "doc_fy2024" not in read:
            return self._step("s2", "read_document", {"doc_id": "doc_fy2024"})
        if "doc_fy2025" not in read:
            return self._step("s3", "read_document", {"doc_id": "doc_fy2025"})
        if not state.get("restatement_checked"):
            return self._step("s4", "check_restatement", {"doc_id": "doc_fy2024"})
        if "doc_fy2025_adjusted" not in read:
            return self._step("s5", "read_document", {"doc_id": "doc_fy2025_adjusted"})
        if "FY2025" not in reconciled_periods:
            return self._step("s6", "reconcile_basis", {"doc_id": "doc_fy2025_adjusted"})
        if "doc_fy2024_restated" not in normalised:
            return self._step("s7", "normalize_units", {"doc_id": "doc_fy2024_restated"})
        if "doc_fy2025" not in normalised:
            return self._step("s8", "normalize_units", {"doc_id": "doc_fy2025"})
        if not computed:
            return self._step("s9", "calculate_margin", {})
        return self._step("s10", "report_blocked", {"reason": "insufficient_evidence"})

    @staticmethod
    def _step(step_id: str, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return {"id": step_id, "tool": tool, "arguments": arguments}
