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
from ..providers.local_policy import LocalPolicy
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


def run(
    *,
    workdir: Path,
    scenario_key: str,
    fresh: bool,
    policy_name: str = "mock",
    endpoint: str = "http://127.0.0.1:11434/v1",
    model: str = "qwen3-4b-fcode",
    json_mode: bool = False,
    timeout: float = 120.0,
) -> dict[str, Any]:
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
    if policy_name == "local":
        policy = LocalPolicy(
            base_url=endpoint, model=model, timeout=timeout, json_mode=json_mode,
        )
    else:
        policy = MockPolicy()
    recorder = TraceRecorder(
        store,
        provider_name=policy.name,
        model_name=policy.model,
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
        policy=policy,
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
        "policy": policy.name,
        "model": policy.model,
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
    parser.add_argument("--policy", choices=("mock", "local"), default="mock")
    parser.add_argument("--endpoint", default="http://127.0.0.1:11434/v1")
    parser.add_argument("--model", default="qwen3-4b-fcode")
    parser.add_argument("--json-mode", action="store_true")
    parser.add_argument("--timeout", type=float, default=120.0)
    args = parser.parse_args(argv)
    summary = run(
        workdir=Path(args.workdir),
        scenario_key=args.scenario,
        fresh=args.fresh,
        policy_name=args.policy,
        endpoint=args.endpoint,
        model=args.model,
        json_mode=args.json_mode,
        timeout=args.timeout,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["verified"] and summary["status"] == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
