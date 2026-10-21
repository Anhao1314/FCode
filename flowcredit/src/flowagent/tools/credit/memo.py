"""Host-assembled credit memo and frozen conclusion policy.

The model never writes a number into the memo. This module reads the committed
observations, recomputes every metric with the domain verifier, validates every
citation against the world's line index, and only then assembles the JSON and
Markdown documents. A missing required metric makes the memo unsigned; it never
fills the gap with a plausible value.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flowagent.core.contracts import AgentError
from flowagent.core.hashing import digest
from flowagent.tools.base import Observation

from .verifier import verify_observation
from .world import METRICS, CreditWorld

__all__ = [
    "MEMO_VERSION",
    "REQUIRED_METRICS",
    "conclusion_for",
    "build_memo",
    "memo_sha256",
    "memo_to_markdown",
    "write_memo",
]

MEMO_VERSION = "credit-memo/v1"
REQUIRED_METRICS: tuple[str, ...] = METRICS


def _present(result: dict[str, Any] | None) -> bool:
    if not result or result.get("computed") is False:
        return False
    if result.get("kind") == "ratio":
        return isinstance(result.get("value_bp"), int)
    if result.get("kind") == "code":
        return isinstance(result.get("value_code"), str)
    return False


def conclusion_for(
    results: dict[str, dict[str, Any]],
) -> tuple[str, str, list[str]]:
    """Return ``(conclusion, rule_fired, missing_metrics)``.

    Order is frozen: ``insufficient_evidence`` → ``reject`` → ``watch`` →
    ``pass``. The thresholds are product policy, not investment advice.
    """
    missing = [metric for metric in REQUIRED_METRICS if not _present(results.get(metric))]
    if missing:
        return "insufficient_evidence", "insufficient_evidence", missing

    audit = results["audit_opinion"]["value_code"]
    rating = results["rating_migration"]["value_code"]
    net_debt = results["net_debt_to_ebitda"]["value_bp"]
    interest = results["interest_coverage"]["value_bp"]
    ocf = results["ocf_to_short_term_debt"]["value_bp"]
    receivables = results["receivables_to_revenue"]["value_bp"]
    related = results["related_party_funding_ratio"]["value_bp"]
    contingent = results["contingent_liabilities_to_equity"]["value_bp"]

    if audit == "disclaimer":
        return "reject", "audit_opinion == disclaimer", []
    if audit == "adverse":
        return "reject", "audit_opinion == adverse", []
    if rating == "downgrade":
        return "reject", "rating_migration == downgrade", []
    if net_debt > 50000:
        return "reject", "net_debt_to_ebitda > 5.0x", []
    if interest < 20000:
        return "reject", "interest_coverage < 2.0x", []

    if audit == "qualified":
        return "watch", "audit_opinion == qualified", []
    if net_debt > 35000:
        return "watch", "net_debt_to_ebitda > 3.5x", []
    if interest < 40000:
        return "watch", "interest_coverage < 4.0x", []
    if ocf < 2000:
        return "watch", "ocf_to_short_term_debt < 0.2x", []
    if receivables > 2500:
        return "watch", "receivables_to_revenue > 25%", []
    if related > 1000:
        return "watch", "related_party_funding_ratio > 10%", []
    if contingent > 1000:
        return "watch", "contingent_liabilities_to_equity > 10%", []

    return "pass", "no threshold fired", []


def build_memo(
    world: CreditWorld,
    observations: list[Observation],
    *,
    chain_head: str,
) -> dict[str, Any]:
    """Assemble a memo from verified observations; never calls a model."""
    results: dict[str, dict[str, Any]] = {}
    blocked: dict[str, dict[str, Any]] = {}
    verification_errors: dict[str, str] = {}

    for observation in observations:
        if observation.tool != "compute_credit_metric":
            continue
        metric = observation.result.get("metric")
        if metric not in REQUIRED_METRICS:
            continue
        if not observation.result.get("computed"):
            blocked[metric] = observation.result
            continue
        try:
            verified = verify_observation(world, observation)
        except AgentError as error:
            verification_errors[metric] = error.message
            continue
        results[metric] = verified["result"]

    conclusion, rule_fired, missing = conclusion_for(results)

    blockers: set[str] = set()
    for result in blocked.values():
        blockers.update(result.get("blockers") or [])
    for observation in observations:
        if observation.tool == "read_document" and observation.result.get("found") is False:
            blockers.add(observation.result.get("reason") or "missing_document")
    for metric in missing:
        probe = world.compute_credit_metric(metric, "FY2025")
        if not probe.get("computed"):
            blockers.update(probe.get("blockers") or [])
    for metric, message in verification_errors.items():
        blockers.add(f"{metric}: verification_failed ({message})")

    verified = not missing and not verification_errors and all(
        result.get("computed") for result in results.values()
    )
    signed = verified and conclusion != "insufficient_evidence"

    metric_entries: list[dict[str, Any]] = []
    for metric in REQUIRED_METRICS:
        result = results.get(metric)
        if result is None:
            continue
        citations = list(result.get("citations") or [])
        if not citations:
            raise AgentError("MEMO_CITATION_MISSING", f"{metric} has no citation")
        for citation in citations:
            if not world.verify_citation(citation):
                raise AgentError(
                    "MEMO_CITATION_INVALID",
                    f"{metric} citation does not resolve: {citation!r}",
                )
        metric_entries.append(
            {
                "metric": metric,
                "period": result["period"],
                "kind": result["kind"],
                "value_bp": result.get("value_bp"),
                "value_code": result.get("value_code"),
                "display": result["display"],
                "citations": citations,
            }
        )

    trend = _trend(world, results)
    caveats: list[str] = []
    if world.restatement is not None:
        original = world.restatement["original_ebitda"]
        restated = world.restatement["restated_ebitda"]
        caveats.append(f"FY2024 EBITDA 从 {original:,} 重述为 {restated:,}。")
    if missing:
        caveats.append("部分必需指标缺失，memo 未签字，未写入任何推测数值。")

    return {
        "memo_version": MEMO_VERSION,
        "issuer": world.display_name,
        "issuer_key": world.issuer_key,
        "as_of": "FY2025",
        "synthetic": True,
        "conclusion": conclusion,
        "rule_fired": rule_fired,
        "metrics": metric_entries,
        "trend": trend,
        "caveats": caveats,
        "reviewer": {"decision": None, "reason": ""},
        "missing": missing,
        "blockers": sorted(blockers),
        "chain_head": chain_head,
        "verified": verified,
        "signed": signed,
    }


def _trend(world: CreditWorld, results: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """Build the FY2024 -> FY2025 interest-coverage trend when restated."""
    restatement = world.restatement
    current = results.get("interest_coverage")
    if restatement is None or current is None:
        return None
    prior = world.compute_credit_metric("interest_coverage", "FY2024")
    if not prior.get("computed"):
        return None
    citations = list(prior.get("citations") or [])
    for citation in citations:
        if not world.verify_citation(citation):
            raise AgentError(
                "MEMO_CITATION_INVALID",
                f"trend citation does not resolve: {citation!r}",
            )
    return {
        "metric": "interest_coverage",
        "prior_period": "FY2024",
        "current_period": "FY2025",
        "prior_value_bp": prior["value_bp"],
        "current_value_bp": current["value_bp"],
        "change_bp": current["value_bp"] - prior["value_bp"],
        "basis": (
            f"FY2024 EBITDA restated from {restatement['original_ebitda']:,} "
            f"to {restatement['restated_ebitda']:,}"
        ),
        "citations": citations,
    }


def memo_sha256(memo: dict[str, Any]) -> str:
    """Hash the canonical memo JSON; this is the value logged by the runner."""
    return digest(memo)


def memo_to_markdown(memo: dict[str, Any], sha256: str) -> str:
    """Render the human-readable memo from the JSON values, not model prose."""
    lines = [
        f"# 信用核查备忘录 — {memo['issuer']}",
        "",
        "> 合成数据，仅用于 FCode 信用尽调实验；不构成任何信贷或投资意见。",
        "",
        f"- 结论：**{memo['conclusion']}**",
        f"- 触发规则：`{memo['rule_fired']}`",
        f"- 签字：{'是' if memo['signed'] else '否'}",
        f"- 已验证：{'是' if memo['verified'] else '否'}",
        f"- 链头：`{memo['chain_head']}`",
        f"- memo sha256：`{sha256}`",
        "",
        "## 指标",
        "",
        "| 指标 | 值 | 类型 | 引用 |",
        "| --- | --- | --- | --- |",
    ]
    for metric in memo["metrics"]:
        citations = "; ".join(
            f"{item['doc_id']}:{item['line']} {item['field']}"
            for item in metric["citations"]
        )
        lines.append(
            f"| {metric['metric']} | {metric['display']} | {metric['kind']} | {citations} |"
        )
    if memo["trend"]:
        trend = memo["trend"]
        lines.extend(
            [
                "",
                "## 趋势",
                "",
                f"- {trend['metric']}：{trend['prior_period']} "
                f"{trend['prior_value_bp']} bp → {trend['current_period']} "
                f"{trend['current_value_bp']} bp（变化 {trend['change_bp']} bp）",
                f"- 口径：{trend['basis']}",
            ]
        )
    lines.extend(["", "## 注意事项", ""])
    if memo["caveats"]:
        lines.extend(f"- {caveat}" for caveat in memo["caveats"])
    else:
        lines.append("- 无")
    if memo["missing"]:
        lines.extend(
            [
                "",
                "## 缺失指标",
                "",
                *(f"- `{metric}`" for metric in memo["missing"]),
            ]
        )
    if memo["blockers"]:
        lines.extend(
            [
                "",
                "## 阻断原因",
                "",
                *(f"- `{blocker}`" for blocker in memo["blockers"]),
            ]
        )
    decision = memo["reviewer"]["decision"]
    lines.extend(
        [
            "",
            "## 复核",
            "",
            f"- 决定：{decision if decision is not None else '待定'}",
            f"- 理由：{memo['reviewer']['reason'] or '（待人工填写）'}",
            "",
            "本备忘录由 Host 从已验证 observation 组装；模型未写入任何数字。",
            "",
        ]
    )
    return "\n".join(lines)


def write_memo(memo: dict[str, Any], workdir: Path) -> tuple[Path, Path, str]:
    """Write ``memo.json`` and ``memo.md``; return paths and canonical hash."""
    workdir.mkdir(parents=True, exist_ok=True)
    sha256 = memo_sha256(memo)
    json_path = workdir / "memo.json"
    markdown_path = workdir / "memo.md"
    json_path.write_text(
        json.dumps(memo, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    markdown_path.write_text(memo_to_markdown(memo, sha256), encoding="utf-8")
    return json_path, markdown_path, sha256
