"""A deterministic offline model with a few switchable policies.

This is not a stand-in for a language model; it is a stand-in for *the shape of a
model's output*. It reads only the context it is given — the same observation
summary a real model would see — and it never looks at the world directly. That
restriction is what makes the demo honest: if the mock can decide the next action
from the observations alone, then the observation design is sufficient, and the
question of whether a real model helps becomes an empirical one rather than a
structural one.

Policies exist so the reliability scenarios can provoke a specific failure without
touching the runtime:

``research``  the nine-round story used by the main demo
``escalate``  propose a tool that was never registered, to exercise the gate
``loop``      repeat one harmless read until the call budget runs out
"""

from __future__ import annotations

from typing import Any, Callable

from ..core.contracts import PLAN_VERSION, AgentError
from .base import Proposal

__all__ = ["MockProvider"]


class MockProvider:
    """Offline, deterministic, zero-dependency proposal source."""

    name = "offline-mock"
    model = "offline-deterministic-mock-v1"

    #: Synthetic accounting so the demo can show a budget being consumed.
    TOKENS_PER_CALL = 880
    COST_PER_CALL_MICROUSD = 420

    def __init__(
        self,
        *,
        policy: str = "research",
        fail_at_call: int | None = None,
        issue_receipt: Callable[..., str] | None = None,
    ) -> None:
        if policy not in ("research", "escalate", "loop"):
            raise ValueError(f"unknown mock policy {policy!r}")
        self.policy = policy
        self.fail_at_call = fail_at_call
        self.issue_receipt = issue_receipt
        self.calls = 0

    def propose(self, context: dict[str, Any]) -> Proposal:
        """Choose exactly one next action from the observation summary."""
        self.calls += 1
        step = self._next_step(context["state"])
        plan = {"version": PLAN_VERSION, "steps": [step]}

        if self.fail_at_call is not None and self.fail_at_call == self.calls:
            # The response was produced and a receipt was persisted, but the
            # runtime never saw it. That is precisely the state an operator can
            # later reconcile — and precisely the state that must not be retried.
            if self.issue_receipt is not None:
                self.issue_receipt(
                    intent=context.get("intent", {}),
                    plan=plan,
                    usage={"provider": self.name, "model": self.model, "tokens": self.TOKENS_PER_CALL},
                )
            raise AgentError("PROVIDER_TIMEOUT", "the provider did not answer within the deadline")

        return Proposal(
            plan=plan,
            provider=self.name,
            model=self.model,
            tokens=self.TOKENS_PER_CALL,
            cost_microusd=self.COST_PER_CALL_MICROUSD,
            latency_ms=0,
            metadata={"policy": self.policy, "round": context.get("round", 0)},
        )

    # ------------------------------------------------------------------ policy

    def _next_step(self, state: dict[str, Any]) -> dict[str, Any]:
        if self.policy == "escalate":
            return self._escalate()
        if self.policy == "loop":
            return self._step("s1", "list_documents", {})
        return self._research(state)

    @staticmethod
    def _escalate() -> dict[str, Any]:
        """Propose a tool the host never registered.

        The name is syntactically valid, so the plan schema accepts it. The gate
        is what refuses it, which is the point: schema validity is not authority.
        """
        return {"id": "s9", "tool": "write_document", "arguments": {"doc_id": "doc_fy2024"}}

    def _research(self, state: dict[str, Any]) -> dict[str, Any]:
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
