"""Scenario definitions: one story, four ways for the runtime to say no.

Each scenario is the same kernel with a different host policy or a different
failure injected. None of them changes runtime code — that is the claim the demo
is making, so the scenarios are data, not branches.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..runtime.budget import BudgetLimits

__all__ = ["Scenario", "SCENARIOS", "AVAILABLE", "get_scenario"]


@dataclass(frozen=True)
class Scenario:
    key: str
    title: str
    objective: str
    story: str
    allowed_tools: tuple[str, ...]
    grant: dict[str, Any]
    limits: BudgetLimits
    max_rounds: int
    policy: str = "research"
    fail_at_call: int | None = None
    reconcile: bool = False
    crash_at: str | None = None
    crash_at_count: int = 1
    expected_status: str = "succeeded"
    available: bool = True


_ALL_TOOLS = (
    "list_documents",
    "read_document",
    "normalize_units",
    "reconcile_basis",
    "check_restatement",
    "calculate_margin",
    "report_blocked",
)

_OBJECTIVE = "判断恒星智算 2024 与 2025 两期合并毛利率是否可比，并在可比时给出变化"
_STORY = (
    "两年年报放在一起并不能直接相减：2024 年用万元、2025 年用百万元；"
    "2025 年还发布了一份调整后口径的补充材料；2024 年的毛利后来被一份重述说明改过。"
)


def _grant(max_calls: int = 12, max_reads: int = 20) -> dict[str, Any]:
    return {
        "grant_id": "demo-host-grant",
        "revision": 1,
        "allowed_tools": list(_ALL_TOOLS),
        "max_calls": max_calls,
        "max_reads": max_reads,
        "max_cost_microusd": 20_000,
        "max_tokens": 20_000,
    }


SCENARIOS: dict[str, Scenario] = {
    "full": Scenario(
        key="full",
        title="完整研究：两期毛利率是否可比",
        objective=_OBJECTIVE,
        story=_STORY + "正确的结论必须同时穿过这三个坑。",
        allowed_tools=_ALL_TOOLS,
        grant=_grant(),
        limits=BudgetLimits(12, 20, 20_000, 20_000),
        max_rounds=12,
    ),
    "tool-denied": Scenario(
        key="tool-denied",
        title="越权工具：主机拒绝，模型与工具都未执行",
        objective=_OBJECTIVE,
        story="模型一上来就提出一个从未注册的工具 write_document。名字合法、schema 合法，但主机不认。",
        allowed_tools=_ALL_TOOLS,
        grant=_grant(),
        limits=BudgetLimits(12, 20, 20_000, 20_000),
        max_rounds=3,
        policy="escalate",
        expected_status="denied",
    ),
    "budget": Scenario(
        key="budget",
        title="预算耗尽：发送前被拒绝，已占用不退",
        objective=_OBJECTIVE,
        story="模型反复请求同一份资料，第 5 次调用在发出之前就被预算拦住。前 4 次的额度真实占用。",
        allowed_tools=_ALL_TOOLS,
        grant=_grant(max_calls=4),
        limits=BudgetLimits(4, 20, 20_000, 20_000),
        max_rounds=10,
        policy="loop",
        expected_status="failed",
    ),
    "crash": Scenario(
        key="crash",
        title="崩溃恢复：进程被杀，续跑不重复",
        objective=_OBJECTIVE,
        story="第三轮工具执行落盘后进程被 SIGKILL。重启后从事件日志重建记忆，第四轮继续，前三次调用不重发。",
        allowed_tools=_ALL_TOOLS,
        grant=_grant(),
        limits=BudgetLimits(12, 20, 20_000, 20_000),
        max_rounds=12,
        crash_at="tool_succeeded",
        crash_at_count=3,
    ),
    "unknown": Scenario(
        key="unknown",
        title="未知结果：不重发，凭签名收据对账",
        objective=_OBJECTIVE,
        story="第三轮调用发出后供应商超时。Runtime 记 unknown，不重发、不退费；只有匹配的签名收据能把它拉回来。",
        allowed_tools=_ALL_TOOLS,
        grant=_grant(),
        limits=BudgetLimits(12, 20, 20_000, 20_000),
        max_rounds=12,
        fail_at_call=3,
        reconcile=True,
    ),
}

AVAILABLE = tuple(key for key, scenario in SCENARIOS.items() if scenario.available)


def get_scenario(key: str) -> Scenario:
    """Return a scenario by key, raising ``KeyError`` for unknown keys."""
    scenario = SCENARIOS.get(key)
    if scenario is None:
        raise KeyError(key)
    return scenario
