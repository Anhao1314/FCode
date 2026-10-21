"""Host memo assembly, policy recommendations and the issuance/sign-off split."""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from flowagent.demo.credit import EXPECTED_RECOMMENDATIONS, run_all, run_issuer  # noqa: E402
from flowagent.tools.credit.memo import (  # noqa: E402
    MEMO_VERSION,
    OPTIONAL_METRICS,
    REQUIRED_METRICS,
    conclusion_for,
    recommendation_for,
    memo_sha256,
)
from flowagent.tools.credit.world import CreditWorld  # noqa: E402

MISSING_YUNLING = [
    "net_debt_to_ebitda",
    "ocf_to_short_term_debt",
    "related_party_funding_ratio",
    "contingent_liabilities_to_equity",
    "rating_migration",
]
MISSING_OPTIONAL_YUNLING = [
    "related_party_funding_ratio",
    "contingent_liabilities_to_equity",
    "rating_migration",
]


def _safe_metrics() -> dict[str, dict]:
    return {
        "net_debt_to_ebitda": {"kind": "ratio", "computed": True, "value_bp": 10000},
        "interest_coverage": {"kind": "ratio", "computed": True, "value_bp": 50000},
        "ocf_to_short_term_debt": {"kind": "ratio", "computed": True, "value_bp": 5000},
        "receivables_to_revenue": {"kind": "ratio", "computed": True, "value_bp": 1000},
        "related_party_funding_ratio": {"kind": "ratio", "computed": True, "value_bp": 100},
        "contingent_liabilities_to_equity": {"kind": "ratio", "computed": True, "value_bp": 100},
        "audit_opinion": {"kind": "code", "computed": True, "value_code": "standard_unqualified"},
        "rating_migration": {"kind": "code", "computed": True, "value_code": "stable"},
    }


class MemoPolicyTests(unittest.TestCase):
    def test_pass_branch_is_reachable(self) -> None:
        recommendation, rule, missing = recommendation_for(_safe_metrics())
        self.assertEqual(recommendation, "pass")
        self.assertEqual(rule, "no threshold fired")
        self.assertEqual(missing, [])

    def test_insufficient_evidence_wins_over_every_threshold(self) -> None:
        metrics = _safe_metrics()
        metrics["net_debt_to_ebitda"]["value_bp"] = 60000
        del metrics["audit_opinion"]
        recommendation, rule, missing = recommendation_for(metrics)
        self.assertEqual(recommendation, "insufficient_evidence")
        self.assertEqual(rule, "insufficient_evidence")
        self.assertEqual(missing, ["audit_opinion"])

    def test_reject_precedes_watch(self) -> None:
        metrics = _safe_metrics()
        metrics["audit_opinion"]["value_code"] = "qualified"
        metrics["net_debt_to_ebitda"]["value_bp"] = 50001
        recommendation, rule, _ = recommendation_for(metrics)
        self.assertEqual(recommendation, "reject")
        self.assertEqual(rule, "net_debt_to_ebitda > 5.0x")

    def test_watch_rules(self) -> None:
        metrics = _safe_metrics()
        metrics["interest_coverage"]["value_bp"] = 39999
        recommendation, rule, _ = recommendation_for(metrics)
        self.assertEqual(recommendation, "watch")
        self.assertEqual(rule, "interest_coverage < 4.0x")

    def test_optional_gaps_do_not_block(self) -> None:
        metrics = _safe_metrics()
        for metric in OPTIONAL_METRICS:
            del metrics[metric]
        recommendation, rule, missing_required, missing_optional = conclusion_for(metrics)
        self.assertEqual(recommendation, "pass")
        self.assertEqual(rule, "no threshold fired")
        self.assertEqual(missing_required, [])
        self.assertEqual(set(missing_optional), set(OPTIONAL_METRICS))

    def test_optional_rating_downgrade_still_rejects(self) -> None:
        metrics = _safe_metrics()
        metrics["rating_migration"]["value_code"] = "downgrade"
        recommendation, rule, missing_required, _ = conclusion_for(metrics)
        self.assertEqual(recommendation, "reject")
        self.assertEqual(rule, "rating_migration == downgrade")
        self.assertEqual(missing_required, [])

    def test_optional_related_and_contingent_still_watch(self) -> None:
        for metric, rule in (
            ("related_party_funding_ratio", "related_party_funding_ratio > 10%"),
            ("contingent_liabilities_to_equity", "contingent_liabilities_to_equity > 10%"),
        ):
            with self.subTest(metric=metric):
                metrics = _safe_metrics()
                metrics[metric]["value_bp"] = 1001
                recommendation, fired, missing_required, _ = conclusion_for(metrics)
                self.assertEqual(recommendation, "watch")
                self.assertEqual(fired, rule)
                self.assertEqual(missing_required, [])

    def test_missing_required_wins_over_optional_thresholds(self) -> None:
        metrics = _safe_metrics()
        metrics["rating_migration"]["value_code"] = "downgrade"
        metrics["related_party_funding_ratio"]["value_bp"] = 5000
        del metrics["net_debt_to_ebitda"]
        recommendation, rule, missing_required, missing_optional = conclusion_for(metrics)
        self.assertEqual(recommendation, "insufficient_evidence")
        self.assertEqual(rule, "insufficient_evidence")
        self.assertEqual(missing_required, ["net_debt_to_ebitda"])
        self.assertEqual(missing_optional, [])


class MemoRunTests(unittest.TestCase):
    def test_hengxing_is_watch_issued_but_not_signed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run = run_issuer("hengxing", workdir=Path(tmp) / "hengxing")
            self.assertEqual(run.status, "succeeded")
            self.assertEqual(run.failure_code, "")
            self.assertEqual(run.recommended_conclusion, "watch")
            self.assertEqual(run.conclusion_authority, "policy")
            self.assertEqual(run.decision_status, "pending_human_review")
            self.assertTrue(run.issued)
            self.assertFalse(run.signed)
            self.assertTrue(run.verified)
            self.assertTrue(run.chain_verified)
            self.assertEqual(run.memo["recommended_conclusion"], "watch")
            self.assertEqual(run.memo["conclusion_authority"], "policy")
            self.assertEqual(run.memo["decision_status"], "pending_human_review")
            self.assertTrue(run.memo["issued"])
            self.assertFalse(run.memo["signed"])
            self.assertTrue(run.memo["verified"])
            self.assertEqual(
                run.memo["reviewer"],
                {"decision": None, "reason": "", "signed_at": None},
            )
            self.assertNotIn("conclusion", run.memo)
            self.assertEqual(run.memo["memo_version"], MEMO_VERSION)
            self.assertEqual(run.memo["required_metrics"], list(REQUIRED_METRICS))
            self.assertEqual(run.memo["optional_metrics"], list(OPTIONAL_METRICS))
            self.assertEqual(run.memo["missing_required"], [])
            self.assertEqual(run.memo["missing_optional"], [])
            self.assertTrue(run.memo["optional_verified"])
            self.assertEqual(run.missing_required, [])
            self.assertEqual(run.missing_optional, [])
            self.assertTrue(run.optional_verified)
            self.assertEqual(len(run.memo["metrics"]), 8)
            self.assertEqual(run.metrics["net_debt_to_ebitda"], 37714)
            self.assertEqual(run.metrics["interest_coverage"], 41667)
            self.assertEqual(run.metrics["audit_opinion"], "standard_unqualified")
            self.assertEqual(run.memo["chain_head"], run.chain_head)
            self.assertTrue(Path(run.memo_path).exists())
            self.assertTrue(Path(run.memo_md_path).exists())
            self.assertEqual(run.memo_sha256, memo_sha256(run.memo))
            self.assertEqual(json.loads(Path(run.memo_path).read_text(encoding="utf-8")), run.memo)

            markdown = Path(run.memo_md_path).read_text(encoding="utf-8")
            self.assertNotIn("签字：是", markdown)
            self.assertIn("策略建议：watch（策略输出，不是信贷决定）", markdown)
            self.assertIn("Host 签发：是", markdown)
            self.assertIn("人工签字：否（待复核）", markdown)
            self.assertIn("复核状态：pending_human_review", markdown)

            world = CreditWorld("hengxing")
            for metric in run.memo["metrics"]:
                self.assertTrue(metric["citations"], metric["metric"])
                for citation in metric["citations"]:
                    self.assertTrue(world.verify_citation(citation), citation)

    def test_yuanyang_is_reject_issued_but_not_signed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run = run_issuer("yuanyang", workdir=Path(tmp) / "yuanyang")
            self.assertEqual(run.status, "succeeded")
            self.assertEqual(run.recommended_conclusion, "reject")
            self.assertEqual(run.decision_status, "pending_human_review")
            self.assertTrue(run.issued)
            self.assertFalse(run.signed)
            self.assertTrue(run.memo["issued"])
            self.assertFalse(run.memo["signed"])
            self.assertTrue(run.memo["verified"])
            self.assertEqual(run.memo["missing_required"], [])
            self.assertEqual(run.memo["missing_optional"], [])
            self.assertTrue(run.memo["optional_verified"])
            self.assertTrue(run.optional_verified)
            self.assertEqual(run.rule_fired, "rating_migration == downgrade")
            self.assertEqual(run.metrics["net_debt_to_ebitda"], 57500)
            self.assertEqual(run.metrics["rating_migration"], "downgrade")

            trend = run.memo["trend"]
            self.assertIsNotNone(trend)
            self.assertEqual(trend["prior_value_bp"], 54000)
            self.assertEqual(trend["current_value_bp"], 30000)
            self.assertEqual(trend["change_bp"], -24000)
            self.assertIn("270,000", trend["basis"])
            self.assertTrue(
                any("300,000" in caveat and "270,000" in caveat for caveat in run.memo["caveats"])
            )
            world = CreditWorld("yuanyang")
            for citation in trend["citations"]:
                self.assertTrue(world.verify_citation(citation), citation)

            markdown = Path(run.memo_md_path).read_text(encoding="utf-8")
            self.assertNotIn("签字：是", markdown)
            self.assertIn("策略建议：reject（策略输出，不是信贷决定）", markdown)
            self.assertIn("Host 签发：是", markdown)
            self.assertIn("人工签字：否（待复核）", markdown)
            self.assertIn("复核状态：pending_human_review", markdown)

    def test_yunling_is_blocked_not_issued_and_lists_missing_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            run = run_issuer("yunling", workdir=Path(tmp) / "yunling")
            self.assertEqual(run.status, "failed")
            self.assertEqual(run.failure_code, "INSUFFICIENT_EVIDENCE")
            self.assertEqual(run.recommended_conclusion, "insufficient_evidence")
            self.assertEqual(run.conclusion_authority, "policy")
            self.assertEqual(run.decision_status, "blocked")
            self.assertFalse(run.issued)
            self.assertFalse(run.signed)
            self.assertFalse(run.verified)
            self.assertTrue(run.chain_verified)
            self.assertEqual(run.rule_fired, "insufficient_evidence")
            self.assertFalse(run.memo["issued"])
            self.assertFalse(run.memo["signed"])
            self.assertFalse(run.memo["verified"])
            self.assertEqual(run.memo["decision_status"], "blocked")
            self.assertEqual(
                run.memo["reviewer"],
                {"decision": None, "reason": "", "signed_at": None},
            )
            self.assertEqual(run.memo["missing"], MISSING_YUNLING)
            self.assertEqual(
                run.memo["missing_required"],
                ["net_debt_to_ebitda", "ocf_to_short_term_debt"],
            )
            self.assertEqual(run.memo["missing_optional"], MISSING_OPTIONAL_YUNLING)
            self.assertEqual(run.missing_required, run.memo["missing_required"])
            self.assertEqual(run.missing_optional, MISSING_OPTIONAL_YUNLING)
            self.assertFalse(run.memo["optional_verified"])
            self.assertFalse(run.optional_verified)
            self.assertIn("missing_debt_schedule", run.memo["blockers"])
            self.assertEqual(len(run.memo["metrics"]), 3)
            self.assertEqual(
                run.metrics,
                {
                    "interest_coverage": 36000,
                    "receivables_to_revenue": 2118,
                    "audit_opinion": "standard_unqualified",
                },
            )
            self.assertFalse(
                any(metric["metric"] in MISSING_YUNLING for metric in run.memo["metrics"])
            )
            self.assertTrue(Path(run.memo_path).exists())
            self.assertTrue(Path(run.memo_md_path).exists())

            markdown = Path(run.memo_md_path).read_text(encoding="utf-8")
            self.assertNotIn("签字：是", markdown)
            self.assertIn("策略建议：insufficient_evidence（证据不足，未签发）", markdown)
            self.assertIn("Host 签发：否", markdown)
            self.assertIn("人工签字：否", markdown)
            self.assertIn("复核状态：blocked", markdown)

    def test_host_issuance_is_not_human_signoff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runs = run_all(workdir=Path(tmp))
            for run in runs:
                self.assertFalse(run.signed)
                self.assertFalse(run.memo["signed"])
                self.assertEqual(
                    run.issued,
                    run.verified and run.recommended_conclusion != "insufficient_evidence",
                )
                self.assertEqual(
                    run.decision_status,
                    "blocked"
                    if run.recommended_conclusion == "insufficient_evidence"
                    else "pending_human_review",
                )
                markdown = Path(run.memo_md_path).read_text(encoding="utf-8")
                self.assertNotIn("签字：是", markdown)
                self.assertIn("人工签字：否", markdown)

    def test_run_all_reaches_the_three_expected_recommendations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runs = run_all(workdir=Path(tmp))
            self.assertEqual(
                [run.recommended_conclusion for run in runs],
                [EXPECTED_RECOMMENDATIONS[key] for key in ("hengxing", "yuanyang", "yunling")],
            )
            self.assertTrue(all(run.ok for run in runs))
            for run in runs:
                self.assertTrue(Path(run.memo_path).exists())
                self.assertTrue(Path(run.memo_md_path).exists())

    def test_cli_all_exposes_issuance_and_signoff_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "credit_demo.py"),
                    "--all",
                    "--workdir",
                    tmp,
                ],
                cwd=str(ROOT),
                capture_output=True,
                text=True,
                timeout=120,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            payload = json.loads(completed.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(
                [case["recommended_conclusion"] for case in payload["cases"]],
                ["watch", "reject", "insufficient_evidence"],
            )
            for case in payload["cases"]:
                self.assertIn("recommended_conclusion", case)
                self.assertIn("issued", case)
                self.assertIn("signed", case)
                self.assertIn("decision_status", case)
                self.assertIn("missing_required", case)
                self.assertIn("missing_optional", case)
                self.assertIn("optional_verified", case)
                self.assertEqual(case["conclusion_authority"], "policy")
                self.assertNotIn("conclusion", case)
                self.assertFalse(case["signed"])
                self.assertTrue(Path(case["memo_path"]).exists())
                self.assertTrue(Path(case["memo_md_path"]).exists())
                self.assertTrue(case["chain_verified"])
                self.assertEqual(
                    case["missing"],
                    [] if case["issuer_key"] != "yunling" else MISSING_YUNLING,
                )
                if case["issuer_key"] in ("hengxing", "yuanyang"):
                    self.assertEqual(case["missing_required"], [])
                    self.assertEqual(case["missing_optional"], [])
                    self.assertTrue(case["optional_verified"])
                    self.assertTrue(case["issued"])
                    self.assertEqual(case["decision_status"], "pending_human_review")
                else:
                    self.assertEqual(
                        case["missing_required"],
                        ["net_debt_to_ebitda", "ocf_to_short_term_debt"],
                    )
                    self.assertEqual(case["missing_optional"], MISSING_OPTIONAL_YUNLING)
                    self.assertFalse(case["optional_verified"])
                    self.assertFalse(case["issued"])
                    self.assertEqual(case["decision_status"], "blocked")


if __name__ == "__main__":
    unittest.main()
