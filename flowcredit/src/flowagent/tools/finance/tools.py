"""The read-only finance toolset registered for the demo.

Every tool here is a *read*. ``calculate_margin`` looks like a computation but
is still read-only from the runtime's point of view: it reads prepared facts and
returns a number the runtime will recompute independently. The model cannot
pass a value in, which is what stops a plausible-sounding number from entering
the trace.
"""

from __future__ import annotations

from typing import Any

from ..base import EFFECT_READ, Param, ToolSpec
from .authority import evaluate_fact_authority
from .fixtures import FinanceWorld

__all__ = ["build_finance_tools", "DOCUMENT_IDS", "BLOCK_REASONS"]

DOCUMENT_IDS: tuple[str, ...] = (
    "doc_fy2024",
    "doc_fy2024_restated",
    "doc_fy2025",
    "doc_fy2025_adjusted",
    "doc_fy2025_bridge",
)

BLOCK_REASONS: tuple[str, ...] = (
    "missing_document",
    "basis_unresolved",
    "restatement_conflict",
    "insufficient_evidence",
)


def build_finance_tools(world: FinanceWorld) -> list[ToolSpec]:
    """Bind the finance world to a list of :class:`ToolSpec`."""

    def list_documents(_: dict[str, Any]) -> dict[str, Any]:
        return world.list_documents()

    def read_document(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.read_document(arguments["doc_id"])

    def normalize_units(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.normalize_units(arguments["doc_id"])

    def reconcile_basis(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.reconcile_basis(arguments["doc_id"])

    def check_restatement(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.check_restatement(arguments["doc_id"])

    def calculate_margin(_: dict[str, Any]) -> dict[str, Any]:
        result = world.calculate_margin()
        if not result.get("computed"):
            return result
        # Attach the authority decision for each cited document, so the trace
        # records *why* a figure was allowed to participate.
        result = dict(result)
        result["authority"] = {
            "FY2024": evaluate_fact_authority(world, "doc_fy2024_restated"),
            "FY2025": evaluate_fact_authority(world, "doc_fy2025"),
        }
        return result

    def report_blocked(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.report_blocked(arguments["reason"])

    doc_param = Param(
        name="doc_id",
        kind="string",
        required=True,
        enum=DOCUMENT_IDS,
        description="document identifier returned by list_documents",
    )

    return [
        ToolSpec(
            name="list_documents",
            summary="List the documents available for this assessment",
            effect=EFFECT_READ,
            params=(),
            handler=list_documents,
        ),
        ToolSpec(
            name="read_document",
            summary="Read one document, including its unit and accounting basis",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=read_document,
        ),
        ToolSpec(
            name="normalize_units",
            summary="Convert one document's amounts to CNY so periods can be compared",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=normalize_units,
        ),
        ToolSpec(
            name="reconcile_basis",
            summary="Bridge a non-IFRS figure to IFRS using the published reconciliation",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=reconcile_basis,
        ),
        ToolSpec(
            name="check_restatement",
            summary="Check whether a period has been restated by a later note",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=check_restatement,
        ),
        ToolSpec(
            name="calculate_margin",
            summary="Compute the two-period gross margin from prepared facts",
            effect=EFFECT_READ,
            params=(),
            handler=calculate_margin,
        ),
        ToolSpec(
            name="report_blocked",
            summary="Declare why the comparison cannot proceed; the runtime decides whether to stop",
            effect=EFFECT_READ,
            params=(
                Param(
                    name="reason",
                    kind="string",
                    required=True,
                    enum=BLOCK_REASONS,
                    description="machine-readable blocker code",
                ),
            ),
            handler=report_blocked,
        ),
    ]
