"""Phase 0 seam spike: a two-metric credit check through the real runtime.

Run from ``flowcredit/``::

    PYTHONPATH=src python3.12 labs/credit_dd/spike.py

Two cases are executed with the real ``TaskStore`` / ``ReceiptStore`` /
``Harness`` / ``Loop`` / ``MockProvider(policy="research")`` / ``TraceRecorder``:

* ``happy-path``: six plan steps, both metrics recomputed, status ``succeeded``;
* ``partial-world``: the debt schedule is missing, ``c4`` is blocked, ``c5`` is
  abandoned, ``c6`` still runs, and the task ends non-succeeded without a
  computed net-debt/EBITDA figure in the trace.

The process prints one JSON object and exits non-zero unless both cases match
their expectations.
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
from flowagent.providers.mock import MockProvider  # noqa: E402
from flowagent.runtime.budget import BudgetLimits  # noqa: E402
from flowagent.runtime.harness import Harness  # noqa: E402
from flowagent.runtime.loop import Loop  # noqa: E402
from flowagent.tools.registry import ToolRegistry  # noqa: E402
from flowagent.trajectory.exporter import verify_trace  # noqa: E402
from flowagent.trajectory.recorder import TraceRecorder  # noqa: E402

from labs.credit_dd.module import CREDIT_DD_DOMAIN  # noqa: E402
from labs.credit_dd.planner import CreditPlanner  # noqa: E402
from labs.credit_dd.tools import TOOL_NAMES, build_credit_tools  # noqa: E402
from labs.credit_dd.world import CreditWorld  # noqa: E402

__all__ = ["CaseRun", "EXPECTED_METRICS", "run_case", "main"]

EXPECTED_METRICS: dict[str, int] = {
    "net_debt_to_ebitda": 377,
    "interest_coverage": 417,
}


def _metrics_from_result(result: dict[str, Any] | None) -> dict[str, int]:
    """Read metrics from either the single-result or multi-result shape."""
    if not result:
        return {}
    if "results" in result:
        return {
            item["metric"]: item["value_x100"]
            for item in result["results"]
            if item.get("computed") and item.get("metric") and "value_x100" in item
        }
    if result.get("computed") and result.get("metric") and "value_x100" in result:
        return {result["metric"]: result["value_x100"]}
    return {}


@dataclass
class CaseRun:
    """Everything one spike case produced, kept for assertions and reporting."""

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
        if "net_debt_to_ebitda" in self.summary["metrics"]:
            return False
        if not self.plan.is_blocked():
            return False
        statuses = {todo.id: todo.status for todo in self.plan.todos}
        if statuses.get("c4") != "blocked":
            return False
        if statuses.get("c5") not in ("abandoned", "blocked"):
            return False
        if statuses.get("c6") != "done":
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
    max_rounds: int = 12,
    planner: Any | None = None,
) -> CaseRun:
    """Assemble the real stack, run one case, and return its trace and state."""
    active_planner = planner or CreditPlanner()
    with tempfile.TemporaryDirectory(prefix=f"fcode-credit-{name}-") as tmp:
        store = TaskStore(Path(tmp) / "task.sqlite")
        try:
            world = CreditWorld(partial=partial)
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
                verifier=lambda observation: CREDIT_DD_DOMAIN.verify(world, observation),
            )

            allowed = list(TOOL_NAMES)
            task = harness.create(
                task_id=f"task-credit-dd-{name}",
                objective="对恒星智造（合成数据）完成 FY2025 净负债/EBITDA 与利息覆盖倍数核查",
                principal="credit-dd-spike",
                binding={
                    "scenario": name,
                    "corpus": "synthetic-authored-v1",
                    "module": "credit-due-diligence",
                    "company": "恒星智造",
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
                planner=active_planner,
                max_rounds=max_rounds,
                observer=recorder,
                # The module, not the kernel, declares which tool's verified
                # observations are the domain's answer.
                result_tools=CREDIT_DD_DOMAIN.result_tools,
            ).run(task.id)

            trace = recorder.build(task)
            verification = verify_trace(trace)
            events = store.events(task.id)
            plan = (
                Plan.from_dict(task.plan_state)
                if task.plan_state
                else active_planner.decompose(task.objective)
            )
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
