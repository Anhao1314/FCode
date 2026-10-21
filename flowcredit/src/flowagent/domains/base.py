"""Domain modules: the pluggable side of the kernel.

A module owns everything a particular digital-economy line of work needs and
nothing else:

* how to build its world (fixtures, data sources, synthetic or real),
* its toolset (the shared workspace tools are composed on top by the caller),
* its planner (the blueprint a deterministic provider follows),
* its verifier (independent recomputation — the only path to "succeeded"),
* which tools are consequential enough to pause for a human.

The kernel never imports a module. Adding audit or quant means adding a module
and registering it; it does not mean teaching the runtime a new noun.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from ..tools.base import Observation, ToolSpec

__all__ = ["DomainModule"]


@dataclass(frozen=True)
class DomainModule:
    key: str
    title: str
    #: Build a fresh world. ``partial=True`` is used by failure-injection
    #: scenarios that need a deliberately incomplete corpus.
    create_world: Callable[..., Any]
    #: Build the module's own tools bound to a world.
    build_tools: Callable[..., list[ToolSpec]]
    #: A fresh planner instance (decompose/advance).
    make_planner: Callable[[], Any]
    #: (world, observation) -> {"verified": True, "verification": ..., "result": ...}
    verify: Callable[[Any, Observation], dict[str, Any]]
    #: Tools whose verified observations are the domain's answer.
    result_tools: tuple[str, ...] = ()
    #: Tools that pause for a human under the "consequential" policy.
    approval_tools: tuple[str, ...] = ()
    #: Which report template the console should use for this module.
    report_template: str = "generic"
