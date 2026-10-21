"""SEC 10-K extraction spike: 21 facts -> same credit plan -> blocked memo.

Run from ``flowcredit/``::

    PYTHONPATH=src python3.12 labs/sec_10k/spike.py

The spike (1) prints the ground-truth vs extractor comparison, (2) runs the
production fourteen-step credit plan through the real Harness/Loop with a
``Sec10kWorld`` adapter, and (3) emits JSON with the facts, metrics and memo
state. No network and no third-party library are used at run time.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
for candidate in (ROOT, ROOT / "src"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from flowagent.core.receipts import ReceiptStore  # noqa: E402
from flowagent.core.store import TaskStore  # noqa: E402
from flowagent.domains.credit import CREDIT_DOMAIN  # noqa: E402
from flowagent.providers.mock import MockProvider  # noqa: E402
from flowagent.runtime.budget import BudgetLimits  # noqa: E402
from flowagent.runtime.harness import Harness  # noqa: E402
from flowagent.runtime.loop import Loop  # noqa: E402
from flowagent.tools.base import Observation  # noqa: E402
from flowagent.tools.credit.memo import (  # noqa: E402
    build_memo,
    memo_sha256,
    memo_to_markdown,
)
from flowagent.tools.credit.planner import CreditPlanner  # noqa: E402
from flowagent.tools.credit.tools import CREDIT_TOOL_NAMES, build_credit_tools  # noqa: E402
from flowagent.tools.registry import ToolRegistry  # noqa: E402
from flowagent.trajectory.exporter import export_trace, verify_trace  # noqa: E402
from flowagent.trajectory.recorder import TraceRecorder  # noqa: E402

from labs.sec_10k.extract import FACT_ORDER, extract_all  # noqa: E402
from labs.sec_10k.world import Sec10kWorld  # noqa: E402

__all__ = ["run_spike", "main"]

LAB_DIR = Path(__file__).resolve().parent
DATA_DIR = LAB_DIR / "data"
EXCERPT_PATH = DATA_DIR / "excerpt.txt"
META_PATH = DATA_DIR / "meta.json"
GROUND_TRUTH_PATH = DATA_DIR / "ground_truth.json"
WORK_DIR = ROOT / "work" / "sec_10k"

_REAL_DISCLAIMER = (
    "> 真实公开数据（SEC 10-K），仅用于 FCode 抽取研究；"
    "不构成任何信贷或投资意见。"
)
_SYNTHETIC_DISCLAIMER = (
    "> 合成数据，仅用于 FCode 信用尽调实验；不构成任何信贷或投资意见。"
)


def _ratio_bp(numerator: int, denominator: int) -> int:
    return (numerator * 10000 + denominator // 2) // denominator


def _expected_metrics(ground_truth: list[dict[str, Any]]) -> dict[str, Any]:
    values = {item["fact"]: item["value"] for item in ground_truth}
    ebitda = values["operating_income"] + values["depreciation_amortization"]
    return {
        "net_debt_to_ebitda": _ratio_bp(
            values["total_debt"] - values["cash_and_equivalents"], ebitda
        ),
        "interest_coverage": _ratio_bp(ebitda, values["interest_expense"]),
        "ocf_to_short_term_debt": _ratio_bp(
            values["operating_cash_flow"], values["short_term_debt"]
        ),
        "receivables_to_revenue": _ratio_bp(
            values["accounts_receivable"], values["revenue"]
        ),
        "audit_opinion": values["audit_opinion"],
    }


def _facts_report(
    ground_truth: list[dict[str, Any]],
    extracted: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    truth = {item["fact"]: item for item in ground_truth}
    report = []
    for fact in FACT_ORDER:
        expected = truth[fact]
        actual = extracted[fact]
        fields = ("value", "unit", "source_unit", "period", "doc_id", "line", "snippet")
        match = all(expected.get(field) == actual.get(field) for field in fields)
        report.append(
            {
                "fact": fact,
                "ground_truth": expected,
                "extracted": actual,
                "match": match,
            }
        )
    return report


def _observations(events: list[dict[str, Any]]) -> list[Observation]:
    observations = []
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


def _fresh_database(path: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        candidate = path.with_name(path.name + suffix)
        if candidate.exists():
            candidate.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)


def run_spike(workdir: Path | None = None) -> dict[str, Any]:
    """Run extraction + the production credit plan; return the spike JSON."""
    target = Path(workdir) if workdir is not None else WORK_DIR
    target.mkdir(parents=True, exist_ok=True)
    db_path = target / "task.sqlite"
    _fresh_database(db_path)

    excerpt_lines = EXCERPT_PATH.read_text(encoding="utf-8").splitlines()
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    ground_truth = json.loads(GROUND_TRUTH_PATH.read_text(encoding="utf-8"))
    extracted = extract_all(EXCERPT_PATH, META_PATH)
    facts = _facts_report(ground_truth, extracted)
    world = Sec10kWorld(extracted, meta, excerpt_lines)

    store = TaskStore(db_path)
    try:
        registry = ToolRegistry(build_credit_tools(world))
        provider = MockProvider(policy="research")
        harness = Harness(
            store=store,
            registry=registry,
            provider=provider,
            world=world,
            limits=BudgetLimits(20, 20, 20_000, 20_000),
            receipts=ReceiptStore(store),
            verifier=lambda observation: CREDIT_DOMAIN.verify(world, observation),
        )
        allowed = list(CREDIT_TOOL_NAMES)
        task = harness.create(
            task_id="task-sec-10k-cisco",
            objective="Cisco FY2025 10-K extraction and credit-plan spike",
            principal="sec-10k-lab",
            binding={
                "scenario": "sec-10k",
                "module": CREDIT_DOMAIN.key,
                "issuer": "cisco",
                "synthetic": False,
                "research_only": True,
            },
            allowed_tools=allowed,
            grant={
                "allowed_tools": allowed,
                "max_calls": 20,
                "max_reads": 20,
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
            max_rounds=20,
            observer=recorder,
            result_tools=CREDIT_DOMAIN.result_tools,
        ).run(task.id)

        trace = recorder.build(task)
        verification = verify_trace(trace)
        trace_path = export_trace(trace, target / "trace.json")
        memo = build_memo(
            world,
            _observations(store.events(task.id)),
            chain_head=verification["head_hash"],
        )
        memo["synthetic"] = False
        memo["research_only"] = True
        memo["source_url"] = meta.get("source_url", "")
        memo["accession"] = meta.get("accession", "")
        memo["cik"] = meta.get("cik", "")
        memo_sha = memo_sha256(memo)
        memo_path = target / "memo.json"
        memo_md_path = target / "memo.md"
        memo_path.write_text(
            json.dumps(memo, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        markdown = memo_to_markdown(memo, memo_sha).replace(
            _SYNTHETIC_DISCLAIMER, _REAL_DISCLAIMER
        )
        memo_md_path.write_text(markdown, encoding="utf-8")

        computed = {
            entry["metric"]: (
                entry["value_bp"] if entry["kind"] == "ratio" else entry["value_code"]
            )
            for entry in memo["metrics"]
        }
        expected = _expected_metrics(ground_truth)
        metrics_match = computed == expected
        memo_state_ok = (
            memo.get("recommended_conclusion") == "insufficient_evidence"
            and memo.get("issued") is False
            and memo.get("signed") is False
            and memo.get("decision_status") == "blocked"
            and "rating_migration" in (memo.get("missing") or [])
        )
        ok = (
            all(item["match"] for item in facts)
            and metrics_match
            and memo_state_ok
            and bool(verification.get("verified"))
        )
        return {
            "ok": ok,
            "issuer": world.display_name,
            "facts": facts,
            "metrics": {
                "computed": computed,
                "expected": expected,
                "missing": list(memo.get("missing") or []),
                "match": metrics_match,
            },
            "memo": {
                "path": str(memo_path),
                "md_path": str(memo_md_path),
                "sha256": memo_sha,
                "chain_head": verification["head_hash"],
                "recommended_conclusion": memo.get("recommended_conclusion"),
                "conclusion_authority": memo.get("conclusion_authority"),
                "issued": memo.get("issued"),
                "signed": memo.get("signed"),
                "decision_status": memo.get("decision_status"),
                "verified": memo.get("verified"),
                "missing": list(memo.get("missing") or []),
                "blockers": list(memo.get("blockers") or []),
                "synthetic": memo.get("synthetic"),
                "research_only": memo.get("research_only"),
            },
            "trace_path": str(trace_path),
        }
    finally:
        store.close()


def main() -> int:
    try:
        result = run_spike()
    except Exception as error:  # noqa: BLE001 - the spike must fail as JSON too
        print(
            json.dumps(
                {"ok": False, "error": f"{type(error).__name__}: {error}"},
                ensure_ascii=False,
                indent=2,
            )
        )
        return 1
    for item in result["facts"]:
        gt = item["ground_truth"]
        ex = item["extracted"]
        print(
            f"{item['fact']:28} {'MATCH' if item['match'] else 'FAIL':5} "
            f"gt_line={gt.get('line')} ex_line={ex.get('line')} "
            f"gt_value={gt.get('value')} ex_value={ex.get('value')}",
            file=sys.stderr,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
