"""Host-assembled credit memo and frozen recommendation policy.

The model never writes a number into the memo. This module reads the committed
observations, recomputes every metric with the domain verifier, validates every
citation against the world's line index, and only then assembles the JSON and
Markdown documents.

The memo separates two authorities. **Host issuance** (``issued``) means every
required metric verified, every citation resolved and the Host assembled the
memo; it is not a human signature. **Human sign-off** (``signed``) is true only
when ``reviewer.decision`` is one of :data:`REVIEW_DECISIONS`; Phase 2b has no
review flow, so it is always false. The policy output is a recommendation, not
a credit decision.

Metrics are tiered: five required metrics can block issuance, while three
optional metrics participate in the policy only when disclosed. A missing
optional metric is a caveat, not an insufficient-evidence verdict.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from flowagent.core.contracts import AgentError
from flowagent.core.hashing import digest
from flowagent.tools.base import Observation

from .verifier import verify_observation
from .world import CreditWorld

__all__ = [
    "MEMO_VERSION",
    "REQUIRED_METRICS",
    "OPTIONAL_METRICS",
    "ALL_METRICS",
    "REVIEW_DECISIONS",
    "recommendation_for",
    "conclusion_for",
    "build_memo",
    "memo_sha256",
    "memo_to_markdown",
    "write_memo",
]

MEMO_VERSION = "credit-memo/v2"
REQUIRED_METRICS: tuple[str, ...] = (
    "net_debt_to_ebitda",
    "interest_coverage",
    "ocf_to_short_term_debt",
    "receivables_to_revenue",
    "audit_opinion",
)
OPTIONAL_METRICS: tuple[str, ...] = (
    "related_party_funding_ratio",
    "contingent_liabilities_to_equity",
    "rating_migration",
)
ALL_METRICS: tuple[str, ...] = REQUIRED_METRICS + OPTIONAL_METRICS
#: Documents whose absence is a caveat, not a blocker.
OPTIONAL_DOCUMENTS: tuple[str, ...] = ("doc_rating_fy2025",)
#: Caveat display order; the user-facing sentence lists rating first.
CAVEAT_ORDER: tuple[str, ...] = (
    "rating_migration",
    "related_party_funding_ratio",
    "contingent_liabilities_to_equity",
)
#: A memo is human-signed only when a reviewer records one of these decisions.
REVIEW_DECISIONS: tuple[str, ...] = ("accept", "needs_evidence", "qualified", "redo")


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
) -> tuple[str, str, list[str], list[str]]:
    """Return ``(recommendation, rule_fired, missing_required, missing_optional)``.

    The recommendation is a policy output, not a credit decision. Order is
    frozen: ``insufficient_evidence`` → ``reject`` → ``watch`` → ``pass``.
    Required metrics always participate; an optional metric participates only
    when present. A missing optional metric is reported, never substituted.
    """
    missing_required = [
        metric for metric in REQUIRED_METRICS if not _present(results.get(metric))
    ]
    missing_optional = [
        metric for metric in OPTIONAL_METRICS if not _present(results.get(metric))
    ]
    if missing_required:
        return (
            "insufficient_evidence",
            "insufficient_evidence",
            missing_required,
            missing_optional,
        )

    audit = results["audit_opinion"]["value_code"]
    net_debt = results["net_debt_to_ebitda"]["value_bp"]
    interest = results["interest_coverage"]["value_bp"]
    ocf = results["ocf_to_short_term_debt"]["value_bp"]
    receivables = results["receivables_to_revenue"]["value_bp"]
    rating = results.get("rating_migration") or {}
    related = results.get("related_party_funding_ratio") or {}
    contingent = results.get("contingent_liabilities_to_equity") or {}

    if audit == "disclaimer":
        return "reject", "audit_opinion == disclaimer", [], missing_optional
    if audit == "adverse":
        return "reject", "audit_opinion == adverse", [], missing_optional
    if rating.get("value_code") == "downgrade":
        return "reject", "rating_migration == downgrade", [], missing_optional
    if net_debt > 50000:
        return "reject", "net_debt_to_ebitda > 5.0x", [], missing_optional
    if interest < 20000:
        return "reject", "interest_coverage < 2.0x", [], missing_optional

    if audit == "qualified":
        return "watch", "audit_opinion == qualified", [], missing_optional
    if net_debt > 35000:
        return "watch", "net_debt_to_ebitda > 3.5x", [], missing_optional
    if interest < 40000:
        return "watch", "interest_coverage < 4.0x", [], missing_optional
    if ocf < 2000:
        return "watch", "ocf_to_short_term_debt < 0.2x", [], missing_optional
    if receivables > 2500:
        return "watch", "receivables_to_revenue > 25%", [], missing_optional
    if related.get("value_bp", -1) > 1000:
        return "watch", "related_party_funding_ratio > 10%", [], missing_optional
    if contingent.get("value_bp", -1) > 1000:
        return "watch", "contingent_liabilities_to_equity > 10%", [], missing_optional

    return "pass", "no threshold fired", [], missing_optional


def recommendation_for(
    results: dict[str, dict[str, Any]],
) -> tuple[str, str, list[str]]:
    """Backward-compatible view: recommendation, rule and missing required."""
    recommendation, rule_fired, missing_required, _ = conclusion_for(results)
    return recommendation, rule_fired, missing_required


def build_memo(
    world: CreditWorld,
    observations: list[Observation],
    *,
    chain_head: str,
    synthetic: bool = True,
    research_only: bool = False,
    source_url: str = "",
    accession: str = "",
    cik: str = "",
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Assemble a memo from verified observations; never calls a model.

    ``synthetic`` defaults to true for the production credit demo. Real-data
    callers pass their own metadata (or a ``meta`` dict), so the lab no longer
    patches the assembled memo after the fact.
    """
    if meta:
        synthetic = bool(meta.get("synthetic", synthetic))
        research_only = bool(meta.get("research_only", research_only))
        source_url = str(meta.get("source_url") or source_url)
        accession = str(meta.get("accession") or accession)
        cik = str(meta.get("cik") or cik)

    results: dict[str, dict[str, Any]] = {}
    blocked: dict[str, dict[str, Any]] = {}
    verification_errors: dict[str, str] = {}

    for observation in observations:
        if observation.tool != "compute_credit_metric":
            continue
        metric = observation.result.get("metric")
        if metric not in ALL_METRICS:
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

    recommendation, rule_fired, missing_required, missing_optional = conclusion_for(
        results
    )
    missing = missing_required + missing_optional

    blockers: set[str] = set()
    for metric, result in blocked.items():
        if metric in REQUIRED_METRICS:
            blockers.update(result.get("blockers") or [])
    for observation in observations:
        if observation.tool == "read_document" and observation.result.get("found") is False:
            doc_id = str(
                observation.arguments.get("doc_id")
                or observation.result.get("doc_id")
                or ""
            )
            if doc_id not in OPTIONAL_DOCUMENTS:
                blockers.add(observation.result.get("reason") or "missing_document")
    for metric in missing_required:
        probe = world.compute_credit_metric(metric, "FY2025")
        if not probe.get("computed"):
            blockers.update(probe.get("blockers") or [])
    for metric, message in verification_errors.items():
        if metric in REQUIRED_METRICS:
            blockers.add(f"{metric}: verification_failed ({message})")

    verified = not missing_required and not any(
        metric in verification_errors for metric in REQUIRED_METRICS
    )
    optional_verified = all(
        metric in results for metric in OPTIONAL_METRICS
    ) and not any(metric in verification_errors for metric in OPTIONAL_METRICS)
    issued = verified and recommendation != "insufficient_evidence"
    decision_status = (
        "pending_human_review" if issued else "blocked"
    )
    reviewer = {"decision": None, "reason": "", "signed_at": None}
    signed = reviewer["decision"] in REVIEW_DECISIONS

    metric_entries: list[dict[str, Any]] = []
    for metric in ALL_METRICS:
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
    if missing_required:
        caveats.append("部分必需指标缺失，Host 未签发，memo 未写入任何推测数值。")
    if missing_optional:
        ordered = [metric for metric in CAVEAT_ORDER if metric in missing_optional]
        ordered += [metric for metric in missing_optional if metric not in ordered]
        prefix = "资料未披露" if synthetic else "10-K 未披露"
        caveats.append(
            f"{prefix} {' / '.join(ordered)}；这些可选指标未参与策略结论。"
        )

    return {
        "memo_version": MEMO_VERSION,
        "issuer": world.display_name,
        "issuer_key": world.issuer_key,
        "as_of": "FY2025",
        "synthetic": synthetic,
        "research_only": research_only,
        "source_url": source_url,
        "accession": accession,
        "cik": cik,
        "recommended_conclusion": recommendation,
        "conclusion_authority": "policy",
        "decision_status": decision_status,
        "issued": issued,
        "signed": signed,
        "required_metrics": list(REQUIRED_METRICS),
        "optional_metrics": list(OPTIONAL_METRICS),
        "missing_required": missing_required,
        "missing_optional": missing_optional,
        "optional_verified": optional_verified,
        "rule_fired": rule_fired,
        "metrics": metric_entries,
        "trend": trend,
        "caveats": caveats,
        "reviewer": reviewer,
        "missing": missing,
        "blockers": sorted(blockers),
        "chain_head": chain_head,
        "verified": verified,
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
    recommendation = memo["recommended_conclusion"]
    if recommendation == "insufficient_evidence":
        recommendation_line = f"- 策略建议：{recommendation}（证据不足，未签发）"
        human_line = "- 人工签字：否"
    else:
        recommendation_line = f"- 策略建议：{recommendation}（策略输出，不是信贷决定）"
        human_line = "- 人工签字：否（待复核）"
    disclaimer = (
        "> 合成数据，仅用于 FCode 信用尽调实验；不构成任何信贷或投资意见。"
        if memo.get("synthetic", True)
        else "> 真实公开数据（SEC 10-K），仅用于 FCode 抽取研究；"
        "不构成任何信贷或投资意见。"
    )
    lines = [
        f"# 信用核查备忘录 — {memo['issuer']}",
        "",
        disclaimer,
        "",
        recommendation_line,
        f"- 触发规则：`{memo['rule_fired']}`",
        f"- Host 签发：{'是' if memo['issued'] else '否'}",
        human_line,
        f"- 复核状态：{memo['decision_status']}",
        f"- 已验证（必需指标）：{'是' if memo['verified'] else '否'}",
        f"- 可选指标已验证：{'是' if memo.get('optional_verified') else '否'}",
        f"- 链头：`{memo['chain_head']}`",
        f"- memo sha256：`{sha256}`",
    ]
    if memo.get("source_url"):
        lines.append(f"- 来源：{memo['source_url']}")
    lines.extend(
        [
            "",
            "## 指标",
            "",
            "| 指标 | 值 | 类型 | 引用 |",
            "| --- | --- | --- | --- |",
        ]
    )
    for metric in memo["metrics"]:
        citations = "; ".join(
            f"{item['doc_id']}:{item['line']} {item['field']}"
            for item in metric["citations"]
        )
        lines.append(
            f"| {metric['metric']} | {metric['display']} | {metric['kind']} | {citations} |"
        )
    if memo.get("trend"):
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
    missing_required = memo.get("missing_required", memo.get("missing", []))
    missing_optional = memo.get("missing_optional", [])
    if missing_required:
        lines.extend(
            [
                "",
                "## 缺失必需指标",
                "",
                *(f"- `{metric}`" for metric in missing_required),
            ]
        )
    if missing_optional:
        lines.extend(
            [
                "",
                "## 缺失可选指标",
                "",
                *(f"- `{metric}`" for metric in missing_optional),
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
    signed_at = memo["reviewer"].get("signed_at") or "—"
    lines.extend(
        [
            "",
            "## 复核",
            "",
            f"- 决定：{decision if decision is not None else '待定'}",
            f"- 理由：{memo['reviewer']['reason'] or '（待人工填写）'}",
            f"- 签字时间：{signed_at}",
            "",
            "本备忘录由 Host 从已验证 observation 组装；模型未写入任何数字。",
            "Host 签发只表示结果已验证并由 Host 组装，不等于人工签字或信贷决定。",
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
