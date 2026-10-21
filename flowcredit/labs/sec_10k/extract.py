"""Deterministic, profile-driven extraction of facts from a 10-K excerpt.

No LLM, no third-party HTML library and no XBRL fallback are used. The labels,
section markers, column positions and component sums come from the issuer's
``profile.json``; this module carries only the generic parser. The extractor
never reads ``ground_truth.json`` — the spike compares the two afterwards.

Values in the filing are usually USD millions; the public fact value is whole USD
(``value = millions * 1_000_000``) and ``source_unit`` records the conversion.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .profiles import FactRule, FilingProfile, load_profile

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


def _find_any(
    section: list[tuple[int, str]],
    labels: tuple[str, ...],
) -> tuple[int, str] | None:
    lowered = tuple(label.lower() for label in labels)
    for line_no, text in section:
        line = text.lower()
        if any(line.startswith(label) for label in lowered):
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
    """Select the opinion paragraph, not an earlier scope/heading paragraph."""
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


def _columns_confirmed(
    section: list[tuple[int, str]],
    rule: Any,
) -> bool:
    """Check the profile's column rule against the section's header."""
    if rule.confirmed:
        return True
    if not rule.header_current or not rule.header_prior:
        return False
    if rule.current >= rule.prior:
        return False
    for _, text in section:
        current_at = text.find(rule.header_current)
        prior_at = text.find(rule.header_prior)
        if current_at >= 0 and prior_at >= 0 and current_at < prior_at:
            return True
    return False


def _base_fact(fact: str) -> str:
    return fact[: -len("_prior")] if fact.endswith("_prior") else fact


def _is_prior(fact: str) -> bool:
    return fact.endswith("_prior")


def _period_for(fact: str, meta: dict[str, Any]) -> str:
    if _is_prior(fact):
        return str(meta.get("prior_fiscal_year") or "FY2024")
    return str(meta.get("fiscal_year") or "FY2025")


def _doc_id_for(
    fact: str,
    rule: FactRule,
    meta: dict[str, Any],
    profile: FilingProfile,
) -> str:
    role = rule.document_prior if _is_prior(fact) else rule.document_current
    return profile.document(role, meta)


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
    profile: FilingProfile,
) -> dict[str, Any]:
    base = _base_fact(fact)
    period = _period_for(fact, meta)
    rule = profile.facts.get(base)
    if rule is None:
        return _missing(fact, "unknown_fact", period, "")
    doc_id = _doc_id_for(fact, rule, meta, profile)
    section_marker = profile.sections.get(rule.section)
    if not section_marker:
        return _missing(fact, f"missing_section_rule:{rule.section}", period, doc_id)
    section = sections.get(section_marker)
    if not section:
        return _missing(fact, f"missing_section:{section_marker}", period, doc_id)

    if rule.special == "audit":
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

    column = profile.columns.get(rule.section)
    if column is None or not _columns_confirmed(section, column):
        return _missing(fact, f"unconfirmed_columns:{rule.section}", period, doc_id)
    index = column.prior if _is_prior(fact) else column.current

    components: list[dict[str, Any]] = []
    if rule.components:
        for component in rule.components:
            hit = _find_any(section, component.labels)
            if hit is None:
                return _missing(
                    fact,
                    f"missing_component:{component.field}",
                    period,
                    doc_id,
                )
            line_no, text = hit
            millions = _number_at(text, index, absolute=rule.absolute)
            if millions is None:
                return _missing(
                    fact,
                    f"missing_component_number:{component.field}",
                    period,
                    doc_id,
                )
            components.append(
                {
                    "field": component.field,
                    "label": text.split(" | ", 1)[0],
                    "value": millions * 1_000_000,
                    "line": line_no,
                    "snippet": text,
                    "doc_id": doc_id,
                }
            )
        value = sum(item["value"] for item in components)
        line_no = components[0]["line"]
        text = components[0]["snippet"]
    else:
        hit = _find_any(section, rule.labels)
        if hit is None:
            return _missing(fact, f"missing_label:{rule.labels}", period, doc_id)
        line_no, text = hit
        millions = _number_at(text, index, absolute=rule.absolute)
        if millions is None:
            return _missing(fact, "missing_number", period, doc_id)
        value = millions * 1_000_000

    result = {
        "fact": fact,
        "status": "ok",
        "value": value,
        "unit": "USD",
        "source_unit": profile.source_unit,
        "period": period,
        "doc_id": doc_id,
        "line": line_no,
        "snippet": text,
        "source_url": meta.get("source_url", ""),
        "accession": meta.get("accession", ""),
    }
    if components:
        result["components"] = components
    return result


def extract_all(
    excerpt_path: str | Path,
    meta_path: str | Path,
    profile_path: str | Path,
) -> dict[str, dict[str, Any]]:
    """Extract all current and prior facts; never reads ground truth."""
    lines = Path(excerpt_path).read_text(encoding="utf-8").splitlines()
    meta = json.loads(Path(meta_path).read_text(encoding="utf-8"))
    profile = load_profile(profile_path)
    sections = split_sections(lines)
    return {
        fact: extract_fact(fact, sections, meta, profile)
        for fact in FACT_ORDER
    }
