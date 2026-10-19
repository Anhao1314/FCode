"""Wires one scenario together and runs it end to end.

This module is the only place where the demo chooses concrete implementations.
Everything below it takes interfaces: the harness does not know it is being
rendered, the renderer does not know it is being recorded, and the loop does not
know whether a human is watching. That is what lets the same runtime be driven
by a test, a CLI, or a future HTTP surface without changing a line of policy.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ..core.store import TaskStore
from ..providers.mock import MockProvider
from ..runtime.harness import Harness
from ..runtime.loop import Loop
from ..tools.finance.fixtures import FinanceWorld
from ..tools.finance.tools import build_finance_tools
from ..tools.registry import ToolRegistry
from ..trajectory.exporter import export_trace, verify_trace
from ..trajectory.recorder import TraceRecorder
from .fixtures import SCENARIOS, get_scenario
from .render import Renderer

__all__ = ["PROJECT_ROOT", "WORK_DIR", "run_scenario"]

PROJECT_ROOT = Path(__file__).resolve().parents[3]
WORK_DIR = PROJECT_ROOT / "work" / "demo"


class _Tee:
    """Fan one observer signal out to several observers, in order."""

    def __init__(self, *observers: Any) -> None:
        self._observers = observers

    def round_start(self, round_no: int, budget: dict[str, Any]) -> None:
        for observer in self._observers:
            observer.round_start(round_no, budget)

    def proposal(self, round_no: int, proposal: Any) -> None:
        for observer in self._observers:
            observer.proposal(round_no, proposal)

    def gate(self, round_no: int, decision: Any) -> None:
        for observer in self._observers:
            observer.gate(round_no, decision)

    def observation(self, round_no: int, observation: Any) -> None:
        for observer in self._observers:
            observer.observation(round_no, observation)

    def round_end(self, round_no: int, budget: dict[str, Any]) -> None:
        for observer in self._observers:
            observer.round_end(round_no, budget)

    def terminal(self, task: Any, result: Any) -> None:
        for observer in self._observers:
            observer.terminal(task, result)


def _fresh_database(path: Path) -> None:
    """Remove a previous run so the demo always starts from an empty store.

    The *decisions* are reproducible; the trace bytes are not, because every
    event carries a wall-clock timestamp. Claiming byte-identical reruns would be
    a lie, and a runtime that lies about reproducibility is worse than one that
    admits timestamps exist.
    """
    for suffix in ("", "-wal", "-shm"):
        candidate = path.with_name(path.name + suffix)
        if candidate.exists():
            candidate.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)


def run_scenario(
    key: str = "full",
    *,
    fast: bool = False,
    trace_out: str | None = None,
    model: str = "mock",
) -> int:
    """Run one scenario and return a process exit code."""
    try:
        scenario = get_scenario(key)
    except KeyError:
        print(f"unknown scenario {key!r}; available: {', '.join(SCENARIOS)}")
        return 2

    if not scenario.available:
        print(f"scenario {key!r} is scheduled for Phase 1b and is not implemented yet.")
        print(f"available now: {', '.join(k for k, s in SCENARIOS.items() if s.available)}")
        return 2

    if model != "mock":
        print(f"model {model!r} is gated off in Phase 1: only the offline mock is enabled.")
        print("a real provider requires a one-time transmission approval, a credential provider,")
        print("a host-reviewed price snapshot and a hard budget. See docs/design-decisions.md.")
        return 2

    _fresh_database(WORK_DIR / f"{key}.sqlite")
    store = TaskStore(WORK_DIR / f"{key}.sqlite")
    world = FinanceWorld()
    registry = ToolRegistry(build_finance_tools(world))
    provider = MockProvider()
    harness = Harness(
        store=store,
        registry=registry,
        provider=provider,
        world=world,
        limits=scenario.limits,
    )
    renderer = Renderer(fast=fast)
    recorder = TraceRecorder(store, provider_name=provider.name, model_name=provider.model)
    observer = _Tee(renderer, recorder)

    task = harness.create(
        task_id=f"task-{key}-0001",
        objective=scenario.objective,
        principal="demo-researcher",
        binding={"scenario": key, "corpus": "synthetic-authored-v1"},
        allowed_tools=list(scenario.allowed_tools),
        grant=scenario.grant,
    )

    renderer.header(scenario.title, scenario.objective, scenario.story, provider.model, harness.budget(task).snapshot())

    loop = Loop(harness, max_rounds=scenario.max_rounds, observer=observer)
    task = loop.run(task.id)

    trace = recorder.build(task)
    target = Path(trace_out) if trace_out else WORK_DIR / f"{key}.trace.json"
    path = export_trace(trace, target)

    renderer.footer(str(path), harness.budget(task).snapshot(), len(trace["rounds"]))

    # The demo re-verifies its own trace before claiming success, because a
    # trace nobody checked is just a log file with extra steps.
    try:
        summary = verify_trace(trace)
        print(f" 轨迹自检  通过：{summary['events']} 个事件，链头 {summary['head_hash'][:12]}…")
    except Exception as error:  # noqa: BLE001 - surfaced to the user, not swallowed
        print(f" 轨迹自检  失败：{error}")
        return 1

    store.close()
    return 0 if task.status == "succeeded" else 1
