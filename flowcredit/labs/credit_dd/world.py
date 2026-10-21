"""Synthetic credit world for the Phase 0 credit-DD seam spike.

Everything in this module is invented. 恒星智造 is not a real issuer, and every
amount, period and audit opinion below is authored for the spike. The annual
reports and the debt schedule exist so the model can only *ask* for a metric;
the runtime's verifier recomputes the same metric from this world rather than
trusting the observation.

The world also remembers which documents were actually read. A metric that
needs an unread or missing schedule is refused with a machine-readable blocker
instead of being computed from data the trace cannot cite.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "COMPANY",
    "UNIT",
    "PERIODS",
    "METRICS",
    "BLOCK_REASONS",
    "DOCUMENT_IDS",
    "DEBT_DOC",
    "FACTS",
    "CreditWorld",
]

COMPANY = "恒星智造股份有限公司（合成数据，非真实公司）"
UNIT = "CNY thousand"
PERIODS: tuple[str, ...] = ("FY2024", "FY2025")
METRICS: tuple[str, ...] = ("net_debt_to_ebitda", "interest_coverage")
BLOCK_REASONS: tuple[str, ...] = (
    "missing_document",
    "insufficient_evidence",
    "basis_unresolved",
)
DOCUMENT_IDS: tuple[str, ...] = ("doc_ar_fy2024", "doc_ar_fy2025", "doc_debt_fy2025")
DEBT_DOC = "doc_debt_fy2025"

#: Synthetic facts, in CNY thousand. The annual reports expose the operating
#: fields; the FY2025 debt schedule exposes the debt fields. FY2024 debt is in
#: the table for context but has no source document, so the net-debt metric
#: refuses FY2024 rather than citing a document that does not contain it.
FACTS: dict[str, dict[str, Any]] = {
    "FY2024": {
        "revenue": 1_200_000,
        "ebitda": 180_000,
        "cash": 150_000,
        "interest_expense": 30_000,
        "operating_cash_flow": 120_000,
        "accounts_receivable": 220_000,
        "total_debt": 600_000,
        "short_term_debt": 200_000,
        "audit_opinion": "标准无保留意见（合成）",
    },
    "FY2025": {
        "revenue": 1_350_000,
        "ebitda": 175_000,
        "cash": 120_000,
        "interest_expense": 42_000,
        "operating_cash_flow": 90_000,
        "accounts_receivable": 310_000,
        "total_debt": 780_000,
        "short_term_debt": 320_000,
        "related_party_loan": 45_000,
        "contingent_liabilities": 18_000,
        "audit_opinion": "标准无保留意见（合成）",
    },
}


def _format(value: Any) -> str:
    return f"{value:,}" if isinstance(value, int) and not isinstance(value, bool) else str(value)


def _document(
    *,
    doc_id: str,
    title: str,
    period: str,
    rows: tuple[tuple[str, str, Any], ...],
    footer: str,
) -> dict[str, Any]:
    """Build a plain-text document and its field -> 1-based line map."""
    lines = [
        COMPANY,
        f"{title} | {period} | 单位：人民币千元 | 合并口径",
    ]
    fields: dict[str, Any] = {}
    line_refs: dict[str, int] = {}
    for field, label, value in rows:
        lines.append(f"{label}：{_format(value)}")
        line_refs[field] = len(lines)
        fields[field] = value
    lines.append(footer)
    return {
        "doc_id": doc_id,
        "id": doc_id,
        "title": title,
        "period": period,
        "unit": UNIT,
        "body": "\n".join(lines),
        "line_refs": line_refs,
        "fields": fields,
        "synthetic": True,
    }


def _build_documents() -> dict[str, dict[str, Any]]:
    fy2024, fy2025 = FACTS["FY2024"], FACTS["FY2025"]
    footer = "本文件为合成数据，仅用于 FCode Phase 0 缝验证，不构成任何信贷意见。"
    annual_rows_2024 = (
        ("revenue", "营业收入", fy2024["revenue"]),
        ("ebitda", "息税折旧摊销前利润（EBITDA）", fy2024["ebitda"]),
        ("cash", "货币资金", fy2024["cash"]),
        ("interest_expense", "利息费用", fy2024["interest_expense"]),
        ("operating_cash_flow", "经营活动现金流量净额", fy2024["operating_cash_flow"]),
        ("accounts_receivable", "应收账款", fy2024["accounts_receivable"]),
        ("audit_opinion", "审计意见", fy2024["audit_opinion"]),
    )
    annual_rows_2025 = (
        ("revenue", "营业收入", fy2025["revenue"]),
        ("ebitda", "息税折旧摊销前利润（EBITDA）", fy2025["ebitda"]),
        ("cash", "货币资金", fy2025["cash"]),
        ("interest_expense", "利息费用", fy2025["interest_expense"]),
        ("operating_cash_flow", "经营活动现金流量净额", fy2025["operating_cash_flow"]),
        ("accounts_receivable", "应收账款", fy2025["accounts_receivable"]),
        ("audit_opinion", "审计意见", fy2025["audit_opinion"]),
    )
    debt_rows = (
        ("total_debt", "总有息负债", fy2025["total_debt"]),
        ("short_term_debt", "短期有息负债", fy2025["short_term_debt"]),
        ("related_party_loan", "关联方借款", fy2025["related_party_loan"]),
        ("contingent_liabilities", "或有负债", fy2025["contingent_liabilities"]),
    )
    documents = {
        "doc_ar_fy2024": _document(
            doc_id="doc_ar_fy2024",
            title="年度报告摘要",
            period="FY2024",
            rows=annual_rows_2024,
            footer=footer,
        ),
        "doc_ar_fy2025": _document(
            doc_id="doc_ar_fy2025",
            title="年度报告摘要",
            period="FY2025",
            rows=annual_rows_2025,
            footer=footer,
        ),
        "doc_debt_fy2025": _document(
            doc_id="doc_debt_fy2025",
            title="债务明细",
            period="FY2025",
            rows=debt_rows,
            footer="口径说明：合并口径，含租赁负债。" + footer,
        ),
    }
    return documents


def _x100(numerator: int, denominator: int) -> int | None:
    """Round a positive ratio to two decimal places, as an integer x100."""
    if denominator <= 0:
        return None
    return (numerator * 100 + denominator // 2) // denominator


class CreditWorld:
    """An authored, read-only corpus plus the two credit metrics.

    ``partial=True`` removes the FY2025 debt schedule. That is the failure
    injection the spike uses to prove the runtime does not invent a net-debt
    figure when the evidence is missing.
    """

    def __init__(self, partial: bool = False) -> None:
        self.partial = bool(partial)
        self._documents = _build_documents()
        self.read_documents: set[str] = set()
        self.blockers: list[dict[str, Any]] = []

    # ---------------------------------------------------------------- documents

    def available_document_ids(self) -> tuple[str, ...]:
        return tuple(
            doc_id
            for doc_id in DOCUMENT_IDS
            if not (self.partial and doc_id == DEBT_DOC)
        )

    def list_documents(self) -> dict[str, Any]:
        keys = ("doc_id", "id", "title", "period", "unit", "synthetic")
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

    # ----------------------------------------------------------------- metrics

    def compute_credit_metric(self, metric: str, period: str) -> dict[str, Any]:
        """Return one metric, or a precise blocker. Never accepts a value."""
        if metric == "net_debt_to_ebitda":
            return self._net_debt_to_ebitda(period)
        if metric == "interest_coverage":
            return self._interest_coverage(period)
        return self._blocked(metric, period, ["unknown_metric"])

    def _net_debt_to_ebitda(self, period: str) -> dict[str, Any]:
        # The only debt schedule in this corpus is FY2025. FY2024 has table
        # values but no document to cite, so the metric refuses rather than
        # laundering an uncited number into the trace.
        if period != "FY2025" or self.partial:
            return self._blocked("net_debt_to_ebitda", period, ["missing_debt_schedule"])
        if DEBT_DOC not in self.read_documents:
            return self._blocked("net_debt_to_ebitda", period, ["debt_schedule_not_read"])
        annual = "doc_ar_fy2025"
        if annual not in self.read_documents:
            return self._blocked("net_debt_to_ebitda", period, ["annual_report_not_read"])

        debt = self._documents[DEBT_DOC]["fields"]
        ar = self._documents[annual]["fields"]
        value = _x100(debt["total_debt"] - ar["cash"], ar["ebitda"])
        if value is None:
            return self._blocked("net_debt_to_ebitda", period, ["non_positive_denominator"])
        return {
            "computed": True,
            "metric": "net_debt_to_ebitda",
            "period": period,
            "value_x100": value,
            "inputs": {
                "total_debt": debt["total_debt"],
                "cash": ar["cash"],
                "ebitda": ar["ebitda"],
            },
            "citations": [
                self._citation(DEBT_DOC, "total_debt"),
                self._citation(annual, "cash"),
                self._citation(annual, "ebitda"),
            ],
            "blockers": [],
        }

    def _interest_coverage(self, period: str) -> dict[str, Any]:
        if period not in PERIODS:
            return self._blocked("interest_coverage", period, ["missing_period"])
        annual = "doc_ar_fy2024" if period == "FY2024" else "doc_ar_fy2025"
        if annual not in self.read_documents:
            return self._blocked("interest_coverage", period, ["annual_report_not_read"])

        ar = self._documents[annual]["fields"]
        value = _x100(ar["ebitda"], ar["interest_expense"])
        if value is None:
            return self._blocked("interest_coverage", period, ["non_positive_denominator"])
        return {
            "computed": True,
            "metric": "interest_coverage",
            "period": period,
            "value_x100": value,
            "inputs": {
                "ebitda": ar["ebitda"],
                "interest_expense": ar["interest_expense"],
            },
            "citations": [
                self._citation(annual, "ebitda"),
                self._citation(annual, "interest_expense"),
            ],
            "blockers": [],
        }

    def report_blocked(self, reason: str) -> dict[str, Any]:
        self.blockers.append({"reason": reason})
        return {
            "acknowledged": True,
            "reason": reason,
            "blocker_count": len(self.blockers),
        }

    # -------------------------------------------------------------- resumption

    def apply_state(self, state: dict[str, Any]) -> None:
        """Rebuild "which documents were read" from the observation log."""
        self.read_documents = set(state.get("read_documents", []))

    # ------------------------------------------------------------------ helper

    def _citation(self, doc_id: str, field: str) -> dict[str, Any]:
        return {
            "doc_id": doc_id,
            "line": self._documents[doc_id]["line_refs"][field],
            "field": field,
        }

    @staticmethod
    def _blocked(metric: str, period: str, blockers: list[str]) -> dict[str, Any]:
        return {
            "computed": False,
            "metric": metric,
            "period": period,
            "inputs": {},
            "citations": [],
            "blockers": blockers,
        }
