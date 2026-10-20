"""Domain registry: the modules the runtime can host."""

from __future__ import annotations

from .base import DomainModule
from .finance import FINANCE_DOMAIN

__all__ = ["DomainModule", "DOMAINS", "get_domain", "list_domains"]

DOMAINS: dict[str, DomainModule] = {FINANCE_DOMAIN.key: FINANCE_DOMAIN}


def get_domain(key: str) -> DomainModule:
    module = DOMAINS.get(key)
    if module is None:
        raise KeyError(f"unknown domain module {key!r}; known: {sorted(DOMAINS)}")
    return module


def list_domains() -> list[DomainModule]:
    return list(DOMAINS.values())
