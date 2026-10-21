"""Deterministic extraction of current and prior-year facts from the 10-K excerpt.

No LLM, no third-party HTML library and no XBRL fallback are used. Each fact has
a section anchor and a label; the first numeric cell after the label is the
current value and the second is the comparative prior-year value. The extractor
never reads ``ground_truth.json`` — the spike compares the two afterwards.

Values in the filing are USD millions; the public fact value is whole USD
(``value = millions * 1_000_000``) and ``source_unit`` records the conversion.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

__all__ = [
    "CURRENT_FACT_ORDER",
    "FACT_ORDER",
    "PRIOR_FACT_ORDER",
    "extract_all",
    "extract_fact",
    "split_sections",
]

CURRENT_FACT_ORDER: tuple[str, ...] = (
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

PRIOR_FACT_ORDER: tuple[str, ...] = tuple(
    f"{fact}_prior"
    for fact in CURRENT_FACT_ORDER
    if fact != "audit_opinion"
)

#: 10 current numeric facts + 10 prior-year values + one audit opinion covering
#: both years = 21 gate facts.
FACT_ORDER: tuple[str, ...] = CURRENT_FACT_ORDER + PRIOR_FACT_ORDER

PRIOR_PERIOD = "FY2024"

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

_CURRENT_DOC = "doc_10k_fy2025"
_PRIOR_DOC = "doc_10k_fy2024"

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


def _numbers(text: str) -> list[int]:
    values: list[int] = []
    for cell in text.split(" | ")[1:]:
        token = cell.strip().replace("$", "").replace(",", "")
        if _NUMBER.match(token):
            if token.startswith("(") and token.endswith(")"):
                values.append(-int(token[1:-1]))
            else:
                values.append(int(token))
    return values


def _number_at(text: str, index: int, *, absolute: bool = False) -> int | None:
    values = _numbers(text)
    if index >= len(values):
        return None
    value = values[index]
    return abs(value) if absolute else value


def _audit_code(text: str) -> str | None:
    """Classify one audit-opinion paragraph, negative signals first.

    ``standard_unqualified`` is the fallback only when no negative or qualified
    signal is present. Ambiguous text returns ``None``; it is never assumed to
    be standard.
    """
    lowered = text.lower()
    if "disclaimer of opinion" in lowered or "do not express an opinion" in lowered:
        return "disclaimer"
    if "adverse opinion" in lowered or "do not present fairly" in lowered:
        return "adverse"
    if (
        "qualified opinion" in lowered
        or "basis for qualified opinion" in lowered
        or ("except for" in lowered and "present fairly" in lowered)
    ):
        return "qualified"
    if "in our opinion" in lowered and "present fairly" in lowered:
        return "standard_unqualified"
    return None


def _find_audit_paragraph(
    section: list[tuple[int, str]],
) -> tuple[int, str] | None:
    """Select the opinion paragraph, not an earlier scope/heading paragraph.

    A line with ``in our opinion`` / ``do not express an opinion`` wins over a
    heading such as ``Basis for Qualified Opinion``. ``except for`` alone is
    never a selector, so a standard opinion that mentions it elsewhere is not
    misclassified.
    """
    best: tuple[int, str] | None = None
    best_score = 0
    for line_no, text in section:
        lowered = text.lower()
        if (
            "in our opinion" in lowered
            or "do not express an opinion" in lowered
            or "disclaimer of opinion" in lowered
        ):
            score = 3
        elif (
            "adverse opinion" in lowered
            or "qualified opinion" in lowered
            or "basis for qualified opinion" in lowered
            or "do not present fairly" in lowered
        ):
            score = 2
        else:
            score = 0
        if score > best_score:
            best = (line_no, text)
            best_score = score
    return best


def _base_fact(fact: str) -> str:
    return fact[: -len("_prior")] if fact.endswith("_prior") else fact


def _is_prior(fact: str) -> bool:
    return fact.endswith("_prior")


def _period_for(fact: str, meta: dict[str, Any]) -> str:
    if _is_prior(fact):
        return str(meta.get("prior_fiscal_year") or PRIOR_PERIOD)
    return str(meta.get("fiscal_year") or "FY2025")


def _doc_id_for(fact: str, base: str) -> str:
    # The debt note contains both the current and comparative columns, so its
    # line anchor stays doc_debt_fy2025 for either period.
    if base in _DOC_ID:
        return _DOC_ID[base]
    return _PRIOR_DOC if _is_prior(fact) else _CURRENT_DOC


def _missing(fact: str, reason: str, period: str, doc_id: str) -> dict[str, Any]:
    return {
        "fact": fact,
        "status": "missing",
        "reason": reason,
        "period": period,
        "doc_id": doc_id,
    }


def extract_fact(
    fact: str,
    sections: dict[str, list[tuple[int, str]]],
    meta: dict[str, Any],
) -> dict[str, Any]:
    base = _base_fact(fact)
    period = _period_for(fact, meta)
    doc_id = _doc_id_for(fact, base)
    section_name = _SECTION.get(base)
    if section_name is None:
        return _missing(fact, "unknown_fact", period, doc_id)
    section = sections.get(section_name)
    if not section:
        return _missing(fact, f"missing_section:{section_name}", period, doc_id)

    if base == "audit_opinion":
        if _is_prior(fact):
            return _missing(fact, "prior_audit_not_a_separate_fact", period, doc_id)
        hit = _find_audit_paragraph(section)
        if hit is None:
            return _missing(fact, "missing_audit_opinion", period, doc_id)
        line_no, text = hit
        code = _audit_code(text)
        if code is None:
            return _missing(fact, "unrecognised_audit_opinion", period, doc_id)
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

    hit = _find(section, _LABEL[base])
    if hit is None:
        return _missing(fact, f"missing_label:{_LABEL[base]}", period, doc_id)
    line_no, text = hit
    index = 1 if _is_prior(fact) else 0
    millions = _number_at(text, index, absolute=(base == "interest_expense"))
    if millions is None:
        return _missing(fact, "missing_number", period, doc_id)
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
    """Extract all current and prior facts; never reads ground truth."""
    lines = Path(excerpt_path).read_text(encoding="utf-8").splitlines()
    meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
    sections = split_sections(lines)
    return {fact: extract_fact(fact, sections, meta) for fact in FACT_ORDER}
