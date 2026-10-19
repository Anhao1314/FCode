"""Multi-round driver: one action per round, termination owned by the runtime.

Two properties are implemented here rather than in the harness.

**Resumption.** The loop rebuilds its working memory from the event log instead
of keeping it in a Python object. A process that dies after a tool call can
therefore restart and know what it already read, which is what makes "recovery
does not repeat work" true rather than aspirational.

**No duplicate dispatch after reconciliation.** If the last committed event is a
reconciliation, the loop executes the already-approved proposal instead of asking
the model again. Asking again would be a second paid call for the same round.
"""

from __future__ import annotations

from typing import Any

from ..core.contracts import AgentError, Task
from ..memory.context import WorkingMemory
from ..tools.base import Observation
from .harness import Harness, TraceObserver

__all__ = ["Loop", "NullObserver"]


class NullObserver:
    """A do-nothing observer, so the loop can run headless."""

    def round_start(self, round_no: int, budget: dict[str, Any]) -> None: ...
    def proposal(self, round_no: int, proposal: Any) -> None: ...
    def gate(self, round_no: int, decision: Any) -> None: ...
    def observation(self, round_no: int, observation: Observation) -> None: ...
    def round_end(self, round_no: int, budget: dict[str, Any]) -> None: ...
    def terminal(self, task: Task, result: dict[str, Any] | None) -> None: ...


class Loop:
    """Runs rounds until the runtime can prove an answer or must stop."""

    def __init__(
        self,
        harness: Harness,
        *,
        max_rounds: int = 12,
        observer: TraceObserver | None = None,
    ) -> None:
        self.harness = harness
        self.max_rounds = max_rounds
        self.observer: TraceObserver = observer or NullObserver()

    def run(self, task_id: str) -> Task:
        task = self.harness.store.load(task_id)
        memory = self.restore(task)
        pending = self.pending_step(task)

        while True:
            if pending is None and task.model.attempts >= self.max_rounds:
                return self._abort(task_id, AgentError("ROUND_LIMIT", f"no verified result after {self.max_rounds} rounds"))

            budget_snapshot = self.harness.budget(task).snapshot()

            if pending is not None:
                # A reconciled round: the proposal is already approved and paid
                # for. Execute it; do not ask the model again.
                step = pending
                pending = None
                round_no = task.model.attempts
                self.observer.round_start(round_no, budget_snapshot)
            else:
                round_no = task.model.attempts + 1
                self.observer.round_start(round_no, budget_snapshot)
                context = memory.build(round_no, budget_snapshot)
                try:
                    task, proposal = self.harness.propose(task, context)
                except AgentError as error:
                    return self._abort(task_id, error)
                if proposal is None:
                    # propose() already committed a terminal state.
                    self.observer.terminal(task, None)
                    return task
                self.observer.proposal(round_no, proposal)
                step = proposal.plan["steps"][0]

            decision = self.harness.gate(task, step)
            self.observer.gate(round_no, decision)
            if not decision.allowed:
                return self._deny(task, decision)

            try:
                task, observation = self.harness.execute(task, step, round_no=round_no)
            except AgentError as error:
                return self._abort(task_id, error)

            memory.record(round_no, observation)
            self.observer.observation(round_no, observation)
            self.observer.round_end(round_no, self.harness.budget(task).snapshot())

            if observation.tool == "calculate_margin" and observation.result.get("computed"):
                verified = self.harness.verify(observation)
                return self._succeed(task, verified)

            if observation.tool == "report_blocked":
                # The model asked to stop. The runtime checks whether the world
                # agrees that no further read could resolve the gap.
                if not self.harness.world.calculate_margin().get("computed"):
                    return self._stop_insufficient(task, observation)

    # -------------------------------------------------------------- resumption

    def restore(self, task: Task) -> WorkingMemory:
        """Rebuild working memory from committed observations."""
        memory = WorkingMemory(
            objective=task.objective,
            tool_catalog=self.harness.registry.catalog(),
        )
        for event in self.harness.store.events(task.id):
            if event["type"] != "tool_succeeded":
                continue
            detail = event["payload"].get("detail", {})
            memory.record(
                int(detail.get("round", 0)),
                Observation(
                    tool=detail["tool"],
                    arguments=detail.get("arguments", {}),
                    result=detail["result"],
                    result_hash=detail["result_hash"],
                ),
            )
        return memory

    def pending_step(self, task: Task) -> dict[str, Any] | None:
        """Return an approved-but-unexecuted step, if reconciliation left one."""
        if task.model.status != "validated" or not task.model.proposal:
            return None
        events = self.harness.store.events(task.id)
        if not events or events[-1]["type"] != "model_reconciled":
            return None
        return task.model.proposal["steps"][0]

    # --------------------------------------------------------------- terminals

    def _succeed(self, task: Task, verified: dict[str, Any]) -> Task:
        result = dict(verified["result"])
        result["verification"] = verified["verification"]
        task = self.harness.finalize(task, "verifying", result=None, event="verification_started")
        task = self.harness.finalize(task, "succeeded", result=result, event="task_succeeded")
        self.observer.terminal(task, result)
        return task

    def _deny(self, task: Task, decision: Any) -> Task:
        task = self.harness.finalize(
            task,
            "denied",
            failure={"code": decision.code, "message": decision.reason, "retryable": False},
            event="tool_denied",
            detail={"tool": decision.tool, "code": decision.code},
        )
        self.observer.terminal(task, None)
        return task

    def _stop_insufficient(self, task: Task, observation: Observation) -> Task:
        reason = observation.result.get("reason", "insufficient_evidence")
        task = self.harness.finalize(
            task,
            "failed",
            failure={"code": "INSUFFICIENT_EVIDENCE", "message": reason, "retryable": False},
            event="task_stopped_insufficient",
            detail={"reason": reason},
        )
        self.observer.terminal(task, None)
        return task

    def _abort(self, task_id: str, error: AgentError) -> Task:
        task = self.harness.store.load(task_id)
        if task.status in ("succeeded", "denied", "failed", "recovery_required"):
            self.observer.terminal(task, None)
            return task
        task = self.harness.finalize(
            task,
            "failed",
            failure=error.to_dict(),
            event="task_failed",
            detail={"code": error.code},
        )
        self.observer.terminal(task, None)
        return task
