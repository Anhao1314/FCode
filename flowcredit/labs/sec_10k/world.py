"""A CreditWorld-compatible adapter over one real SEC 10-K excerpt.

The adapter is issuer-agnostic. The caller supplies ``issuer_key``, extracted
``facts``, ``meta``, the excerpt lines and a ``field_lines`` index; periods and
document ids are derived from ``meta``. The production ``CreditPlanner``,
``verify_observation`` and ``memo.build_memo`` run unchanged.

Documents are virtual views over the same excerpt:

* current column / prior column / debt note / a missing rating report.

Both columns come from ``extract.py``; there are no hand-written prior-year
constants. The audit report's single opinion covers both years, so the current
``audit_opinion`` value is also used for the prior period.

The 10-K does not disclose a rating migration, a related-party loan total or a
single contingent-liability total. Those metrics are returned as blocked, never
as zero.
"""

from __future__ import annotations

from typing import Any

__all__ = ["Sec10kWorld", "METRICS"]

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
        issuer_key: str,
        facts: dict[str, dict[str, Any]],
        meta: dict[str, Any],
        excerpt_lines: list[str],
        field_lines: dict[str, int],
    ) -> None:
        self.issuer_key = issuer_key
        self.facts = facts
        self.meta = meta
        self.field_lines = dict(field_lines)
        self._excerpt_lines = list(excerpt_lines)
        self.display_name = str(meta.get("company") or "SEC filer")
        self.current_period = str(meta.get("fiscal_year") or "FY2025")
        self.prior_period = str(meta.get("prior_fiscal_year") or "FY2024")
        self.periods = (self.prior_period, self.current_period)
        self.current_doc = f"doc_10k_{self.current_period.lower()}"
        self.prior_doc = f"doc_10k_{self.prior_period.lower()}"
        self.debt_doc = f"doc_debt_{self.current_period.lower()}"
        self.rating_doc = f"doc_rating_{self.current_period.lower()}"
        self.aliases = {
            f"doc_ar_{self.current_period.lower()}": self.current_doc,
            f"doc_ar_{self.prior_period.lower()}": self.prior_doc,
        }
        self.document_ids = (
            self.prior_doc,
            self.current_doc,
            self.debt_doc,
            self.rating_doc,
            *self.aliases,
        )
        self.restatement = None
        self.read_documents: set[str] = set()
        self.blockers: list[dict[str, Any]] = []
        self._line_refs: dict[str, dict[str, int]] = {}
        self._snippets: dict[tuple[str, str], str] = {}
        self._citation_index: dict[tuple[str, int, str], str] = {}
        self._index_facts()
        self._index_debt_view()
        self._current = self._current_values()
        self._prior = self._prior_values()
        self._body = "\n".join(self._excerpt_lines)

    # ---------------------------------------------------------------- indexing

    def _index_facts(self) -> None:
        for fact, result in self.facts.items():
            if result.get("status") != "ok":
                continue
            base = fact[: -len("_prior")] if fact.endswith("_prior") else fact
            doc_id = str(result.get("doc_id") or "")
            line = result.get("line")
            snippet = str(result.get("snippet") or "")
            if not doc_id or not isinstance(line, int):
                continue
            self._line_refs.setdefault(doc_id, {})[base] = line
            self._snippets[(doc_id, base)] = snippet
            self._citation_index[(doc_id, line, base)] = snippet
            for component in result.get("components") or ():
                field = str(component.get("field") or "")
                comp_doc = str(component.get("doc_id") or doc_id)
                comp_line = component.get("line")
                comp_snippet = str(component.get("snippet") or "")
                if not field or not isinstance(comp_line, int):
                    continue
                self._line_refs.setdefault(comp_doc, {})[field] = comp_line
                self._snippets[(comp_doc, field)] = comp_snippet
                self._citation_index[(comp_doc, comp_line, field)] = comp_snippet
        # Caller-supplied line index for the compact read_document view.
        for fact, line in self.field_lines.items():
            result = self.facts.get(fact)
            if not result or result.get("status") != "ok":
                continue
            base = fact[: -len("_prior")] if fact.endswith("_prior") else fact
            doc_id = str(result.get("doc_id") or "")
            if doc_id and isinstance(line, int):
                self._line_refs.setdefault(doc_id, {})[base] = line

    def _index_debt_view(self) -> None:
        for field in ("total_debt", "short_term_debt"):
            result = self.facts.get(field)
            if not result or result.get("status") != "ok":
                continue
            self._line_refs.setdefault(self.debt_doc, {})[field] = result["line"]
            self._snippets[(self.debt_doc, field)] = result["snippet"]
            self._citation_index[(self.debt_doc, result["line"], field)] = result["snippet"]

    # ---------------------------------------------------------------- documents

    def available_document_ids(self) -> tuple[str, ...]:
        return (self.prior_doc, self.current_doc, self.debt_doc)

    def list_documents(self) -> dict[str, Any]:
        documents = []
        for doc_id, title, period in (
            (
                self.current_doc,
                f"Form 10-K ({self.current_period} current column)",
                self.current_period,
            ),
            (
                self.prior_doc,
                f"Form 10-K ({self.prior_period} comparative column)",
                self.prior_period,
            ),
            (self.debt_doc, "Debt view (current total and short-term debt)", self.current_period),
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
        canonical = self.aliases.get(doc_id, doc_id)
        if canonical == self.rating_doc:
            return {
                "found": False,
                "doc_id": self.rating_doc,
                "reason": "missing_document",
            }
        if canonical == self.current_doc:
            fields = dict(self._current)
            period = self.current_period
            title = f"Form 10-K ({self.current_period} current column)"
        elif canonical == self.prior_doc:
            fields = dict(self._prior)
            period = self.prior_period
            title = f"Form 10-K ({self.prior_period} comparative column)"
        elif canonical == self.debt_doc:
            fields = {
                "total_debt": self._current["total_debt"],
                "short_term_debt": self._current["short_term_debt"],
            }
            period = self.current_period
            title = "Debt view (current total and short-term debt)"
        else:
            return {
                "found": False,
                "doc_id": doc_id,
                "reason": "missing_document",
            }
        self.read_documents.add(canonical)
        return {
            "found": True,
            "doc_id": canonical,
            "title": title,
            "period": period,
            "unit": "USD",
            "body": self._body,
            "line_refs": dict(self._line_refs.get(canonical, {})),
            "fields": fields,
            "synthetic": False,
            "research_only": True,
        }

    def check_restatement(self, doc_id: str) -> dict[str, Any]:
        """The 10-K has no restatement of the comparative prior column."""
        if doc_id not in (self.prior_doc, f"doc_ar_{self.prior_period.lower()}"):
            raise ValueError(f"check_restatement supports {self.prior_doc} only")
        ebitda = self._prior["operating_income"] + self._prior["depreciation_amortization"]
        return {
            "period": self.prior_period,
            "restated": False,
            "original_ebitda": ebitda,
            "restated_ebitda": ebitda,
            "delta": 0,
            "superseded_by": None,
            "citations": (
                self._citations("operating_income_prior")
                + self._citations("depreciation_amortization_prior")
            ),
        }

    # ----------------------------------------------------------------- metrics

    def compute_credit_metric(self, metric: str, period: str) -> dict[str, Any]:
        if metric not in METRICS:
            return self._blocked(metric, period, "ratio", ["unknown_metric"])
        if period not in self.periods:
            return self._blocked(metric, period, self._kind(metric), ["missing_period"])
        current = period == self.current_period
        values = self._current if current else self._prior
        suffix = "" if current else "_prior"

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
                "citations": self._citations("audit_opinion"),
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
                "citations": (
                    self._citations("total_debt" + suffix)
                    + self._citations("cash_and_equivalents" + suffix)
                    + self._citations("operating_income" + suffix)
                    + self._citations("depreciation_amortization" + suffix)
                ),
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
                "citations": (
                    self._citations("operating_income" + suffix)
                    + self._citations("depreciation_amortization" + suffix)
                    + self._citations("interest_expense" + suffix)
                ),
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
                "citations": (
                    self._citations("operating_cash_flow" + suffix)
                    + self._citations("short_term_debt" + suffix)
                ),
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
                "citations": (
                    self._citations("accounts_receivable" + suffix)
                    + self._citations("revenue" + suffix)
                ),
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
        field = citation.get("field")
        line = citation.get("line")
        if not isinstance(doc_id, str) or not isinstance(field, str):
            return False
        if not isinstance(line, int) or not 1 <= line <= len(self._excerpt_lines):
            return False
        snippet = self._citation_index.get((doc_id, line, field))
        if snippet is None:
            return False
        return self._excerpt_lines[line - 1] == snippet

    def apply_state(self, state: dict[str, Any]) -> None:
        self.read_documents = set(state.get("read_documents", []))

    # ----------------------------------------------------------------- helpers

    def _citations(self, fact: str) -> list[dict[str, Any]]:
        result = self.facts.get(fact)
        if not result or result.get("status") != "ok":
            return []
        base = fact[: -len("_prior")] if fact.endswith("_prior") else fact
        components = result.get("components") or ()
        if components:
            return [
                {
                    "doc_id": component["doc_id"],
                    "line": component["line"],
                    "field": component["field"],
                }
                for component in components
            ]
        return [
            {
                "doc_id": result["doc_id"],
                "line": result["line"],
                "field": base,
            }
        ]

    def _current_values(self) -> dict[str, Any]:
        return {
            fact: result["value"]
            for fact, result in self.facts.items()
            if result.get("status") == "ok" and not fact.endswith("_prior")
        }

    def _prior_values(self) -> dict[str, Any]:
        prior = {
            fact[: -len("_prior")]: result["value"]
            for fact, result in self.facts.items()
            if fact.endswith("_prior") and result.get("status") == "ok"
        }
        if "audit_opinion" in self._current:
            prior["audit_opinion"] = self._current["audit_opinion"]
        return prior

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
