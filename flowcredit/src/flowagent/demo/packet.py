"""Run one scenario in Executive–Policy packet mode.

The host compiles a compact DecisionPacket for each round; MockPolicy picks the
first legal candidate. The experiment reports which rounds skipped the model
(fast path) and how much smaller the packet is than the legacy context.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any

from ..core.hashing import canonical_json
from ..core.receipts import ReceiptStore
from ..core.store import TaskStore
from ..domains.finance import verify_observation
from ..memory.cases import CaseIndex
from ..memory.facts import FactStore
from ..providers.mock import MockProvider
from ..runtime.harness import Harness
from ..runtime.loop import Loop
from ..runtime.policy import MockPolicy, compile_packet
from ..tools.artifacts import ArtifactStore
from ..tools.connectors import default_registry
from ..tools.evidence import EvidenceStore
from ..tools.finance.facts import project_facts
from ..tools.finance.fixtures import FinanceWorld
from ..tools.finance.planner import FinancePlanner
from ..tools.finance.tools import build_finance_tools
from ..tools.registry import ToolRegistry
from ..trajectory.exporter import export_trace, verify_trace
from ..trajectory.recorder import TraceRecorder
from .fixtures import get_scenario

__all__ = ["run"]

PROJECT_ROOT = Path(__file__).resolve().parents[3]


def run(*, workdir: Path, scenario_key: str, fresh: bool) -> dict[str, Any]:
    scenario = get_scenario(scenario_key)
    workdir = workdir.expanduser().resolve()
    if workdir in (Path("/"), PROJECT_ROOT):
        raise ValueError(f"refusing to use {workdir} as a lab workdir")
    if fresh and workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    store = TaskStore(workdir / "task.sqlite")
    world = FinanceWorld(partial=scenario.partial_corpus)
    cases = CaseIndex(workdir / "cases.sqlite")
    facts = FactStore(workdir / "facts.sqlite")
    registry = ToolRegistry(build_finance_tools(
        world,
        EvidenceStore(workdir / "evidence"),
        ArtifactStore(workdir / "artifacts"),
        default_registry(),
        cases,
        facts,
    ))
    receipts = ReceiptStore(store)
    provider = MockProvider(policy=scenario.policy)
    harness = Harness(
        store=store,
        registry=registry,
        provider=provider,
        world=world,
        limits=scenario.limits,
        receipts=receipts,
        verifier=lambda observation: verify_observation(world, observation),
    )
    recorder = TraceRecorder(
        store,
        provider_name="mock-packet-policy",
        model_name="rule-first-candidate",
    )
    task = harness.create(
        task_id=f"task-packet-{scenario.key}",
        objective=scenario.objective,
        principal="packet-lab",
        binding={"scenario": scenario.key, "module": "finance-research", "source": "packet-lab"},
        allowed_tools=list(scenario.allowed_tools),
        grant=dict(scenario.grant),
    )
    loop = Loop(
        harness,
        planner=FinancePlanner(),
        max_rounds=scenario.max_rounds,
        observer=recorder,
        policy=MockPolicy(),
    )
    memory = loop.restore(task)
    plan = loop.rebuild_plan(task, memory)
    budget = harness.budget(task).snapshot()
    packet = compile_packet(
        objective=task.objective,
        round_no=1,
        plan=plan,
        memory=memory,
        registry=harness.registry,
        budget=budget,
    )
    legacy = memory.build(1, budget, plan)
    packet_bytes = len(canonical_json(packet.to_dict()).encode("utf-8"))
    legacy_bytes = len(canonical_json(legacy).encode("utf-8"))

    try:
        task = loop.run(task.id)
        final = recorder.build(store.load(task.id))
        run_id = f"packet-{scenario.key}"
        cases.upsert(final, run_id=run_id)
        facts.upsert_run(run_id=run_id, facts=project_facts(final, run_id=run_id))
        trace_path = export_trace(final, workdir / "trace.json")
        try:
            verify_trace(final)
            verified = True
        except Exception:  # noqa: BLE001 — surfaced in the summary
            verified = False
        types = [event["type"] for event in final["events"]]
    finally:
        store.close()

    return {
        "scenario": scenario.key,
        "status": task.status,
        "change_bp": (task.result or {}).get("change_bp"),
        "rounds": len(final.get("rounds") or []),
        "events": len(final.get("events") or []),
        "model_calls": types.count("model_started"),
        "policy_decisions": types.count("policy_decided"),
        "auto_actions": types.count("auto_action"),
        "packet_bytes": packet_bytes,
        "legacy_context_bytes": legacy_bytes,
        "reduction_pct": round((1 - packet_bytes / legacy_bytes) * 100, 1) if legacy_bytes else 0.0,
        "trace": str(trace_path),
        "verified": verified,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flowagent-packet-lab")
    parser.add_argument("--workdir", required=True)
    parser.add_argument("--scenario", default="full")
    parser.add_argument("--fresh", action="store_true")
    args = parser.parse_args(argv)
    summary = run(workdir=Path(args.workdir), scenario_key=args.scenario, fresh=args.fresh)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["verified"] and summary["status"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
