"""Phase 0 seam proof, now a thin runner over the production credit module.

Run from ``flowcredit/``::

    PYTHONPATH=src python3.12 labs/credit_dd/spike.py

The lab no longer owns a world, planner, toolset or verifier. It selects the
production ``CreditWorld`` for ``hengxing`` and runs the production fourteen-step
blueprint through the real ``TaskStore`` / ``Harness`` / ``Loop`` /
``MockProvider`` / ``TraceRecorder``. The two cases are:

* ``happy-path``: all eight metrics verified, status ``succeeded``;
* ``partial-world``: the debt schedule is removed, c5 is blocked, c6/c7/c9/c11/
  c12/c14 are abandoned, c8/c10/c13 still run, and the task ends
  ``INSUFFICIENT_EVIDENCE`` without a computed net-debt/EBITDA figure.
"""

from __future__ import annotations

import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for candidate in (ROOT, ROOT / "src"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from flowagent.core.contracts import Task  # noqa: E402
from flowagent.core.plan import Plan  # noqa: E402
from flowagent.core.receipts import ReceiptStore  # noqa: E402
from flowagent.core.store import TaskStore  # noqa: E402
from flowagent.domains.credit import CREDIT_DOMAIN  # noqa: E402
from flowagent.providers.mock import MockProvider  # noqa: E402
from flowagent.runtime.budget import BudgetLimits  # noqa: E402
from flowagent.runtime.harness import Harness  # noqa: E402
from flowagent.runtime.loop import Loop  # noqa: E402
from flowagent.tools.credit.planner import CreditPlanner  # noqa: E402
from flowagent.tools.credit.tools import CREDIT_TOOL_NAMES, build_credit_tools  # noqa: E402
from flowagent.tools.credit.world import CreditWorld  # noqa: E402
from flowagent.tools.registry import ToolRegistry  # noqa: E402
from flowagent.trajectory.exporter import verify_trace  # noqa: E402
from flowagent.trajectory.recorder import TraceRecorder  # noqa: E402

__all__ = ["CaseRun", "EXPECTED_METRICS", "run_case", "main"]

EXPECTED_METRICS: dict[str, Any] = {
    "net_debt_to_ebitda": 37714,
    "interest_coverage": 41667,
    "ocf_to_short_term_debt": 3000,
    "receivables_to_revenue": 2296,
    "related_party_funding_ratio": 577,
    "contingent_liabilities_to_equity": 281,
    "audit_opinion": "standard_unqualified",
    "rating_migration": "stable",
}


def _metrics_from_result(result: dict[str, Any] | None) -> dict[str, Any]:
    if not result:
        return {}
    if "results" in result:
        return {
            item["metric"]: (
                item.get("value_bp")
                if item.get("kind") == "ratio"
                else item.get("value_code")
            )
            for item in result["results"]
        }
    if result.get("computed") and result.get("metric"):
        return {
            result["metric"]: (
                result.get("value_bp")
                if result.get("kind") == "ratio"
                else result.get("value_code")
            )
        }
    return {}


@dataclass
class CaseRun:
    """Everything one lab case produced, kept for assertions and reporting."""

    name: str
    partial: bool
    task: Task
    plan: Plan
    events: list[dict[str, Any]]
    trace: dict[str, Any]
    verification: dict[str, Any]
    summary: dict[str, Any]
    world: CreditWorld

    @property
    def ok(self) -> bool:
        if not self.verification.get("verified"):
            return False
        if not self.partial:
            return (
                self.task.status == "succeeded"
                and self.summary["metrics"] == EXPECTED_METRICS
                and self.plan.is_complete()
                and all(todo.status == "done" for todo in self.plan.todos)
            )
        if self.task.status != "failed":
            return False
        if self.summary["failure_code"] != "INSUFFICIENT_EVIDENCE":
            return False
        if not self.plan.is_blocked():
            return False
        statuses = {todo.id: todo.status for todo in self.plan.todos}
        if statuses.get("c5") != "blocked":
            return False
        if any(
            statuses.get(todo) != "abandoned"
            for todo in ("c6", "c7", "c9", "c11", "c12", "c14")
        ):
            return False
        if any(statuses.get(todo) != "done" for todo in ("c8", "c10", "c13")):
            return False
        return not self.has_computed_net_debt()

    def has_computed_net_debt(self) -> bool:
        for event in self.events:
            if event["type"] != "tool_succeeded":
                continue
            detail = event["payload"].get("detail", {})
            if detail.get("tool") != "compute_credit_metric":
                continue
            result = detail.get("result", {})
            if result.get("metric") == "net_debt_to_ebitda" and result.get("computed"):
                return True
        return False


def run_case(
    name: str,
    *,
    partial: bool = False,
    issuer: str = "hengxing",
    max_rounds: int = 20,
) -> CaseRun:
    """Assemble the real stack, run one case, and return its trace and state."""
    with tempfile.TemporaryDirectory(prefix=f"fcode-credit-{name}-") as tmp:
        store = TaskStore(Path(tmp) / "task.sqlite")
        try:
            world = CreditWorld(issuer=issuer, partial=partial)
            registry = ToolRegistry(build_credit_tools(world))
            receipts = ReceiptStore(store)
            provider = MockProvider(policy="research")
            limits = BudgetLimits(
                max_calls=max_rounds,
                max_reads=max_rounds,
                max_cost_microusd=20_000,
                max_tokens=20_000,
            )
            harness = Harness(
                store=store,
                registry=registry,
                provider=provider,
                world=world,
                limits=limits,
                receipts=receipts,
                verifier=lambda observation: CREDIT_DOMAIN.verify(world, observation),
            )
            allowed = list(CREDIT_TOOL_NAMES)
            task = harness.create(
                task_id=f"task-credit-dd-{name}",
                objective=f"对{world.display_name}做 FY2025 八指标信用核查",
                principal="credit-dd-lab",
                binding={
                    "scenario": name,
                    "corpus": "synthetic-authored-v1",
                    "module": CREDIT_DOMAIN.key,
                    "issuer": issuer,
                    "synthetic": True,
                },
                allowed_tools=allowed,
                grant={
                    "grant_id": f"grant-{name}",
                    "revision": 1,
                    "allowed_tools": allowed,
                    "max_calls": max_rounds,
                    "max_reads": max_rounds,
                    "max_cost_microusd": 20_000,
                    "max_tokens": 20_000,
                },
            )
            recorder = TraceRecorder(
                store,
                provider_name=provider.name,
                model_name=provider.model,
            )
            task = Loop(
                harness,
                planner=CreditPlanner(),
                max_rounds=max_rounds,
                observer=recorder,
                result_tools=CREDIT_DOMAIN.result_tools,
            ).run(task.id)

            trace = recorder.build(task)
            verification = verify_trace(trace)
            events = store.events(task.id)
            plan = Plan.from_dict(task.plan_state) if task.plan_state else CreditPlanner().decompose(task.objective)
            failure = task.failure or {}
            summary = {
                "name": name,
                "status": task.status,
                "failure_code": failure.get("code", ""),
                "metrics": _metrics_from_result(task.result),
                "events": len(events),
                "chain_head": verification["head_hash"],
                "verified": bool(verification["verified"]),
            }
            return CaseRun(
                name=name,
                partial=partial,
                task=task,
                plan=plan,
                events=events,
                trace=trace,
                verification=verification,
                summary=summary,
                world=world,
            )
        finally:
            store.close()


def main() -> int:
    try:
        cases = [
            run_case("happy-path"),
            run_case("partial-world", partial=True),
        ]
    except Exception as error:  # noqa: BLE001 - the spike must fail as JSON too
        print(
            json.dumps(
                {"ok": False, "error": f"{type(error).__name__}: {error}"},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1
    ok = all(case.ok for case in cases)
    print(
        json.dumps(
            {"ok": ok, "cases": [case.summary for case in cases]},
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
