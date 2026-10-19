"""Wires one scenario together and runs it end to end.

This module is the only place that chooses concrete implementations. Everything
below it takes interfaces: the harness does not know it is being rendered, the
renderer does not know it is being recorded, and the loop does not know whether a
human is watching. That is what lets the same runtime be driven by a test, a CLI,
or a future HTTP surface without changing a line of policy.

The crash scenario is the one exception to "no subprocesses": a real SIGKILL
needs a real process to kill, so it spawns a worker that dies on purpose and then
resumes from the same database in the parent.
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..core.contracts import AgentError, Task
from ..core.receipts import ReceiptStore
from ..core.store import TaskStore
from ..providers.mock import MockProvider
from ..runtime.harness import Harness
from ..runtime.loop import Loop
from ..tools.finance.fixtures import FinanceWorld
from ..tools.finance.tools import build_finance_tools
from ..tools.registry import ToolRegistry
from ..trajectory.exporter import export_trace, verify_trace
from ..trajectory.recorder import TraceRecorder
from .fixtures import SCENARIOS, Scenario, get_scenario
from .render import Renderer

__all__ = ["PROJECT_ROOT", "WORK_DIR", "RunResult", "run_scenario", "run_all"]

PROJECT_ROOT = Path(__file__).resolve().parents[3]
WORK_DIR = PROJECT_ROOT / "work" / "demo"


@dataclass
class RunResult:
    """What one scenario produced, in the numbers a reviewer will ask for."""

    key: str
    status: str
    rounds: int = 0
    calls: int = 0
    reads: int = 0
    cost_microusd: int = 0
    trace_path: str = ""
    trace_verified: bool = False
    recovered: bool = False
    reconciled: bool = False
    failure_code: str = ""
    model_calls: int = 0
    note: str = ""
    expected: str = "succeeded"

    @property
    def ok(self) -> bool:
        """True when the scenario reached the terminal state it was designed for."""
        return self.status == self.expected and self.trace_verified

    @property
    def exit_code(self) -> int:
        return 0 if self.ok else 1


@dataclass
class Stack:
    store: TaskStore
    world: FinanceWorld
    registry: ToolRegistry
    receipts: ReceiptStore
    provider: MockProvider
    harness: Harness
    issued: dict[str, str] = field(default_factory=dict)


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


def _db_path(key: str) -> Path:
    return WORK_DIR / f"{key}.sqlite"


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


def build_stack(db_path: Path, scenario: Scenario) -> Stack:
    """Assemble store, world, registry, provider and harness for one scenario."""
    store = TaskStore(db_path)
    world = FinanceWorld()
    registry = ToolRegistry(build_finance_tools(world))
    receipts = ReceiptStore(store)
    issued: dict[str, str] = {}

    def issue(**kwargs: Any) -> str:
        ref = receipts.issue(**kwargs)
        issued["ref"] = ref
        return ref

    provider = MockProvider(
        policy=scenario.policy,
        fail_at_call=scenario.fail_at_call,
        issue_receipt=issue if scenario.fail_at_call else None,
    )
    harness = Harness(
        store=store,
        registry=registry,
        provider=provider,
        world=world,
        limits=scenario.limits,
        receipts=receipts,
    )
    return Stack(store, world, registry, receipts, provider, harness, issued)


def _count(store: TaskStore, task_id: str, event_type: str) -> int:
    return sum(1 for event in store.events(task_id) if event["type"] == event_type)


def _create_task(stack: Stack, scenario: Scenario) -> Task:
    return stack.harness.create(
        task_id=f"task-{scenario.key}-0001",
        objective=scenario.objective,
        principal="demo-researcher",
        binding={"scenario": scenario.key, "corpus": "synthetic-authored-v1"},
        allowed_tools=list(scenario.allowed_tools),
        grant=scenario.grant,
    )


def _finish(stack: Stack, scenario: Scenario, task: Task, recorder: TraceRecorder, renderer: Renderer, *, trace_out: str | None) -> tuple[str, bool]:
    trace = recorder.build(task)
    target = Path(trace_out) if trace_out else WORK_DIR / f"{scenario.key}.trace.json"
    path = export_trace(trace, target)
    renderer.footer(str(path), stack.harness.budget(task).snapshot(), task.model.attempts)
    try:
        verify_trace(trace)
        verified = True
        if not renderer.quiet:
            print(f" 轨迹自检  通过：{trace['chain']['event_count']} 个事件，链头 {trace['chain']['head_hash'][:12]}…")
    except Exception as error:  # noqa: BLE001 - surfaced, never swallowed
        verified = False
        print(f" 轨迹自检  失败：{error}")
    return str(path), verified


def run_scenario(
    key: str = "full",
    *,
    fast: bool = False,
    trace_out: str | None = None,
    model: str = "mock",
    quiet: bool = False,
) -> RunResult:
    """Run one scenario and return its numbers."""
    scenario = get_scenario(key)
    if model != "mock":
        raise AgentError(
            "PROVIDER_GATED",
            f"model {model!r} is gated off in Phase 1: only the offline mock is enabled",
        )

    db = _db_path(key)
    _fresh_database(db)
    stack = build_stack(db, scenario)
    renderer = Renderer(fast=fast, quiet=quiet)
    recorder = TraceRecorder(stack.store, provider_name=stack.provider.name, model_name=stack.provider.model)
    observer = _Tee(renderer, recorder)
    task = _create_task(stack, scenario)
    renderer.header(scenario.title, scenario.objective, scenario.story, stack.provider.model, stack.harness.budget(task).snapshot())

    recovered = False
    reconciled = False
    note = ""

    if scenario.crash_at:
        task, recovered = _run_crash(stack, scenario, task, observer, renderer)
    else:
        task = Loop(stack.harness, max_rounds=scenario.max_rounds, observer=observer).run(task.id)

        if scenario.reconcile and task.status == "recovery_required":
            renderer.event("UNKNOWN", "模型结果未知：不重发、不退费，等待显式对账", colour=Renderer.YELLOW)
            try:
                stack.harness.reconcile(task, "0" * 64)
            except AgentError as error:
                renderer.event("REJECTED", f"错误收据被拒绝：{error.code}", colour=Renderer.RED)
            ref = stack.issued.get("ref", "")
            task = stack.harness.reconcile(task, ref)
            reconciled = True
            renderer.event("RECONCILED", f"签名收据匹配 round {task.model.attempts}，继续执行", colour=Renderer.GREEN)
            task = Loop(stack.harness, max_rounds=scenario.max_rounds, observer=observer).run(task.id)

    path, verified = _finish(stack, scenario, task, recorder, renderer, trace_out=trace_out)
    budget = stack.harness.budget(task).snapshot()
    result = RunResult(
        key=key,
        status=task.status,
        rounds=task.model.attempts,
        calls=budget["calls_used"],
        reads=budget["reads_used"],
        cost_microusd=budget["cost_used_microusd"],
        trace_path=path,
        trace_verified=verified,
        recovered=recovered,
        reconciled=reconciled,
        failure_code=(task.failure or {}).get("code", ""),
        model_calls=_count(stack.store, task.id, "model_started"),
        note=note,
        expected=scenario.expected_status,
    )
    stack.store.close()
    return result


def _run_crash(
    stack: Stack,
    scenario: Scenario,
    task: Task,
    observer: _Tee,
    renderer: Renderer,
) -> tuple[Task, bool]:
    """Run until the worker kills itself, then resume in this process."""
    env = {
        **os.environ,
        "PYTHONPATH": str(PROJECT_ROOT / "src"),
        "FLOWAGENT_DB": str(_db_path(scenario.key)),
        "FLOWAGENT_TASK_ID": task.id,
        "FLOWAGENT_CRASH_AT": scenario.crash_at or "tool_succeeded",
        "FLOWAGENT_CRASH_AT_COUNT": str(scenario.crash_at_count),
        "FLOWAGENT_MAX_ROUNDS": str(scenario.max_rounds),
    }
    completed = subprocess.run(
        [sys.executable, "-m", "flowagent.demo.crash_worker"],
        cwd=str(PROJECT_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    killed = completed.returncode < 0
    renderer.event(
        "CRASH",
        f"子进程退出码 {completed.returncode}（负数即被信号杀死），数据库仍完整",
        colour=Renderer.RED if killed else Renderer.YELLOW,
    )
    if not killed:
        renderer.event("WARNING", f"worker 未按预期崩溃：{completed.stderr.strip()[:120]}", colour=Renderer.YELLOW)

    resumed = stack.store.load(task.id)
    memory = Loop(stack.harness).restore(resumed)
    stack.world.apply_state(memory.state())
    renderer.event(
        "RECOVERED",
        f"从事件日志重建记忆：已读 {len(memory.state()['read_documents'])} 份资料，"
        f"崩溃前完成 {resumed.model.attempts} 轮",
        colour=Renderer.GREEN,
    )

    task = Loop(stack.harness, max_rounds=scenario.max_rounds, observer=observer).run(resumed.id)

    # The property that matters is not "the counter went up by the right amount"
    # but "no round was proposed twice". Duplicates would mean a paid call was
    # repeated after a crash, which is the failure this scenario exists to rule out.
    rounds = [
        event["payload"]["detail"].get("round")
        for event in stack.store.events(task.id)
        if event["type"] == "model_started"
    ]
    duplicated = sorted({item for item in rounds if rounds.count(item) > 1})
    assert not duplicated, f"recovery re-proposed rounds {duplicated}"
    renderer.event(
        "NO REPEAT",
        f"模型共调用 {len(rounds)} 次，覆盖轮次 {sorted(set(rounds))}，无任何一轮被重复提议",
        colour=Renderer.GREEN,
    )
    return task, killed


def run_all(*, trace_dir: str | None = None) -> list[RunResult]:
    """Run every scenario in order and print a summary table."""
    results: list[RunResult] = []
    for key in SCENARIOS:
        results.append(run_scenario(key, fast=True, quiet=True, trace_out=None))

    print()
    print("─" * 78)
    print(" 场景汇总")
    print("─" * 78)
    header = f" {'场景':<12} {'终态':<20} {'轮次':>4} {'调用':>4} {'读取':>4} {'花费µUSD':>9} {'轨迹':>4}"
    print(header)
    for result in results:
        trace_state = "ok" if result.trace_verified else "FAIL"
        print(
            f" {result.key:<12} {result.status:<20} {result.rounds:>4} {result.calls:>4}"
            f" {result.reads:>4} {result.cost_microusd:>9} {trace_state:>4}"
        )
    print("─" * 78)
    failures = [result for result in results if not result.trace_verified]
    if failures:
        print(f" {len(failures)} 个场景的轨迹未通过自检")
    else:
        print(f" 全部 {len(results)} 个场景的轨迹均通过自检")
    print()
    return results
