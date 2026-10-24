"""Credit due diligence: the second production domain module.

The module owns the synthetic issuer world, the five read-only tools, the
fourteen-step planner, the independent metric verifier and the memo-oriented
report template. The kernel does not import it directly; it is registered in
``flowagent.domains`` so assembly can select it by key.
"""

from __future__ import annotations

from typing import Any

from ..tools.base import ToolSpec
from ..tools.credit.planner import CreditPlanner
from ..tools.credit.tools import build_credit_tools
from ..tools.credit.verifier import verify_observation
from ..tools.credit.world import CreditWorld
from .base import DomainModule

__all__ = ["CREDIT_DOMAIN", "APPROVAL_TOOLS", "create_world", "build_tools", "make_planner"]

APPROVAL_TOOLS: tuple[str, ...] = ("report_blocked",)


def create_world(issuer: str = "hengxing", partial: bool = False) -> CreditWorld:
    return CreditWorld(issuer=issuer, partial=partial)


def build_tools(world: CreditWorld, **_: Any) -> list[ToolSpec]:
    return build_credit_tools(world)


def make_planner(world: Any = None, **kwargs: Any) -> CreditPlanner:
    return CreditPlanner()


CREDIT_DOMAIN = DomainModule(
    key="credit-due-diligence",
    title="信用尽调",
    create_world=create_world,
    build_tools=build_tools,
    make_planner=make_planner,
    # The loop calls this once per committed result observation, so all eight
    # metrics are independently verified through the module contract.
    verify=verify_observation,
    result_tools=("compute_credit_metric",),
    approval_tools=APPROVAL_TOOLS,
    report_template="credit-memo",
)
