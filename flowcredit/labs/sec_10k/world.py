"""A CreditWorld-compatible adapter over one real SEC 10-K excerpt.

This is deliberately a lab adapter, not a production domain. It exposes the
same methods the production ``CreditWorld`` does, so the production
``CreditPlanner``, ``verify_observation`` and ``memo.build_memo`` run unchanged.

Document mapping:

* ``doc_10k_fy2025`` / ``doc_ar_fy2025``: FY2025 current column
* ``doc_10k_fy2024`` / ``doc_ar_fy2024``: FY2024 comparative column
* ``doc_debt_fy2025``: MD&A total debt + Note 12 short-term debt
* ``doc_rating_fy2025``: does not exist in a 10-K; reads return missing

The 10-K does not disclose a rating migration, a related-party loan total or a
single contingent-liability total. Those metrics are returned as blocked, never
as zero.
"""

from __future__ import annotations

from typing import Any

__all__ = ["Sec10kWorld", "CURRENT_DOC", "PRIOR_DOC", "DEBT_DOC", "RATING_DOC"]

CURRENT_PERIOD = "FY2025"
PRIOR_PERIOD = "FY2024"
CURRENT_DOC = "doc_10k_fy2025"
PRIOR_DOC = "doc_10k_fy2024"
DEBT_DOC = "doc_debt_fy2025"
RATING_DOC = "doc_rating_fy2025"
ALIASES = {"doc_ar_fy2025": CURRENT_DOC, "doc_ar_fy2024": PRIOR_DOC}

PERIODS = (PRIOR_PERIOD, CURRENT_PERIOD)
METRICS = (
    "net_debt_to_ebitda",
    "interest_coverage",
    "ocf_to_short_term_debt",
    "receivables_to_revenue",
    "related_party_funding_ratio",
    "contingent_liabilities_to_equity",
    "audit_opinion",
    "rating_migration",
)

#: Prior-year amounts read from the comparative column of the same excerpt.
PRIOR_MILLIONS: dict[str, int] = {
    "revenue": 53_803,
    "operating_income": 12_181,
    "depreciation_amortization": 2_507,
    "interest_expense": 1_006,
    "cash_and_equivalents": 7_508,
    "total_debt": 30_962,
    "short_term_debt": 11_341,
    "operating_cash_flow": 10_880,
    "accounts_receivable": 6_685,
    "equity": 45_457,
}
PRIOR_AUDIT = "standard_unqualified"

#: The excerpt line for each prior/current field. Values on those lines include
#: both the current and comparative columns.
FIELD_LINES: dict[str, int] = {
    "revenue": 57,
    "operating_income": 70,
    "depreciation_amortization": 85,
    "interest_expense": 72,
    "cash_and_equivalents": 13,
    "total_debt": 107,
    "short_term_debt": 122,
    "operating_cash_flow": 100,
    "accounts_receivable": 15,
    "equity": 48,
    "audit_opinion": 6,
}
DEBT_FIELDS = ("total_debt", "short_term_debt")
CURRENT_FIELDS = (
    "revenue",
    "operating_income",
    "depreciation_amortization",
    "interest_expense",
    "cash_and_equivalents",
    "operating_cash_flow",
    "accounts_receivable",
    "equity",
    "audit_opinion",
)


def _ratio_bp(numerator: int, denominator: int) -> int | None:
    if denominator <= 0:
        return None
    return (numerator * 10000 + denominator // 2) // denominator


def _display_ratio(value_bp: int, unit: str) -> str:
    if unit == "x":
        hundredths = (value_bp + 50) // 100
        return f"{hundredths // 100}.{hundredths % 100:02d}x"
    if unit == "%":
        return f"{value_bp // 100}.{value_bp % 100:02d}%"
    return str(value_bp)


class Sec10kWorld:
    """One extracted 10-K presented through the credit-world interface."""

    def __init__(
        self,
        facts: dict[str, dict[str, Any]],
        meta: dict[str, Any],
        excerpt_lines: list[str],
    ) -> None:
        self.facts = facts
        self.meta = meta
        self._excerpt_lines = list(excerpt_lines)
        self.display_name = str(meta.get("company") or "SEC filer")
        self.issuer_key = "cisco"
        self.restatement = None
        self.read_documents: set[str] = set()
        self.blockers: list[dict[str, Any]] = []
        self.document_ids = (
            PRIOR_DOC,
            CURRENT_DOC,
            DEBT_DOC,
            RATING_DOC,
            "doc_ar_fy2024",
            "doc_ar_fy2025",
        )
        self._line_refs: dict[str, dict[str, int]] = {
            CURRENT_DOC: {field: FIELD_LINES[field] for field in CURRENT_FIELDS},
            PRIOR_DOC: {field: FIELD_LINES[field] for field in CURRENT_FIELDS + DEBT_FIELDS},
            DEBT_DOC: {field: FIELD_LINES[field] for field in DEBT_FIELDS},
        }
        self._snippets: dict[tuple[str, str], str] = {}
        for field in CURRENT_FIELDS:
            self._snippets[(CURRENT_DOC, field)] = self._excerpt_lines[FIELD_LINES[field] - 1]
            self._snippets[(PRIOR_DOC, field)] = self._excerpt_lines[FIELD_LINES[field] - 1]
        for field in DEBT_FIELDS:
            self._snippets[(DEBT_DOC, field)] = self._excerpt_lines[FIELD_LINES[field] - 1]
            self._snippets[(PRIOR_DOC, field)] = self._excerpt_lines[FIELD_LINES[field] - 1]
        self._current = self._current_values()
        self._prior = {
            field: value * 1_000_000
            for field, value in PRIOR_MILLIONS.items()
        }
        self._prior["audit_opinion"] = PRIOR_AUDIT
        self._body = "\n".join(self._excerpt_lines)

    # ---------------------------------------------------------------- documents

    def available_document_ids(self) -> tuple[str, ...]:
        return (PRIOR_DOC, CURRENT_DOC, DEBT_DOC)

    def list_documents(self) -> dict[str, Any]:
        documents = []
        for doc_id, title, period in (
            (CURRENT_DOC, "Form 10-K (FY2025 current column)", CURRENT_PERIOD),
            (PRIOR_DOC, "Form 10-K (FY2024 comparative column)", PRIOR_PERIOD),
            (DEBT_DOC, "Debt note (MD&A total debt + Note 12)", CURRENT_PERIOD),
        ):
            documents.append(
                {
                    "doc_id": doc_id,
                    "title": title,
                    "period": period,
                    "unit": "USD",
                    "synthetic": False,
                }
            )
        return {"documents": documents}

    def read_document(self, doc_id: str) -> dict[str, Any]:
        canonical = ALIASES.get(doc_id, doc_id)
        if canonical == RATING_DOC:
            return {
                "found": False,
                "doc_id": RATING_DOC,
                "reason": "missing_document",
            }
        if canonical not in self._line_refs:
            return {
                "found": False,
                "doc_id": doc_id,
                "reason": "missing_document",
            }
        self.read_documents.add(canonical)
        if canonical == CURRENT_DOC:
            fields = dict(self._current)
            period = CURRENT_PERIOD
            title = "Form 10-K (FY2025 current column)"
        elif canonical == PRIOR_DOC:
            fields = dict(self._prior)
            period = PRIOR_PERIOD
            title = "Form 10-K (FY2024 comparative column)"
        else:
            fields = {
                "total_debt": self._current["total_debt"],
                "short_term_debt": self._current["short_term_debt"],
            }
            period = CURRENT_PERIOD
            title = "Debt note (MD&A total debt + Note 12)"
        return {
            "found": True,
            "doc_id": canonical,
            "title": title,
            "period": period,
            "unit": "USD",
            "body": self._body,
            "line_refs": dict(self._line_refs[canonical]),
            "fields": fields,
            "synthetic": False,
            "research_only": True,
        }

    def check_restatement(self, doc_id: str) -> dict[str, Any]:
        """The 10-K has no restatement of the comparative FY2024 column."""
        if doc_id not in (PRIOR_DOC, "doc_ar_fy2024"):
            raise ValueError("check_restatement supports doc_ar_fy2024 only")
        ebitda = self._prior["operating_income"] + self._prior["depreciation_amortization"]
        return {
            "period": PRIOR_PERIOD,
            "restated": False,
            "original_ebitda": ebitda,
            "restated_ebitda": ebitda,
            "delta": 0,
            "superseded_by": None,
            "citations": [
                self._citation(PRIOR_DOC, "operating_income"),
                self._citation(PRIOR_DOC, "depreciation_amortization"),
            ],
        }

    # ----------------------------------------------------------------- metrics

    def compute_credit_metric(self, metric: str, period: str) -> dict[str, Any]:
        if metric not in METRICS:
            return self._blocked(metric, period, "ratio", ["unknown_metric"])
        if period not in PERIODS:
            return self._blocked(metric, period, self._kind(metric), ["missing_period"])
        values = self._current if period == CURRENT_PERIOD else self._prior
        doc = CURRENT_DOC if period == CURRENT_PERIOD else PRIOR_DOC

        if metric == "related_party_funding_ratio":
            return self._blocked(metric, period, "ratio", ["missing_related_party_disclosure"])
        if metric == "contingent_liabilities_to_equity":
            return self._blocked(metric, period, "ratio", ["missing_contingent_liability_disclosure"])
        if metric == "rating_migration":
            return self._blocked(metric, period, "code", ["missing_rating_report"])
        if metric == "audit_opinion":
            code = values.get("audit_opinion")
            if code is None:
                return self._blocked(metric, period, "code", ["missing_fact:audit_opinion"])
            return {
                "computed": True,
                "metric": metric,
                "period": period,
                "kind": "code",
                "value_bp": None,
                "value_code": code,
                "display": code,
                "inputs": {"audit_opinion": code},
                "citations": [self._citation(doc, "audit_opinion")],
                "blockers": [],
            }

        if metric == "net_debt_to_ebitda":
            required = ("total_debt", "cash_and_equivalents", "operating_income", "depreciation_amortization")
            missing = [name for name in required if name not in values]
            if missing:
                return self._blocked(metric, period, "ratio", [f"missing_fact:{name}" for name in missing])
            ebitda = values["operating_income"] + values["depreciation_amortization"]
            numerator = values["total_debt"] - values["cash_and_equivalents"]
            value_bp = _ratio_bp(numerator, ebitda)
            if value_bp is None:
                return self._blocked(metric, period, "ratio", ["non_positive_denominator"])
            return {
                "computed": True,
                "metric": metric,
                "period": period,
                "kind": "ratio",
                "value_bp": value_bp,
                "value_code": None,
                "display": _display_ratio(value_bp, "x"),
                "inputs": {
                    "total_debt": values["total_debt"],
                    "cash_and_equivalents": values["cash_and_equivalents"],
                    "ebitda": ebitda,
                    "operating_income": values["operating_income"],
                    "depreciation_amortization": values["depreciation_amortization"],
                },
                "citations": [
                    self._citation(DEBT_DOC, "total_debt"),
                    self._citation(doc, "cash_and_equivalents"),
                    self._citation(doc, "operating_income"),
                    self._citation(doc, "depreciation_amortization"),
                ],
                "blockers": [],
            }

        if metric == "interest_coverage":
            required = ("operating_income", "depreciation_amortization", "interest_expense")
            missing = [name for name in required if name not in values]
            if missing:
                return self._blocked(metric, period, "ratio", [f"missing_fact:{name}" for name in missing])
            ebitda = values["operating_income"] + values["depreciation_amortization"]
            value_bp = _ratio_bp(ebitda, values["interest_expense"])
            if value_bp is None:
                return self._blocked(metric, period, "ratio", ["non_positive_denominator"])
            return {
                "computed": True,
                "metric": metric,
                "period": period,
                "kind": "ratio",
                "value_bp": value_bp,
                "value_code": None,
                "display": _display_ratio(value_bp, "x"),
                "inputs": {
                    "ebitda": ebitda,
                    "interest_expense": values["interest_expense"],
                    "operating_income": values["operating_income"],
                    "depreciation_amortization": values["depreciation_amortization"],
                },
                "citations": [
                    self._citation(doc, "operating_income"),
                    self._citation(doc, "depreciation_amortization"),
                    self._citation(doc, "interest_expense"),
                ],
                "blockers": [],
            }

        if metric == "ocf_to_short_term_debt":
            required = ("operating_cash_flow", "short_term_debt")
            missing = [name for name in required if name not in values]
            if missing:
                return self._blocked(metric, period, "ratio", [f"missing_fact:{name}" for name in missing])
            value_bp = _ratio_bp(values["operating_cash_flow"], values["short_term_debt"])
            if value_bp is None:
                return self._blocked(metric, period, "ratio", ["non_positive_denominator"])
            return {
                "computed": True,
                "metric": metric,
                "period": period,
                "kind": "ratio",
                "value_bp": value_bp,
                "value_code": None,
                "display": _display_ratio(value_bp, "x"),
                "inputs": {
                    "operating_cash_flow": values["operating_cash_flow"],
                    "short_term_debt": values["short_term_debt"],
                },
                "citations": [
                    self._citation(doc, "operating_cash_flow"),
                    self._citation(DEBT_DOC, "short_term_debt"),
                ],
                "blockers": [],
            }

        if metric == "receivables_to_revenue":
            required = ("accounts_receivable", "revenue")
            missing = [name for name in required if name not in values]
            if missing:
                return self._blocked(metric, period, "ratio", [f"missing_fact:{name}" for name in missing])
            value_bp = _ratio_bp(values["accounts_receivable"], values["revenue"])
            if value_bp is None:
                return self._blocked(metric, period, "ratio", ["non_positive_denominator"])
            return {
                "computed": True,
                "metric": metric,
                "period": period,
                "kind": "ratio",
                "value_bp": value_bp,
                "value_code": None,
                "display": _display_ratio(value_bp, "%"),
                "inputs": {
                    "accounts_receivable": values["accounts_receivable"],
                    "revenue": values["revenue"],
                },
                "citations": [
                    self._citation(doc, "accounts_receivable"),
                    self._citation(doc, "revenue"),
                ],
                "blockers": [],
            }

        return self._blocked(metric, period, self._kind(metric), ["unknown_metric"])

    def report_blocked(self, reason: str) -> dict[str, Any]:
        self.blockers.append({"reason": reason})
        return {
            "acknowledged": True,
            "reason": reason,
            "blocker_count": len(self.blockers),
        }

    def verify_citation(self, citation: dict[str, Any]) -> bool:
        doc_id = citation.get("doc_id")
        if doc_id not in self._line_refs:
            return False
        field = citation.get("field")
        line = citation.get("line")
        if self._line_refs[doc_id].get(field) != line:
            return False
        if not isinstance(line, int) or not 1 <= line <= len(self._excerpt_lines):
            return False
        snippet = self._snippets.get((doc_id, field))
        return snippet is None or self._excerpt_lines[line - 1] == snippet

    def apply_state(self, state: dict[str, Any]) -> None:
        self.read_documents = set(state.get("read_documents", []))

    # ----------------------------------------------------------------- helpers

    def _current_values(self) -> dict[str, Any]:
        current: dict[str, Any] = {}
        for fact, result in self.facts.items():
            if result.get("status") == "ok":
                current[fact] = result["value"]
        return current

    def _citation(self, doc_id: str, field: str) -> dict[str, Any]:
        return {
            "doc_id": doc_id,
            "line": self._line_refs[doc_id][field],
            "field": field,
        }

    @staticmethod
    def _kind(metric: str) -> str:
        return "code" if metric in ("audit_opinion", "rating_migration") else "ratio"

    @staticmethod
    def _blocked(metric: str, period: str, kind: str, blockers: list[str]) -> dict[str, Any]:
        return {
            "computed": False,
            "metric": metric,
            "period": period,
            "kind": kind,
            "inputs": {},
            "citations": [],
            "blockers": blockers,
        }
