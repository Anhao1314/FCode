"""Single-action mechanics: propose, gate, execute, verify.

This is the smallest unit of the runtime. It knows how to ask a model for one
proposal, how to refuse it, how to run one read, and how to re-derive the final
answer independently. It deliberately knows nothing about *how many* rounds
happen — that is :mod:`flowagent.runtime.loop`.

The split matters for an interview question like "what stops the model from
looping forever?" The answer is not in this file; it is in the loop's round
budget and in the verifier's refusal to accept an unproven result.
"""

from __future__ import annotations

from typing import Any, Protocol

from ..core.contracts import AgentError, Task, validate_plan
from ..core.store import TaskStore
from ..providers.base import Proposal, Provider
from ..tools.base import Observation
from ..tools.registry import ToolRegistry
from .budget import Budget, BudgetLimits
from .permissions import GateDecision, Permissions

__all__ = ["Harness", "TraceObserver"]


class TraceObserver(Protocol):
    """Receives structured signals so the demo can render and record one run."""

    def round_start(self, round_no: int, budget: dict[str, Any]) -> None: ...
    def proposal(self, round_no: int, proposal: Proposal) -> None: ...
    def gate(self, round_no: int, decision: GateDecision) -> None: ...
    def observation(self, round_no: int, observation: Observation) -> None: ...
    def round_end(self, round_no: int, budget: dict[str, Any]) -> None: ...
    def terminal(self, task: Task, result: dict[str, Any] | None) -> None: ...


class Harness:
    """Executes exactly one proposal at a time against a durable task."""

    #: Conservative reservation charged before a model call is dispatched.
    RESERVED_TOKENS = 1_000
    RESERVED_COST_MICROUSD = 500

    def __init__(
        self,
        *,
        store: TaskStore,
        registry: ToolRegistry,
        provider: Provider,
        world: Any,
        limits: BudgetLimits,
    ) -> None:
        self.store = store
        self.registry = registry
        self.provider = provider
        self.world = world
        self.limits = limits

    # ------------------------------------------------------------------ setup

    def create(
        self,
        *,
        task_id: str,
        objective: str,
        principal: str,
        binding: dict[str, Any],
        allowed_tools: list[str],
        grant: dict[str, Any],
    ) -> Task:
        task = Task(
            id=task_id,
            principal=principal,
            objective=objective,
            binding=binding,
            allowed_tools=list(allowed_tools),
            model_grant=dict(grant),
        )
        return self.store.create(task)

    def budget(self, task: Task) -> Budget:
        return Budget(self.store, f"task:{task.id}", self.limits)

    def permissions(self, task: Task) -> Permissions:
        return Permissions(self.registry, task.allowed_tools, task.model_grant)

    # -------------------------------------------------------------- mechanics

    def propose(self, task: Task, context: dict[str, Any]) -> tuple[Task, Proposal]:
        """Ask the model for one proposal and commit it as a plan-less round.

        The plan is *not* written into ``task.plan``: in loop mode each round is
        a fresh proposal, and the task-level plan is reserved for the single-shot
        path. Keeping them separate is what lets the store keep enforcing "a
        validated plan is immutable" without blocking round two.
        """
        first = task.status == "created"
        if first:
            task = self._commit(
                task,
                task.advance("planning").with_model(status="started", attempts=task.model.attempts + 1),
                "model_started",
                {"round": context["round"]},
            )
        else:
            task = self._commit(
                task,
                task.with_model(attempts=task.model.attempts + 1),
                "model_started",
                {"round": context["round"]},
            )

        # Charge before dispatch. A provider that never answers still costs.
        self.budget(task).charge_call(
            tokens=self.RESERVED_TOKENS,
            cost_microusd=self.RESERVED_COST_MICROUSD,
        )

        proposal = self.provider.propose(context)
        plan = validate_plan(proposal.plan)

        updated = task.with_model(
            status="validated",
            proposal=plan.to_dict(),
            receipt=proposal.receipt(),
        )
        if first:
            updated = updated.advance("planned")
        return self._commit(updated, updated, "plan_validated", {"plan": plan.to_dict(), "round": context["round"]}), proposal

    def gate(self, task: Task, step: dict[str, Any]) -> GateDecision:
        """Ask the host gate about one step. Never raises for a denial."""
        return self.permissions(task).gate(step["tool"], step.get("arguments") or {})

    def execute(self, task: Task, step: dict[str, Any]) -> tuple[Task, Observation]:
        """Run one gated read and commit the observation."""
        if task.status == "planned":
            task = self._commit(task, task.advance("running"), "execution_started", {})

        self.budget(task).charge_read()
        task = self._commit(
            task,
            task,
            "tool_started",
            {"tool": step["tool"], "arguments": step.get("arguments") or {}},
        )
        try:
            observation = self.registry.execute(step["tool"], step.get("arguments") or {})
        except AgentError as error:
            failed = task
            failed.failure = error.to_dict()
            failed = self._commit(failed, failed, "tool_failed", {"code": error.code})
            raise
        return self._commit(task, task, "tool_succeeded", {"tool": observation.tool, "result_hash": observation.result_hash}), observation

    def verify(self, observation: Observation) -> dict[str, Any]:
        """Recompute the answer from the world and compare it with the model's.

        The model never produced these numbers; it only asked for them. This
        method is what turns "the tool returned something" into "the runtime
        independently agrees", and it is the only path to ``succeeded``.
        """
        if observation.tool != "calculate_margin" or not observation.result.get("computed"):
            raise AgentError("RESULT_INCOMPLETE", "no computed margin to verify")
        recomputed = self.world.calculate_margin()
        if not recomputed.get("computed"):
            raise AgentError("RESULT_INCOMPLETE", "the world refuses to recompute the margin")
        for key in ("margin_bp_2024", "margin_bp_2025", "change_bp"):
            if recomputed[key] != observation.result[key]:
                raise AgentError(
                    "RESULT_VERIFICATION_FAILED",
                    f"{key} differs: recorded {observation.result[key]} vs recomputed {recomputed[key]}",
                )
        return {
            "verified": True,
            "verification": "runtime-recomputed",
            "result": recomputed,
        }

    # ------------------------------------------------------------------ helper

    def finalize(
        self,
        task: Task,
        status: str,
        *,
        result: dict[str, Any] | None = None,
        failure: dict[str, Any] | None = None,
        event: str = "task_finished",
        detail: dict[str, Any] | None = None,
    ) -> Task:
        """Move a task to a terminal state and commit it.

        Kept public because the loop owns termination policy while the harness
        owns the mechanics of writing it down.
        """
        updated = task.advance(status)
        if result is not None:
            updated.result = result
        if failure is not None:
            updated.failure = failure
        return self._commit(task, updated, event, detail or {})

    def _commit(self, previous: Task, updated: Task, event: str, detail: dict[str, Any]) -> Task:
        """Advance the sequence and write one event plus the new body."""
        expected = previous.sequence
        updated.sequence = expected + 1
        return self.store.save(updated, expected, event, detail)
