"""Deterministic extraction of 11 facts from the committed 10-K excerpt.

No LLM, no third-party HTML library and no XBRL fallback are used. Each fact has
a section anchor and a label; the first numeric cell after the label is the
value. The extractor never reads ``ground_truth.json`` — the spike compares the
two afterwards.

Values in the filing are USD millions; the public fact value is whole USD
(``value = millions * 1_000_000``) and ``source_unit`` records the conversion.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

__all__ = ["FACT_ORDER", "extract_all", "extract_fact", "split_sections"]

FACT_ORDER: tuple[str, ...] = (
    "revenue",
    "operating_income",
    "depreciation_amortization",
    "interest_expense",
    "cash_and_equivalents",
    "total_debt",
    "short_term_debt",
    "operating_cash_flow",
    "accounts_receivable",
    "equity",
    "audit_opinion",
)

_SECTION = {
    "revenue": "### CONSOLIDATED STATEMENTS OF OPERATIONS",
    "operating_income": "### CONSOLIDATED STATEMENTS OF OPERATIONS",
    "interest_expense": "### CONSOLIDATED STATEMENTS OF OPERATIONS",
    "depreciation_amortization": "### CONSOLIDATED STATEMENTS OF CASH FLOWS",
    "operating_cash_flow": "### CONSOLIDATED STATEMENTS OF CASH FLOWS",
    "cash_and_equivalents": "### CONSOLIDATED BALANCE SHEETS",
    "accounts_receivable": "### CONSOLIDATED BALANCE SHEETS",
    "equity": "### CONSOLIDATED BALANCE SHEETS",
    "total_debt": "### MD&A TOTAL DEBT",
    "short_term_debt": "### NOTE 12 BORROWINGS",
    "audit_opinion": "### AUDIT REPORT",
}

_LABEL = {
    "revenue": "Total revenue",
    "operating_income": "OPERATING INCOME",
    "depreciation_amortization": "Depreciation, amortization, and other",
    "interest_expense": "Interest expense",
    "cash_and_equivalents": "Cash and cash equivalents",
    "total_debt": "Total debt",
    "short_term_debt": "Total",
    "operating_cash_flow": "Net cash provided by operating activities",
    "accounts_receivable": "Accounts receivable, net",
    "equity": "Total equity",
}

_DOC_ID = {
    "total_debt": "doc_debt_fy2025",
    "short_term_debt": "doc_debt_fy2025",
}

_NUMBER = re.compile(r"^\(?-?\d[\d,]*\)?$")


def split_sections(lines: list[str]) -> dict[str, list[tuple[int, str]]]:
    """Split excerpt lines into ``marker -> [(1-based line, text), ...]``."""
    sections: dict[str, list[tuple[int, str]]] = {}
    current: str | None = None
    for index, line in enumerate(lines, start=1):
        if line.startswith("### "):
            current = line.strip()
            sections.setdefault(current, [])
            continue
        if current is not None:
            sections[current].append((index, line))
    return sections


def _find(section: list[tuple[int, str]], prefix: str) -> tuple[int, str] | None:
    prefix = prefix.lower()
    for line_no, text in section:
        if text.lower().startswith(prefix):
            return line_no, text
    return None


def _first_number(text: str, *, absolute: bool = False) -> int | None:
    cells = text.split(" | ")
    for cell in cells[1:]:
        token = cell.strip().replace("$", "").replace(",", "")
        if _NUMBER.match(token):
            if token.startswith("(") and token.endswith(")"):
                value = -int(token[1:-1])
            else:
                value = int(token)
            return abs(value) if absolute else value
    return None


def _audit_code(text: str) -> str | None:
    lowered = text.lower()
    if "in our opinion" in lowered and "present fairly" in lowered:
        return "standard_unqualified"
    if "adverse opinion" in lowered:
        return "adverse"
    if "disclaimer of opinion" in lowered:
        return "disclaimer"
    if "qualified opinion" in lowered:
        return "qualified"
    return None


def _missing(fact: str, reason: str, period: str) -> dict[str, Any]:
    return {
        "fact": fact,
        "status": "missing",
        "reason": reason,
        "period": period,
        "doc_id": _DOC_ID.get(fact, "doc_10k_fy2025"),
    }


def extract_fact(
    fact: str,
    sections: dict[str, list[tuple[int, str]]],
    meta: dict[str, Any],
) -> dict[str, Any]:
    period = str(meta.get("fiscal_year") or "FY2025")
    section_name = _SECTION.get(fact)
    if section_name is None:
        return _missing(fact, "unknown_fact", period)
    section = sections.get(section_name)
    if not section:
        return _missing(fact, f"missing_section:{section_name}", period)

    doc_id = _DOC_ID.get(fact, "doc_10k_fy2025")
    if fact == "audit_opinion":
        hit = _find(section, "In our opinion")
        if hit is None:
            return _missing(fact, "missing_audit_opinion", period)
        line_no, text = hit
        code = _audit_code(text)
        if code is None:
            return _missing(fact, "unrecognised_audit_opinion", period)
        return {
            "fact": fact,
            "status": "ok",
            "value": code,
            "unit": "code",
            "source_unit": "code",
            "period": period,
            "doc_id": doc_id,
            "line": line_no,
            "snippet": text,
            "source_url": meta.get("source_url", ""),
            "accession": meta.get("accession", ""),
        }

    hit = _find(section, _LABEL[fact])
    if hit is None:
        return _missing(fact, f"missing_label:{_LABEL[fact]}", period)
    line_no, text = hit
    millions = _first_number(text, absolute=(fact == "interest_expense"))
    if millions is None:
        return _missing(fact, "missing_number", period)
    return {
        "fact": fact,
        "status": "ok",
        "value": millions * 1_000_000,
        "unit": "USD",
        "source_unit": "USD millions",
        "period": period,
        "doc_id": doc_id,
        "line": line_no,
        "snippet": text,
        "source_url": meta.get("source_url", ""),
        "accession": meta.get("accession", ""),
    }


def extract_all(
    excerpt_path: str | Path,
    meta_path: str | Path,
) -> dict[str, dict[str, Any]]:
    """Extract all facts from the committed excerpt; never reads ground truth."""
    lines = Path(excerpt_path).read_text(encoding="utf-8").splitlines()
    meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
    sections = split_sections(lines)
    return {fact: extract_fact(fact, sections, meta) for fact in FACT_ORDER}
