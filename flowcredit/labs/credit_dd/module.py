"""Thin lab alias for the production credit domain module."""

from __future__ import annotations

from flowagent.domains.credit import (  # noqa: F401
    APPROVAL_TOOLS,
    CREDIT_DOMAIN,
    build_tools,
    create_world,
    make_planner,
)

CREDIT_DD_DOMAIN = CREDIT_DOMAIN

__all__ = [
    "CREDIT_DD_DOMAIN",
    "CREDIT_DOMAIN",
    "APPROVAL_TOOLS",
    "create_world",
    "build_tools",
    "make_planner",
]
