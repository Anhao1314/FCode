"""Multi-round driver: follow a plan, one action per round.

Three properties are implemented here rather than in the harness.

**The plan is derived, not trusted.** On every run the plan is rebuilt by
replaying the committed observations through the domain planner. The snapshot in
the task body is for display and for resuming quickly; the log is what decides.
A crash between "observation committed" and "plan updated" therefore costs
nothing — the replay catches up on its own.

**Resumption does not repeat work.** If the last committed event is a
reconciliation, the loop executes the already-approved proposal instead of asking
the model again. Asking again would be a second paid call for the same round.

**Termination is the plan's, then the verifier's.** The loop stops when nothing
is open. It only reports success when the runtime recomputes the answer and
agrees, and only reports failure when the plan says a todo is genuinely blocked.
"""

from __future__ import annotations

from typing import Any

from ..core.contracts import AgentError, Task
from ..core.plan import Plan
from ..memory.context import WorkingMemory
from ..tools.base import Observation
from .control import Control, Denial
from .harness import Harness, TraceObserver

__all__ = ["Loop", "NullObserver"]


class NullObserver:
    """A do-nothing observer, so the loop can run headless."""

    def round_start(self, round_no: int, budget: dict[str, Any], plan: Any = None) -> None: ...
    def proposal(self, round_no: int, proposal: Any) -> None: ...
    def gate(self, round_no: int, decision: Any) -> None: ...
    def observation(self, round_no: int, observation: Observation) -> None: ...
    def round_end(self, round_no: int, budget: dict[str, Any], plan: Any = None) -> None: ...
    def terminal(self, task: Task, result: dict[str, Any] | None) -> None: ...


class Loop:
    """Runs rounds until the plan is settled or the runtime must stop."""

    def __init__(
        self,
        harness: Harness,
        *,
        planner: Any = None,
        max_rounds: int = 12,
        observer: TraceObserver | None = None,
        control: Control | None = None,
    ) -> None:
        self.harness = harness
        self.planner = planner
        self.max_rounds = max_rounds
        self.observer: TraceObserver = observer or NullObserver()
        self.control = control

    def run(self, task_id: str) -> Task:
        task = self.harness.store.load(task_id)
        memory = self.restore(task)
        plan = self.rebuild_plan(task, memory)
        pending = self.pending_step(task)

        while True:
            if pending is None and self.control is not None:
                controlled = self.control.before_round(
                    round_no=task.model.attempts + 1,
                    task=task,
                    plan=plan,
                )
                task, plan = controlled.task, controlled.plan

            if pending is None:
                if plan.is_blocked():
                    return self._stop(task, plan, "PLAN_BLOCKED")
                if plan.is_complete() or plan.next_open() is None:
                    return self._stop(task, plan, "PLAN_EXHAUSTED")
                if task.model.attempts >= self.max_rounds:
                    return self._abort(task_id, AgentError("ROUND_LIMIT", f"no verified result after {self.max_rounds} rounds"))

            budget_snapshot = self.harness.budget(task).snapshot()

            if pending is not None:
                # A reconciled round: the proposal is already approved and paid
                # for. Execute it; do not ask the model again.
                step = pending
                pending = None
                round_no = task.model.attempts
                self.observer.round_start(round_no, budget_snapshot, plan)
            else:
                round_no = task.model.attempts + 1
                self.observer.round_start(round_no, budget_snapshot, plan)
                context = memory.build(round_no, budget_snapshot, plan)
                try:
                    task, proposal = self.harness.propose(task, context)
                except AgentError as error:
                    return self._abort(task_id, error)
                if proposal is None:
                    self.observer.terminal(task, None)
                    return task
                self.observer.proposal(round_no, proposal)
                step = proposal.plan["steps"][0]

            decision = self.harness.gate(task, step)
            self.observer.gate(round_no, decision)
            if not decision.allowed:
                return self._deny(task, decision, plan)

            if self.control is not None:
                approval = self.control.before_tool(
                    round_no=round_no,
                    task=task,
                    step=step,
                    decision=decision,
                )
                task = approval.task
                if not approval.allowed:
                    if approval.terminated:
                        self.observer.terminal(task, None)
                        return task
                    return self._deny(
                        task,
                        Denial(
                            tool=step["tool"],
                            code=approval.code or "OPERATOR_DENIED",
                            reason=approval.reason or "operator denied the call",
                        ),
                        plan,
                    )

            try:
                task, observation = self.harness.execute(task, step, round_no=round_no)
            except AgentError as error:
                return self._abort(task_id, error)

            memory.record(round_no, observation)
            plan = self.planner.advance(plan, observation) if self.planner else plan
            task = self._persist_plan(task, plan, round_no)

            self.observer.observation(round_no, observation)
            self.observer.round_end(round_no, self.harness.budget(task).snapshot(), plan)

            if observation.tool == "calculate_margin" and observation.result.get("computed"):
                verified = self.harness.verify(observation)
                return self._succeed(task, verified, plan)

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

    def rebuild_plan(self, task: Task, memory: WorkingMemory) -> Plan:
        """Derive the current plan from the log, including operator revisions.

        The stored snapshot is not trusted here. If a process died between
        committing an observation and updating the plan, the snapshot is one
        step behind; the replay is always right. When an operator revised the
        plan, the latest revision becomes the base and only observations after
        it are replayed — otherwise a restart would silently undo the decision.
        """
        if self.planner is None:
            return Plan(goal=task.objective)
        events = self.harness.store.events(task.id)
        base = Plan.from_dict(task.plan_state) if task.plan_state else self.planner.decompose(task.objective)
        revised_after: int | None = None
        for event in events:
            if event["type"] != "plan_steered":
                continue
            detail = event["payload"].get("detail") or {}
            if detail.get("plan"):
                base = Plan.from_dict(detail["plan"])
                revised_after = int(event["sequence"])
        for event in events:
            if revised_after is not None and int(event["sequence"]) <= revised_after:
                continue
            if event["type"] != "tool_succeeded":
                continue
            detail = event["payload"].get("detail", {})
            base = self.planner.advance(
                base,
                Observation(
                    tool=detail["tool"],
                    arguments=detail.get("arguments", {}),
                    result=detail["result"],
                    result_hash=detail["result_hash"],
                ),
            )
        return base

    def pending_step(self, task: Task) -> dict[str, Any] | None:
        """Return an approved-but-unexecuted step, if reconciliation left one."""
        if task.model.status != "validated" or not task.model.proposal:
            return None
        events = self.harness.store.events(task.id)
        if not events or events[-1]["type"] != "model_reconciled":
            return None
        return task.model.proposal["steps"][0]

    # --------------------------------------------------------------- terminals

    def _persist_plan(self, task: Task, plan: Plan, round_no: int) -> Task:
        task.plan_state = plan.to_dict()
        return self.harness.record(task, "plan_updated", {"round": round_no, "plan": plan.to_dict()})

    def _succeed(self, task: Task, verified: dict[str, Any], plan: Plan) -> Task:
        result = dict(verified["result"])
        result["verification"] = verified["verification"]
        result["plan"] = plan.progress()
        task = self.harness.finalize(task, "verifying", result=None, event="verification_started")
        task = self.harness.finalize(task, "succeeded", result=result, event="task_succeeded")
        self.observer.terminal(task, result)
        return task

    def _deny(self, task: Task, decision: Any, plan: Plan) -> Task:
        task = self.harness.finalize(
            task,
            "denied",
            failure={"code": decision.code, "message": decision.reason, "retryable": False},
            event="tool_denied",
            detail={"tool": decision.tool, "code": decision.code, "plan": plan.progress()},
        )
        self.observer.terminal(task, None)
        return task

    def _stop(self, task: Task, plan: Plan, code: str) -> Task:
        blocked = [todo.to_dict() for todo in plan.todos if todo.status == "blocked"]
        task = self.harness.finalize(
            task,
            "failed",
            failure={
                "code": "INSUFFICIENT_EVIDENCE" if code == "PLAN_BLOCKED" else "PLAN_INCOMPLETE",
                "message": "; ".join(item["reason"] for item in blocked if item["reason"]) or "the plan has no remaining action",
                "retryable": False,
            },
            event="task_stopped",
            detail={"code": code, "plan": plan.progress(), "blocked": blocked},
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
