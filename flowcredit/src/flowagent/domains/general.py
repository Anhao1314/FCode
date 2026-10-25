"""General delegation: the second domain module, and the reference for
governed *general* capabilities.

The finance module proves the runtime on recomputable numbers. This module
proves it on file writes and web fetches — capabilities where "independent
recomputation" generalises to file-state hashes and honest not-verified
labels. Same kernel, same gate, same budget, same receipts; only the domain
vocabulary changed.
"""

from __future__ import annotations

from typing import Any

from ..tools.base import ToolSpec
from ..tools.general.planner import GeneralPlanner
from ..tools.general.world import GeneralWorld
from .base import DomainModule

__all__ = ["GENERAL_DOMAIN", "create_world", "build_tools", "make_planner", "verify_observation"]

APPROVAL_TOOLS = ("write_file", "edit_file", "run_command")


def create_world(partial: bool = False, spec: dict[str, Any] | None = None, **kwargs: Any) -> GeneralWorld:
    """``partial`` is accepted for interface parity; a general delegation has
    no corpus to withhold. ``sandbox``/``fetcher``/``command_runner``/
    ``command_config`` may be injected by the console so the world shares the
    run directory's workspace and the host's command whitelist."""
    return GeneralWorld(
        spec,
        sandbox=kwargs.get("sandbox"),
        fetcher=kwargs.get("fetcher"),
        command_runner=kwargs.get("command_runner"),
        command_config=kwargs.get("command_config"),
    )


def build_tools(world: GeneralWorld, **kwargs: Any) -> list[ToolSpec]:
    return world.build_tools()


def make_planner(world: GeneralWorld | None = None, **kwargs: Any) -> GeneralPlanner:
    if world is None:
        raise ValueError("the general planner needs the delegation's world (it carries the mode and inputs)")
    return GeneralPlanner(
        world.sources,
        report_path=world.report_path,
        mode=world.mode,
        script_path=world.script_path,
    )


def verify_observation(world: GeneralWorld, observation) -> dict[str, Any]:
    return world.verify_observation(observation)


GENERAL_DOMAIN = DomainModule(
    key="general-work",
    title="通用委托",
    create_world=create_world,
    build_tools=build_tools,
    make_planner=make_planner,
    verify=verify_observation,
    result_tools=("write_file",),
    approval_tools=APPROVAL_TOOLS,
    report_template="generic",
)
