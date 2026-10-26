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
    GET  /api/review-profile      past review decisions projected from exported traces
    POST /api/runs                {"objective": "...", "template": "full", "approval": "consequential"}
    GET  /api/runs/{id}/stream    server-sent events: trace snapshots as they grow
    POST /api/runs/{id}/stop      stop at the next round boundary
    POST /api/runs/{id}/decision  {"approvalId": "...", "allow": true, "remember": false}
    POST /api/runs/{id}/plan      {"action": "skip"|"promote", "todoId": "t4"}
    POST /api/runs/{id}/budget    raise limits; applies at the next round
    POST /api/runs/{id}/resume    add budget and continue a failed run
    POST /api/runs/{id}/review    append a human decision to a terminal run's chain
    POST /api/runs/{id}/meta      {"name": "...", "pinned": true} -> updated record

Standard library only, the same constraint as the rest of this viewer. The
runtime itself is imported from the checkout given with ``--repo``; if that is
missing the static viewer still works and /api/health says why live mode is off.

This file is the HTTP surface. Configuration and the model catalog live in
``console_common``, runtime execution in ``console_runtime``, and run history
in ``console_manager``.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socketserver
import sys
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urlparse

VIEWER_DIR = Path(__file__).resolve().parent
if str(VIEWER_DIR) not in sys.path:
    sys.path.insert(0, str(VIEWER_DIR))

from console_common import (  # noqa: E402
    DOMAIN_KEY,
    MAX_REQUEST_BODY,
    RUNS_DIR,
    forbidden_static_path,
    migrate_legacy_chat_config,
    run_trace_path,
)
from console_manager import RunManager as _RunManager  # noqa: E402

class RunManager(_RunManager):
    """Bind the manager to this module's RUNS_DIR (tests patch it)."""

    def __init__(self, *args, **kwargs) -> None:
        kwargs.setdefault("runs_dir", RUNS_DIR)
        super().__init__(*args, **kwargs)
from console_runtime import Run, Runtime  # noqa: E402

__all__ = ["main"]

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
        if length > MAX_REQUEST_BODY:
            # Drain a bounded amount so the client gets a clean 413 instead of
            # a reset connection, then let the caller reject the request.
            self.rfile.read(min(length, 65_536))
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _same_origin(self) -> bool:
        """Refuse browser cross-site writes; non-browser clients have no Origin."""
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if site and site not in ("same-origin", "none"):
            return False
        origin = (self.headers.get("Origin") or "").strip()
        if not origin:
            return True
        parsed = urlparse(origin)
        host = (self.headers.get("Host") or "").strip().lower()
        return bool(host) and parsed.netloc.lower() == host

    def _mutation_guard(self) -> bool:
        """Return False and write the error response when a write is refused."""
        if not self._same_origin():
            self._json({"error": "cross-origin request refused"}, 403)
            return False
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_REQUEST_BODY:
            # Drain a bounded prefix so the client can read the 413 instead of
            # hitting a broken pipe; anything beyond 8 MiB is not worth reading.
            try:
                self.rfile.read(min(length, 8_388_608))
            except OSError:
                pass
            self._json({"error": "request body too large"}, 413)
            self.close_connection = True
            return False
        if length > 0:
            content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if content_type != "application/json":
                self._json({"error": "content-type must be application/json"}, 415)
                return False
        return True

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
            # Bootstrap: set an HttpOnly cookie, then strip only the token from
            # the URL. Other parameters (desktop=1, template=...) survive.
            params = parse_qs(parsed.query, keep_blank_values=True)
            params.pop("token", None)
            location = path or "/"
            if params:
                location += "?" + urlencode(params, doseq=True)
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Set-Cookie", f"fcode_token={self.token}; Path=/; HttpOnly; SameSite=Strict")
            self.end_headers()
            return
        if not self._authorized():
            return self._reject_unauthorized(path)
        if path.startswith("/api/"):
            return self._api_get(path)
        if forbidden_static_path(path):
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
        if path == "/api/memory":
            return self._json(mgr.memory_summary())
        if path == "/api/templates":
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            return self._json(mgr.runtime.templates())
        if path == "/api/models":
            query = parse_qs(urlparse(self.path).query)
            template_key = (query.get("template") or [""])[0].strip()
            return self._json({
                "default": "mock",
                "template": template_key or None,
                "models": mgr.model_catalog_with_budget(template_key or None),
            })
        if path == "/api/chat/threads":
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            query = parse_qs(urlparse(self.path).query)
            try:
                limit = int((query.get("limit") or ["50"])[0])
                offset = int((query.get("offset") or ["0"])[0])
            except (TypeError, ValueError):
                return self._json({"error": "limit and offset must be integers"}, 400)
            if not 1 <= limit <= 200 or offset < 0:
                return self._json({"error": "limit must be 1..200 and offset >= 0"}, 400)
            return self._json({
                "threads": mgr.chat.list_threads(limit, offset),
                "total": mgr.chat.thread_count(),
                "limit": limit,
                "offset": offset,
            })
        if path == "/api/chat/models":
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            return self._json({
                "models": mgr.chat.chat_models(),
                "default": mgr.chat.default_model(),
            })
        if path == "/api/settings/chat-config":
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            return self._json(mgr.chat.config_snapshot())
        if path.startswith("/api/chat/threads/"):
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            thread_id = path[len("/api/chat/threads/") :]
            if not thread_id or "/" in thread_id:
                return self._json({"error": "no such thread"}, 404)
            try:
                thread = mgr.chat.get_thread(thread_id)
            except Exception as error:  # noqa: BLE001 — a missing thread is a 404
                code = getattr(error, "code", "")
                status = 404 if code in ("CHAT_THREAD_NOT_FOUND", "TASK_NOT_FOUND") else 400
                return self._json({"error": str(error), "code": code}, status)
            return self._json(thread)
        if path == "/api/corpus":
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            query = parse_qs(urlparse(self.path).query)
            template_key = (query.get("template") or [""])[0].strip()
            try:
                documents = mgr.runtime.corpus(template_key or None)
            except Exception:  # noqa: BLE001 — unknown template is a 400, not a crash
                return self._json({"error": "unknown template"}, 400)
            return self._json({"documents": documents, "default": "full"})
        if path.startswith("/api/templates/") and path.endswith("/tools"):
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            template_key = path[len("/api/templates/") : -len("/tools")]
            try:
                tools = mgr.runtime.template_tools(template_key)
            except Exception:  # noqa: BLE001
                return self._json({"error": f"unknown template {template_key!r}"}, 400)
            return self._json({"template": template_key, "tools": tools})
        if path == "/api/modules":
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            return self._json({"modules": mgr.runtime.modules()})
        if path == "/api/mcp":
            bridge = mgr.mcp.get("bridge")
            return self._json({
                "ready": mgr.mcp.get("ready", False),
                "servers": mgr.mcp_tools(),
                "approvalTools": list(bridge.approval_names()) if bridge else [],
            })
        if path == "/api/tools":
            if mgr.runtime is None:
                return self._json({"error": mgr.runtime_error}, 503)
            return self._json({"tools": mgr.runtime.tool_contracts()})
        if path == "/api/runs":
            return self._json(mgr.list_runs())
        if path == "/api/review-profile":
            query = parse_qs(urlparse(self.path).query)

            def param(name: str) -> str:
                values = query.get(name) or [""]
                return str(values[0] or "").strip()

            return self._json(
                mgr.review_profile(
                    module=param("module"),
                    template=param("template"),
                    outcome=param("outcome"),
                )
            )
        if path.startswith("/api/runs/"):
            rest = path[len("/api/runs/") :]
            run_id, _, action = rest.partition("/")
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            if action == "stream":
                return self._stream(run)
            if action == "trace":
                return self._run_trace(run)
            if action == "":
                return self._json(run.to_json(detail=True))
            if action == "queue":
                control = getattr(run, "controller", None)
                queue = control.queue_snapshot() if control is not None else (run.queue or [])
                return self._json({"id": run.id, "queue": queue})
            if action == "workspace" or action.startswith("workspace/"):
                # Read-only views of the run's sandbox, jail-checked by the
                # same WorkspaceSandbox the tools use — never raw paths.
                if mgr.runtime is None:
                    return self._json({"error": mgr.runtime_error}, 503)
                sandbox = mgr.runtime.WorkspaceSandbox(RUNS_DIR / run.id / "workspace")
                target = action[len("workspace"):].lstrip("/")
                if not target:
                    if not sandbox.root.exists():
                        return self._json({"entries": [], "count": 0})
                    return self._json({"entries": sandbox.ls(), "count": len(sandbox.ls())})
                try:
                    record = sandbox.read(target)
                except Exception as error:  # noqa: BLE001 — jail refusals are 404/400, not crashes
                    code = getattr(error, "code", "")
                    status = 400 if code == "SANDBOX_PATH_DENIED" else 404
                    return self._json({"error": code or str(error)}, status)
                return self._json(record)
            return self._json({"error": "unknown action"}, 404)
        return self._json({"error": "unknown endpoint"}, 404)

    def _run_trace(self, run: Run) -> None:
        """One run's trace, read out of the manager's runs directory.

        ``runs/<id>/trace.json`` is only reachable as a *static* path when the
        runs directory happens to sit inside the viewer checkout (the
        development default). The desktop bundle keeps runs in Application
        Support, where the static handler cannot see them, so a finished run
        opened after a restart used to answer 404. Serving it here gives both
        deployments one code path, and the jail check in ``run_trace_path``
        keeps the read inside the run's own directory.
        """
        path = run_trace_path(self.manager.runs_dir, run.id)
        if path is None:
            return self._json({"error": "refused: trace path is outside the runs directory"}, 400)
        if not path.is_file():
            return self._json({"error": "this run has no trace on disk yet"}, 404)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            return self._json({"error": f"trace is unreadable: {error}"}, 500)
        return self._json(payload)

    def _stream(self, run: Run) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        if not self._sse("hello", {"runId": run.id, "status": run.status, "queue": run.queue or []}):
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
                queue = run.queue
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
                            "queue": queue or [],
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
                        "queue": queue or [],
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

    def _stream_chat(self, events) -> None:
        """Relay a ChatService event generator as SSE.

        A client disconnect makes ``_sse`` return False; closing the generator
        lets the service record the cancelled turn in the event chain.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            for event in events:
                kind = str(event.get("type") or "message")
                if not self._sse(kind, event):
                    break
        except Exception as error:  # noqa: BLE001 — surface config/provider failures in-band
            self._sse("error", {
                "code": getattr(error, "code", "CHAT_FAILED"),
                "message": str(error),
            })
        finally:
            close = getattr(events, "close", None)
            if close is not None:
                try:
                    close()
                except Exception:  # noqa: BLE001 — the response is already over
                    pass

    # ------------------------------------------------------------------- POST

    def do_POST(self) -> None:  # noqa: N802
        path = unquote(urlparse(self.path).path)
        if not path.startswith("/api/"):
            return self.send_error(404)
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 401)
        if not self._mutation_guard():
            return
        mgr = self.manager
        if path == "/api/intake":
            if mgr.runtime is None:
                return self._json({"error": f"live mode unavailable: {mgr.runtime_error}"}, 503)
            body = self._read_body()
            message = str(body.get("message") or "")[:2000]
            spec = body.get("spec") if isinstance(body.get("spec"), dict) else {}
            choice = body.get("choice") if isinstance(body.get("choice"), dict) else None
            history = body.get("history") if isinstance(body.get("history"), list) else []
            if len(json.dumps(spec, ensure_ascii=False).encode("utf-8")) > 4096:
                return self._json({"error": "spec is too large"}, 400)
            try:
                turn = mgr.runtime.clarify(
                    message=message,
                    history=history[-20:],
                    spec=spec,
                    choice=choice,
                    template=str(body.get("template") or ""),
                )
            except Exception as error:  # noqa: BLE001
                return self._json({"error": f"intake failed: {error}"}, 400)
            return self._json(turn)
        if path == "/api/settings/chat-config":
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            body = self._read_body()
            provider = body.get("provider")
            if provider is not None and not isinstance(provider, str):
                return self._json({"error": "provider must be a string"}, 400)
            default_model = body.get("default_model")
            if default_model is not None and not isinstance(default_model, str):
                return self._json({"error": "default_model must be a string"}, 400)
            values = body.get("values")
            if values is not None and not isinstance(values, dict):
                return self._json({"error": "values must be an object"}, 400)
            if len(json.dumps(body, ensure_ascii=False).encode("utf-8")) > 8192:
                return self._json({"error": "config payload is too large"}, 400)
            try:
                snapshot = mgr.chat.update_config(
                    provider=provider,
                    values=values,
                    default_model=default_model,
                )
            except Exception as error:  # noqa: BLE001 — validation errors are 400s
                return self._json(
                    {"error": str(error), "code": getattr(error, "code", "CHAT_CONFIG_INVALID")},
                    400,
                )
            return self._json(snapshot)
        if path == "/api/chat/send":
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            body = self._read_body()
            text = body.get("text")
            if not isinstance(text, str):
                return self._json({"error": "text must be a string"}, 400)
            thread_id = body.get("threadId")
            if thread_id is not None and not isinstance(thread_id, str):
                return self._json({"error": "threadId must be a string"}, 400)
            model = body.get("model") if isinstance(body.get("model"), str) else None
            try:
                mgr.chat.check_model(model)
            except Exception as error:  # noqa: BLE001 — fail closed with the exact missing config
                return self._json(
                    {"error": str(error), "code": getattr(error, "code", "CHAT_PROVIDER_UNAVAILABLE")},
                    400,
                )
            events = mgr.chat.send(
                thread_id=thread_id,
                text=text,
                attachments=body.get("attachments"),
                model=model,
            )
            return self._stream_chat(events)
        if path.startswith("/api/chat/threads/") and path.endswith("/confirm"):
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            if mgr.runtime is None:
                return self._json({"error": f"live mode unavailable: {mgr.runtime_error}"}, 503)
            thread_id = path[len("/api/chat/threads/") : -len("/confirm")]
            body = self._read_body()
            message_id = str(body.get("messageId") or "").strip()
            if not message_id:
                return self._json({"error": "messageId is required"}, 400)
            try:
                thread = mgr.chat.get_thread(thread_id)
            except Exception as error:  # noqa: BLE001 — no such thread is a 404, not a 500
                return self._json({"error": str(error)}, 404)
            message = next(
                (item for item in thread["messages"] if item["id"] == message_id), None
            )
            if message is None:
                return self._json({"error": "no such message"}, 404)
            action = message.get("action") or {}
            if not action:
                return self._json({"error": "this message carries no execution proposal"}, 400)
            if message.get("run"):
                return self._json(
                    {"error": "proposal already started", "runId": (message["run"] or {}).get("id")},
                    409,
                )
            # The card may be edited before confirming; the edits pass the
            # parser's own fail-closed checks (chat.merge_action).
            try:
                action = mgr.merge_chat_action(
                    action,
                    goal=body.get("goal") if isinstance(body.get("goal"), str) else None,
                    mode=body.get("mode") if isinstance(body.get("mode"), str) else None,
                    sources=body.get("sources") if isinstance(body.get("sources"), list) else None,
                )
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            # 与「转为委托」的同一创建路径：模板、spec 校验、审批档位都走原逻辑
            template = "general-research"
            try:
                scenario = mgr.runtime.get_scenario(template)
            except Exception:
                return self._json({"error": f"unknown template {template!r}"}, 400)
            spec = {
                "version": "fcode.intake/v1",
                "task": template,
                "mode": str(action.get("mode") or "script"),
                "source": "chat-action",
                "origin_thread": {
                    "threadId": thread_id,
                    "threadTitle": thread.get("title", ""),
                    # The tail of the conversation, same rule as
                    # validate_delegation_spec: recency wins, size is bounded.
                    "messages": [
                        {"role": item["role"], "text": str(item["text"])[:600]}
                        for item in thread["messages"]
                        if item.get("role") in ("user", "assistant")
                        and item.get("text") and item.get("status") != "error"
                    ][-24:],
                },
            }
            if action.get("sources"):
                spec["sources"] = list(action["sources"])

            approval = str(body.get("approval") or "consequential")
            if approval not in ("off", "consequential", "all"):
                return self._json({"error": "approval must be off, consequential or all"}, 400)
            try:
                mgr.validate_delegation_spec(spec, scenario)
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            model_field = body.get("model")
            effort_field = body.get("effort")
            try:
                model_key, effort = mgr.resolve_model(
                    model_field if isinstance(model_field, str) else None,
                    effort_field if isinstance(effort_field, str) else None,
                )
            except ValueError as exc:
                return self._json({"error": str(exc)}, 400)
            objective = str(action["goal"]).strip()[:600]
            run = mgr.create(objective, template, approval, spec, model_key=model_key, effort=effort)
            try:
                mgr.chat.link_run(
                    thread_id, message_id, run.id, goal=objective, mode=str(action["mode"])
                )
            except Exception as error:  # noqa: BLE001 — the run exists; the anchor failure is reported, not hidden
                return self._json({"error": f"run {run.id} started but the thread anchor failed: {error}"}, 500)
            return self._json({"run": run.to_json(detail=True)}, 202)
        if path.startswith("/api/chat/threads/") and path.endswith("/edit"):
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            thread_id = path[len("/api/chat/threads/") : -len("/edit")]
            body = self._read_body()
            text = body.get("text")
            message_id = body.get("messageId")
            if not isinstance(text, str) or not isinstance(message_id, str):
                return self._json({"error": "text and messageId are required strings"}, 400)
            model = body.get("model") if isinstance(body.get("model"), str) else None
            try:
                mgr.chat.check_model(model)
            except Exception as error:  # noqa: BLE001
                return self._json(
                    {"error": str(error), "code": getattr(error, "code", "CHAT_PROVIDER_UNAVAILABLE")},
                    400,
                )
            events = mgr.chat.edit(
                thread_id=thread_id,
                message_id=message_id,
                text=text,
                attachments=body.get("attachments"),
                model=model,
            )
            return self._stream_chat(events)
        if path.startswith("/api/chat/threads/") and path.endswith("/regenerate"):
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            thread_id = path[len("/api/chat/threads/") : -len("/regenerate")]
            body = self._read_body()
            message_id = body.get("messageId")
            if not isinstance(message_id, str):
                return self._json({"error": "messageId must be a string"}, 400)
            model = body.get("model") if isinstance(body.get("model"), str) else None
            try:
                mgr.chat.check_model(model)
            except Exception as error:  # noqa: BLE001
                return self._json(
                    {"error": str(error), "code": getattr(error, "code", "CHAT_PROVIDER_UNAVAILABLE")},
                    400,
                )
            events = mgr.chat.regenerate(
                thread_id=thread_id,
                message_id=message_id,
                model=model,
            )
            return self._stream_chat(events)
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
            spec = body.get("spec")
            if spec is not None:
                if not isinstance(spec, dict):
                    return self._json({"error": "spec must be an object"}, 400)
                if len(json.dumps(spec, ensure_ascii=False).encode("utf-8")) > 4096:
                    return self._json({"error": "spec is too large"}, 400)
                try:
                    mgr.validate_delegation_spec(spec, scenario)
                except ValueError as exc:
                    return self._json({"error": str(exc)}, 400)
            model_field = body.get("model")
            effort_field = body.get("effort")
            try:
                model_key, effort = mgr.resolve_model(
                    model_field if isinstance(model_field, str) else None,
                    effort_field if isinstance(effort_field, str) else None,
                )
            except ValueError as exc:
                # fail-closed：创建时环境不满足就是 400，绝不静默回退 mock
                return self._json({"error": str(exc)}, 400)
            run = mgr.create(objective, template, approval, spec, model_key=model_key, effort=effort)
            return self._json(run.to_json(detail=True), 202)
        if path.startswith("/api/runs/") and path.endswith("/review"):
            if mgr.runtime is None:
                return self._json({"error": f"live mode unavailable: {mgr.runtime_error}"}, 503)
            run_id = path[len("/api/runs/") : -len("/review")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            body = self._read_body()
            decision = body.get("decision")
            if decision not in mgr.runtime.REVIEW_DECISIONS:
                return self._json(
                    {"error": f"decision must be one of {', '.join(mgr.runtime.REVIEW_DECISIONS)}"},
                    400,
                )
            reason = body.get("reason")
            if reason is None:
                reason = ""
            if not isinstance(reason, str) or len(reason) > mgr.runtime.MAX_REASON:
                return self._json(
                    {"error": f"reason must be a string of at most {mgr.runtime.MAX_REASON} characters"},
                    400,
                )
            reviewer = body.get("reviewer")
            if reviewer is None:
                reviewer = ""
            if not isinstance(reviewer, str) or len(reviewer) > mgr.runtime.MAX_REVIEWER:
                return self._json(
                    {"error": f"reviewer must be a string of at most {mgr.runtime.MAX_REVIEWER} characters"},
                    400,
                )
            try:
                payload = mgr.record_review(run.id, decision, reason, reviewer)
            except KeyError:
                return self._json({"error": "no such run"}, 404)
            except ValueError as exc:
                return self._json({"error": str(exc)}, 409)
            return self._json(payload)
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
        if path.startswith("/api/runs/") and path.endswith("/answer"):
            run_id = path[len("/api/runs/") : -len("/answer")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            body = self._read_body()
            question_id = str(body.get("questionId") or "").strip()
            if not question_id:
                return self._json({"error": "questionId is required"}, 400)
            text = body.get("text")
            skip = bool(body.get("skip"))
            control = getattr(run, "controller", None)
            if control is None:
                return self._json({"error": "this run is not accepting answers"}, 409)
            if skip:
                ok = control.skip_question(question_id)
            else:
                if not isinstance(text, str) or not text.strip():
                    return self._json({"error": "text is required unless skip is set"}, 400)
                if len(text) > 600:
                    return self._json({"error": "text must be at most 600 characters"}, 400)
                ok = control.answer(question_id, text)
            if not ok:
                return self._json({"error": "that question is not pending"}, 409)
            return self._json({"ok": True, "questionId": question_id, "skipped": skip})
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
            message_id = uuid.uuid4().hex[:10]
            control.queue({"kind": "message", "text": text, "id": message_id})
            return self._json({"queued": True, "id": run.id, "messageId": message_id}, 202)
        if path.startswith("/api/runs/") and path.endswith("/steer"):
            run_id = path[len("/api/runs/") : -len("/steer")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            if run.finished:
                return self._json({"error": "run has finished"}, 409)
            control = getattr(run, "controller", None)
            if control is None:
                return self._json({"error": "run has no live control"}, 409)
            body = self._read_body()
            result = control.steer_message(str(body.get("messageId") or ""))
            if not result.get("ok"):
                return self._json({"error": result.get("error", "steer failed")}, 409)
            return self._json(result)
        if path.startswith("/api/runs/") and path.endswith("/queue"):
            run_id = path[len("/api/runs/") : -len("/queue")]
            run = mgr.get(run_id)
            if run is None:
                return self._json({"error": "no such run"}, 404)
            if run.finished:
                return self._json({"error": "run has finished"}, 409)
            control = getattr(run, "controller", None)
            if control is None:
                return self._json({"error": "run has no live control"}, 409)
            body = self._read_body()
            op = str(body.get("op") or "")
            result = control.mutate_message(str(body.get("messageId") or ""), op, body.get("text"))
            if not result.get("ok"):
                return self._json({"error": result.get("error", "queue op failed")}, 409)
            return self._json(result)
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
        if not path.startswith("/api/"):
            return self.send_error(404)
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 401)
        if not self._mutation_guard():
            return
        mgr = self.manager
        if path.startswith("/api/chat/threads/"):
            thread_id = path[len("/api/chat/threads/") :]
            if not thread_id or "/" in thread_id:
                return self._json({"error": "no such thread"}, 404)
            if mgr.chat is None:
                return self._json({"error": "chat is unavailable"}, 503)
            try:
                result = mgr.chat.archive_thread(thread_id)
            except Exception as error:  # noqa: BLE001 — missing thread is a 404
                code = getattr(error, "code", "")
                status = 404 if code in ("CHAT_THREAD_NOT_FOUND", "TASK_NOT_FOUND") else 400
                return self._json({"error": str(error), "code": code}, status)
            return self._json(result)
        if not path.startswith("/api/runs/") or path.count("/") != 3:
            return self.send_error(404)
        if mgr.runtime is None:
            return self._json({"error": "live mode unavailable"}, 503)
        run_id = path[len("/api/runs/") :]
        ok, reason = mgr.delete(run_id)
        if not ok:
            return self._json({"error": reason}, 404 if reason == "no such run" else 409)
        return self._json({"deleted": True, "id": run_id})


# ------------------------------------------------------------------------ main


class ConsoleHTTPServer(ThreadingHTTPServer):
    """永不解析反向 DNS 的 HTTP 服务。

    标准库 ``HTTPServer.server_bind`` 在 bind 之后会执行 ``socket.getfqdn(host)``。
    反向 DNS 慢或不可达的机器上这句会挂很久：CI 的 macOS runner 实测
    ``getfqdn('127.0.0.1') -> 'localhost' in 35.06s``。而它发生在我们打印任何
    启动日志、进入 serve_forever 之前，于是外部看到的现象是「套接字已经 listen、
    请求却没人处理、日志一行没有」——两份以子进程方式起控制台的测试因此连续
    二十余次在 macOS 上超时（ubuntu 的解析快，一直是绿的）。

    我们只绑回环，且 ``server_name`` 不参与任何路由，所以直接用字面量填掉它。
    """

    def server_bind(self) -> None:
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = int(port)


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
        "--local-endpoint",
        default=os.environ.get("FCODE_LOCAL_ENDPOINT", ""),
        help="Ollama-compatible base URL for the local provider (enables the 本地 Qwen model entry)",
    )
    parser.add_argument(
        "--token",
        default="",
        help="require this token (cookie bootstrap via /?token=…); desktop mode uses it",
    )
    args = parser.parse_args(argv)
    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.token:
        print(
            "[console] refusing to listen on a non-loopback host without --token; "
            "configure --token (the desktop app does this) or bind 127.0.0.1"
        )
        return 2

    runtime: Runtime | None = None
    runtime_error = ""
    if args.repo:
        try:
            runtime = Runtime(Path(args.repo).expanduser())
        except Exception as exc:  # noqa: BLE001
            runtime_error = f"{type(exc).__name__}: {exc}"
    else:
        runtime_error = "no --repo given; set it to the FCode checkout to enable live runs"

    migrate_legacy_chat_config()
    manager = RunManager(
        runtime, runtime_error, args.pace, args.approval_timeout,
        local_endpoint=args.local_endpoint.strip() or None,
    )
    Handler.manager = manager
    Handler.token = args.token or None
    httpd = ConsoleHTTPServer((args.host, args.port), Handler)
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
