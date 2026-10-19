"""Scenario definitions and the narrative text used by the demo.

Only ``full`` is implemented in Phase 1a. The other four keys exist so the CLI
can give an honest answer instead of an exception traceback: they are declared
here, and :func:`get_scenario` reports them as scheduled for Phase 1b.
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

_GRANT = {
    "grant_id": "demo-host-grant",
    "revision": 1,
    "allowed_tools": list(_ALL_TOOLS),
    "max_calls": 12,
    "max_reads": 20,
    "max_cost_microusd": 20_000,
    "max_tokens": 20_000,
}

_LIMITS = BudgetLimits(
    max_calls=12,
    max_reads=20,
    max_cost_microusd=20_000,
    max_tokens=20_000,
)


SCENARIOS: dict[str, Scenario] = {
    "full": Scenario(
        key="full",
        title="完整研究：两期毛利率是否可比",
        objective="判断恒星智算 2024 与 2025 两期合并毛利率是否可比，并在可比时给出变化",
        story=(
            "这家公司的两年年报放在一起并不能直接相减：2024 年用万元、2025 年用百万元；"
            "2025 年还发布了一份调整后口径的补充材料；2024 年的毛利后来被一份重述说明改过。"
            "正确的结论必须同时穿过这三个坑。"
        ),
        allowed_tools=_ALL_TOOLS,
        grant=_GRANT,
        limits=_LIMITS,
        max_rounds=12,
    ),
    "tool-denied": Scenario(
        key="tool-denied",
        title="越权工具被主机拒绝",
        objective="（Phase 1b）演示模型提议一个不在授权范围内的工具",
        story="模型提议越权动作，主机门控拒绝，工具与模型均未执行。",
        allowed_tools=_ALL_TOOLS,
        grant=_GRANT,
        limits=_LIMITS,
        max_rounds=6,
        available=False,
    ),
    "budget": Scenario(
        key="budget",
        title="预算耗尽被拦截",
        objective="（Phase 1b）演示调用预算在发送前被拒绝",
        story="预算在上限处停止，已占用额度可见且不退还。",
        allowed_tools=_ALL_TOOLS,
        grant=_GRANT,
        limits=_LIMITS,
        max_rounds=6,
        available=False,
    ),
    "crash": Scenario(
        key="crash",
        title="崩溃后恢复且不重复执行",
        objective="（Phase 1b）演示工具执行后进程被杀，重启续跑",
        story="SIGKILL 之后重新加载，已完成步骤不重放，模型调用次数不增加。",
        allowed_tools=_ALL_TOOLS,
        grant=_GRANT,
        limits=_LIMITS,
        max_rounds=12,
        available=False,
    ),
    "unknown": Scenario(
        key="unknown",
        title="未知结果不重发，凭收据对账",
        objective="（Phase 1b）演示发送后超时进入 unknown",
        story="超时后不重发、不退费；只有匹配的签名收据能显式对账。",
        allowed_tools=_ALL_TOOLS,
        grant=_GRANT,
        limits=_LIMITS,
        max_rounds=12,
        available=False,
    ),
}

AVAILABLE = tuple(key for key, scenario in SCENARIOS.items() if scenario.available)


def get_scenario(key: str) -> Scenario:
    """Return a scenario by key, raising a clear error for unknown keys."""
    scenario = SCENARIOS.get(key)
    if scenario is None:
        raise KeyError(key)
    return scenario
