"""Credit due-diligence demo runner.

This is the module-driven assembly for the credit domain: it selects a
``CreditWorld`` for one synthetic issuer, binds the module's five tools, runs the
real ``Harness``/``Loop`` with the offline mock, then lets the Host assemble and
write the memo. The model never writes a number into the memo, and the memo is
still written when the run is refused (not issued).
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..core.receipts import ReceiptStore
from ..core.store import TaskStore
from ..domains.credit import CREDIT_DOMAIN
from ..providers.mock import MockProvider
from ..runtime.budget import BudgetLimits
from ..runtime.harness import Harness
from ..runtime.loop import Loop
from ..tools.base import Observation
from ..tools.credit.memo import build_memo, write_memo
from ..tools.credit.tools import CREDIT_TOOL_NAMES
from ..tools.credit.world import ISSUER_KEYS, ISSUER_NAMES
from ..tools.registry import ToolRegistry
from ..trajectory.exporter import export_trace, verify_trace
from ..trajectory.recorder import TraceRecorder

__all__ = [
    "PROJECT_ROOT",
    "WORK_DIR",
    "EXPECTED_RECOMMENDATIONS",
    "CreditRun",
    "run_issuer",
    "run_all",
    "main",
]

PROJECT_ROOT = Path(__file__).resolve().parents[3]
WORK_DIR = PROJECT_ROOT / "work" / "credit"

EXPECTED_RECOMMENDATIONS: dict[str, str] = {
    "hengxing": "watch",
    "yuanyang": "reject",
    "yunling": "insufficient_evidence",
}


@dataclass
class CreditRun:
    """One issuer run: runtime status, memo and audit anchors."""

    issuer_key: str
    issuer: str
    expected: str
    status: str
    failure_code: str
    recommended_conclusion: str
    conclusion_authority: str
    decision_status: str
    issued: bool
    signed: bool
    rule_fired: str
    metrics: dict[str, Any]
    memo: dict[str, Any]
    memo_path: str
    memo_md_path: str
    memo_sha256: str
    chain_head: str
    chain_verified: bool
    verified: bool
    missing_required: list[str]
    missing_optional: list[str]
    optional_gaps: list[dict[str, str]]
    optional_verified: bool
    trace_path: str

    @property
    def ok(self) -> bool:
        return self.recommended_conclusion == self.expected

    def to_dict(self) -> dict[str, Any]:
        return {
            "issuer": self.issuer,
            "issuer_key": self.issuer_key,
            "expected": self.expected,
            "status": self.status,
            "failure_code": self.failure_code,
            "recommended_conclusion": self.recommended_conclusion,
            "conclusion_authority": self.conclusion_authority,
            "decision_status": self.decision_status,
            "issued": self.issued,
            "signed": self.signed,
            "rule_fired": self.rule_fired,
            "metrics": dict(self.metrics),
            "memo_path": self.memo_path,
            "memo_md_path": self.memo_md_path,
            "memo_sha256": self.memo_sha256,
            "chain_head": self.chain_head,
            "chain_verified": self.chain_verified,
            "verified": self.verified,
            "missing": list(self.memo.get("missing") or []),
            "missing_required": list(self.memo.get("missing_required") or []),
            "missing_optional": list(self.memo.get("missing_optional") or []),
            "optional_gaps": [dict(gap) for gap in self.memo.get("optional_gaps") or []],
            "optional_verified": bool(self.memo.get("optional_verified")),
        }


def _fresh_database(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        candidate = path.with_name(path.name + suffix)
        if candidate.exists():
            candidate.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)


def _observations(events: list[dict[str, Any]]) -> list[Observation]:
    observations: list[Observation] = []
    for event in events:
        if event["type"] != "tool_succeeded":
            continue
        detail = event["payload"].get("detail", {})
        observations.append(
            Observation(
                tool=detail["tool"],
                arguments=dict(detail.get("arguments") or {}),
                result=dict(detail.get("result") or {}),
                result_hash=detail.get("result_hash", ""),
                tool_version=detail.get("tool_version", ""),
            )
        )
    return observations


def run_issuer(
    issuer_key: str,
    *,
    workdir: Path | None = None,
    max_rounds: int = 20,
) -> CreditRun:
    """Run one synthetic issuer through the real runtime and write its memo."""
    if issuer_key not in ISSUER_KEYS:
        raise ValueError(f"unknown issuer {issuer_key!r}; known: {list(ISSUER_KEYS)}")
    expected = EXPECTED_RECOMMENDATIONS[issuer_key]
    target = Path(workdir) if workdir is not None else WORK_DIR / issuer_key
    target.mkdir(parents=True, exist_ok=True)
    db_path = target / "task.sqlite"
    _fresh_database(db_path)
    store = TaskStore(db_path)
    try:
        world = CREDIT_DOMAIN.create_world(issuer=issuer_key)
        registry = ToolRegistry(CREDIT_DOMAIN.build_tools(world))
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
            task_id=f"task-credit-{issuer_key}",
            objective=f"对{ISSUER_NAMES[issuer_key]}做 FY2025 信用核查并生成 memo",
            principal="credit-demo",
            binding={
                "scenario": f"credit-{issuer_key}",
                "corpus": "synthetic-authored-v1",
                "module": CREDIT_DOMAIN.key,
                "issuer": issuer_key,
                "synthetic": True,
            },
            allowed_tools=allowed,
            grant={
                "grant_id": f"grant-credit-{issuer_key}",
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
            planner=CREDIT_DOMAIN.make_planner(),
            max_rounds=max_rounds,
            observer=recorder,
            result_tools=CREDIT_DOMAIN.result_tools,
        ).run(task.id)

        trace = recorder.build(task)
        trace_verification = verify_trace(trace)
        trace_path = export_trace(trace, target / "trace.json")
        observations = _observations(store.events(task.id))
        memo = build_memo(
            world,
            observations,
            chain_head=trace_verification["head_hash"],
            plan=task.plan_state,
        )
        memo_path, memo_md_path, memo_sha = write_memo(memo, target)

        metrics = {
            entry["metric"]: (
                entry["value_bp"] if entry["kind"] == "ratio" else entry["value_code"]
            )
            for entry in memo["metrics"]
        }
        failure = task.failure or {}
        return CreditRun(
            issuer_key=issuer_key,
            issuer=world.display_name,
            expected=expected,
            status=task.status,
            failure_code=failure.get("code", ""),
            recommended_conclusion=memo["recommended_conclusion"],
            conclusion_authority=memo["conclusion_authority"],
            decision_status=memo["decision_status"],
            issued=bool(memo["issued"]),
            signed=bool(memo["signed"]),
            rule_fired=memo["rule_fired"],
            metrics=metrics,
            memo=memo,
            memo_path=str(memo_path),
            memo_md_path=str(memo_md_path),
            memo_sha256=memo_sha,
            chain_head=trace_verification["head_hash"],
            chain_verified=bool(trace_verification["verified"]),
            verified=bool(memo["verified"]),
            missing_required=list(memo.get("missing_required") or []),
            missing_optional=list(memo.get("missing_optional") or []),
            optional_gaps=[dict(gap) for gap in memo.get("optional_gaps") or []],
            optional_verified=bool(memo.get("optional_verified")),
            trace_path=str(trace_path),
        )
    finally:
        store.close()


def run_all(*, workdir: Path | None = None, max_rounds: int = 20) -> list[CreditRun]:
    """Run all three synthetic issuers in order."""
    base = Path(workdir) if workdir is not None else WORK_DIR
    return [
        run_issuer(key, workdir=base / key, max_rounds=max_rounds)
        for key in ISSUER_KEYS
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FCode credit due-diligence demo")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--issuer", choices=ISSUER_KEYS, help="run one synthetic issuer")
    target.add_argument("--all", action="store_true", help="run all three issuers")
    parser.add_argument("--workdir", default=None, help="base directory for run artifacts")
    args = parser.parse_args(argv)

    if args.all:
        runs = run_all(workdir=Path(args.workdir) if args.workdir else None)
        ok = all(run.ok for run in runs)
        print(
            json.dumps(
                {"ok": ok, "cases": [run.to_dict() for run in runs]},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if ok else 1

    run = run_issuer(
        args.issuer,
        workdir=Path(args.workdir) if args.workdir else None,
    )
    print(json.dumps(run.to_dict(), ensure_ascii=False, indent=2))
    return 0 if run.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
