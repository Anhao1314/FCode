"""General delegation: the default domain module and the general-agent
prototype.

The finance module stays as the reference workload that proves the runtime on
recomputable numbers. This module proves it on file writes, command execution
and web fetches — capabilities where "independent recomputation" generalises to
file-state hashes and honest not-verified labels. Same kernel, same gate, same
budget, same receipts; only the vocabulary changed.
"""

from __future__ import annotations

from typing import Any

from ..tools.base import ToolSpec
from ..tools.general.planner import GeneralPlanner
from ..tools.general.world import GeneralWorld
from .base import DomainModule

__all__ = [
    "GENERAL_DOMAIN",
    "GENERAL_INSTRUCTION",
    "create_world",
    "build_tools",
    "make_planner",
    "verify_observation",
    "summarize_state",
]

#: The protocol the general planner is bound by. It must describe what this
#: domain actually does: read *and* write the workspace, run whitelisted
#: commands, fetch declared sources — while still proposing exactly one action
#: and leaving execution to the runtime.
GENERAL_INSTRUCTION = (
    "每轮只提议一个动作，且必须来自 tools 列表里的工具；"
    "你只能提议，不能执行、不能宣告任务完成——执行与验收由运行时完成。"
    "你可以读写工作区文件（write_file / edit_file）、"
    "用受限终端运行白名单命令（run_command）、抓取已声明的来源（fetch_url）。"
    "提议未列出的工具会被权限门控拒绝并终止本次运行，"
    "所以不确定时选 tools 里最接近的那个，而不是发明一个工具名。"
    "如果关键信息缺失（日期、对象、目标文件……）且猜错代价高，"
    "用 ask_operator 问操作员一句再继续——它会带着答案回到你的下一轮。"
    "如果问了没人回答，而你仍然无法完成：把已知信息与缺口如实写进产出文件，"
    "在文件里说明缺什么——不要提议未列出的工具（那会被门控拒绝并终止整个运行）。"
    "如果上一轮的提议因为参数形状被拒（context 里的 rejected_proposals），"
    "按错误信息改正参数后重新提议；连续两次都改不对，这次运行会终止。"
)

APPROVAL_TOOLS = ("write_file", "edit_file", "run_command")


def create_world(partial: bool = False, spec: dict[str, Any] | None = None, **kwargs: Any) -> GeneralWorld:
    """``partial`` is accepted for interface parity; a general delegation has
    no corpus to withhold. ``sandbox``/``fetcher``/``command_runner``/
    ``command_config`` may be injected by the console so the world shares the
    run directory's workspace and the host's command whitelist, and
    ``ask_operator`` carries the operator channel the question tool waits on.
    Whatever this function does not forward does not exist: the channel was
    dropped here once, and a real run asked a question nobody could answer."""
    return GeneralWorld(
        spec,
        sandbox=kwargs.get("sandbox"),
        fetcher=kwargs.get("fetcher"),
        command_runner=kwargs.get("command_runner"),
        command_config=kwargs.get("command_config"),
        ask_operator=kwargs.get("ask_operator"),
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


def summarize_state(records) -> dict[str, Any]:
    """The general agent's "what has been established so far" card.

    Files are the facts: what was written (with its content hash), what was
    edited, what was read; commands with their exit codes; fetches with their
    status; open blockers. Every value comes from signed observations — the
    card is a projection, never a model note.
    """
    written: list[dict[str, Any]] = []
    edited: list[str] = []
    read: list[str] = []
    commands: list[dict[str, Any]] = []
    fetches: list[dict[str, Any]] = []
    listed = False
    blockers: list[str] = []
    for record in records:
        tool, result = record.tool, record.result
        if tool == "write_file":
            if result.get("changed", True):
                written.append({
                    "path": result.get("path"),
                    "bytes": result.get("bytes"),
                    "sha256": result.get("sha256_after"),
                })
        elif tool == "edit_file":
            if result.get("changed", True):
                edited.append(result.get("path"))
        elif tool == "read_file":
            read.append(result.get("path"))
        elif tool == "run_command":
            commands.append({
                "command": result.get("command"),
                "exit_code": result.get("exit_code"),
            })
            if result.get("exit_code") not in (0, None):
                blockers.append(f"command failed: {result.get('command')}")
        elif tool == "fetch_url":
            fetches.append({"url": result.get("url"), "status": result.get("status")})
        elif tool == "ls_workspace":
            listed = True
        if result.get("blockers"):
            blockers.extend(result["blockers"])
    return {
        "workspace_listed": listed,
        "files_written": written,
        "files_edited": sorted(set(edited)),
        "files_read": sorted(set(read)),
        "commands": commands,
        "fetches": fetches,
        "blockers": blockers,
    }


GENERAL_DOMAIN = DomainModule(
    instruction=GENERAL_INSTRUCTION,
    key="general-work",
    title="通用委托",
    create_world=create_world,
    build_tools=build_tools,
    make_planner=make_planner,
    verify=verify_observation,
    result_tools=("write_file",),
    approval_tools=APPROVAL_TOOLS,
    report_template="generic",
    summarize_state=summarize_state,
)
