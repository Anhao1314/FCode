"""The credit-DD lab's DomainModule instance.

This module is deliberately not registered in ``flowagent.domains`` or in the
demo's ``DOMAINS``. Phase 0 only proves that the protocol can describe a second
domain; making it selectable by the product would be a later phase.
"""

from __future__ import annotations

from typing import Any

from flowagent.domains.base import DomainModule
from flowagent.tools.base import ToolSpec

from .planner import CreditPlanner
from .tools import build_credit_tools
from .verifier import verify_observation
from .world import CreditWorld

__all__ = ["CREDIT_DD_DOMAIN", "APPROVAL_TOOLS", "create_world", "build_tools", "make_planner"]

APPROVAL_TOOLS: tuple[str, ...] = ("report_blocked",)


def create_world(partial: bool = False) -> CreditWorld:
    return CreditWorld(partial=partial)


def build_tools(world: CreditWorld, **_: Any) -> list[ToolSpec]:
    return build_credit_tools(world)


def make_planner() -> CreditPlanner:
    return CreditPlanner()


CREDIT_DD_DOMAIN = DomainModule(
    key="credit-due-diligence",
    title="信用尽调",
    create_world=create_world,
    build_tools=build_tools,
    make_planner=make_planner,
    # The module-level verifier checks one observation. The spike's
    # CreditVerifier wraps it to check both metrics in the committed chain.
    verify=verify_observation,
    approval_tools=APPROVAL_TOOLS,
    report_template="credit-memo",
)
