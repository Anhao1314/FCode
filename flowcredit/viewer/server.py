#!/usr/bin/env python3
"""Fcode console — live server for the flowcredit runtime.

Serves the static viewer plus a small JSON + SSE API that drives the *real*
flowcredit runtime (the flowagent package) from a checkout, so the console is
not only a replay player:
a task typed into the composer actually runs, round by round, and committed
events stream into the page while the run is still in flight.

    python3 server.py --repo /path/to/FCode [--port 8642] [--pace 0.8] [--approval-timeout 300]

Endpoints
    GET  /api/health              what the server can and cannot do
    GET  /api/templates           scenario templates the composer may run
    GET  /api/runs                run history (survives restarts, runs/*/meta.json)
    POST /api/runs                {"objective": "...", "template": "full", "approval": "consequential"}
                                  -> {"id": "run-..."}
    GET  /api/runs/{id}/stream    server-sent events: trace snapshots as they grow
    POST /api/runs/{id}/stop      stop at the next round boundary
    POST /api/runs/{id}/decision  {"approvalId": "...", "allow": true, "remember": false}
    POST /api/runs/{id}/plan      {"action": "skip"|"promote", "todoId": "t4"}
    POST /api/runs/{id}/budget    raise limits; applies at the next round
    POST /api/runs/{id}/resume    add budget and continue a failed run
    POST /api/runs/{id}/meta      {"name": "...", "pinned": true} -> updated record

Standard library only, the same constraint as the rest of this viewer. The
runtime itself is imported from the checkout given with ``--repo``; if that is
missing the static viewer still works and /api/health says why live mode is off.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import types
import uuid
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

__all__ = ["main"]

#: The first domain module. Scenarios still come from demo fixtures; the
#: vocabulary of the runtime already comes from the module registry.
DOMAIN_KEY = "finance-research"

VIEWER_DIR = Path(__file__).resolve().parent
#: The desktop shell points this at the user's Application Support directory:
#: a packaged .app bundle is read-only, and run records belong to the user.
RUNS_DIR = Path(os.environ.get("FCODE_RUNS_DIR") or (VIEWER_DIR / "runs"))

TERMINAL_STATUS = ("succeeded", "failed", "denied", "recovery_required")


class StopRequested(Exception):
    """Raised inside an observer callback when the operator stops the run."""


# --------------------------------------------------------------------- runtime


class Runtime:
    """A lazily imported flowagent checkout, exposing just what the console needs."""

    def __init__(self, repo: Path) -> None:
        src = None
        for candidate in (repo / "flowcredit" / "src", repo / "src", repo):
            if (candidate / "flowagent" / "__init__.py").exists():
                src = candidate.resolve()
                break
        if src is None:
            raise RuntimeError(f"no flowagent package found under {repo}")
        self.repo = repo.resolve()
        self.src = src
        if str(src) not in sys.path:
            sys.path.insert(0, str(src))

        def imp(name: str):
            return importlib.import_module(name)

        m = imp("flowagent.core.contracts")
        self.AgentError = m.AgentError
        m = imp("flowagent.core.receipts")
        self.ReceiptStore = m.ReceiptStore
        m = imp("flowagent.core.store")
        self.TaskStore = m.TaskStore
        m = imp("flowagent.core.plan")
        self.Plan = m.Plan
        m = imp("flowagent.domains")
        self.get_domain = m.get_domain
        self.list_domains = m.list_domains
        m = imp("flowagent.demo.fixtures")
        self.SCENARIOS = m.SCENARIOS
        self.AVAILABLE = m.AVAILABLE
        self.get_scenario = m.get_scenario
        m = imp("flowagent.providers.mock")
        self.MockProvider = m.MockProvider
        m = imp("flowagent.runtime.budget")
        self.BudgetLimits = m.BudgetLimits
        m = imp("flowagent.runtime.control")
        self.RoundControl = m.RoundControl
        self.ToolControl = m.ToolControl
        m = imp("flowagent.runtime.harness")
        self.Harness = m.Harness
        m = imp("flowagent.runtime.loop")
        self.Loop = m.Loop
        m = imp("flowagent.tools.finance.fixtures")
        self.FinanceWorld = m.FinanceWorld
        m = imp("flowagent.tools.finance.planner")
        self.FinancePlanner = m.FinancePlanner
        m = imp("flowagent.tools.finance.tools")
        self.build_finance_tools = m.build_finance_tools
        m = imp("flowagent.tools.registry")
        self.ToolRegistry = m.ToolRegistry
        m = imp("flowagent.trajectory.exporter")
        self.export_trace = m.export_trace
        self.verify_trace = m.verify_trace
        m = imp("flowagent.trajectory.recorder")
        self.TraceRecorder = m.TraceRecorder

    def tool_contracts(self) -> list[dict]:
        """The registered contracts (name, effect, version, schemas)."""
        module = self.get_domain(DOMAIN_KEY)
        world = module.create_world()
        registry = self.ToolRegistry(module.build_tools(world))
        return [registry.get(tool["name"]).contract() for tool in registry.catalog()]

    def modules(self) -> list[dict]:
        """The domain modules this runtime can host, for the console."""
        return [
            {
                "key": module.key,
                "title": module.title,
                "reportTemplate": module.report_template,
                "approvalTools": list(module.approval_tools),
            }
            for module in self.list_domains()
        ]

    def templates(self) -> list[dict]:
        out = []
        for key in self.AVAILABLE:
            scenario = self.SCENARIOS[key]
            limits = scenario.limits
            out.append(
                {
                    "key": scenario.key,
                    "title": scenario.title,
                    "objective": scenario.objective,
                    "story": scenario.story,
                    "expected": scenario.expected_status,
                    "max_rounds": scenario.max_rounds,
                    "limits": limits.to_dict(),
                }
            )
        return out


# ------------------------------------------------------------------ run records


@dataclass
class Run:
    id: str
    template: str
    objective: str
    created: str
    pace: float
    status: str = "running"  # running | succeeded | failed | denied | stopped | error
    version: int = 0
    snapshot: dict | None = None
    trace_path: str = ""
    rounds: int = 0
    event_count: int = 0
    trace_verified: bool = False
    task_id: str = ""
    error: str = ""
    stop_requested: bool = False
    finished: bool = False
    name: str = ""
    pinned: bool = False
    approval: str = "consequential"  # off | consequential | all
    pending: dict | None = None
    cost: dict | None = None
    controller: Any = None
    lock: threading.RLock = field(default_factory=threading.RLock)
    cond: threading.Condition = field(init=False)

    def __post_init__(self) -> None:
        self.cond = threading.Condition(self.lock)

    def bump(self) -> None:
        """Caller must hold the lock."""
        self.version += 1
        self.cond.notify_all()

    def to_json(self, *, detail: bool = False) -> dict:
        out = {
            "id": self.id,
            "template": self.template,
            "objective": self.objective,
            "created": self.created,
            "status": self.status,
            "rounds": self.rounds,
            "events": self.event_count,
            "tracePath": self.trace_path,
            "verified": self.trace_verified,
            "name": self.name,
            "pinned": self.pinned,
            "approval": self.approval,
            "taskId": self.task_id,
            "cost": self.cost,
        }
        if detail:
            out["error"] = self.error
            out["pending"] = self.pending
        return out


def _budget_summary(trace: dict) -> dict | None:
    """Final budget snapshot for the ledger: what the run actually cost."""
    for round_ in reversed(trace.get("rounds") or []):
        b = round_.get("budget_after")
        if b and b.get("calls_used") is not None:
            lim = b.get("limits") or {}
            return {
                "calls": b.get("calls_used"),
                "reads": b.get("reads_used"),
                "costMicrousd": b.get("cost_used_microusd"),
                "tokens": b.get("tokens_used"),
                "maxCalls": lim.get("max_calls"),
                "maxCostMicrousd": lim.get("max_cost_microusd"),
            }
    return None


class RunManager:
    def __init__(self, runtime: Runtime | None, runtime_error: str, pace: float, approval_timeout: float = 300.0) -> None:
        self.runtime = runtime
        self.runtime_error = runtime_error
        self.pace = pace
        self.approval_timeout = approval_timeout
        self.runs: dict[str, Run] = {}
        self.order: list[str] = []
        self._lock = threading.Lock()
        self._seq = 0
        RUNS_DIR.mkdir(exist_ok=True)
        self._load_history()

    # ------------------------------------------------------------- persistence

    def _load_history(self) -> None:
        for meta_path in sorted(RUNS_DIR.glob("run-*/meta.json")):
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            run = Run(
                id=meta["id"],
                template=meta.get("template", "?"),
                objective=meta.get("objective", ""),
                created=meta.get("created", ""),
                pace=0.0,
                status=meta.get("status", "error"),
                rounds=int(meta.get("rounds", 0)),
                event_count=int(meta.get("events", 0)),
                trace_path=meta.get("tracePath", ""),
                trace_verified=bool(meta.get("verified", False)),
                name=meta.get("name", ""),
                pinned=bool(meta.get("pinned", False)),
                approval=meta.get("approval", "consequential"),
                task_id=meta.get("taskId", ""),
                cost=meta.get("cost"),
                finished=True,
            )
            self.runs[run.id] = run
            self.order.append(run.id)
        self.order.sort(key=lambda rid: self.runs[rid].created, reverse=True)

    def _write_meta(self, run: Run) -> None:
        meta = run.to_json()
        meta["verified"] = run.trace_verified
        try:
            (RUNS_DIR / run.id / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass

    # ------------------------------------------------------------------ public

    def list_runs(self) -> list[dict]:
        with self._lock:
            return [self.runs[rid].to_json() for rid in self.order]

    def get(self, run_id: str) -> Run | None:
        return self.runs.get(run_id)

    def delete(self, run_id: str) -> tuple[bool, str]:
        """Remove a finished run's record and directory. Running runs are refused."""
        with self._lock:
            run = self.runs.get(run_id)
            if run is None:
                return False, "no such run"
            if run.status == "running" and not run.finished:
                return False, "run is still running; stop it first"
            self.runs.pop(run_id, None)
            if run_id in self.order:
                self.order.remove(run_id)
        shutil.rmtree(RUNS_DIR / run_id, ignore_errors=True)
        return True, ""

    def create(self, objective: str, template: str, approval: str = "consequential") -> Run:
        with self._lock:
            self._seq += 1
            stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
            run_id = f"run-{stamp}-{uuid.uuid4().hex[:4]}"
            run = Run(
                id=run_id,
                template=template,
                objective=objective,
                created=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                pace=self.pace,
                approval=approval,
            )
            self.runs[run_id] = run
            self.order.insert(0, run_id)
        (RUNS_DIR / run.id).mkdir(parents=True, exist_ok=True)
        self._write_meta(run)
        thread = threading.Thread(target=self._run_thread, args=(run,), name=f"run:{run.id}", daemon=True)
        thread.start()
        return run

    def resume(self, run: Run, *, limits: dict, extra_rounds: int = 6) -> Run:
        """Continue a run that stopped on a resource limit, without re-paying."""
        rt = self.runtime
        if rt is None:
            raise ValueError("live runtime is unavailable")
        if not run.finished:
            raise ValueError("run is still active")
        if not run.task_id:
            raise ValueError("run has no durable task to continue")
        db = RUNS_DIR / run.id / "task.sqlite"
        store = rt.TaskStore(db)
        try:
            task = store.load(run.task_id)
        finally:
            store.close()
        code = (task.failure or {}).get("code", "")
        if task.status != "failed" or code not in ("BUDGET_EXCEEDED", "ROUND_LIMIT"):
            raise ValueError(f"run cannot be resumed from {task.status}/{code or 'no failure'}")
        with run.lock:
            run.finished = False
            run.status = "running"
            run.error = ""
            run.stop_requested = False
            run.pending = None
            run.bump()
        thread = threading.Thread(
            target=self._run_thread,
            args=(run,),
            kwargs={"resume_limits": limits, "extra_rounds": extra_rounds},
            name=f"run:{run.id}",
            daemon=True,
        )
        thread.start()
        return run

    # ------------------------------------------------------------- run driver

    def _run_thread(self, run: Run, *, resume_limits: dict | None = None, extra_rounds: int = 6) -> None:
        rt = self.runtime
        assert rt is not None
        store = None
        watcher = None
        try:
            scenario = rt.get_scenario(run.template)
            run_dir = RUNS_DIR / run.id
            db = run_dir / "task.sqlite"
            store = rt.TaskStore(db)
            module = rt.get_domain(DOMAIN_KEY)
            world = module.create_world(partial=scenario.partial_corpus)
            registry = rt.ToolRegistry(module.build_tools(world))
            receipts = rt.ReceiptStore(store)
            issued: dict[str, str] = {}

            limits = scenario.limits
            if resume_limits:
                limits = rt.BudgetLimits(
                    max_calls=int(resume_limits["maxCalls"]),
                    max_reads=int(resume_limits["maxReads"]),
                    max_cost_microusd=int(resume_limits["maxCostMicrousd"]),
                    max_tokens=int(resume_limits.get("maxTokens") or scenario.limits.max_tokens),
                )

            def issue(**kwargs):
                ref = receipts.issue(**kwargs)
                issued["ref"] = ref
                return ref

            provider = rt.MockProvider(
                policy=scenario.policy,
                fail_at_call=scenario.fail_at_call,
                issue_receipt=issue if scenario.fail_at_call else None,
            )
            harness = rt.Harness(
                store=store,
                registry=registry,
                provider=provider,
                world=world,
                limits=limits,
                receipts=receipts,
                verifier=lambda observation: module.verify(world, observation),
            )
            recorder = rt.TraceRecorder(
                store, provider_name=provider.name, model_name=provider.model
            )
            if resume_limits:
                previous = run_dir / "trace.json"
                if previous.exists():
                    try:
                        recorder.seed(json.loads(previous.read_text(encoding="utf-8")).get("rounds") or [])
                    except Exception:  # noqa: BLE001 — a damaged old trace must not block resume
                        pass
            control = RunControl(run, harness, rt, scenario.approval_tools, self.approval_timeout)
            run.controller = control
            if resume_limits:
                task = store.load(run.task_id)
                task = harness.resume(
                    task,
                    detail={"by": "operator", "reason": "budget topped up", "limits": limits.to_dict()},
                )
                max_rounds = max(scenario.max_rounds, task.model.attempts + extra_rounds)
            else:
                task = harness.create(
                    task_id=f"task-{run.id}",
                    objective=run.objective,
                    principal="console-operator",
                    binding={
                    "scenario": scenario.key,
                    "module": module.key,
                    "corpus": "synthetic-authored-v1",
                    "source": "viewer-live",
                },
                    allowed_tools=list(scenario.allowed_tools),
                    grant=scenario.grant,
                )
                max_rounds = scenario.max_rounds
            run.task_id = task.id
            observer = LiveObserver(run, recorder, store, task.id)
            watcher = threading.Thread(
                target=_watch, args=(run, recorder, store, db, task.id), name=f"watch:{run.id}", daemon=True
            )
            watcher.start()

            loop = rt.Loop(
                harness,
                planner=module.make_planner(),
                max_rounds=max_rounds,
                observer=observer,
                control=control,
            )
            if resume_limits:
                # The world is in-memory; the event log is not. Rebuild the
                # "already read" flags before the loop so a resumed run does
                # not read or charge for the same documents twice.
                world.apply_state(loop.restore(task).state())

            try:
                if scenario.crash_at:
                    task = _run_crash(rt, harness, store, world, scenario, task, observer, db)
                else:
                    task = loop.run(task.id)

                if scenario.reconcile and task.status == "recovery_required":
                    # Mirrors demo/runner.py: an unknown model result is never
                    # retried; it waits for an explicit, signed reconciliation.
                    try:
                        harness.reconcile(task, "0" * 64)
                    except rt.AgentError:
                        pass
                    task = harness.reconcile(task, issued.get("ref", ""))
                    task = rt.Loop(
                        harness,
                        planner=module.make_planner(),
                        max_rounds=max_rounds,
                        observer=observer,
                        control=control,
                    ).run(task.id)
                status = task.status
            except StopRequested:
                task = store.load(task.id)
                if task.status not in TERMINAL_STATUS:
                    task = harness.finalize(
                        task,
                        "failed",
                        failure={
                            "code": "STOPPED_BY_OPERATOR",
                            "message": "操作员在轮次边界停止了这次运行",
                            "retryable": False,
                        },
                        event="task_failed",
                        detail={"code": "STOPPED_BY_OPERATOR"},
                    )
                observer.terminal(task, None)
                status = "stopped"
            except Exception as exc:  # noqa: BLE001 — surface, never swallow
                traceback.print_exc()
                run.error = f"{type(exc).__name__}: {exc}"
                task = store.load(task.id)
                if task.status not in TERMINAL_STATUS:
                    task = harness.finalize(
                        task,
                        "failed",
                        failure={"code": "VIEWER_RUNNER_ERROR", "message": str(exc)[:300], "retryable": False},
                        event="task_failed",
                        detail={"code": "VIEWER_RUNNER_ERROR"},
                    )
                observer.terminal(task, None)
                status = "error"

            final = recorder.build(store.load(task.id))
            trace_path = run_dir / "trace.json"
            rt.export_trace(final, trace_path)
            try:
                verification = rt.verify_trace(final)
                verified = bool(verification.get("ok", verification.get("valid", True)))
            except Exception:  # verification must never kill a finished run
                verified = False

            with run.lock:
                run.snapshot = final
                run.status = status
                run.rounds = len(final["rounds"])
                run.event_count = len(final["events"])
                run.trace_path = f"runs/{run.id}/trace.json"
                run.trace_verified = verified
                run.cost = _budget_summary(final)
                run.finished = True
                run.bump()
        except Exception as exc:  # noqa: BLE001 — setup failure
            traceback.print_exc()
            with run.lock:
                run.status = "error"
                run.error = f"{type(exc).__name__}: {exc}"
                run.finished = True
                run.bump()
        finally:
            with run.lock:
                if run.pending is not None:
                    run.pending = None
                    run.bump()
                run.controller = None
            self._write_meta(run)
            if store is not None:
                try:
                    store.close()
                except Exception:  # noqa: BLE001
                    pass


# -------------------------------------------------------------------- observer


class LiveObserver:
    """The demo Renderer's job, minus the ANSI — and with an operator stop.

    Timing is simulated: the offline mock answers instantly, so without pacing a
    nine-round run would be one blob. Each pause doubles as a stop check, which
    is why stopping lands on a round boundary instead of mid-transaction.
    """

    def __init__(self, run: Run, recorder, store, task_id: str) -> None:
        self.run = run
        self.recorder = recorder
        self.store = store
        self.task_id = task_id
        self.pace = run.pace

    # ---------------------------------------------------------------- plumbing

    def _pace(self, seconds: float) -> None:
        if seconds <= 0:
            return
        deadline = time.monotonic() + seconds
        while True:
            if self.run.stop_requested:
                raise StopRequested()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.05, remaining))

    def _enter(self, seconds: float):
        self._pace(seconds)
        if self.run.stop_requested:
            raise StopRequested()

    # ------------------------------------------------------------ observer API

    def round_start(self, round_no: int, budget, plan=None) -> None:
        self._enter(self.pace * 0.5)
        with self.run.lock:
            self.recorder.round_start(round_no, budget, plan)

    def proposal(self, round_no: int, proposal) -> None:
        self._enter(self.pace * 0.25)
        with self.run.lock:
            self.recorder.proposal(round_no, proposal)

    def gate(self, round_no: int, decision) -> None:
        with self.run.lock:
            self.recorder.gate(round_no, decision)

    def observation(self, round_no: int, observation) -> None:
        self._enter(self.pace * 0.25)
        with self.run.lock:
            self.recorder.observation(round_no, observation)

    def round_end(self, round_no: int, budget, plan=None) -> None:
        with self.run.lock:
            self.recorder.round_end(round_no, budget, plan)

    def terminal(self, task, result) -> None:
        with self.run.lock:
            self.recorder.terminal(task, result)


class RunControl:
    """Console-side control: approvals block, plan and budget commands queue.

    Exactly one thread writes the event chain: the run thread. HTTP threads only
    set a decision or enqueue a command, and the run thread commits it at the
    next legal boundary. That keeps the compare-and-swap discipline intact and
    makes "下一轮生效" a fact rather than a label.
    """

    def __init__(self, run: Run, harness, runtime: Runtime, approval_tools, timeout: float) -> None:
        self.run = run
        self.harness = harness
        self.Plan = runtime.Plan
        self.BudgetLimits = runtime.BudgetLimits
        self.RoundControl = runtime.RoundControl
        self.ToolControl = runtime.ToolControl
        self.approval_tools = set(approval_tools)
        self.timeout = max(5.0, float(timeout))
        self._lock = threading.Lock()
        self._commands: deque[dict] = deque()
        self._approval: dict | None = None
        self._decision: dict | None = None
        self._wake = threading.Event()
        self._remembered: set[str] = set()

    # ---------------------------------------------------------------- HTTP side

    def queue(self, command: dict) -> None:
        with self._lock:
            self._commands.append(command)

    def decide(self, approval_id: str, *, allow: bool, remember: bool = False) -> bool:
        with self._lock:
            if self._approval is None or self._approval.get("id") != approval_id:
                return False
            if self._decision is not None:
                return False
            self._decision = {"allow": allow, "remember": remember}
            self._wake.set()
            return True

    def pending(self) -> dict | None:
        with self._lock:
            return dict(self._approval) if self._approval else None

    def current_limits(self) -> dict:
        return self.harness.limits.to_dict()

    # ------------------------------------------------------------- runtime side

    def before_round(self, *, round_no: int, task, plan):
        with self._lock:
            commands, self._commands = list(self._commands), deque()
        for command in commands:
            if command["kind"] == "plan":
                task, plan = self._apply_plan(task, plan, round_no, command)
            elif command["kind"] == "budget":
                task = self._apply_budget(task, round_no, command)
            elif command["kind"] == "message":
                task = self._apply_message(task, round_no, command)
        return self.RoundControl(task=task, plan=plan)

    def before_tool(self, *, round_no: int, task, step: dict, decision):
        mode = self.run.approval
        tool = step["tool"]
        required = mode == "all" or (mode == "consequential" and tool in self.approval_tools)
        if not required:
            return self.ToolControl(task=task, allowed=True)
        if tool in self._remembered:
            task = self.harness.record(
                task,
                "approval_granted",
                {"round": round_no, "tool": tool, "by": "operator-rule", "scope": "run"},
            )
            return self.ToolControl(task=task, allowed=True)

        if task.status == "planned":
            task = self.harness.transition(task, "running", "execution_started", {})
        approval = {
            "id": f"apv-{round_no}-{uuid.uuid4().hex[:6]}",
            "round": round_no,
            "tool": tool,
            "arguments": step.get("arguments") or {},
            "policy": "every-step" if mode == "all" else "consequential",
            "expiresIn": int(self.timeout),
            "requestedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        task = self.harness.transition(task, "paused", "approval_requested", approval)
        with self._lock:
            self._approval = approval
            self._decision = None
            self._wake.clear()
        self._publish()

        deadline = time.monotonic() + self.timeout
        try:
            while True:
                if self.run.stop_requested:
                    with self._lock:
                        self._approval = None
                    self._publish()
                    task = self.harness.record(
                        task,
                        "approval_aborted",
                        {"round": round_no, "tool": tool, "by": "operator", "code": "STOPPED_BY_OPERATOR"},
                    )
                    task = self.harness.transition(
                        task, "running", "execution_resumed", {"round": round_no}
                    )
                    raise StopRequested()
                if self._wake.wait(0.1):
                    break
                if time.monotonic() >= deadline:
                    with self._lock:
                        self._decision = {"allow": False, "timeout": True}
                    break
        except BaseException:
            with self._lock:
                self._approval = None
            self._publish()
            if task.status == "paused":
                task = self.harness.transition(
                    task, "running", "execution_resumed", {"round": round_no, "reason": "controller interrupted"}
                )
            raise

        with self._lock:
            result = self._decision or {"allow": False, "timeout": True}
            self._approval = None
        self._publish()
        if result["allow"]:
            task = self.harness.transition(
                task,
                "running",
                "approval_granted",
                {
                    "round": round_no,
                    "tool": tool,
                    "by": "operator",
                    "remember": bool(result.get("remember")),
                },
            )
            if result.get("remember"):
                with self._lock:
                    self._remembered.add(tool)
            return self.ToolControl(task=task, allowed=True)

        code = "APPROVAL_TIMEOUT" if result.get("timeout") else "OPERATOR_DENIED"
        reason = (
            "no decision arrived before the approval deadline"
            if result.get("timeout")
            else "the operator denied this call"
        )
        task = self.harness.record(
            task,
            "approval_denied",
            {"round": round_no, "tool": tool, "by": "operator", "code": code},
        )
        return self.ToolControl(task=task, allowed=False, code=code, reason=reason)

    # ------------------------------------------------------------------ private

    def _publish(self) -> None:
        pending = self.pending()
        with self.run.lock:
            self.run.pending = pending
            self.run.bump()

    def _reject(self, task, round_no: int, kind: str, reason: str):
        return self.harness.record(
            task,
            "control_rejected",
            {"round": round_no, "kind": kind, "reason": reason[:200], "by": "operator"},
        )

    def _apply_plan(self, task, plan, round_no: int, command: dict):
        action = command.get("action")
        todo_id = command.get("todo_id")
        note = str(command.get("note") or "")[:200]
        try:
            if action == "skip":
                marked = plan.mark(todo_id, "abandoned", reason=note or "operator skipped this step")
                updated = self.Plan(goal=marked.goal, todos=marked.todos, revision=plan.revision + 1)
            elif action == "promote":
                todos = list(plan.todos)
                index = next((i for i, todo in enumerate(todos) if todo.id == todo_id), None)
                if index is None:
                    raise ValueError(f"no todo {todo_id!r}")
                target = todos.pop(index)
                if target.status not in ("pending", "active"):
                    raise ValueError(f"todo {todo_id!r} is {target.status}")
                insert = next(
                    (i for i, todo in enumerate(todos) if todo.status in ("pending", "active")),
                    len(todos),
                )
                updated = self.Plan(
                    goal=plan.goal,
                    todos=todos[:insert] + [target] + todos[insert:],
                    revision=plan.revision + 1,
                )
            else:
                raise ValueError(f"unknown plan action {action!r}")
        except Exception as exc:  # noqa: BLE001 — a stale command must not kill the run
            return self._reject(task, round_no, "plan", str(exc)), plan
        task.plan_state = updated.to_dict()
        task = self.harness.record(
            task,
            "plan_steered",
            {
                "round": round_no,
                "action": action,
                "todo_id": todo_id,
                "note": note,
                "plan": updated.to_dict(),
                "by": "operator",
            },
        )
        return task, updated

    def _apply_budget(self, task, round_no: int, command: dict):
        before = self.harness.limits
        try:
            new = self.BudgetLimits(
                max_calls=int(command["maxCalls"]),
                max_reads=int(command["maxReads"]),
                max_cost_microusd=int(command["maxCostMicrousd"]),
                max_tokens=int(command.get("maxTokens") or before.max_tokens),
            )
        except (KeyError, TypeError, ValueError) as exc:
            return self._reject(task, round_no, "budget", f"invalid limits: {exc}")
        if (
            new.max_calls < before.max_calls
            or new.max_reads < before.max_reads
            or new.max_cost_microusd < before.max_cost_microusd
            or new.max_tokens < before.max_tokens
        ):
            return self._reject(task, round_no, "budget", "limits can only be raised")
        used = self.harness.budget(task).snapshot()
        if (
            used["calls_used"] > new.max_calls
            or used["reads_used"] > new.max_reads
            or used["cost_used_microusd"] > new.max_cost_microusd
        ):
            return self._reject(task, round_no, "budget", "new limits are below current usage")
        self.harness.limits = new
        return self.harness.record(
            task,
            "budget_adjusted",
            {
                "round": round_no,
                "before": before.to_dict(),
                "after": new.to_dict(),
                "by": "operator",
            },
        )

    def _apply_message(self, task, round_no: int, command: dict):
        # A mid-run operator note. The deterministic mock cannot read free
        # text, so this does not steer the planner yet — but it is committed
        # to the same hash chain as every other human decision, and a real
        # provider consumes it from the event log like any other input.
        text = str(command.get("text") or "").strip()
        if not text:
            return task
        return self.harness.record(
            task,
            "operator_message",
            {"round": round_no, "text": text[:600], "by": "operator"},
        )


class _EventsShim:
    """Satisfies TraceRecorder.build()'s only store call, from a read connection.

    The watcher must read committed rows through its own SQLite connection
    (WAL gives it a stable snapshot), not through the run's connection where a
    read could land inside an open write transaction and see torn state.
    """

    def __init__(self, events: list[dict]) -> None:
        self._events = events

    def events(self, task_id: str) -> list[dict]:
        return self._events


def _watch(run: Run, recorder, store, db: Path, task_id: str) -> None:
    """Tail the committed event chain and publish trace snapshots."""
    conn = sqlite3.connect(str(db))
    conn.row_factory = sqlite3.Row
    last_events = -1
    try:
        while True:
            time.sleep(0.12)
            with run.lock:
                if run.finished:
                    return
            try:
                rows = conn.execute(
                    "SELECT sequence, type, payload, prev_hash, hash, at FROM event"
                    " WHERE task_id=? ORDER BY sequence ASC",
                    (task_id,),
                ).fetchall()
                if len(rows) == last_events:
                    continue
                body_row = conn.execute("SELECT body FROM task WHERE id=?", (task_id,)).fetchone()
                if body_row is None:
                    continue
                body = json.loads(body_row["body"])
                events = [
                    {
                        "sequence": row["sequence"],
                        "type": row["type"],
                        "payload": json.loads(row["payload"]),
                        "prev_hash": row["prev_hash"],
                        "hash": row["hash"],
                        "at": row["at"],
                    }
                    for row in rows
                ]
                task_view = types.SimpleNamespace(
                    id=body["id"],
                    objective=body["objective"],
                    principal=body["principal"],
                    binding=body["binding"],
                    allowed_tools=body["allowed_tools"],
                    model_grant=body["model_grant"],
                    status=body["status"],
                    sequence=body["sequence"],
                    failure=body.get("failure"),
                )
                with run.lock:
                    if run.finished:
                        return
                    real_store = recorder._store  # noqa: SLF001 — swap is guarded by run.lock
                    recorder._store = _EventsShim(events)
                    try:
                        snapshot = recorder.build(task_view)
                    finally:
                        recorder._store = real_store
                    run.snapshot = snapshot
                    run.event_count = len(events)
                    run.rounds = len(snapshot["rounds"])
                    run.bump()
                last_events = len(rows)
            except sqlite3.Error:
                continue  # database being created/renamed under us; retry next tick
    finally:
        conn.close()


def _run_crash(rt: Runtime, harness, store, world, scenario, task, observer, db: Path):
    """Mirrors demo/runner.py::_run_crash, against this run's database.

    A real SIGKILL needs a real process, so the worker subprocess kills itself
    mid-run and the parent resumes from the same event log.
    """
    env = {
        **os.environ,
        "PYTHONPATH": str(rt.src),
        "FLOWAGENT_DB": str(db),
        "FLOWAGENT_TASK_ID": task.id,
        "FLOWAGENT_CRASH_AT": scenario.crash_at or "tool_succeeded",
        "FLOWAGENT_CRASH_AT_COUNT": str(scenario.crash_at_count),
        "FLOWAGENT_MAX_ROUNDS": str(scenario.max_rounds),
    }
    subprocess.run(
        [sys.executable, "-m", "flowagent.demo.crash_worker"],
        cwd=str(rt.src.parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    resumed = store.load(task.id)
    module = rt.get_domain(DOMAIN_KEY)
    memory = rt.Loop(harness, planner=module.make_planner()).restore(resumed)
    world.apply_state(memory.state())
    return rt.Loop(
        harness, planner=module.make_planner(), max_rounds=scenario.max_rounds, observer=observer
    ).run(resumed.id)


# ---------------------------------------------------------------- http surface


class Handler(SimpleHTTPRequestHandler):
    server_version = "FcodeConsole/1.1"
    manager: RunManager  # set by main()
    token: str | None = None  # set by main() in desktop mode

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=str(VIEWER_DIR), **kwargs)

    def _authorized(self) -> bool:
        """Desktop mode: cookie or bearer token. Browser dev mode: open."""
        if not self.token:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer ") and secrets.compare_digest(header[7:], self.token):
            return True
        for part in (self.headers.get("Cookie") or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == "fcode_token" and secrets.compare_digest(value, self.token):
                return True
        return False

    def _reject_unauthorized(self, path: str) -> None:
        if path.startswith("/api/"):
            self._json({"error": "unauthorized"}, 401)
        else:
            self.send_error(403)

    def log_message(self, fmt: str, *args) -> None:
        if "/api/" in (self.path or "") and self.command == "GET" and self.path.endswith("/stream"):
            return
        sys.stderr.write(f"[console] {self.address_string()} {fmt % args}\n")

    # ------------------------------------------------------------------- utils

    def end_headers(self) -> None:  # noqa: N802
        # Static assets change under the operator's feet; never let the browser cache them.
        if (self.path or "").split("?")[0].endswith((".html", ".css", ".js")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, payload: dict | list, code: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _sse(self, event: str, payload: dict) -> bool:
        try:
            data = json.dumps(payload, ensure_ascii=False)
            self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode("utf-8"))
            self.wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    # -------------------------------------------------------------------- GET

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        supplied = parse_qs(parsed.query).get("token", [None])[0]
        if self.token and supplied is not None:
            if not secrets.compare_digest(supplied, self.token):
                return self.send_error(403)
            # Bootstrap: set an HttpOnly cookie, then strip the token from the URL.
            self.send_response(302)
            self.send_header("Location", path or "/")
            self.send_header("Set-Cookie", f"fcode_token={self.token}; Path=/; HttpOnly; SameSite=Strict")
            self.end_headers()
            return
        if not self._authorized():
            return self._reject_unauthorized(path)
        if path.startswith("/api/"):
            return self._api_get(path)
        if path.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm")):
            self.send_error(404)
            return
        return super().do_GET()

    def _api_get(self, path: str) -> None:
        mgr = self.manager
        if path == "/api/health":
            live = mgr.runtime is not None
            return self._json(
                {
                    "ok": True,
                    "live": live,
                    "repo": str(mgr.runtime.repo) if live else "",
                    "runtimeError": mgr.runtime_error,
                    "pace": mgr.pace,
                    "templates": len(mgr.runtime.templates()) if live else 0,
                    "domain": (
                        {"key": DOMAIN_KEY, "title": mgr.runtime.get_domain(DOMAIN_KEY).title}
                        if live else None
                    ),
                }
            )
        if path == "/api/templates":
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            return self._json(mgr.runtime.templates())
        if path == "/api/modules":
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            return self._json({"modules": mgr.runtime.modules()})
        if path == "/api/tools":
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            return self._json({"tools": mgr.runtime.tool_contracts()})
        if path == "/api/runs":
            return self._json(mgr.list_runs())
        if path.startswith("/api/runs/"):
            rest = path[len("/api/runs/") :]
            run_id, _, action = rest.partition("/")
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            if action == "stream":
                return self._stream(run)
            if action == "":
                return self._json(run.to_json(detail=True))
            return self._json({"error": "unknown action"}, 404)
        return self._json({"error": "unknown endpoint"}, 404)

    def _stream(self, run: Run) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        if not self._sse("hello", {"runId": run.id, "status": run.status}):
            return
        last = -1
        # Incremental protocol: the first frame carries the whole trace, every
        # later frame carries only what changed. The watcher rebuilds the full
        # snapshot each tick, so the delta is computed here by slicing: events
        # are append-only, and at most the last previously-sent round can still
        # mutate (round_start -> proposal -> observation), so it is resent.
        sent_events = 0
        sent_rounds = 0
        sent_round_tail = None
        sent_full = False
        while True:
            with run.cond:
                run.cond.wait_for(lambda: run.version > last or run.finished, timeout=10)
                version = run.version
                snapshot = run.snapshot
                finished = run.finished
                status = run.status
                trace_path = run.trace_path
                error = run.error
                pending = run.pending
                approval = run.approval
            if version > last and snapshot is not None:
                last = version
                if not sent_full:
                    sent_full = True
                    events = snapshot.get("events") or []
                    rounds = snapshot.get("rounds") or []
                    sent_events = len(events)
                    sent_rounds = len(rounds)
                    ok = self._sse(
                        "snapshot",
                        {
                            "version": version,
                            "status": status,
                            "finished": finished,
                            "tracePath": trace_path,
                            "error": error,
                            "snapshot": snapshot,
                            "pending": pending,
                            "approval": approval,
                        },
                    )
                else:
                    events = snapshot.get("events") or []
                    rounds = snapshot.get("rounds") or []
                    round_start = sent_rounds
                    if sent_rounds and (len(rounds) < sent_rounds or rounds[sent_rounds - 1] != sent_round_tail):
                        round_start = sent_rounds - 1
                    round_start = max(0, round_start)
                    delta = {
                        "version": version,
                        "status": status,
                        "finished": finished,
                        "tracePath": trace_path,
                        "error": error,
                        "pending": pending,
                        "approval": approval,
                        "roundStart": round_start,
                        "rounds": rounds[round_start:],
                        "events": events[sent_events:],
                        "terminal": snapshot.get("terminal"),
                        "chain": snapshot.get("chain"),
                        "task": snapshot.get("task"),
                        "model": snapshot.get("model"),
                    }
                    sent_events = len(events)
                    sent_rounds = len(rounds)
                    sent_round_tail = rounds[-1] if rounds else None
                    ok = self._sse("append", delta)
                if not ok:
                    return
            elif finished:
                if snapshot is None:
                    self._sse("failed", {"status": status, "error": error})
                    return
            if finished and version == last and snapshot is not None:
                self._sse("done", {"status": status, "tracePath": trace_path, "error": error})
                return
            if version == last:
                try:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return

    # ------------------------------------------------------------------- POST

    def do_POST(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not path.startswith("/api/"):
            return self.send_error(404)
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 401)
        mgr = self.manager
        if path == "/api/runs":
            if mgr.runtime is None:
                return self._json({"error": f"live mode unavailable: {mgr.runtime_error}"}, 503)
            body = self._read_body()
            template = str(body.get("template") or "full")
            objective = str(body.get("objective") or "").strip()
            try:
                scenario = mgr.runtime.get_scenario(template)
            except Exception:
                return self._json({"error": f"unknown template {template!r}"}, 400)
            if not objective:
                objective = scenario.objective
            if len(objective) > 600:
                return self._json({"error": "objective too long"}, 400)
            approval = str(body.get("approval") or "consequential")
            if approval not in ("off", "consequential", "all"):
                return self._json({"error": "approval must be off, consequential or all"}, 400)
            run = mgr.create(objective, template, approval)
            return self._json(run.to_json(detail=True), 202)
        if path.startswith("/api/runs/") and path.endswith("/stop"):
            run_id = path[len("/api/runs/") : -len("/stop")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            run.stop_requested = True
            return self._json({"stop": True, "id": run.id})
        if path.startswith("/api/runs/") and path.endswith("/decision"):
            run_id = path[len("/api/runs/") : -len("/decision")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            body = self._read_body()
            control = getattr(run, "controller", None)
            if control is None:
                return self._json({"error": "run is not waiting for a decision"}, 409)
            if not control.decide(
                str(body.get("approvalId") or ""),
                allow=bool(body.get("allow")),
                remember=bool(body.get("remember")),
            ):
                return self._json({"error": "no pending approval with that id"}, 409)
            return self._json({"ok": True})
        if path.startswith("/api/runs/") and path.endswith("/messages"):
            run_id = path[len("/api/runs/") : -len("/messages")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            if run.finished:
                return self._json({"error": "run has finished"}, 409)
            control = getattr(run, "controller", None)
            if control is None:
                return self._json({"error": "run has no live control"}, 409)
            body = self._read_body()
            text = str(body.get("text") or "").strip()
            if not text:
                return self._json({"error": "text is required"}, 400)
            if len(text) > 600:
                return self._json({"error": "message too long"}, 400)
            control.queue({"kind": "message", "text": text})
            return self._json({"queued": True, "id": run.id}, 202)
        if path.startswith("/api/runs/") and path.endswith("/plan"):
            run_id = path[len("/api/runs/") : -len("/plan")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            if run.finished:
                return self._json({"error": "run has finished"}, 409)
            control = getattr(run, "controller", None)
            if control is None:
                return self._json({"error": "run has no live control"}, 409)
            body = self._read_body()
            action = str(body.get("action") or "")
            todo_id = str(body.get("todoId") or "")
            if action not in ("skip", "promote") or not todo_id:
                return self._json({"error": "action must be skip or promote, with a todoId"}, 400)
            control.queue(
                {
                    "kind": "plan",
                    "action": action,
                    "todo_id": todo_id,
                    "note": str(body.get("note") or "")[:200],
                }
            )
            return self._json({"queued": True, "applies": "next-round"})
        if path.startswith("/api/runs/") and path.endswith("/budget"):
            run_id = path[len("/api/runs/") : -len("/budget")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            if run.finished:
                return self._json({"error": "run has finished"}, 409)
            control = getattr(run, "controller", None)
            if control is None:
                return self._json({"error": "run has no live control"}, 409)
            body = self._read_body()
            try:
                max_calls = int(body["maxCalls"])
                max_reads = int(body["maxReads"])
                max_cost = int(body["maxCostMicrousd"])
            except (KeyError, TypeError, ValueError):
                return self._json({"error": "maxCalls, maxReads and maxCostMicrousd are required integers"}, 400)
            current = control.current_limits()
            if (
                max_calls < current["max_calls"]
                or max_reads < current["max_reads"]
                or max_cost < current["max_cost_microusd"]
            ):
                return self._json({"error": "limits can only be raised"}, 400)
            control.queue(
                {
                    "kind": "budget",
                    "maxCalls": max_calls,
                    "maxReads": max_reads,
                    "maxCostMicrousd": max_cost,
                }
            )
            return self._json({"queued": True, "applies": "next-round"})
        if path.startswith("/api/runs/") and path.endswith("/resume"):
            run_id = path[len("/api/runs/") : -len("/resume")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            body = self._read_body()
            try:
                max_calls = int(body["maxCalls"])
                max_reads = int(body["maxReads"])
                max_cost = int(body["maxCostMicrousd"])
                extra_rounds = int(body.get("extraRounds") or 6)
            except (KeyError, TypeError, ValueError):
                return self._json({"error": "maxCalls, maxReads and maxCostMicrousd are required integers"}, 400)
            if min(max_calls, max_reads, max_cost) < 1 or not 0 <= extra_rounds <= 50:
                return self._json({"error": "limits must be positive and extraRounds between 0 and 50"}, 400)
            try:
                mgr.resume(
                    run,
                    limits={"maxCalls": max_calls, "maxReads": max_reads, "maxCostMicrousd": max_cost},
                    extra_rounds=extra_rounds,
                )
            except ValueError as exc:
                return self._json({"error": str(exc)}, 409)
            return self._json(run.to_json(detail=True), 202)
        if path.startswith("/api/runs/") and path.endswith("/meta"):
            run_id = path[len("/api/runs/") : -len("/meta")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            body = self._read_body()
            if "name" in body:
                run.name = str(body.get("name") or "").strip()[:60]
            if "pinned" in body:
                run.pinned = bool(body.get("pinned"))
            mgr._write_meta(run)
            return self._json(run.to_json())
        return self._json({"error": "unknown endpoint"}, 404)

    def do_DELETE(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not path.startswith("/api/runs/") or path.count("/") != 3:
            return self.send_error(404)
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 401)
        mgr = self.manager
        if mgr.runtime is None:
            return self._json({"error": "live mode unavailable"}, 503)
        run_id = path[len("/api/runs/") :]
        ok, reason = mgr.delete(run_id)
        if not ok:
            return self._json({"error": reason}, 404 if reason == "no such run" else 409)
        return self._json({"deleted": True, "id": run_id})


# ------------------------------------------------------------------------ main


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="console-server", description="Fcode console — static viewer + live runtime API."
    )
    parser.add_argument(
        "--repo",
        default=os.environ.get("FLOWAGENT_REPO", ""),
        help="path to the FCode checkout (or set FLOWAGENT_REPO)",
    )
    parser.add_argument("--port", type=int, default=8642)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--pace", type=float, default=0.8, help="simulated thinking seconds per round (0 = as fast as possible)"
    )
    parser.add_argument(
        "--approval-timeout",
        type=float,
        default=300.0,
        help="seconds a paused approval waits for a human before denying (default 300)",
    )
    parser.add_argument(
        "--token",
        default="",
        help="require this token (cookie bootstrap via /?token=…); desktop mode uses it",
    )
    args = parser.parse_args(argv)

    runtime: Runtime | None = None
    runtime_error = ""
    if args.repo:
        try:
            runtime = Runtime(Path(args.repo).expanduser())
        except Exception as exc:  # noqa: BLE001
            runtime_error = f"{type(exc).__name__}: {exc}"
    else:
        runtime_error = "no --repo given; set it to the FCode checkout to enable live runs"

    manager = RunManager(runtime, runtime_error, args.pace, args.approval_timeout)
    Handler.manager = manager
    Handler.token = args.token or None
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"[console] serving {VIEWER_DIR} on http://{args.host}:{args.port}")
    if runtime is not None:
        print(
            f"[console] live mode on — runtime from {runtime.src} "
            f"(pace {args.pace}s/round, approval timeout {args.approval_timeout:.0f}s)"
        )
    else:
        print(f"[console] live mode OFF — {runtime_error}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[console] bye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
