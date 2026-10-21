"""The fourteen-step credit blueprint and its honest todo transitions.

The blueprint is deliberately boring: read the evidence, check the FY2024
restatement, read the FY2025 annual report, debt schedule and rating report,
then compute the eight metrics. A missing debt schedule blocks c5 and abandons
the four debt-dependent metric todos; the remaining metrics still run so the
memo can state exactly what was and was not provable.

There is no retry and no appended step. ``report_blocked`` is not a todo: the
loop turns a blocked plan into ``INSUFFICIENT_EVIDENCE`` on its own.
"""

from __future__ import annotations

from typing import Any

from flowagent.core.plan import Plan, Todo
from flowagent.tools.base import Observation

__all__ = ["CreditPlanner", "BLUEPRINT", "DEPENDENTS"]

#: Fourteen ordinary todos. The conditional terminal (``report_blocked``) is
#: owned by the runtime, not by this blueprint.
BLUEPRINT: tuple[Todo, ...] = (
    Todo("c1", "列出本次信用核查可用的资料", "list_documents", "listed"),
    Todo(
        "c2",
        "读取 FY2024 年报，确认单位、重述与口径",
        "read_document",
        "read:doc_ar_fy2024",
        {"doc_id": "doc_ar_fy2024"},
    ),
    Todo(
        "c3",
        "检查 FY2024 是否被后续说明重述",
        "check_restatement",
        "restatement_checked",
        {"doc_id": "doc_ar_fy2024"},
    ),
    Todo(
        "c4",
        "读取 FY2025 年报，确认单位与口径",
        "read_document",
        "read:doc_ar_fy2025",
        {"doc_id": "doc_ar_fy2025"},
    ),
    Todo(
        "c5",
        "读取 FY2025 债务明细",
        "read_document",
        "read:doc_debt_fy2025",
        {"doc_id": "doc_debt_fy2025"},
    ),
    Todo(
        "c6",
        "读取 FY2025 评级报告",
        "read_document",
        "read:doc_rating_fy2025",
        {"doc_id": "doc_rating_fy2025"},
    ),
    Todo(
        "c7",
        "计算 FY2025 净负债 / EBITDA",
        "compute_credit_metric",
        "computed:net_debt_to_ebitda:FY2025",
        {"metric": "net_debt_to_ebitda", "period": "FY2025"},
    ),
    Todo(
        "c8",
        "计算 FY2025 利息覆盖倍数",
        "compute_credit_metric",
        "computed:interest_coverage:FY2025",
        {"metric": "interest_coverage", "period": "FY2025"},
    ),
    Todo(
        "c9",
        "计算 FY2025 经营现金流 / 短期债务",
        "compute_credit_metric",
        "computed:ocf_to_short_term_debt:FY2025",
        {"metric": "ocf_to_short_term_debt", "period": "FY2025"},
    ),
    Todo(
        "c10",
        "计算 FY2025 应收账款 / 营业收入",
        "compute_credit_metric",
        "computed:receivables_to_revenue:FY2025",
        {"metric": "receivables_to_revenue", "period": "FY2025"},
    ),
    Todo(
        "c11",
        "计算 FY2025 关联方融资占比",
        "compute_credit_metric",
        "computed:related_party_funding_ratio:FY2025",
        {"metric": "related_party_funding_ratio", "period": "FY2025"},
    ),
    Todo(
        "c12",
        "计算 FY2025 或有负债 / 所有者权益",
        "compute_credit_metric",
        "computed:contingent_liabilities_to_equity:FY2025",
        {"metric": "contingent_liabilities_to_equity", "period": "FY2025"},
    ),
    Todo(
        "c13",
        "提取 FY2025 审计意见",
        "compute_credit_metric",
        "computed:audit_opinion:FY2025",
        {"metric": "audit_opinion", "period": "FY2025"},
    ),
    Todo(
        "c14",
        "判断 FY2025 评级迁移",
        "compute_credit_metric",
        "computed:rating_migration:FY2025",
        {"metric": "rating_migration", "period": "FY2025"},
    ),
)

#: A blocked todo abandons the metric todos that can no longer be computed.
DEPENDENTS: dict[str, tuple[str, ...]] = {
    "c5": ("c7", "c9", "c11", "c12"),
    "c6": ("c14",),
}

_OWNER: dict[tuple[str, str, str, str], str] = {
    ("list_documents", "", "", ""): "c1",
    ("read_document", "doc_ar_fy2024", "", ""): "c2",
    ("check_restatement", "doc_ar_fy2024", "", ""): "c3",
    ("read_document", "doc_ar_fy2025", "", ""): "c4",
    ("read_document", "doc_debt_fy2025", "", ""): "c5",
    ("read_document", "doc_rating_fy2025", "", ""): "c6",
    ("compute_credit_metric", "", "net_debt_to_ebitda", "FY2025"): "c7",
    ("compute_credit_metric", "", "interest_coverage", "FY2025"): "c8",
    ("compute_credit_metric", "", "ocf_to_short_term_debt", "FY2025"): "c9",
    ("compute_credit_metric", "", "receivables_to_revenue", "FY2025"): "c10",
    ("compute_credit_metric", "", "related_party_funding_ratio", "FY2025"): "c11",
    ("compute_credit_metric", "", "contingent_liabilities_to_equity", "FY2025"): "c12",
    ("compute_credit_metric", "", "audit_opinion", "FY2025"): "c13",
    ("compute_credit_metric", "", "rating_migration", "FY2025"): "c14",
}


class CreditPlanner:
    """Decomposes the credit goal, then settles todos from observations."""

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
        if observation.tool == "check_restatement":
            return bool(result.get("period")) and not result.get("reason")
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
