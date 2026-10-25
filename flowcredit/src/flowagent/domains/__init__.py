"""Domain registry: the modules the runtime can host."""

from __future__ import annotations

from .base import DomainModule
from .finance import FINANCE_DOMAIN
from .general import GENERAL_DOMAIN

__all__ = [
    "DomainModule",
    "DOMAINS",
    "FINANCE_DOMAIN",
    "GENERAL_DOMAIN",
    "get_domain",
    "list_domains",
]

#: The general module is the product's default entry. The finance module stays
#: registered as the deterministic reference workload: it is what the reliability
#: scenarios and the independent-recomputation tests run against.
DOMAINS: dict[str, DomainModule] = {
    GENERAL_DOMAIN.key: GENERAL_DOMAIN,
    FINANCE_DOMAIN.key: FINANCE_DOMAIN,
}


def get_domain(key: str) -> DomainModule:
    module = DOMAINS.get(key)
    if module is None:
        raise KeyError(f"unknown domain module {key!r}; known: {sorted(DOMAINS)}")
    return module


def list_domains() -> list[DomainModule]:
    return list(DOMAINS.values())
