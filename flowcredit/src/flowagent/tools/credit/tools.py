"""Five read-only credit tools bound to one synthetic issuer world.

The model can list documents, read one, check the FY2024 restatement, ask for
one metric, or declare itself blocked. It cannot pass a financial value, write,
or choose a document outside the issuer's corpus. ``compute_credit_metric``
looks like a calculation but is a read from the host's point of view: the
runtime recomputes it from the world before it accepts the run.
"""

from __future__ import annotations

from typing import Any

from flowagent.tools.base import EFFECT_READ, Param, ToolSpec

from .world import (
    BLOCK_REASONS,
    KINDS,
    METRICS,
    PERIODS,
    VALUE_CODES,
    CreditWorld,
)

__all__ = ["build_credit_tools", "CREDIT_TOOL_NAMES"]

CREDIT_TOOL_NAMES: tuple[str, ...] = (
    "list_documents",
    "read_document",
    "check_restatement",
    "compute_credit_metric",
    "report_blocked",
)


def _out(
    name: str,
    kind: str,
    *,
    required: bool = True,
    nullable: bool = False,
    enum: tuple[str, ...] | None = None,
) -> Param:
    return Param(
        name=name,
        kind=kind,
        required=required,
        nullable=nullable,
        enum=enum,
    )


def build_credit_tools(world: CreditWorld) -> list[ToolSpec]:
    """Bind the issuer world to the five tool contracts the blueprint names."""

    def list_documents(_: dict[str, Any]) -> dict[str, Any]:
        return world.list_documents()

    def read_document(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.read_document(arguments["doc_id"])

    def check_restatement(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.check_restatement(arguments["doc_id"])

    def compute_credit_metric(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.compute_credit_metric(arguments["metric"], arguments["period"])

    def report_blocked(arguments: dict[str, Any]) -> dict[str, Any]:
        return world.report_blocked(arguments["reason"])

    doc_param = Param(
        name="doc_id",
        kind="string",
        required=True,
        enum=world.document_ids,
        description="document identifier returned by list_documents",
    )
    metric_param = Param(
        name="metric",
        kind="string",
        required=True,
        enum=METRICS,
        description="credit metric to compute from the world",
    )
    period_param = Param(
        name="period",
        kind="string",
        required=True,
        enum=PERIODS,
        description="fiscal period; debt metrics require FY2025",
    )

    document_outputs = (
        _out("found", "boolean"),
        _out("doc_id", "string"),
        _out("reason", "string", required=False),
        _out("title", "string", required=False),
        _out("period", "string", required=False),
        _out("unit", "string", required=False),
        _out("body", "string", required=False),
        _out("line_refs", "object", required=False),
        _out("fields", "object", required=False),
        _out("synthetic", "boolean", required=False),
    )

    metric_outputs = (
        _out("computed", "boolean"),
        _out("metric", "string", enum=METRICS),
        _out("period", "string", enum=PERIODS),
        _out("kind", "string", enum=KINDS),
        _out("value_bp", "integer", required=False, nullable=True),
        _out("value_code", "string", required=False, nullable=True, enum=VALUE_CODES),
        _out("display", "string", required=False),
        _out("inputs", "object"),
        _out("citations", "array"),
        _out("blockers", "array"),
    )

    restatement_outputs = (
        _out("period", "string"),
        _out("restated", "boolean"),
        _out("original_ebitda", "integer"),
        _out("restated_ebitda", "integer"),
        _out("delta", "integer"),
        _out("superseded_by", "string", nullable=True),
        _out("citations", "array"),
        _out("reason", "string", required=False),
    )

    return [
        ToolSpec(
            name="list_documents",
            summary="List the synthetic documents available for this issuer",
            effect=EFFECT_READ,
            params=(),
            handler=list_documents,
            outputs=(_out("documents", "array"),),
            version="1.0",
        ),
        ToolSpec(
            name="read_document",
            summary="Read one document, including its fields and line references",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=read_document,
            outputs=document_outputs,
            version="1.0",
        ),
        ToolSpec(
            name="check_restatement",
            summary="Check whether FY2024 EBITDA was restated by a later note",
            effect=EFFECT_READ,
            params=(
                Param(
                    name="doc_id",
                    kind="string",
                    required=True,
                    enum=("doc_ar_fy2024",),
                    description="FY2024 annual report to check for a restatement",
                ),
            ),
            handler=check_restatement,
            outputs=restatement_outputs,
            version="1.0",
        ),
        ToolSpec(
            name="compute_credit_metric",
            summary="Compute one credit metric from world facts; the model passes no values",
            effect=EFFECT_READ,
            params=(metric_param, period_param),
            handler=compute_credit_metric,
            outputs=metric_outputs,
            version="1.0",
        ),
        ToolSpec(
            name="report_blocked",
            summary="Declare why the credit check cannot proceed; the runtime decides whether to stop",
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
            outputs=(
                _out("acknowledged", "boolean"),
                _out("reason", "string", enum=BLOCK_REASONS),
                _out("blocker_count", "integer"),
            ),
            version="1.0",
        ),
    ]
