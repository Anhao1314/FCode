"""The read-only finance toolset registered for the demo.

Every tool here is a *read*. ``calculate_margin`` looks like a computation but
is still read-only from the runtime's point of view: it reads prepared facts and
returns a number the runtime will recompute independently. The model cannot
pass a value in, which is what stops a plausible-sounding number from entering
the trace.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..base import EFFECT_READ, Param, ToolSpec
from ..evidence import EvidenceStore
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


def build_finance_tools(world: FinanceWorld, evidence: EvidenceStore | None = None) -> list[ToolSpec]:
    """Bind the finance world to a list of :class:`ToolSpec`.

    ``evidence`` is the sandbox for file ingestion. The catalog is the same
    whether or not anything has been ingested, so the model-visible tool list
    stays deterministic; only the store's contents vary.
    """
    evidence = evidence or EvidenceStore(Path.cwd())

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

    def ingest_file(arguments: dict[str, Any]) -> dict[str, Any]:
        return evidence.ingest(arguments["path"])

    def search_corpus(arguments: dict[str, Any]) -> dict[str, Any]:
        return evidence.search(arguments["query"], int(arguments.get("limit") or 10))

    def read_slice(arguments: dict[str, Any]) -> dict[str, Any]:
        return evidence.read_slice(
            arguments["doc_id"],
            int(arguments.get("start") or 1),
            arguments.get("end"),
        )

    doc_param = Param(
        name="doc_id",
        kind="string",
        required=True,
        enum=DOCUMENT_IDS,
        description="document identifier returned by list_documents",
    )

    def out(name: str, kind: str, required: bool = True, nullable: bool = False) -> Param:
        """Declare one output field. Extras are allowed; declared ones are enforced."""
        return Param(name=name, kind=kind, required=required, nullable=nullable)

    doc_outputs = (
        out("id", "string"), out("title", "string"), out("kind", "string"),
        out("period", "string"), out("unit", "string"), out("unit_label", "string"),
        out("basis", "string"), out("revenue", "integer"), out("gross_profit", "integer"),
        out("supersedes", "string", nullable=True), out("body", "string"),
    )

    return [
        ToolSpec(
            name="list_documents",
            summary="List the documents available for this assessment",
            effect=EFFECT_READ,
            params=(),
            handler=list_documents,
            outputs=(out("documents", "array"),),
            version="1.0",
        ),
        ToolSpec(
            name="read_document",
            summary="Read one document, including its unit and accounting basis",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=read_document,
            outputs=doc_outputs,
            version="1.0",
        ),
        ToolSpec(
            name="normalize_units",
            summary="Convert one document's amounts to CNY so periods can be compared",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=normalize_units,
            outputs=(
                out("id", "string"), out("period", "string"),
                out("source_unit", "string"), out("target_unit", "string"),
                out("revenue_cny", "integer"), out("gross_profit_cny", "integer"),
                out("factor", "integer"),
            ),
            version="1.0",
        ),
        ToolSpec(
            name="reconcile_basis",
            summary="Bridge a non-IFRS figure to IFRS using the published reconciliation",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=reconcile_basis,
            outputs=(
                out("period", "string"), out("reconciled", "boolean"),
                out("reason", "string", required=False),
                out("from_basis", "string", required=False),
                out("to_basis", "string", required=False),
                out("bridge_id", "string", required=False),
                out("delta", "integer", required=False),
                out("reconciled_gross_profit", "integer", required=False),
            ),
            version="1.0",
        ),
        ToolSpec(
            name="check_restatement",
            summary="Check whether a period has been restated by a later note",
            effect=EFFECT_READ,
            params=(doc_param,),
            handler=check_restatement,
            outputs=(
                out("period", "string"), out("restated", "boolean"),
                out("superseded_by", "string", required=False, nullable=True),
                out("original_gross_profit", "integer", required=False),
                out("restated_gross_profit", "integer", required=False),
                out("delta", "integer", required=False),
                out("reason", "string", required=False),
            ),
            version="1.0",
        ),
        ToolSpec(
            name="calculate_margin",
            summary="Compute the two-period gross margin from prepared facts",
            effect=EFFECT_READ,
            params=(),
            handler=calculate_margin,
            outputs=(
                out("computed", "boolean"),
                out("blockers", "array", required=False),
                out("comparable", "boolean", required=False),
                out("basis", "string", required=False),
                out("consolidation", "string", required=False),
                out("restatement_applied", "boolean", required=False),
                out("periods", "array", required=False),
                out("margin_bp_2024", "integer", required=False),
                out("margin_bp_2025", "integer", required=False),
                out("change_bp", "integer", required=False),
                out("citations", "array", required=False),
                out("authority", "object", required=False),
            ),
            version="1.0",
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
            outputs=(
                out("acknowledged", "boolean"),
                out("reason", "string"),
                out("blocker_count", "integer"),
            ),
            version="1.0",
        ),
        ToolSpec(
            name="ingest_file",
            summary="Ingest a text/CSV/JSON file inside the evidence sandbox; returns a content hash and line anchors",
            effect=EFFECT_READ,
            params=(
                Param(
                    name="path",
                    kind="string",
                    required=True,
                    description="path relative to the evidence root (absolute paths and .. are refused)",
                ),
            ),
            handler=ingest_file,
            outputs=(
                out("doc_id", "string"),
                out("kind", "string"),
                out("size", "integer"),
                out("sha256", "string"),
                out("lines", "integer"),
                out("rows", "integer", required=False, nullable=True),
                out("columns", "array", required=False, nullable=True),
            ),
            version="1.0",
        ),
        ToolSpec(
            name="search_corpus",
            summary="Search ingested evidence by substring; returns hits with doc_id and line anchors",
            effect=EFFECT_READ,
            params=(
                Param(name="query", kind="string", required=True, description="case-insensitive substring"),
                Param(name="limit", kind="integer", required=False, minimum=1, maximum=50, description="max hits (default 10)"),
            ),
            handler=search_corpus,
            outputs=(
                out("query", "string"),
                out("hits", "array"),
                out("scanned", "integer"),
                out("truncated", "boolean"),
            ),
            version="1.0",
        ),
        ToolSpec(
            name="read_slice",
            summary="Read a bounded line range from ingested evidence; whole documents are never dumped",
            effect=EFFECT_READ,
            params=(
                Param(name="doc_id", kind="string", required=True, description="doc_id returned by ingest_file"),
                Param(name="start", kind="integer", required=False, minimum=1, description="first line (1-based, default 1)"),
                Param(name="end", kind="integer", required=False, minimum=1, description="last line (inclusive; window capped at 80 lines)"),
            ),
            handler=read_slice,
            outputs=(
                out("doc_id", "string"),
                out("start", "integer"),
                out("end", "integer"),
                out("lines", "array"),
                out("truncated", "boolean"),
                out("total_lines", "integer"),
            ),
            version="1.0",
        ),
    ]
