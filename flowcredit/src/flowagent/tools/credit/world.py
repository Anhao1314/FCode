"""Synthetic credit world for three fictional issuers.

Every issuer, amount, rating and audit opinion below is authored for FCode's
credit-due-diligence product surface. No real filing, rating or issuer is used.
The world is the only source of metric inputs: the model can ask for a metric,
but it cannot pass a number, and the verifier recomputes from this world.

The eight metrics are stored in integer basis points (``value_bp = ratio *
10000``) or as a code (``value_code``). The human-readable ``display`` string is
generated here by the Host, never by the model.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "UNIT",
    "PERIODS",
    "METRICS",
    "RATIO_METRICS",
    "CODE_METRICS",
    "KINDS",
    "METRIC_KIND",
    "METRIC_UNIT",
    "BLOCK_REASONS",
    "AUDIT_CODES",
    "RATING_CODES",
    "VALUE_CODES",
    "DEBT_METRICS",
    "DEBT_DOC",
    "RATING_DOC",
    "RESTATEMENT_DOC",
    "AR_DOCS",
    "BASE_DOCUMENT_IDS",
    "ISSUER_KEYS",
    "ISSUER_NAMES",
    "ISSUERS",
    "CreditWorld",
]

UNIT = "CNY thousand"
PERIODS: tuple[str, ...] = ("FY2024", "FY2025")

METRICS: tuple[str, ...] = (
    "net_debt_to_ebitda",
    "interest_coverage",
    "ocf_to_short_term_debt",
    "receivables_to_revenue",
    "related_party_funding_ratio",
    "contingent_liabilities_to_equity",
    "audit_opinion",
    "rating_migration",
)
RATIO_METRICS: tuple[str, ...] = METRICS[:6]
CODE_METRICS: tuple[str, ...] = METRICS[6:]
KINDS: tuple[str, ...] = ("ratio", "code")

METRIC_KIND: dict[str, str] = {
    metric: "ratio" for metric in RATIO_METRICS
} | {metric: "code" for metric in CODE_METRICS}
METRIC_UNIT: dict[str, str] = {
    "net_debt_to_ebitda": "x",
    "interest_coverage": "x",
    "ocf_to_short_term_debt": "x",
    "receivables_to_revenue": "%",
    "related_party_funding_ratio": "%",
    "contingent_liabilities_to_equity": "%",
    "audit_opinion": "code",
    "rating_migration": "code",
}

#: The six ratio metrics that need the FY2025 debt schedule. The four in
#: ``DEBT_METRICS`` are abandoned when that document is missing.
DEBT_METRICS: tuple[str, ...] = (
    "net_debt_to_ebitda",
    "ocf_to_short_term_debt",
    "related_party_funding_ratio",
    "contingent_liabilities_to_equity",
)

BLOCK_REASONS: tuple[str, ...] = (
    "missing_document",
    "insufficient_evidence",
    "basis_unresolved",
)

AUDIT_CODES: tuple[str, ...] = (
    "standard_unqualified",
    "qualified",
    "disclaimer",
    "adverse",
)
RATING_CODES: tuple[str, ...] = ("upgrade", "stable", "downgrade")
VALUE_CODES: tuple[str, ...] = AUDIT_CODES + RATING_CODES

DEBT_DOC = "doc_debt_fy2025"
RATING_DOC = "doc_rating_fy2025"
RESTATEMENT_DOC = "doc_restatement_fy2024"
AR_DOCS: dict[str, str] = {"FY2024": "doc_ar_fy2024", "FY2025": "doc_ar_fy2025"}
BASE_DOCUMENT_IDS: tuple[str, ...] = (
    "doc_ar_fy2024",
    "doc_ar_fy2025",
    DEBT_DOC,
    RATING_DOC,
)

#: Higher index is a better rating. The synthetic corpus only uses a few of
#: these, but the scale makes the migration derivation auditable.
RATING_SCALE: tuple[str, ...] = (
    "CCC", "B-", "B", "B+", "BB-", "BB", "BB+",
    "BBB-", "BBB", "BBB+", "A-", "A", "A+",
    "AA-", "AA", "AA+", "AAA",
)

ISSUER_KEYS: tuple[str, ...] = ("hengxing", "yuanyang", "yunling")
ISSUER_NAMES: dict[str, str] = {
    "hengxing": "恒星智造（合成数据）",
    "yuanyang": "远洋材料（合成数据）",
    "yunling": "云岭设备（合成数据）",
}

ISSUERS: dict[str, dict[str, Any]] = {
    "hengxing": {
        "name": ISSUER_NAMES["hengxing"],
        "facts": {
            "FY2024": {
                "revenue": 1_200_000,
                "ebitda": 180_000,
                "cash": 150_000,
                "interest_expense": 30_000,
                "operating_cash_flow": 120_000,
                "accounts_receivable": 220_000,
                "equity": 600_000,
                "audit_opinion": "standard_unqualified",
            },
            "FY2025": {
                "revenue": 1_350_000,
                "ebitda": 175_000,
                "cash": 120_000,
                "interest_expense": 42_000,
                "operating_cash_flow": 90_000,
                "accounts_receivable": 310_000,
                "equity": 640_000,
                "audit_opinion": "standard_unqualified",
            },
        },
        "debt": {
            "total_debt": 780_000,
            "short_term_debt": 300_000,
            "related_party_loan": 45_000,
            "contingent_liabilities": 18_000,
        },
        "rating": {"prior_rating": "AA-", "current_rating": "AA-", "outlook": "stable"},
        "restatement": None,
    },
    "yuanyang": {
        "name": ISSUER_NAMES["yuanyang"],
        "facts": {
            "FY2024": {
                "revenue": 2_000_000,
                "ebitda": 300_000,
                "cash": 200_000,
                "interest_expense": 50_000,
                "operating_cash_flow": 180_000,
                "accounts_receivable": 400_000,
                "equity": 900_000,
                "audit_opinion": "standard_unqualified",
            },
            "FY2025": {
                "revenue": 2_100_000,
                "ebitda": 240_000,
                "cash": 120_000,
                "interest_expense": 80_000,
                "operating_cash_flow": 60_000,
                "accounts_receivable": 620_000,
                "equity": 850_000,
                "audit_opinion": "qualified",
            },
        },
        "debt": {
            "total_debt": 1_500_000,
            "short_term_debt": 700_000,
            "related_party_loan": 220_000,
            "contingent_liabilities": 150_000,
        },
        "rating": {"prior_rating": "A", "current_rating": "BBB", "outlook": "negative"},
        "restatement": {
            "original_ebitda": 300_000,
            "restated_ebitda": 270_000,
            "reason": "FY2024 年报披露后，公司更正了折旧与摊销分摊（合成重述）。",
        },
    },
    "yunling": {
        "name": ISSUER_NAMES["yunling"],
        "facts": {
            "FY2024": {
                "revenue": 800_000,
                "ebitda": 100_000,
                "cash": 80_000,
                "interest_expense": 20_000,
                "operating_cash_flow": 50_000,
                "accounts_receivable": 150_000,
                "equity": 300_000,
                "audit_opinion": "standard_unqualified",
            },
            "FY2025": {
                "revenue": 850_000,
                "ebitda": 90_000,
                "cash": 60_000,
                "interest_expense": 25_000,
                "operating_cash_flow": 30_000,
                "accounts_receivable": 180_000,
                "equity": 310_000,
                "audit_opinion": "standard_unqualified",
            },
        },
        "debt": None,
        "rating": {"prior_rating": "BBB", "current_rating": "BBB", "outlook": "stable"},
        "restatement": None,
    },
}

FOOTER = "本文件为合成数据，仅用于 FCode 信用尽调实验，不构成任何信贷或投资意见。"


def _format(value: Any) -> str:
    return f"{value:,}" if isinstance(value, int) and not isinstance(value, bool) else str(value)


def _document(
    *,
    issuer_name: str,
    doc_id: str,
    title: str,
    period: str,
    rows: tuple[tuple[str, str, Any], ...],
    unit: str = UNIT,
    header_label: str = "单位：人民币千元 | 合并口径",
) -> dict[str, Any]:
    lines = [
        f"{issuer_name} | 合成数据，非真实公司",
        f"{title} | {period} | {header_label}",
    ]
    fields: dict[str, Any] = {}
    line_refs: dict[str, int] = {}
    for field, label, value in rows:
        lines.append(f"{label}：{_format(value)}")
        line_refs[field] = len(lines)
        fields[field] = value
    lines.append(FOOTER)
    return {
        "doc_id": doc_id,
        "title": title,
        "period": period,
        "unit": unit,
        "body": "\n".join(lines),
        "line_refs": line_refs,
        "fields": fields,
        "synthetic": True,
    }


def _annual_rows(facts: dict[str, Any]) -> tuple[tuple[str, str, Any], ...]:
    return (
        ("revenue", "营业收入", facts["revenue"]),
        ("ebitda", "息税折旧摊销前利润（EBITDA）", facts["ebitda"]),
        ("cash", "货币资金", facts["cash"]),
        ("interest_expense", "利息费用", facts["interest_expense"]),
        ("operating_cash_flow", "经营活动现金流量净额", facts["operating_cash_flow"]),
        ("accounts_receivable", "应收账款", facts["accounts_receivable"]),
        ("equity", "所有者权益", facts["equity"]),
        ("audit_opinion", "审计意见", facts["audit_opinion"]),
    )


def _debt_rows(debt: dict[str, Any]) -> tuple[tuple[str, str, Any], ...]:
    return (
        ("total_debt", "总有息负债", debt["total_debt"]),
        ("short_term_debt", "短期有息负债", debt["short_term_debt"]),
        ("related_party_loan", "关联方借款", debt["related_party_loan"]),
        ("contingent_liabilities", "或有负债", debt["contingent_liabilities"]),
    )


def _rating_rows(rating: dict[str, Any]) -> tuple[tuple[str, str, Any], ...]:
    return (
        ("prior_rating", "前次评级", rating["prior_rating"]),
        ("current_rating", "本次评级", rating["current_rating"]),
        ("outlook", "展望", rating["outlook"]),
    )


def _restatement_rows(restatement: dict[str, Any]) -> tuple[tuple[str, str, Any], ...]:
    return (
        ("original_ebitda", "原披露 EBITDA", restatement["original_ebitda"]),
        ("restated_ebitda", "重述后 EBITDA", restatement["restated_ebitda"]),
        ("reason", "重述原因", restatement["reason"]),
    )


def _build_documents(issuer_key: str) -> dict[str, dict[str, Any]]:
    issuer = ISSUERS[issuer_key]
    name = issuer["name"]
    facts = issuer["facts"]
    documents = {
        "doc_ar_fy2024": _document(
            issuer_name=name,
            doc_id="doc_ar_fy2024",
            title="年度报告摘要",
            period="FY2024",
            rows=_annual_rows(facts["FY2024"]),
        ),
        "doc_ar_fy2025": _document(
            issuer_name=name,
            doc_id="doc_ar_fy2025",
            title="年度报告摘要",
            period="FY2025",
            rows=_annual_rows(facts["FY2025"]),
        ),
        RATING_DOC: _document(
            issuer_name=name,
            doc_id=RATING_DOC,
            title="评级报告",
            period="FY2025",
            rows=_rating_rows(issuer["rating"]),
            unit="rating",
            header_label="评级符号 | 合成",
        ),
    }
    if issuer["debt"] is not None:
        documents[DEBT_DOC] = _document(
            issuer_name=name,
            doc_id=DEBT_DOC,
            title="债务明细",
            period="FY2025",
            rows=_debt_rows(issuer["debt"]),
        )
    if issuer["restatement"] is not None:
        documents[RESTATEMENT_DOC] = _document(
            issuer_name=name,
            doc_id=RESTATEMENT_DOC,
            title="FY2024 重述说明",
            period="FY2024",
            rows=_restatement_rows(issuer["restatement"]),
            header_label="单位：人民币千元 | FY2024 重述",
        )
    return documents


def _ratio_bp(numerator: int, denominator: int) -> int | None:
    """Round a positive ratio to basis points (ratio x 10000)."""
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


class CreditWorld:
    """One synthetic issuer's documents, facts and eight metric formulas.

    ``partial=True`` removes the debt schedule for a deliberately incomplete
    corpus. ``yunling`` is incomplete by construction: its debt schedule does
    not exist in the synthetic corpus.
    """

    def __init__(self, issuer: str = "hengxing", partial: bool = False) -> None:
        if issuer not in ISSUERS:
            raise ValueError(f"unknown synthetic issuer {issuer!r}; known: {list(ISSUER_KEYS)}")
        self.issuer_key = issuer
        self.display_name = ISSUERS[issuer]["name"]
        self.partial = bool(partial)
        self._issuer = ISSUERS[issuer]
        self._documents = _build_documents(issuer)
        self.document_ids: tuple[str, ...] = tuple(BASE_DOCUMENT_IDS) + (
            (RESTATEMENT_DOC,) if self._issuer["restatement"] is not None else ()
        )
        self.read_documents: set[str] = set()
        self.restatement_checked = False
        self.restatement_applied = False
        self.blockers: list[dict[str, Any]] = []

    # ---------------------------------------------------------------- documents

    @property
    def restatement(self) -> dict[str, Any] | None:
        """The issuer's synthetic FY2024 restatement, if one exists."""
        return self._issuer["restatement"]

    def available_document_ids(self) -> tuple[str, ...]:
        return tuple(
            doc_id
            for doc_id in self.document_ids
            if doc_id in self._documents
            and not (self.partial and doc_id == DEBT_DOC)
        )

    def list_documents(self) -> dict[str, Any]:
        keys = ("doc_id", "title", "period", "unit", "synthetic")
        return {
            "documents": [
                {key: self._documents[doc_id][key] for key in keys}
                for doc_id in self.available_document_ids()
            ]
        }

    def read_document(self, doc_id: str) -> dict[str, Any]:
        if doc_id not in self._documents or (self.partial and doc_id == DEBT_DOC):
            return {
                "found": False,
                "doc_id": doc_id,
                "reason": "missing_document",
            }
        self.read_documents.add(doc_id)
        return {"found": True, **self._documents[doc_id]}

    def check_restatement(self, doc_id: str) -> dict[str, Any]:
        """Return the FY2024 restatement, if the synthetic issuer has one."""
        if doc_id != "doc_ar_fy2024":
            raise ValueError("check_restatement supports doc_ar_fy2024 only")
        self.restatement_checked = True
        facts = self._issuer["facts"]["FY2024"]
        restatement = self._issuer["restatement"]
        if restatement is not None:
            self.restatement_applied = True
            self.read_documents.add(RESTATEMENT_DOC)
            original = restatement["original_ebitda"]
            restated = restatement["restated_ebitda"]
            return {
                "period": "FY2024",
                "restated": True,
                "original_ebitda": original,
                "restated_ebitda": restated,
                "delta": restated - original,
                "superseded_by": RESTATEMENT_DOC,
                "citations": [
                    self._citation(RESTATEMENT_DOC, "original_ebitda"),
                    self._citation(RESTATEMENT_DOC, "restated_ebitda"),
                ],
            }
        self.restatement_applied = False
        ebitda = facts["ebitda"]
        return {
            "period": "FY2024",
            "restated": False,
            "original_ebitda": ebitda,
            "restated_ebitda": ebitda,
            "delta": 0,
            "superseded_by": None,
            "citations": [self._citation("doc_ar_fy2024", "ebitda")],
        }

    # ----------------------------------------------------------------- metrics

    def compute_credit_metric(self, metric: str, period: str) -> dict[str, Any]:
        """Return one metric, or a precise blocker. Never accepts a value."""
        if metric not in METRICS:
            return self._blocked(metric, period, METRIC_KIND.get(metric, "ratio"), ["unknown_metric"])
        if metric in CODE_METRICS:
            return self._code_metric(metric, period)
        return self._ratio_metric(metric, period)

    def _ratio_metric(self, metric: str, period: str) -> dict[str, Any]:
        kind = "ratio"
        if period not in PERIODS:
            return self._blocked(metric, period, kind, ["missing_period"])
        ar_id = AR_DOCS[period]
        if ar_id not in self.read_documents:
            return self._blocked(metric, period, kind, ["annual_report_not_read"])
        if period == "FY2024" and self._issuer["restatement"] is not None and not self.restatement_checked:
            return self._blocked(metric, period, kind, ["restatement_not_checked"])

        debt_needed = metric in DEBT_METRICS
        if debt_needed:
            if period != "FY2025" or self.partial or self._issuer["debt"] is None or DEBT_DOC not in self._documents:
                return self._blocked(metric, period, kind, ["missing_debt_schedule"])
            if DEBT_DOC not in self.read_documents:
                return self._blocked(metric, period, kind, ["debt_schedule_not_read"])

        facts = self._issuer["facts"][period]
        debt = self._issuer["debt"] or {}
        ebitda = self._effective_ebitda(period)
        if metric == "net_debt_to_ebitda":
            inputs = {"total_debt": debt["total_debt"], "cash": facts["cash"], "ebitda": ebitda}
            citations = [
                self._citation(DEBT_DOC, "total_debt"),
                self._citation(ar_id, "cash"),
                self._ebitda_citation(period),
            ]
            numerator, denominator = debt["total_debt"] - facts["cash"], ebitda
        elif metric == "interest_coverage":
            inputs = {"ebitda": ebitda, "interest_expense": facts["interest_expense"]}
            citations = [
                self._ebitda_citation(period),
                self._citation(ar_id, "interest_expense"),
            ]
            numerator, denominator = ebitda, facts["interest_expense"]
        elif metric == "ocf_to_short_term_debt":
            inputs = {
                "operating_cash_flow": facts["operating_cash_flow"],
                "short_term_debt": debt["short_term_debt"],
            }
            citations = [
                self._citation(ar_id, "operating_cash_flow"),
                self._citation(DEBT_DOC, "short_term_debt"),
            ]
            numerator, denominator = facts["operating_cash_flow"], debt["short_term_debt"]
        elif metric == "receivables_to_revenue":
            inputs = {
                "accounts_receivable": facts["accounts_receivable"],
                "revenue": facts["revenue"],
            }
            citations = [
                self._citation(ar_id, "accounts_receivable"),
                self._citation(ar_id, "revenue"),
            ]
            numerator, denominator = facts["accounts_receivable"], facts["revenue"]
        elif metric == "related_party_funding_ratio":
            inputs = {
                "related_party_loan": debt["related_party_loan"],
                "total_debt": debt["total_debt"],
            }
            citations = [
                self._citation(DEBT_DOC, "related_party_loan"),
                self._citation(DEBT_DOC, "total_debt"),
            ]
            numerator, denominator = debt["related_party_loan"], debt["total_debt"]
        elif metric == "contingent_liabilities_to_equity":
            inputs = {
                "contingent_liabilities": debt["contingent_liabilities"],
                "equity": facts["equity"],
            }
            citations = [
                self._citation(DEBT_DOC, "contingent_liabilities"),
                self._citation(ar_id, "equity"),
            ]
            numerator, denominator = debt["contingent_liabilities"], facts["equity"]
        else:  # pragma: no cover - guarded by METRICS
            return self._blocked(metric, period, kind, ["unknown_metric"])

        value_bp = _ratio_bp(numerator, denominator)
        if value_bp is None:
            return self._blocked(metric, period, kind, ["non_positive_denominator"])
        return {
            "computed": True,
            "metric": metric,
            "period": period,
            "kind": kind,
            "value_bp": value_bp,
            "value_code": None,
            "display": _display_ratio(value_bp, METRIC_UNIT[metric]),
            "inputs": inputs,
            "citations": citations,
            "blockers": [],
        }

    def _code_metric(self, metric: str, period: str) -> dict[str, Any]:
        kind = "code"
        if period not in PERIODS:
            return self._blocked(metric, period, kind, ["missing_period"])
        if metric == "audit_opinion":
            ar_id = AR_DOCS[period]
            if ar_id not in self.read_documents:
                return self._blocked(metric, period, kind, ["annual_report_not_read"])
            value = self._issuer["facts"][period]["audit_opinion"]
            if value not in AUDIT_CODES:
                return self._blocked(metric, period, kind, ["unknown_audit_opinion"])
            return {
                "computed": True,
                "metric": metric,
                "period": period,
                "kind": kind,
                "value_bp": None,
                "value_code": value,
                "display": value,
                "inputs": {"audit_opinion": value},
                "citations": [self._citation(ar_id, "audit_opinion")],
                "blockers": [],
            }
        if metric == "rating_migration":
            if period != "FY2025":
                return self._blocked(metric, period, kind, ["missing_rating_report"])
            if RATING_DOC not in self.read_documents:
                return self._blocked(metric, period, kind, ["rating_report_not_read"])
            rating = self._issuer["rating"]
            prior, current = rating["prior_rating"], rating["current_rating"]
            try:
                prior_index = RATING_SCALE.index(prior)
                current_index = RATING_SCALE.index(current)
            except ValueError:
                return self._blocked(metric, period, kind, ["unknown_rating"])
            if current_index == prior_index:
                migration = "stable"
            elif current_index > prior_index:
                migration = "upgrade"
            else:
                migration = "downgrade"
            return {
                "computed": True,
                "metric": metric,
                "period": period,
                "kind": kind,
                "value_bp": None,
                "value_code": migration,
                "display": migration,
                "inputs": {"prior_rating": prior, "current_rating": current},
                "citations": [
                    self._citation(RATING_DOC, "prior_rating"),
                    self._citation(RATING_DOC, "current_rating"),
                ],
                "blockers": [],
            }
        return self._blocked(metric, period, kind, ["unknown_metric"])

    # ------------------------------------------------------------------ support

    def report_blocked(self, reason: str) -> dict[str, Any]:
        self.blockers.append({"reason": reason})
        return {
            "acknowledged": True,
            "reason": reason,
            "blocker_count": len(self.blockers),
        }

    def apply_state(self, state: dict[str, Any]) -> None:
        """Rebuild read/restatement flags from the committed observation log."""
        self.read_documents = set(state.get("read_documents", []))
        self.restatement_checked = bool(state.get("restatement_checked"))
        self.restatement_applied = bool(state.get("restatement_applied"))

    def verify_citation(self, citation: dict[str, Any]) -> bool:
        """Return True when the citation's line and field exist in the corpus."""
        document = self._documents.get(str(citation.get("doc_id", "")))
        if document is None:
            return False
        field = citation.get("field")
        return document["line_refs"].get(field) == citation.get("line")

    def _effective_ebitda(self, period: str) -> int:
        if period == "FY2024" and self.restatement_applied:
            return int(self._issuer["restatement"]["restated_ebitda"])
        return int(self._issuer["facts"][period]["ebitda"])

    def _ebitda_citation(self, period: str) -> dict[str, Any]:
        if period == "FY2024" and self.restatement_applied:
            return self._citation(RESTATEMENT_DOC, "restated_ebitda")
        return self._citation(AR_DOCS[period], "ebitda")

    def _citation(self, doc_id: str, field: str) -> dict[str, Any]:
        return {
            "doc_id": doc_id,
            "line": self._documents[doc_id]["line_refs"][field],
            "field": field,
        }

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
