"""Thin lab re-export.

The canonical implementation is :mod:`flowagent.tools.credit.world`. The lab
keeps this module only so the Phase 0 seam proof has a stable import path; no
world data or metric logic is duplicated here.
"""

from __future__ import annotations

from flowagent.tools.credit.world import (  # noqa: F401
    AR_DOCS,
    AUDIT_CODES,
    BASE_DOCUMENT_IDS,
    BLOCK_REASONS,
    CODE_METRICS,
    DEBT_DOC,
    DEBT_METRICS,
    ISSUER_KEYS,
    ISSUER_NAMES,
    ISSUERS,
    KINDS,
    METRICS,
    METRIC_KIND,
    METRIC_UNIT,
    PERIODS,
    RATING_CODES,
    RATING_DOC,
    RATIO_METRICS,
    RESTATEMENT_DOC,
    UNIT,
    VALUE_CODES,
    CreditWorld,
)

COMPANY = ISSUER_NAMES["hengxing"]
DOCUMENT_IDS = BASE_DOCUMENT_IDS

__all__ = [
    "COMPANY",
    "DOCUMENT_IDS",
    "CreditWorld",
    "ISSUER_KEYS",
    "ISSUER_NAMES",
    "ISSUERS",
    "METRICS",
    "PERIODS",
    "BLOCK_REASONS",
]
