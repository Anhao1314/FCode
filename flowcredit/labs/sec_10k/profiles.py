"""Issuer profiles for deterministic 10-K extraction.

Profiles are data, not code: each ``data/<issuer>/profile.json`` carries the
issuer metadata, statement section markers, label aliases, column rules and
excerpt anchors. Adding a filing should not require a new branch in the
extractor. The only code here is the typed loader and document-id resolution.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = [
    "ColumnRule",
    "ComponentRule",
    "ExcerptRule",
    "FactRule",
    "FilingProfile",
    "load_profile",
    "resolve_document",
]


@dataclass(frozen=True)
class ColumnRule:
    """Where the current and prior values sit in a table row.

    ``header_current`` / ``header_prior`` are checked in order inside the
    excerpt section. ``confirmed`` is only for a profile whose table has no
    header in the committed excerpt; the profile must say so explicitly rather
    than relying on a global "second number" default.
    """

    current: int = 0
    prior: int = 1
    header_current: str = ""
    header_prior: str = ""
    confirmed: bool = False


@dataclass(frozen=True)
class ComponentRule:
    field: str
    labels: tuple[str, ...]


@dataclass(frozen=True)
class FactRule:
    section: str
    labels: tuple[str, ...] = ()
    components: tuple[ComponentRule, ...] = ()
    document_current: str = "current"
    document_prior: str = "prior"
    absolute: bool = False
    special: str = ""


@dataclass(frozen=True)
class ExcerptRule:
    marker: str
    mode: str
    start: str = ""
    end_prefix: str = ""
    anchor: str = ""
    after_anchor: str = ""
    before: int = 0
    after: int = 0


@dataclass(frozen=True)
class FilingProfile:
    issuer_key: str
    company: str
    ticker: str
    cik: str
    fiscal_year: str
    prior_fiscal_year: str
    source_unit: str
    sections: dict[str, str]
    columns: dict[str, ColumnRule]
    facts: dict[str, FactRule]
    excerpt: tuple[ExcerptRule, ...]
    selection_note: str = ""

    def document(self, role: str, meta: dict[str, Any]) -> str:
        return resolve_document(role, meta)


def resolve_document(role: str, meta: dict[str, Any]) -> str:
    """Resolve a profile document role against the filing's fiscal periods."""
    fiscal = str(meta.get("fiscal_year") or "").lower()
    prior = str(meta.get("prior_fiscal_year") or "").lower()
    if role == "current":
        return f"doc_10k_{fiscal}"
    if role == "prior":
        return f"doc_10k_{prior}"
    if role == "debt":
        return f"doc_debt_{fiscal}"
    if role == "rating":
        return f"doc_rating_{fiscal}"
    if role == "none":
        return ""
    raise ValueError(f"unknown document role: {role!r}")


def _column(raw: dict[str, Any]) -> ColumnRule:
    return ColumnRule(
        current=int(raw.get("current", 0)),
        prior=int(raw.get("prior", 1)),
        header_current=str(raw.get("header_current") or ""),
        header_prior=str(raw.get("header_prior") or ""),
        confirmed=bool(raw.get("confirmed", False)),
    )


def _component(raw: dict[str, Any]) -> ComponentRule:
    labels = raw.get("labels") or []
    if isinstance(labels, str):
        labels = [labels]
    return ComponentRule(
        field=str(raw["field"]),
        labels=tuple(str(label) for label in labels),
    )


def _fact(raw: dict[str, Any]) -> FactRule:
    labels = raw.get("labels") or []
    if isinstance(labels, str):
        labels = [labels]
    return FactRule(
        section=str(raw["section"]),
        labels=tuple(str(label) for label in labels),
        components=tuple(_component(item) for item in raw.get("components") or ()),
        document_current=str(raw.get("document_current") or "current"),
        document_prior=str(raw.get("document_prior") or "prior"),
        absolute=bool(raw.get("absolute", False)),
        special=str(raw.get("special") or ""),
    )


def _excerpt(raw: dict[str, Any]) -> ExcerptRule:
    return ExcerptRule(
        marker=str(raw["marker"]),
        mode=str(raw["mode"]),
        start=str(raw.get("start") or ""),
        end_prefix=str(raw.get("end_prefix") or ""),
        anchor=str(raw.get("anchor") or ""),
        after_anchor=str(raw.get("after_anchor") or ""),
        before=int(raw.get("before", 0)),
        after=int(raw.get("after", 0)),
    )


def load_profile(path: str | Path) -> FilingProfile:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return FilingProfile(
        issuer_key=str(data["issuer_key"]),
        company=str(data.get("company") or ""),
        ticker=str(data.get("ticker") or ""),
        cik=str(data.get("cik") or "").zfill(10),
        fiscal_year=str(data.get("fiscal_year") or ""),
        prior_fiscal_year=str(data.get("prior_fiscal_year") or ""),
        source_unit=str(data.get("source_unit") or "USD millions"),
        sections={str(key): str(value) for key, value in (data.get("sections") or {}).items()},
        columns={
            str(key): _column(value)
            for key, value in (data.get("columns") or {}).items()
        },
        facts={
            str(key): _fact(value)
            for key, value in (data.get("facts") or {}).items()
        },
        excerpt=tuple(_excerpt(item) for item in data.get("excerpt") or ()),
        selection_note=str(data.get("selection_note") or ""),
    )
