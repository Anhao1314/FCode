"""Working memory: the observation summary the model is allowed to see.

Two design choices are worth defending in an interview.

**It is derived, not stored.** The context is rebuilt from the observation log
every round rather than mutated in place. A model that could mutate memory could
rewrite history; a derived view cannot drift from the record.

**It is compressed, not raw.** Each observation is reduced to the fields a
decision actually needs. Passing full tool output forward is how a context window
fills with text nobody reads — and it also makes the next action depend on
phrasing rather than on facts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..tools.base import Observation

__all__ = ["ObservationRecord", "WorkingMemory"]


@dataclass(frozen=True)
class ObservationRecord:
    """One compressed observation, kept for the whole task."""

    round: int
    tool: str
    arguments: dict[str, Any]
    result: dict[str, Any]
    result_hash: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "round": self.round,
            "tool": self.tool,
            "arguments": self.arguments,
            "result": self.result,
            "result_hash": self.result_hash,
        }


@dataclass
class WorkingMemory:
    """Accumulates observations and derives the next context."""

    objective: str
    tool_catalog: list[dict[str, Any]]
    records: list[ObservationRecord] = field(default_factory=list)

    def record(self, round_no: int, observation: Observation) -> ObservationRecord:
        record = ObservationRecord(
            round=round_no,
            tool=observation.tool,
            arguments=dict(observation.arguments),
            result=dict(observation.result),
            result_hash=observation.result_hash,
        )
        self.records.append(record)
        return record

    # ------------------------------------------------------------------- state

    def state(self) -> dict[str, Any]:
        """Derive what has been established so far, from observations alone."""
        read_documents: list[str] = []
        normalised: list[str] = []
        reconciled_periods: list[str] = []
        listed = False
        restatement_checked = False
        restatement_applied = False
        computed = False
        blockers: list[str] = []
        margins: dict[str, Any] = {}

        for record in self.records:
            tool, result = record.tool, record.result
            if tool == "list_documents":
                listed = True
            elif tool == "read_document" and "id" in result:
                read_documents.append(result["id"])
            elif tool == "normalize_units" and "id" in result:
                normalised.append(result["id"])
            elif tool == "reconcile_basis" and "period" in result:
                reconciled_periods.append(result["period"])
            elif tool == "check_restatement":
                restatement_checked = True
                restatement_applied = bool(result.get("restated"))
            elif tool == "calculate_margin":
                computed = bool(result.get("computed"))
                blockers = list(result.get("blockers") or [])
                if computed:
                    margins = {
                        "margin_bp_2024": result.get("margin_bp_2024"),
                        "margin_bp_2025": result.get("margin_bp_2025"),
                        "change_bp": result.get("change_bp"),
                    }
            elif tool == "report_blocked":
                blockers.append(result.get("reason", "unspecified"))

        reconciled_documents: list[str] = []
        for period in sorted(set(reconciled_periods)):
            reconciled_documents.extend(self._documents_for_period(period))

        return {
            "listed_documents": listed,
            "read_documents": sorted(set(read_documents)),
            "normalised_documents": sorted(set(normalised)),
            "reconciled_periods": sorted(set(reconciled_periods)),
            "reconciled_documents": sorted(set(reconciled_documents)),
            "restatement_checked": restatement_checked,
            "restatement_applied": restatement_applied,
            "computed": computed,
            "blockers": blockers,
            "margins": margins,
        }

    def _documents_for_period(self, period: str) -> list[str]:
        """Map a reconciled period back to the document that owns it."""
        mapping = {"FY2024": ["doc_fy2024"], "FY2025": ["doc_fy2025"]}
        return mapping.get(period, [])

    # ----------------------------------------------------------------- context

    def build(
        self,
        round_no: int,
        budget_snapshot: dict[str, Any],
        plan: Any | None = None,
    ) -> dict[str, Any]:
        """Return the context object handed to the provider this round.

        ``plan`` is the open-todo view, not the whole plan: the model needs to
        know what is left, not the history of how it got there.
        """
        return {
            "objective": self.objective,
            "round": round_no,
            "tools": self.tool_catalog,
            "plan": plan.to_context() if plan is not None else [],
            "state": self.state(),
            "observations": [
                {
                    "round": record.round,
                    "tool": record.tool,
                    "arguments": record.arguments,
                    "summary": self._summarise(record),
                }
                for record in self.records
            ],
            "budget": budget_snapshot,
            "instruction": (
                "Propose exactly one read-only action. You cannot execute it, "
                "cannot mark the task complete, and cannot pass a financial value. "
                "The runtime decides when the evidence is sufficient."
            ),
        }

    @staticmethod
    def _summarise(record: ObservationRecord) -> dict[str, Any]:
        """Compress one observation to the fields a decision needs."""
        result = record.result
        if record.tool == "list_documents":
            return {"documents": [item["id"] for item in result.get("documents", [])]}
        if record.tool == "read_document":
            return {
                "id": result.get("id"),
                "period": result.get("period"),
                "unit": result.get("unit"),
                "basis": result.get("basis"),
                "revenue": result.get("revenue"),
                "gross_profit": result.get("gross_profit"),
            }
        if record.tool == "normalize_units":
            return {
                "id": result.get("id"),
                "revenue_cny": result.get("revenue_cny"),
                "gross_profit_cny": result.get("gross_profit_cny"),
            }
        if record.tool == "reconcile_basis":
            return {
                "period": result.get("period"),
                "from_basis": result.get("from_basis"),
                "delta": result.get("delta"),
                "reconciled_gross_profit": result.get("reconciled_gross_profit"),
            }
        if record.tool == "check_restatement":
            return {
                "period": result.get("period"),
                "restated": result.get("restated"),
                "delta": result.get("delta"),
            }
        if record.tool == "calculate_margin":
            return {
                "computed": result.get("computed"),
                "blockers": result.get("blockers", []),
                "change_bp": result.get("change_bp"),
            }
        return {"reason": result.get("reason")}
