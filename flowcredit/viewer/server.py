#!/usr/bin/env python3
"""Fcode console — live server for the flowcredit runtime.

Serves the static viewer plus a small JSON + SSE API that drives the *real*
flowcredit runtime (the flowagent package) from a checkout, so the console is
not only a replay player:
a task typed into the composer actually runs, round by round, and committed
events stream into the page while the run is still in flight.

    python3 server.py --repo /path/to/FCode [--port 8642] [--pace 0.8]

Endpoints
    GET  /api/health              what the server can and cannot do
    GET  /api/templates           scenario templates the composer may run
    GET  /api/runs                run history (survives restarts, runs/*/meta.json)
    POST /api/runs                {"objective": "...", "template": "full"} -> {"id": "run-..."}
    GET  /api/runs/{id}/stream    server-sent events: trace snapshots as they grow
    POST /api/runs/{id}/stop      stop at the next round boundary
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
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import types
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

__all__ = ["main"]

VIEWER_DIR = Path(__file__).resolve().parent
RUNS_DIR = VIEWER_DIR / "runs"

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
        m = imp("flowagent.demo.fixtures")
        self.SCENARIOS = m.SCENARIOS
        self.AVAILABLE = m.AVAILABLE
        self.get_scenario = m.get_scenario
        m = imp("flowagent.providers.mock")
        self.MockProvider = m.MockProvider
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
        }
        if detail:
            out["error"] = self.error
        return out


class RunManager:
    def __init__(self, runtime: Runtime | None, runtime_error: str, pace: float) -> None:
        self.runtime = runtime
        self.runtime_error = runtime_error
        self.pace = pace
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

    def create(self, objective: str, template: str) -> Run:
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
            )
            self.runs[run_id] = run
            self.order.insert(0, run_id)
        (RUNS_DIR / run.id).mkdir(parents=True, exist_ok=True)
        self._write_meta(run)
        thread = threading.Thread(target=self._run_thread, args=(run,), name=f"run:{run.id}", daemon=True)
        thread.start()
        return run

    # ------------------------------------------------------------- run driver

    def _run_thread(self, run: Run) -> None:
        rt = self.runtime
        assert rt is not None
        store = None
        watcher = None
        try:
            scenario = rt.get_scenario(run.template)
            run_dir = RUNS_DIR / run.id
            db = run_dir / "task.sqlite"
            store = rt.TaskStore(db)
            world = rt.FinanceWorld(partial=scenario.partial_corpus)
            registry = rt.ToolRegistry(rt.build_finance_tools(world))
            receipts = rt.ReceiptStore(store)
            issued: dict[str, str] = {}

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
                limits=scenario.limits,
                receipts=receipts,
            )
            recorder = rt.TraceRecorder(
                store, provider_name=provider.name, model_name=provider.model
            )
            task = harness.create(
                task_id=f"task-{run.id}",
                objective=run.objective,
                principal="console-operator",
                binding={"scenario": scenario.key, "corpus": "synthetic-authored-v1", "source": "viewer-live"},
                allowed_tools=list(scenario.allowed_tools),
                grant=scenario.grant,
            )
            run.task_id = task.id
            observer = LiveObserver(run, recorder, store, task.id)
            watcher = threading.Thread(
                target=_watch, args=(run, recorder, store, db, task.id), name=f"watch:{run.id}", daemon=True
            )
            watcher.start()

            try:
                if scenario.crash_at:
                    task = _run_crash(rt, harness, store, world, scenario, task, observer, db)
                else:
                    task = rt.Loop(
                        harness, planner=rt.FinancePlanner(), max_rounds=scenario.max_rounds, observer=observer
                    ).run(task.id)

                if scenario.reconcile and task.status == "recovery_required":
                    # Mirrors demo/runner.py: an unknown model result is never
                    # retried; it waits for an explicit, signed reconciliation.
                    try:
                        harness.reconcile(task, "0" * 64)
                    except rt.AgentError:
                        pass
                    task = harness.reconcile(task, issued.get("ref", ""))
                    task = rt.Loop(
                        harness, planner=rt.FinancePlanner(), max_rounds=scenario.max_rounds, observer=observer
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
    memory = rt.Loop(harness, planner=rt.FinancePlanner()).restore(resumed)
    world.apply_state(memory.state())
    return rt.Loop(
        harness, planner=rt.FinancePlanner(), max_rounds=scenario.max_rounds, observer=observer
    ).run(resumed.id)


# ---------------------------------------------------------------- http surface


class Handler(SimpleHTTPRequestHandler):
    server_version = "FcodeConsole/1.1"
    manager: RunManager  # set by main()

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, directory=str(VIEWER_DIR), **kwargs)

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
        path = unquote(urlparse(self.path).path)
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
                }
            )
        if path == "/api/templates":
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            return self._json(mgr.runtime.templates())
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
        while True:
            with run.cond:
                run.cond.wait_for(lambda: run.version > last or run.finished, timeout=10)
                version = run.version
                snapshot = run.snapshot
                finished = run.finished
                status = run.status
                trace_path = run.trace_path
                error = run.error
            if version > last and snapshot is not None:
                last = version
                if not self._sse(
                    "snapshot",
                    {
                        "version": version,
                        "status": status,
                        "finished": finished,
                        "tracePath": trace_path,
                        "error": error,
                        "snapshot": snapshot,
                    },
                ):
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
            run = mgr.create(objective, template)
            return self._json(run.to_json(detail=True), 202)
        if path.startswith("/api/runs/") and path.endswith("/stop"):
            run_id = path[len("/api/runs/") : -len("/stop")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            run.stop_requested = True
            return self._json({"stop": True, "id": run.id})
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

    manager = RunManager(runtime, runtime_error, args.pace)
    Handler.manager = manager
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    print(f"[console] serving {VIEWER_DIR} on http://{args.host}:{args.port}")
    if runtime is not None:
        print(f"[console] live mode on — runtime from {runtime.src} (pace {args.pace}s/round)")
    else:
        print(f"[console] live mode OFF — {runtime_error}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[console] bye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
