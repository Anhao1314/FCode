"""SEC 10-K extraction: two issuers, profile-driven facts and tiered memos."""

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

from flowagent.tools.credit.memo import (  # noqa: E402
    MEMO_VERSION,
    OPTIONAL_METRICS,
    REQUIRED_METRICS,
)
from labs.sec_10k.extract import FACT_ORDER, _audit_code, extract_all  # noqa: E402
from labs.sec_10k.spike import (  # noqa: E402
    LAB_DIR,
    available_issuers,
    issuer_paths,
    run_spike,
)
from labs.sec_10k.world import Sec10kWorld  # noqa: E402

ISSUERS = ("cisco", "home-depot")
COMPARE_FIELDS = (
    "value",
    "unit",
    "source_unit",
    "period",
    "doc_id",
    "line",
    "snippet",
    "components",
)


def _world_for(issuer: str, extracted: dict, meta: dict, excerpt: list[str]) -> Sec10kWorld:
    field_lines = {
        fact: item["line"]
        for fact, item in extracted.items()
        if item.get("status") == "ok" and isinstance(item.get("line"), int)
    }
    return Sec10kWorld(issuer, extracted, meta, excerpt, field_lines)


class ExtractionTests(unittest.TestCase):
    def _load(self, issuer: str):
        paths = issuer_paths(issuer)
        excerpt = paths["excerpt"].read_text(encoding="utf-8").splitlines()
        meta = json.loads(paths["meta"].read_text(encoding="utf-8"))
        ground_truth = json.loads(paths["ground_truth"].read_text(encoding="utf-8"))
        extracted = extract_all(paths["excerpt"], paths["meta"], paths["profile"])
        return paths, excerpt, meta, ground_truth, extracted

    def test_both_ground_truths_have_twenty_one_well_formed_entries(self) -> None:
        for issuer in ISSUERS:
            with self.subTest(issuer=issuer):
                _, excerpt, meta, ground_truth, _ = self._load(issuer)
                self.assertEqual(
                    [item["fact"] for item in ground_truth],
                    list(FACT_ORDER),
                )
                self.assertEqual(len(ground_truth), 21)
                self.assertEqual(
                    sum(not fact.endswith("_prior") for fact in FACT_ORDER), 11
                )
                self.assertEqual(
                    sum(fact.endswith("_prior") for fact in FACT_ORDER), 10
                )
                for item in ground_truth:
                    self.assertGreaterEqual(item["line"], 1)
                    self.assertLessEqual(item["line"], len(excerpt))
                    self.assertEqual(excerpt[item["line"] - 1], item["snippet"])
                    self.assertEqual(item["source_url"], meta["source_url"])
                    self.assertEqual(item["accession"], meta["accession"])
                    if item["fact"].endswith("_prior"):
                        self.assertEqual(item["period"], meta["prior_fiscal_year"])
                    else:
                        self.assertEqual(item["period"], meta["fiscal_year"])
                    if item["source_unit"] == "USD millions":
                        self.assertEqual(item["unit"], "USD")
                        self.assertEqual(item["value"] % 1_000_000, 0)
                    else:
                        self.assertEqual(item["unit"], "code")
                    for component in item.get("components") or ():
                        self.assertEqual(
                            excerpt[component["line"] - 1],
                            component["snippet"],
                        )
                        self.assertEqual(component["doc_id"], item["doc_id"])
                    if item.get("components"):
                        self.assertEqual(
                            sum(component["value"] for component in item["components"]),
                            item["value"],
                        )

    def test_both_extractors_match_all_twenty_one_facts(self) -> None:
        for issuer in ISSUERS:
            with self.subTest(issuer=issuer):
                _, _, _, ground_truth, extracted = self._load(issuer)
                truth = {item["fact"]: item for item in ground_truth}
                matches = []
                for fact in FACT_ORDER:
                    expected = truth[fact]
                    actual = extracted[fact]
                    matches.append(
                        all(
                            expected.get(field) == actual.get(field)
                            for field in COMPARE_FIELDS
                        )
                    )
                self.assertEqual(matches, [True] * 21)

    def test_components_are_explicit_for_home_depot_debt(self) -> None:
        _, _, _, _, extracted = self._load("home-depot")
        total = extracted["total_debt"]
        self.assertEqual(
            [component["field"] for component in total["components"]],
            [
                "short_term_debt",
                "current_installments_of_long_term_debt",
                "long_term_debt",
            ],
        )
        self.assertEqual(
            sum(component["value"] for component in total["components"]),
            total["value"],
        )
        short = extracted["short_term_debt"]
        self.assertEqual(
            [component["field"] for component in short["components"]],
            ["short_term_debt", "current_installments_of_long_term_debt"],
        )
        self.assertEqual(
            sum(component["value"] for component in short["components"]),
            short["value"],
        )
        _, _, _, _, cisco = self._load("cisco")
        self.assertNotIn("components", cisco["total_debt"])
        self.assertNotIn("components", cisco["short_term_debt"])

    def test_every_extracted_citation_reads_back_from_the_excerpt(self) -> None:
        for issuer in ISSUERS:
            with self.subTest(issuer=issuer):
                _, excerpt, meta, _, extracted = self._load(issuer)
                world = _world_for(issuer, extracted, meta, excerpt)
                for fact, item in extracted.items():
                    self.assertEqual(item["status"], "ok", fact)
                    self.assertEqual(excerpt[item["line"] - 1], item["snippet"], fact)
                    self.assertTrue(1 <= item["line"] <= len(excerpt), fact)
                    for citation in world._citations(fact):
                        self.assertTrue(world.verify_citation(citation), citation)

    def test_world_returns_missing_for_rating_and_undisclosed_metrics(self) -> None:
        for issuer in ISSUERS:
            with self.subTest(issuer=issuer):
                _, excerpt, meta, _, extracted = self._load(issuer)
                world = _world_for(issuer, extracted, meta, excerpt)
                for metric in (
                    "rating_migration",
                    "related_party_funding_ratio",
                    "contingent_liabilities_to_equity",
                ):
                    result = world.compute_credit_metric(metric, meta["fiscal_year"])
                    self.assertFalse(result["computed"], metric)
                    self.assertNotIn("value_bp", result)
                    self.assertNotIn("value_code", result)
                    self.assertTrue(result["blockers"], metric)

    def test_world_prior_document_uses_extracted_comparative_values(self) -> None:
        for issuer in ISSUERS:
            with self.subTest(issuer=issuer):
                _, excerpt, meta, ground_truth, extracted = self._load(issuer)
                world = _world_for(issuer, extracted, meta, excerpt)
                fields = world.read_document(world.prior_doc)["fields"]
                expected = {
                    item["fact"][: -len("_prior")]: item["value"]
                    for item in ground_truth
                    if item["fact"].endswith("_prior")
                }
                for fact, value in expected.items():
                    self.assertEqual(fields[fact], value, fact)
                self.assertEqual(
                    fields["audit_opinion"],
                    extracted["audit_opinion"]["value"],
                )
                ebitda = fields["operating_income"] + fields["depreciation_amortization"]
                numerator = fields["total_debt"] - fields["cash_and_equivalents"]
                expected_bp = (numerator * 10000 + ebitda // 2) // ebitda
                result = world.compute_credit_metric(
                    "net_debt_to_ebitda", meta["prior_fiscal_year"]
                )
                self.assertTrue(result["computed"])
                self.assertEqual(result["value_bp"], expected_bp)

    def test_column_header_mismatch_returns_missing(self) -> None:
        paths = issuer_paths("cisco")
        profile = json.loads(paths["profile"].read_text(encoding="utf-8"))
        profile["columns"]["balance"]["header_current"] = "not-the-current-date"
        with tempfile.TemporaryDirectory() as tmp:
            profile_path = Path(tmp) / "profile.json"
            profile_path.write_text(json.dumps(profile), encoding="utf-8")
            extracted = extract_all(paths["excerpt"], paths["meta"], profile_path)
        self.assertEqual(extracted["cash_and_equivalents"]["status"], "missing")
        self.assertEqual(
            extracted["cash_and_equivalents"]["reason"],
            "unconfirmed_columns:balance",
        )
        self.assertEqual(extracted["revenue"]["status"], "ok")

    def test_missing_fact_is_missing_not_guessed(self) -> None:
        paths = issuer_paths("cisco")
        with tempfile.TemporaryDirectory() as tmp:
            excerpt = Path(tmp) / "excerpt.txt"
            excerpt.write_text(
                "### AUDIT REPORT\nIn our opinion, present fairly.\n",
                encoding="utf-8",
            )
            extracted = extract_all(excerpt, paths["meta"], paths["profile"])
        self.assertEqual(extracted["revenue"]["status"], "missing")
        self.assertNotIn("value", extracted["revenue"])
        self.assertIn("reason", extracted["revenue"])

    def test_audit_opinion_classification_precedence(self) -> None:
        fixtures = {
            "standard": (
                "In our opinion, the consolidated financial statements present fairly, "
                "in all material respects, the financial position of the Company.",
                "standard_unqualified",
            ),
            "qualified": (
                "In our opinion, except for the effect of the matter described in the "
                "Basis for Qualified Opinion section, the consolidated financial "
                "statements present fairly, in all material respects, the financial "
                "position of the Company.",
                "qualified",
            ),
            "adverse": (
                "In our opinion, because of the significance of the matter described in "
                "the Basis for Adverse Opinion section, the consolidated financial "
                "statements do not present fairly the financial position of the Company.",
                "adverse",
            ),
            "disclaimer": (
                "We do not express an opinion on the consolidated financial statements "
                "of the Company.",
                "disclaimer",
            ),
        }
        for label, (text, expected) in fixtures.items():
            with self.subTest(label=label):
                actual = self._extract_audit(text)
                self.assertEqual(actual["status"], "ok")
                self.assertEqual(actual["value"], expected)

    def test_ambiguous_audit_opinion_is_not_guessed(self) -> None:
        text = "The consolidated financial statements are presented in accordance with GAAP."
        self.assertIsNone(_audit_code(text))
        actual = self._extract_audit(text)
        self.assertEqual(actual["status"], "missing")
        self.assertEqual(actual["reason"], "missing_audit_opinion")
        self.assertNotIn("value", actual)

    def test_except_for_outside_opinion_paragraph_does_not_qualify_standard(self) -> None:
        text = (
            "We have audited the consolidated financial statements, except for the "
            "matter described in Note 14.\n"
            "In our opinion, the consolidated financial statements present fairly, in "
            "all material respects, the financial position of the Company."
        )
        actual = self._extract_audit(text)
        self.assertEqual(actual["status"], "ok")
        self.assertEqual(actual["value"], "standard_unqualified")

    def _extract_audit(self, text: str) -> dict:
        paths = issuer_paths("cisco")
        with tempfile.TemporaryDirectory() as tmp:
            excerpt = Path(tmp) / "excerpt.txt"
            excerpt.write_text(f"### AUDIT REPORT\n{text}\n", encoding="utf-8")
            return extract_all(excerpt, paths["meta"], paths["profile"])["audit_opinion"]

    def test_issuer_discovery_is_data_driven(self) -> None:
        self.assertEqual(available_issuers(), ISSUERS)


class SpikeTests(unittest.TestCase):
    def _spike(self, issuer: str, tmp: Path) -> dict:
        return run_spike(issuer, workdir=tmp / issuer)

    def test_both_spikes_are_ok_and_match_expected_metrics(self) -> None:
        expected = {
            "cisco": {
                "net_debt_to_ebitda": 13552,
                "interest_coverage": 91469,
                "ocf_to_short_term_debt": 27127,
                "receivables_to_revenue": 1183,
                "audit_opinion": "standard_unqualified",
            },
            "home-depot": {
                "net_debt_to_ebitda": 22507,
                "interest_coverage": 100178,
                "ocf_to_short_term_debt": 17310,
                "receivables_to_revenue": 340,
                "audit_opinion": "standard_unqualified",
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            for issuer in ISSUERS:
                with self.subTest(issuer=issuer):
                    result = self._spike(issuer, Path(tmp))
                    self.assertTrue(result["ok"])
                    self.assertEqual(len(result["facts"]), 21)
                    self.assertTrue(all(item["match"] for item in result["facts"]))
                    self.assertTrue(result["metrics"]["match"])
                    self.assertEqual(result["metrics"]["computed"], expected[issuer])
                    memo = result["memo"]
                    self.assertEqual(memo["memo_version"], MEMO_VERSION)
                    self.assertEqual(memo["recommended_conclusion"], "pass")
                    self.assertEqual(memo["rule_fired"], "no threshold fired")
                    self.assertTrue(memo["issued"])
                    self.assertFalse(memo["signed"])
                    self.assertTrue(memo["verified"])
                    self.assertFalse(memo["optional_verified"])
                    self.assertEqual(memo["decision_status"], "pending_human_review")
                    self.assertEqual(memo["missing_required"], [])
                    self.assertEqual(
                        set(memo["missing_optional"]), set(OPTIONAL_METRICS)
                    )
                    self.assertEqual(len(memo["optional_gaps"]), 3)
                    self.assertEqual(
                        {gap["metric"] for gap in memo["optional_gaps"]},
                        set(OPTIONAL_METRICS),
                    )
                    self.assertTrue(
                        all(
                            gap["reason"] == "not_disclosed"
                            for gap in memo["optional_gaps"]
                        )
                    )
                    self.assertTrue(all(gap["detail"] for gap in memo["optional_gaps"]))
                    self.assertFalse(memo["synthetic"])
                    self.assertTrue(memo["research_only"])

    def test_cisco_memo_v2_issued_with_optional_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self._spike("cisco", Path(tmp))
            memo = json.loads(Path(result["memo"]["path"]).read_text(encoding="utf-8"))
            markdown = Path(result["memo"]["md_path"]).read_text(encoding="utf-8")
        self.assertEqual(memo["required_metrics"], list(REQUIRED_METRICS))
        self.assertEqual(memo["optional_metrics"], list(OPTIONAL_METRICS))
        self.assertEqual(memo["missing_required"], [])
        self.assertEqual(set(memo["missing_optional"]), set(OPTIONAL_METRICS))
        self.assertIn(
            "10-K 未披露 rating_migration / related_party_funding_ratio / "
            "contingent_liabilities_to_equity；这些可选指标未参与策略结论。",
            memo["caveats"],
        )
        self.assertFalse(any("未尝试" in caveat for caveat in memo["caveats"]))
        self.assertEqual([metric["metric"] for metric in memo["metrics"]], list(REQUIRED_METRICS))
        self.assertIn("策略建议：pass（策略输出，不是信贷决定）", markdown)
        self.assertIn("Host 签发：是", markdown)
        self.assertIn("人工签字：否（待复核）", markdown)
        self.assertIn("复核状态：pending_human_review", markdown)
        self.assertIn("缺失可选指标", markdown)

    def test_home_depot_memo_and_debt_component_citations(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = self._spike("home-depot", Path(tmp))
            memo = json.loads(Path(result["memo"]["path"]).read_text(encoding="utf-8"))
            markdown = Path(result["memo"]["md_path"]).read_text(encoding="utf-8")
        self.assertEqual(memo["recommended_conclusion"], "pass")
        self.assertTrue(memo["issued"])
        self.assertFalse(memo["signed"])
        self.assertEqual(memo["decision_status"], "pending_human_review")
        self.assertEqual(memo["missing_required"], [])
        self.assertEqual(set(memo["missing_optional"]), set(OPTIONAL_METRICS))
        self.assertIn(
            "10-K 未披露 rating_migration / related_party_funding_ratio / "
            "contingent_liabilities_to_equity；这些可选指标未参与策略结论。",
            memo["caveats"],
        )
        by_metric = {metric["metric"]: metric for metric in memo["metrics"]}
        total_citations = by_metric["net_debt_to_ebitda"]["citations"]
        self.assertEqual(
            [citation["field"] for citation in total_citations],
            [
                "short_term_debt",
                "current_installments_of_long_term_debt",
                "long_term_debt",
                "cash_and_equivalents",
                "operating_income",
                "depreciation_amortization",
            ],
        )
        self.assertEqual(
            [citation["line"] for citation in total_citations[:3]],
            [25, 31, 35],
        )
        self.assertEqual(
            by_metric["ocf_to_short_term_debt"]["citations"][1:],
            [
                {"doc_id": "doc_10k_fy2025", "line": 25, "field": "short_term_debt"},
                {
                    "doc_id": "doc_10k_fy2025",
                    "line": 31,
                    "field": "current_installments_of_long_term_debt",
                },
            ],
        )
        self.assertEqual(
            by_metric["audit_opinion"]["citations"],
            [{"doc_id": "doc_10k_fy2025", "line": 6, "field": "audit_opinion"}],
        )
        self.assertIn("策略建议：pass", markdown)
        self.assertIn("Host 签发：是", markdown)

    def test_all_cli_runs_both_issuers(self) -> None:
        completed = subprocess.run(
            [sys.executable, str(ROOT / "labs/sec_10k/spike.py"), "--all"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual(
            [item["issuer_key"] for item in payload["issuers"]],
            list(ISSUERS),
        )
        self.assertTrue(all(item["ok"] for item in payload["issuers"]))

    def test_lab_code_contains_no_cisco_constants(self) -> None:
        forbidden = (
            "0000858877",
            "csco-20250726",
            "FIELD_LINES",
            'issuer_key = "cisco"',
        )
        for path in LAB_DIR.glob("*.py"):
            text = path.read_text(encoding="utf-8")
            for needle in forbidden:
                self.assertNotIn(needle, text, f"{path.name} contains {needle!r}")


if __name__ == "__main__":
    unittest.main()
