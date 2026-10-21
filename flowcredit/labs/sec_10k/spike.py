"""Profile-driven SEC 10-K extraction spike.

Run from ``flowcredit/``::

    PYTHONPATH=src python3.12 labs/sec_10k/spike.py --issuer cisco
    PYTHONPATH=src python3.12 labs/sec_10k/spike.py --issuer home-depot
    PYTHONPATH=src python3.12 labs/sec_10k/spike.py --all

Each issuer reads its own ``data/<issuer>/`` excerpt, metadata, ground truth and
profile. The spike (1) prints the ground-truth vs extractor comparison, (2) runs
the production fourteen-step credit plan through the real Harness/Loop with a
``Sec10kWorld`` adapter, and (3) emits JSON with facts, metrics and memo state.
No network and no third-party library are used at run time.
"""

from __future__ import annotations

import argparse
import json
import sys
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

__all__ = ["available_issuers", "issuer_paths", "run_spike", "main"]

LAB_DIR = Path(__file__).resolve().parent
DATA_ROOT = LAB_DIR / "data"
WORK_ROOT = ROOT / "work" / "sec_10k"


def available_issuers() -> tuple[str, ...]:
    """Issuers with a complete data directory, discovered from disk."""
    if not DATA_ROOT.exists():
        return ()
    return tuple(
        sorted(
            path.name
            for path in DATA_ROOT.iterdir()
            if path.is_dir()
            and (path / "meta.json").exists()
            and (path / "profile.json").exists()
            and (path / "excerpt.txt").exists()
            and (path / "ground_truth.json").exists()
        )
    )


def issuer_paths(issuer: str) -> dict[str, Path]:
    base = DATA_ROOT / issuer
    return {
        "base": base,
        "excerpt": base / "excerpt.txt",
        "meta": base / "meta.json",
        "ground_truth": base / "ground_truth.json",
        "profile": base / "profile.json",
    }


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
        fields = (
            "value",
            "unit",
            "source_unit",
            "period",
            "doc_id",
            "line",
            "snippet",
            "components",
        )
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


def run_spike(issuer: str, workdir: Path | None = None) -> dict[str, Any]:
    """Run one issuer: extraction + the production credit plan; return JSON."""
    paths = issuer_paths(issuer)
    target = Path(workdir) if workdir is not None else WORK_ROOT / issuer
    target.mkdir(parents=True, exist_ok=True)
    db_path = target / "task.sqlite"
    _fresh_database(db_path)

    excerpt_lines = paths["excerpt"].read_text(encoding="utf-8").splitlines()
    meta = json.loads(paths["meta"].read_text(encoding="utf-8"))
    ground_truth = json.loads(paths["ground_truth"].read_text(encoding="utf-8"))
    extracted = extract_all(paths["excerpt"], paths["meta"], paths["profile"])
    facts = _facts_report(ground_truth, extracted)
    field_lines = {
        fact: item["line"]
        for fact, item in extracted.items()
        if item.get("status") == "ok" and isinstance(item.get("line"), int)
    }
    world = Sec10kWorld(issuer, extracted, meta, excerpt_lines, field_lines)

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
            task_id=f"task-sec-10k-{issuer}",
            objective=(
                f"{meta.get('company', issuer)} {meta.get('fiscal_year', '')} "
                "10-K extraction and credit-plan spike"
            ),
            principal="sec-10k-lab",
            binding={
                "scenario": "sec-10k",
                "module": CREDIT_DOMAIN.key,
                "issuer": issuer,
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
            plan=task.plan_state,
            synthetic=bool(meta.get("synthetic", False)),
            research_only=bool(meta.get("research_only", True)),
            source_url=str(meta.get("source_url", "")),
            accession=str(meta.get("accession", "")),
            cik=str(meta.get("cik", "")),
        )
        memo_sha = memo_sha256(memo)
        memo_path = target / "memo.json"
        memo_md_path = target / "memo.md"
        memo_path.write_text(
            json.dumps(memo, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        markdown = memo_to_markdown(memo, memo_sha)
        memo_md_path.write_text(markdown, encoding="utf-8")

        computed = {
            entry["metric"]: (
                entry["value_bp"] if entry["kind"] == "ratio" else entry["value_code"]
            )
            for entry in memo["metrics"]
        }
        expected = _expected_metrics(ground_truth)
        metrics_match = computed == expected
        issued = bool(memo.get("issued"))
        expected_issued = bool(memo.get("verified")) and (
            memo.get("recommended_conclusion") != "insufficient_evidence"
        )
        memo_state_ok = (
            issued == expected_issued
            and memo.get("signed") is False
            and memo.get("decision_status")
            == ("pending_human_review" if issued else "blocked")
            and len(memo.get("missing_optional") or [])
            == len(memo.get("optional_gaps") or [])
        )
        ok = (
            all(item["match"] for item in facts)
            and metrics_match
            and memo_state_ok
            and bool(verification.get("verified"))
        )
        return {
            "ok": ok,
            "issuer_key": issuer,
            "issuer": world.display_name,
            "company": meta.get("company", ""),
            "fiscal_year": meta.get("fiscal_year", ""),
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
                "memo_version": memo.get("memo_version"),
                "recommended_conclusion": memo.get("recommended_conclusion"),
                "conclusion_authority": memo.get("conclusion_authority"),
                "rule_fired": memo.get("rule_fired"),
                "issued": memo.get("issued"),
                "signed": memo.get("signed"),
                "decision_status": memo.get("decision_status"),
                "verified": memo.get("verified"),
                "required_metrics": list(memo.get("required_metrics") or []),
                "optional_metrics": list(memo.get("optional_metrics") or []),
                "missing_required": list(memo.get("missing_required") or []),
                "missing_optional": list(memo.get("missing_optional") or []),
                "optional_gaps": [
                    dict(gap) for gap in memo.get("optional_gaps") or []
                ],
                "optional_verified": bool(memo.get("optional_verified")),
                "missing": list(memo.get("missing") or []),
                "caveats": list(memo.get("caveats") or []),
                "blockers": list(memo.get("blockers") or []),
                "synthetic": memo.get("synthetic"),
                "research_only": memo.get("research_only"),
            },
            "trace_path": str(trace_path),
        }
    finally:
        store.close()


def _print_comparison(result: dict[str, Any]) -> None:
    issuer = result.get("issuer_key", "?")
    for item in result.get("facts") or ():
        gt = item["ground_truth"]
        ex = item["extracted"]
        print(
            f"{issuer:12} {item['fact']:30} "
            f"{'MATCH' if item['match'] else 'FAIL':5} "
            f"gt_line={gt.get('line')} ex_line={ex.get('line')} "
            f"gt_value={gt.get('value')} ex_value={ex.get('value')}",
            file=sys.stderr,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the SEC 10-K extraction spike")
    parser.add_argument("--issuer", choices=available_issuers(), default=None)
    parser.add_argument("--all", action="store_true", help="run every complete issuer")
    args = parser.parse_args(argv)
    if not args.all and not args.issuer:
        parser.error("pass --issuer or --all")

    targets = available_issuers() if args.all else (args.issuer,)
    results: list[dict[str, Any]] = []
    for issuer in targets:
        try:
            result = run_spike(issuer)
        except Exception as error:  # noqa: BLE001 - the spike must fail as JSON too
            result = {
                "ok": False,
                "issuer_key": issuer,
                "error": f"{type(error).__name__}: {error}",
            }
        _print_comparison(result)
        results.append(result)

    ok = all(result.get("ok") for result in results)
    payload: dict[str, Any] = (
        {"ok": ok, "issuers": results} if args.all else results[0]
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
