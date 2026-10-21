"""The credit-DD blueprint and its honest todo transitions.

The blueprint is fixed for the spike: six steps, in dependency order. A todo is
``done`` only when the observation it names actually arrived. A tool that says
the evidence is missing marks its todo ``blocked``; a todo that depends on a
blocked step is ``abandoned`` rather than optimistically attempted. There is no
retry and no appended step.
"""

from __future__ import annotations

from typing import Any

from flowagent.core.plan import Plan, Todo
from flowagent.tools.base import Observation

__all__ = ["CreditPlanner", "BLUEPRINT", "DEPENDENTS"]

#: Six steps a complete two-metric credit check needs. c5 depends on the debt
#: schedule read in c4; c6 depends only on the FY2025 annual report in c3.
BLUEPRINT: tuple[Todo, ...] = (
    Todo("c1", "列出本次信用核查可用的资料", "list_documents", "listed"),
    Todo(
        "c2",
        "读取 FY2024 年报，确认单位与口径",
        "read_document",
        "read:doc_ar_fy2024",
        {"doc_id": "doc_ar_fy2024"},
    ),
    Todo(
        "c3",
        "读取 FY2025 年报，确认单位与口径",
        "read_document",
        "read:doc_ar_fy2025",
        {"doc_id": "doc_ar_fy2025"},
    ),
    Todo(
        "c4",
        "读取 FY2025 债务明细",
        "read_document",
        "read:doc_debt_fy2025",
        {"doc_id": "doc_debt_fy2025"},
    ),
    Todo(
        "c5",
        "计算 FY2025 净负债 / EBITDA",
        "compute_credit_metric",
        "computed:net_debt_to_ebitda:FY2025",
        {"metric": "net_debt_to_ebitda", "period": "FY2025"},
    ),
    Todo(
        "c6",
        "计算 FY2025 利息覆盖倍数",
        "compute_credit_metric",
        "computed:interest_coverage:FY2025",
        {"metric": "interest_coverage", "period": "FY2025"},
    ),
)

#: A blocked todo abandons the steps that can no longer be attempted.
DEPENDENTS: dict[str, tuple[str, ...]] = {
    "c3": ("c6",),
    "c4": ("c5",),
}

#: Which todo each successful observation settles, keyed by the call's shape.
_OWNER: dict[tuple[str, str, str, str], str] = {
    ("list_documents", "", "", ""): "c1",
    ("read_document", "doc_ar_fy2024", "", ""): "c2",
    ("read_document", "doc_ar_fy2025", "", ""): "c3",
    ("read_document", "doc_debt_fy2025", "", ""): "c4",
    ("compute_credit_metric", "", "net_debt_to_ebitda", "FY2025"): "c5",
    ("compute_credit_metric", "", "interest_coverage", "FY2025"): "c6",
}


class CreditPlanner:
    """Decomposes the goal, then settles todos from observations."""

    def decompose(self, goal: str) -> Plan:
        return Plan(goal=goal, todos=[_copy(todo) for todo in BLUEPRINT], revision=1)

    def advance(self, plan: Plan, observation: Observation) -> Plan:
        todo_id = self._owner(observation)
        if todo_id is None or not any(todo.id == todo_id for todo in plan.todos):
            return plan

        todo = next(todo for todo in plan.todos if todo.id == todo_id)
        if todo.status in ("done", "abandoned", "blocked"):
            return plan

        if self._satisfied(observation):
            return plan.mark(todo_id, "done", evidence=(observation.result_hash,))

        # The tool ran and reported that it could not produce the result. That
        # is a domain finding, not a transient error: block it and abandon its
        # dependents. The loop decides when a blocked plan must stop.
        plan = plan.mark(todo_id, "blocked", reason=self._reason(observation))
        return self._abandon_dependents(plan, todo_id)

    # ------------------------------------------------------------------ rules

    @staticmethod
    def _owner(observation: Observation) -> str | None:
        arguments = observation.arguments or {}
        return _OWNER.get(
            (
                observation.tool,
                str(arguments.get("doc_id", "")),
                str(arguments.get("metric", "")),
                str(arguments.get("period", "")),
            )
        )

    @staticmethod
    def _satisfied(observation: Observation) -> bool:
        result: dict[str, Any] = observation.result
        if observation.tool == "list_documents":
            return bool(result.get("documents"))
        if observation.tool == "read_document":
            return bool(result.get("found"))
        if observation.tool == "compute_credit_metric":
            return bool(result.get("computed"))
        return True

    @staticmethod
    def _reason(observation: Observation) -> str:
        result: dict[str, Any] = observation.result
        return (
            result.get("reason")
            or "; ".join(result.get("blockers") or [])
            or "tool reported no usable result"
        )

    @staticmethod
    def _abandon_dependents(plan: Plan, todo_id: str) -> Plan:
        for dependent in DEPENDENTS.get(todo_id, ()):
            current = next((todo for todo in plan.todos if todo.id == dependent), None)
            if current is None or current.status not in ("pending", "active"):
                continue
            plan = plan.mark(
                dependent,
                "abandoned",
                reason=f"dependency {todo_id} is blocked",
            )
        return plan


def _copy(todo: Todo) -> Todo:
    """Return a fresh Todo so a plan revision cannot mutate the blueprint."""
    return Todo(
        id=todo.id,
        text=todo.text,
        tool=todo.tool,
        done_when=todo.done_when,
        arguments=dict(todo.arguments),
        status=todo.status,
        evidence=todo.evidence,
        reason=todo.reason,
    )
