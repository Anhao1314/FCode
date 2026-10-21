"""SEC 10-K extraction spike: 11 facts, citations and the blocked memo."""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from labs.sec_10k.extract import FACT_ORDER, extract_all  # noqa: E402
from labs.sec_10k.spike import (  # noqa: E402
    EXCERPT_PATH,
    GROUND_TRUTH_PATH,
    META_PATH,
    run_spike,
)
from labs.sec_10k.world import Sec10kWorld  # noqa: E402

COMPARE_FIELDS = ("value", "unit", "source_unit", "period", "doc_id", "line", "snippet")


class ExtractionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.excerpt = EXCERPT_PATH.read_text(encoding="utf-8").splitlines()
        self.meta = json.loads(META_PATH.read_text(encoding="utf-8"))
        self.ground_truth = json.loads(GROUND_TRUTH_PATH.read_text(encoding="utf-8"))
        self.extracted = extract_all(EXCERPT_PATH, META_PATH)

    def test_ground_truth_has_eleven_well_formed_entries(self) -> None:
        self.assertEqual([item["fact"] for item in self.ground_truth], list(FACT_ORDER))
        self.assertEqual(len(self.ground_truth), 11)
        for item in self.ground_truth:
            self.assertGreaterEqual(item["line"], 1)
            self.assertLessEqual(item["line"], len(self.excerpt))
            self.assertEqual(self.excerpt[item["line"] - 1], item["snippet"])
            self.assertEqual(item["source_url"], self.meta["source_url"])
            self.assertEqual(item["accession"], self.meta["accession"])
            if item["source_unit"] == "USD millions":
                self.assertEqual(item["unit"], "USD")
                self.assertEqual(item["value"] % 1_000_000, 0)
            else:
                self.assertEqual(item["unit"], "code")

    def test_extractor_matches_all_eleven_facts(self) -> None:
        matches = []
        for fact in FACT_ORDER:
            expected = next(item for item in self.ground_truth if item["fact"] == fact)
            actual = self.extracted[fact]
            matches.append(all(expected.get(field) == actual.get(field) for field in COMPARE_FIELDS))
        self.assertEqual(matches, [True] * 11)

    def test_every_extracted_citation_reads_back_from_the_excerpt(self) -> None:
        for fact, item in self.extracted.items():
            self.assertEqual(item["status"], "ok", fact)
            self.assertEqual(self.excerpt[item["line"] - 1], item["snippet"], fact)
            self.assertTrue(1 <= item["line"] <= len(self.excerpt), fact)

    def test_missing_fact_is_missing_not_guessed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            excerpt = Path(tmp) / "excerpt.txt"
            excerpt.write_text("### AUDIT REPORT\nIn our opinion, present fairly.\n", encoding="utf-8")
            extracted = extract_all(excerpt, META_PATH)
        self.assertEqual(extracted["revenue"]["status"], "missing")
        self.assertNotIn("value", extracted["revenue"])
        self.assertIn("reason", extracted["revenue"])

    def test_world_returns_missing_for_rating_and_undisclosed_metrics(self) -> None:
        world = Sec10kWorld(self.extracted, self.meta, self.excerpt)
        for metric in ("rating_migration", "related_party_funding_ratio", "contingent_liabilities_to_equity"):
            result = world.compute_credit_metric(metric, "FY2025")
            self.assertFalse(result["computed"], metric)
            self.assertNotIn("value_bp", result)
            self.assertNotIn("value_code", result)
            self.assertTrue(result["blockers"], metric)

    def test_world_citations_resolve_against_the_excerpt(self) -> None:
        world = Sec10kWorld(self.extracted, self.meta, self.excerpt)
        for fact in FACT_ORDER:
            item = self.extracted[fact]
            citation = {
                "doc_id": item["doc_id"],
                "line": item["line"],
                "field": fact,
            }
            self.assertTrue(world.verify_citation(citation), citation)


class SpikeTests(unittest.TestCase):
    def test_spike_is_ok_and_memo_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = run_spike(workdir=Path(tmp))
            self.assertTrue(result["ok"])
            self.assertEqual(len(result["facts"]), 11)
            self.assertTrue(all(item["match"] for item in result["facts"]))
            self.assertTrue(result["metrics"]["match"])
            self.assertEqual(
                result["metrics"]["computed"],
                {
                    "net_debt_to_ebitda": 13552,
                    "interest_coverage": 91469,
                    "ocf_to_short_term_debt": 27127,
                    "receivables_to_revenue": 1183,
                    "audit_opinion": "standard_unqualified",
                },
            )
            self.assertIn("rating_migration", result["metrics"]["missing"])
            memo = result["memo"]
            self.assertEqual(memo["recommended_conclusion"], "insufficient_evidence")
            self.assertEqual(memo["conclusion_authority"], "policy")
            self.assertFalse(memo["issued"])
            self.assertFalse(memo["signed"])
            self.assertFalse(memo["verified"])
            self.assertEqual(memo["decision_status"], "blocked")
            self.assertFalse(memo["synthetic"])
            self.assertTrue(memo["research_only"])
            self.assertTrue(Path(memo["path"]).exists())
            self.assertTrue(Path(memo["md_path"]).exists())
            markdown = Path(memo["md_path"]).read_text(encoding="utf-8")
            self.assertIn("真实公开数据（SEC 10-K）", markdown)
            self.assertNotIn("合成数据", markdown)
            self.assertIn("策略建议：insufficient_evidence", markdown)
            self.assertIn("Host 签发：否", markdown)
            self.assertIn("人工签字：否", markdown)
            self.assertIn("复核状态：blocked", markdown)
            self.assertIn("rating_migration", markdown)

    def test_memo_json_carries_source_and_missing_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            result = run_spike(workdir=Path(tmp))
            memo = json.loads(Path(result["memo"]["path"]).read_text(encoding="utf-8"))
        self.assertEqual(memo["source_url"], self.meta_url())
        self.assertEqual(memo["accession"], "0000858877-25-000111")
        self.assertFalse(memo["synthetic"])
        self.assertTrue(memo["research_only"])
        self.assertEqual(memo["as_of"], "FY2025")
        self.assertIn("rating_migration", memo["missing"])
        self.assertNotIn("related_party_funding_ratio", [m["metric"] for m in memo["metrics"]])
        for metric in memo["metrics"]:
            self.assertTrue(metric["citations"])
            for citation in metric["citations"]:
                self.assertIn(citation["doc_id"], ("doc_10k_fy2025", "doc_debt_fy2025"))
                self.assertGreaterEqual(citation["line"], 1)

    @staticmethod
    def meta_url() -> str:
        return json.loads(META_PATH.read_text(encoding="utf-8"))["source_url"]


if __name__ == "__main__":
    unittest.main()
