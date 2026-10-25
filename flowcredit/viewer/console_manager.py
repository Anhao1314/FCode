"""Run history, creation, control and persistence.

The manager owns the runs/ directory, resumes and reviews. It uses the runtime
host for execution and the shared catalog for model/budget facts, and exposes a
small surface the HTTP handler calls.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlparse

from console_common import (
    CHAT_CONFIG_PATH,
    DOMAIN_KEY,
    EFFORT_LEVELS,
    REVIEWABLE_STATUS,
    RUNS_DIR,
    TERMINAL_STATUS,
    VIEWER_DIR,
    _scaled_budget_for_prices,
    model_catalog,
)
from console_runtime import (
    LiveObserver,
    Run,
    RunControl,
    Runtime,
    ScopedPlanner,
    StopRequested,
    _run_crash,
    _watch,
)

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
    def __init__(
        self,
        runtime: Runtime | None,
        runtime_error: str,
        pace: float,
        approval_timeout: float = 300.0,
        local_endpoint: str | None = None,
        runs_dir: Path | None = None,
    ) -> None:
        self.runtime = runtime
        # Injected so a caller (the HTTP server, tests) can point the manager at
        # a temporary history without mutating a process-wide global.
        self.runs_dir = Path(runs_dir) if runs_dir is not None else RUNS_DIR
        self.runtime_error = runtime_error
        self.pace = pace
        self.approval_timeout = approval_timeout
        self.local_endpoint = local_endpoint
        self.runs: dict[str, Run] = {}
        self.order: list[str] = []
        self.case_index = runtime.CaseIndex() if runtime is not None else None
        self.fact_store = runtime.FactStore() if runtime is not None else None
        self.chat = None
        if runtime is not None:
            try:
                # Chat lives next to the run history (Application Support in the
                # desktop bundle), so audit records survive app upgrades. The
                # settings file sits beside it and holds provider overrides —
                # including API keys — outside the repository.
                self.chat = runtime.ChatService(
                    self.runs_dir.parent / "chat.sqlite",
                    CHAT_CONFIG_PATH,
                )
                try:
                    retention = int(os.environ.get("FCODE_CHAT_RETENTION_DAYS", "0") or 0)
                except ValueError:
                    retention = 0
                if retention > 0:
                    archived = self.chat.archive_stale(retention)
                    if archived:
                        print(f"[console] archived {archived} chat thread(s) older than {retention} days")
            except Exception:  # noqa: BLE001 — chat must not take the console down
                traceback.print_exc()
        self._lock = threading.Lock()
        self._seq = 0
        self.runs_dir.mkdir(exist_ok=True)
        self._load_history()
        # The MCP bridge attaches whatever the host reviewed into mcp.json.
        # Connection happens off-thread: a hanging server must not delay boot,
        # and /api/mcp reports the honest per-server status meanwhile.
        self.mcp: dict[str, Any] = {"ready": False, "bridge": None}
        if runtime is not None:
            config_path = os.environ.get("FCODE_MCP_CONFIG") or str(runtime.repo / "mcp.json")
            thread = threading.Thread(
                target=self._connect_mcp, args=(config_path,), name="mcp:bridge", daemon=True,
            )
            thread.start()

    def _connect_mcp(self, config_path: str) -> None:
        try:
            from flowagent.tools.mcp.bridge import McpBridge

            bridge = McpBridge(config_path, cwd=self.runtime.repo if self.runtime else None)
            bridge.connect()
            self.mcp = {"ready": True, "bridge": bridge}
        except Exception as error:  # noqa: BLE001 — the bridge must never kill the console
            traceback.print_exc()
            self.mcp = {"ready": True, "bridge": None, "error": f"{type(error).__name__}: {error}"}

    def mcp_tools(self) -> list[dict]:
        """Honest MCP availability for the console (server-by-server)."""
        bridge = self.mcp.get("bridge")
        if bridge is None:
            error = self.mcp.get("error")
            return [{
                "server": "mcp",
                "connected": False,
                "tools": [],
                "refused": [],
                "reason": error or "no mcp.json configured",
            }]
        return bridge.statuses()

    def resolve_model(self, model_key: str | None, effort: str | None) -> tuple[str, str]:
        """Fail-closed model resolution for run creation.

        An unavailable or unknown selection raises with the same reason the
        catalog shows — creation never silently falls back to the mock.
        """
        if model_key in (None, "", "mock"):
            if effort not in (None, ""):
                raise ValueError("mock 模型不支持思考强度选择")
            return "mock", ""
        entry = next((m for m in model_catalog(self.local_endpoint) if m["key"] == model_key), None)
        if entry is None:
            raise ValueError(f"未知模型 {model_key!r}")
        if not entry["available"]:
            raise ValueError(entry["reason"] or f"模型 {model_key} 当前不可用")
        if not entry["supportsEffort"]:
            if effort not in (None, ""):
                raise ValueError(f"模型 {model_key} 不支持思考强度选择")
            return model_key, ""
        if effort not in (None, "", *EFFORT_LEVELS):
            raise ValueError("思考强度必须是 low、medium 或 high")
        return model_key, effort or "medium"

    def validate_delegation_spec(self, spec: dict | None, scenario) -> dict | None:
        """Validate operator delegation overrides before a run exists.

        Finance delegations carry ``scope`` (which corpus documents this run may
        read) and ``budget``. General delegations carry a mode: ``research``
        needs ``sources`` (the URLs fetch_url may visit); ``script`` needs
        neither (the plan writes and runs a script in the sandbox). ``budget``
        applies to both. All of it is fact in the task binding, consumed by
        the run thread — not decorative UI state.
        """
        if spec is None:
            return None
        if not isinstance(spec, dict):
            raise ValueError("spec must be an object")
        general = scenario.module != DOMAIN_KEY
        if general:
            mode = str(spec.get("mode") or "research")
            if mode not in ("research", "script"):
                raise ValueError("mode must be research or script")
            script_path = spec.get("scriptPath")
            if script_path is not None and (
                not isinstance(script_path, str)
                or not script_path.strip()
                or "/" in script_path
                or script_path.startswith(".")
            ):
                raise ValueError("scriptPath must be a bare workspace filename")
            sources = spec.get("sources")
            if sources is not None:
                if not isinstance(sources, list) or not all(isinstance(item, str) for item in sources):
                    raise ValueError("sources must be a list of URLs")
                if not 1 <= len(sources) <= 5:
                    raise ValueError("sources must list 1 to 5 URLs")
                if len(set(sources)) != len(sources):
                    raise ValueError("sources must not repeat a URL")
                for url in sources:
                    parsed = urlparse(url)
                    if parsed.scheme not in ("http", "https") or not parsed.hostname:
                        raise ValueError(f"sources contains a non-http(s) URL: {url[:120]!r}")
            elif mode == "research" and "scope" not in spec:
                # A research delegation without sources cannot plan a single
                # fetch; refuse at creation instead of failing mid-run. A
                # script delegation plans no fetch at all.
                raise ValueError("a research delegation needs spec.sources (1 to 5 URLs)")
            # Chat-to-work bridge: the conversation a delegation came from, so
            # "周三/当天/到了后" resolve against what the user actually said.
            # Capped hard — context travels, but cannot smuggle a payload.
            origin = spec.get("origin_thread")
            if origin is not None:
                if not isinstance(origin, dict):
                    raise ValueError("origin_thread must be an object")
                if origin.get("threadId") is not None and not isinstance(origin["threadId"], str):
                    raise ValueError("origin_thread.threadId must be a string")
                for field in ("threadTitle",):
                    if origin.get(field) is not None and not isinstance(origin[field], str):
                        raise ValueError(f"origin_thread.{field} must be a string")
                messages = origin.get("messages")
                if messages is None:
                    messages = []
                if not isinstance(messages, list) or not all(
                    isinstance(item, dict) and item.get("role") in ("user", "assistant")
                    and isinstance(item.get("text"), str)
                    for item in messages
                ):
                    raise ValueError("origin_thread.messages must be user/assistant objects")
                if len(messages) > 24:
                    raise ValueError("origin_thread carries at most 24 messages")
                origin["messages"] = [
                    {"role": item["role"], "text": item["text"][:600]} for item in messages[:24]
                ]
        else:
            scope = spec.get("scope")
            if scope is not None:
                if not isinstance(scope, list) or not all(isinstance(item, str) for item in scope):
                    raise ValueError("scope must be a list of document ids")
                if not scope:
                    raise ValueError("scope cannot be empty; omit it to use the full corpus")
                if len(set(scope)) != len(scope):
                    raise ValueError("scope cannot contain duplicate documents")
                known = {doc["id"] for doc in self.runtime.corpus(scenario.key)}
                unknown = [doc for doc in scope if doc not in known]
                if unknown:
                    raise ValueError(f"scope contains unknown documents: {', '.join(unknown)}")
        budget = spec.get("budget")
        if budget is not None:
            if not isinstance(budget, dict):
                raise ValueError("budget must be an object")
            required = ("maxCalls", "maxReads", "maxCostMicrousd")
            missing = [name for name in required if name not in budget]
            if missing:
                raise ValueError(f"budget is missing {', '.join(missing)}")
            for name in required:
                value = budget[name]
                if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                    raise ValueError(f"budget.{name} must be a positive integer")
        return spec

    def model_catalog_with_budget(self, template_key: str | None) -> list[dict]:
        """模型清单 + 该模板下各自真实生效的预算顶（草稿预览的单一事实源）。"""
        models = model_catalog(self.local_endpoint)
        limits = None
        if template_key and self.runtime is not None:
            try:
                limits = self.runtime.get_scenario(template_key).limits
            except Exception:  # noqa: BLE001 — unknown template: budget stays None
                limits = None
        if limits is None:
            return models
        out = []
        for m in models:
            entry = dict(m)
            entry["budget"] = self._budget_for_model(m, limits)
            out.append(entry)
        return out

    def _budget_for_model(self, m: dict, limits) -> dict | None:
        if m["key"] in ("mock", "local"):
            # 不产生外部计费，预算顶即模板草案
            return {
                "max_calls": limits.max_calls,
                "max_reads": limits.max_reads,
                "max_cost_microusd": limits.max_cost_microusd,
                "max_tokens": limits.max_tokens,
            }
        price = m.get("price")
        if not m.get("available") or not price:
            return None
        # 任何带价格快照的 provider（预设或主机声明）都按其单价重算预算顶：
        # 创建与恢复共用这一条路径，菜单里的数字与运行时一致。
        from types import SimpleNamespace

        snapshot = SimpleNamespace(
            input_microusd_per_mtok=price["inputMicrousdPerMtok"],
            output_microusd_per_mtok=price["outputMicrousdPerMtok"],
        )
        return _scaled_budget_for_prices(
            limits, snapshot, int(m.get("maxCompletionTokens") or 512)
        )

    # ------------------------------------------------------------- persistence

    def _load_history(self) -> None:
        for meta_path in sorted(self.runs_dir.glob("run-*/meta.json")):
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
                spec=meta.get("spec"),
                finished=True,
            )
            self.runs[run.id] = run
            self.order.append(run.id)
        self.order.sort(key=lambda rid: self.runs[rid].created, reverse=True)

    def _write_meta(self, run: Run) -> None:
        meta = run.to_json()
        meta["verified"] = run.trace_verified
        try:
            (self.runs_dir / run.id / "meta.json").write_text(
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
        shutil.rmtree(self.runs_dir / run_id, ignore_errors=True)
        if self.case_index is not None:
            try:
                self.case_index.tombstone(run_id)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        if self.artifact_book is not None:
            try:
                self.artifact_book.archive_run(run_id)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        if self.fact_store is not None:
            try:
                self.fact_store.tombstone_run(run_id)
            except Exception:  # noqa: BLE001
                traceback.print_exc()
        return True, ""

    def memory_summary(self) -> dict[str, Any]:
        """Read-only counts for the settings page; never includes case contents."""
        cases = self.case_index
        facts = self.fact_store
        return {
            "runs": len(self.runs),
            "cases": {
                "active": cases.count() if cases else 0,
                "total": cases.count(include_archived=True) if cases else 0,
            },
            "facts": {
                "active": facts.count() if facts else 0,
                "total": facts.count(include_archived=True) if facts else 0,
            },
        }

    def review_profile(self, module: str = "", template: str = "", outcome: str = "") -> dict[str, Any]:
        """Project past review decisions from exported traces, read-only.

        The scan is on demand so a newly reviewed run is visible immediately and
        there is no second index to keep in sync. Unreadable or half-written
        traces are skipped: one damaged file must not hide the rest of the
        history. The projection itself lives in ``flowagent.review_profile``.
        """
        builder = getattr(self.runtime, "build_profile", None)
        if builder is None:
            # Static mode: the viewer still sits beside its source checkout.
            src = VIEWER_DIR.parent / "src"
            if str(src) not in sys.path and (src / "flowagent" / "__init__.py").exists():
                sys.path.insert(0, str(src))
            from flowagent.review_profile import build_profile

            builder = build_profile

        traces: list[tuple[str, dict]] = []
        for trace_path in sorted(self.runs_dir.glob("run-*/trace.json")):
            try:
                trace = json.loads(trace_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(trace, dict):
                traces.append((trace_path.parent.name, trace))
        return builder(traces, module=module, template=template, outcome=outcome)

    def create(
        self,
        objective: str,
        template: str,
        approval: str = "consequential",
        spec: dict | None = None,
        model_key: str = "mock",
        effort: str = "",
    ) -> Run:
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
                spec=spec,
                model=model_key,
                effort=effort,
            )
            self.runs[run_id] = run
            self.order.insert(0, run_id)
        (self.runs_dir / run.id).mkdir(parents=True, exist_ok=True)
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
        db = self.runs_dir / run.id / "task.sqlite"
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

    def record_review(self, run_id: str, decision: str, reason: str, reviewer: str) -> dict:
        """Append a human decision to a finished run and re-export its trace.

        This is a new event on the existing hash chain, not a status change:
        the run stays terminal, and the trace is rebuilt from the store so the
        reviewer's judgement sits beside the evidence it is judging.
        """
        rt = self.runtime
        if rt is None:
            raise ValueError("live runtime is unavailable")
        run = self.runs.get(run_id)
        if run is None:
            raise KeyError(run_id)
        with run.lock:
            status = run.status
            finished = run.finished
            task_id = run.task_id
        if not finished or status == "running":
            raise ValueError("run is still running; a review can only be recorded after it finishes")
        if status not in REVIEWABLE_STATUS:
            raise ValueError(f"run is {status}; only a terminal run can be reviewed")
        if not task_id:
            raise ValueError("run has no durable task to review")
        run_dir = self.runs_dir / run.id
        trace_path = run_dir / "trace.json"
        db = run_dir / "task.sqlite"
        if not trace_path.exists():
            raise ValueError("run has no trace.json; a review needs the exported trace")
        if not db.exists():
            raise ValueError("run has no task.sqlite; a review needs the durable event chain")
        try:
            trace = json.loads(trace_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"cannot read trace.json: {exc}") from exc

        store = rt.TaskStore(db)
        try:
            try:
                final, event = rt.record_review(
                    store,
                    task_id,
                    trace,
                    decision=decision,
                    reason=reason,
                    reviewer=reviewer,
                )
            except rt.AgentError as exc:
                raise ValueError(f"cannot record review: {exc}") from exc
            except ValueError:
                raise
            except Exception as exc:  # noqa: BLE001 — a damaged trace is a 409, not a crash
                raise ValueError(f"cannot record review: {type(exc).__name__}: {exc}") from exc
            rt.export_trace(final, trace_path)
            try:
                verification = rt.verify_trace(final)
                verified = bool(verification.get("ok", verification.get("valid", True)))
            except Exception:  # verification must never lose the recorded decision
                verified = False
            with run.lock:
                run.snapshot = final
                run.rounds = len(final["rounds"])
                run.event_count = len(final["events"])
                run.trace_path = f"runs/{run.id}/trace.json"
                run.trace_verified = verified
                run.cost = _budget_summary(final)
                run.bump()
            self._write_meta(run)
            if self.case_index is not None:
                try:
                    self.case_index.upsert(final, run_id=run.id)
                except Exception:  # noqa: BLE001 — memory must never lose a review
                    traceback.print_exc()
            return {
                "ok": True,
                "decision": decision,
                "sequence": event["sequence"],
                "event": {
                    "sequence": event["sequence"],
                    "type": event["type"],
                    "hash": event["hash"],
                },
                "tracePath": run.trace_path,
            }
        finally:
            try:
                store.close()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------- run driver

    def _build_provider(self, rt: Runtime, run: Run, scenario, receipts, issue):
        """Construct this run's proposal source from the operator's selection.

        mock keeps the console's own wiring (scenario policy + fault-injection
        receipts); every other provider goes through the demo factory so env
        validation, price snapshots, pacing and fault disclosure stay identical
        to the CLI path. Gating, budgets and auditing live in the runtime and
        are untouched by this choice.
        """
        if (run.model or "mock") == "mock":
            return rt.MockProvider(
                policy=scenario.policy,
                fail_at_call=scenario.fail_at_call,
                issue_receipt=issue if scenario.fail_at_call else None,
            )
        from flowagent.demo.provider_factory import build_provider

        return build_provider(
            run.model,
            scenario=scenario,
            receipts=receipts,
            endpoint=self.local_endpoint if run.model == "local" else None,
            # 思考强度对任何 supportsEffort 的 provider 生效（创建时已校验）
            reasoning_effort=(run.effort or None) if run.model != "mock" else None,
        )

    def _run_thread(self, run: Run, *, resume_limits: dict | None = None, extra_rounds: int = 6) -> None:
        rt = self.runtime
        assert rt is not None
        store = None
        watcher = None
        try:
            scenario = rt.get_scenario(run.template)
            run_dir = self.runs_dir / run.id
            db = run_dir / "task.sqlite"
            store = rt.TaskStore(db)
            module = rt.get_domain(scenario.module)
            general = module.key != DOMAIN_KEY
            # The general module keeps its workspace sandbox inside the run
            # directory, next to the chain it feeds; files survive restarts.
            # commands.json lives next to mcp.json (repo root): the host's
            # extension of the terminal whitelist, injected here.
            world_kwargs = {}
            sandbox = None
            if general:
                sandbox = rt.WorkspaceSandbox(run_dir / "workspace")
                world_kwargs = {
                    "sandbox": sandbox,
                    "command_config": os.environ.get("FCODE_COMMANDS_CONFIG")
                    or str(rt.repo / "commands.json"),
                }
            world = module.create_world(
                partial=scenario.partial_corpus, spec=run.spec or {}, **world_kwargs,
            )
            # 委托 scope：world 与计划同宽。列表、读取和派生工具都只能看到
            # 所选文档；缺资料导致的阻塞由域工具如实报告，不静默放宽。
            scope = list(((run.spec or {}).get("scope") or []))
            if scope and hasattr(world, "documents"):
                selected = set(scope)
                unknown = selected - set(world.documents)
                if unknown:
                    raise ValueError(f"scope contains unknown documents: {', '.join(sorted(unknown))}")
                world.documents = {doc_id: world.documents[doc_id] for doc_id in selected}
            native_tools = module.build_tools(
                world, cases=self.case_index, facts=self.fact_store,
            )
            # MCP 导入是"进注册表"，不是绕过注册表：只有通用域委托把导入
            # 工具并入 allowed_tools 与 grant（主机决策，随 binding 入链）。
            mcp_bridge = self.mcp.get("bridge") if general else None
            mcp_specs = mcp_bridge.specs() if mcp_bridge else []
            extra_allowed: list[str] = [spec.name for spec in mcp_specs]
            registry = rt.ToolRegistry(native_tools + mcp_specs)
            receipts = rt.ReceiptStore(store)
            issued: dict[str, str] = {}

            limits = scenario.limits
            budget_override = (run.spec or {}).get("budget") if not resume_limits else None
            if budget_override:
                # 操作者微调后的治理顶：创建时生效，随任务 binding 入链。
                # 上调是显式放宽（UI 提示），下调立即收紧；实际计费仍以收据为准。
                limits = rt.BudgetLimits(
                    max_calls=int(budget_override["maxCalls"]),
                    max_reads=int(budget_override["maxReads"]),
                    max_cost_microusd=int(budget_override["maxCostMicrousd"]),
                    max_tokens=scenario.limits.max_tokens,
                )
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

            provider = self._build_provider(rt, run, scenario, receipts, issue)
            if run.model != "mock":
                # scenario 的成本顶按 mock 免费价拟定；外部计费模型换真实价格后
                # 一次预留就会击穿。创建与恢复都按 provider 声明的价格快照重算
                # 成本顶与 token 顶（调用 / 读取次数沿用当前草案）——恢复路径
                # 显式重算，而不是靠“上限只升不降”的旧值兜底。
                price = getattr(provider, "price", None)
                max_completion = int(getattr(provider, "max_completion_tokens", 512) or 512)
                if price is not None:
                    scaled = _scaled_budget_for_prices(limits, price, max_completion)
                    limits = rt.BudgetLimits(**scaled)
            harness = rt.Harness(
                store=store,
                registry=registry,
                provider=provider,
                world=world,
                limits=limits,
                receipts=receipts,
                verifier=lambda observation: module.verify(world, observation),
                state_fn=module.summarize_state,
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
            approval_tools = tuple(scenario.approval_tools)
            if mcp_bridge is not None:
                # 导入工具默认 consequential：只有主机在 mcp.json 标了
                # readonly 的才免审批。分类权在主机，不在 server 自述。
                approval_tools += tuple(mcp_bridge.approval_names())

            def _approval_preview(tool: str, arguments: dict) -> dict | None:
                """主机在执行前算好的审批预览：write_file/edit_file 的真实
                diff、run_command 的完整命令行。预览与执行共用同一套沙箱
                校验——预览被沙箱拒绝的，执行也会被拒绝，且原因如实上屏。"""
                if sandbox is None:
                    return None
                if tool == "write_file":
                    path = str(arguments.get("path") or "")
                    content = str(arguments.get("content") or "")
                    if not path or not content:
                        return None
                    try:
                        return sandbox.diff_preview(path, content)
                    except Exception as error:  # noqa: BLE001 — 审批预览必须先于执行；沙箱拒绝也要如实上屏
                        return {"path": path, "created": True, "additions": 0,
                                "removals": 0, "truncated": False, "diff": "",
                                "error": f"{getattr(error, 'code', type(error).__name__)}: {error}"}
                if tool == "edit_file":
                    path = str(arguments.get("path") or "")
                    old_text = str(arguments.get("old_text") or "")
                    if not path or not old_text:
                        return None
                    try:
                        return sandbox.edit_preview(path, old_text, str(arguments.get("new_text") or ""))
                    except Exception as error:  # noqa: BLE001
                        return {"path": path, "created": False, "additions": 0,
                                "removals": 0, "truncated": False, "diff": "",
                                "error": f"{getattr(error, 'code', type(error).__name__)}: {error}"}
                if tool == "run_command":
                    command = str(arguments.get("command") or "")
                    if not command:
                        return None
                    argv = [command, *(arguments.get("args") or [])]
                    return {
                        "command": " ".join(argv),
                        "timeout": arguments.get("timeout_seconds") or 30,
                        "note": "白名单内命令；无 shell、参数逐个校验；超时记 unknown 不重跑",
                    }
                return None

            def _classify_consequential(tool: str, arguments: dict) -> bool:
                """run_command 的命令级分类：注册表标 readonly 的纯读命令
                （ls/cat/grep/find/wc/diff/git status|diff|log）免审批——与
                read_document 同等待遇；其余命令一律过审批。分类权在主机
                的命令注册表，不在模型提议。"""
                if tool != "run_command" or world is None:
                    return True
                runner = getattr(world, "command_runner", None)
                if runner is None:
                    return True
                verdict = runner.policy.classify(
                    str(arguments.get("command") or ""),
                    list(arguments.get("args") or []),
                )
                return True if verdict is None else verdict

            control = RunControl(
                run, harness, rt, approval_tools, self.approval_timeout,
                preview=_approval_preview if sandbox is not None else None,
                classify_consequential=_classify_consequential,
            )
            run.controller = control
            if resume_limits:
                task = store.load(run.task_id)
                task = harness.resume(
                    task,
                    detail={"by": "operator", "reason": "budget topped up", "limits": limits.to_dict()},
                )
                max_rounds = max(scenario.max_rounds, task.model.attempts + extra_rounds)
            else:
                binding = {
                    "scenario": scenario.key,
                    "module": module.key,
                    "source": "viewer-live",
                    **({"spec": run.spec} if run.spec else {}),
                }
                if general:
                    binding["workspace"] = "workspace"
                if extra_allowed:
                    binding["mcp_imports"] = extra_allowed
                grant = dict(scenario.grant)
                if extra_allowed:
                    grant["allowed_tools"] = list(grant.get("allowed_tools") or []) + extra_allowed
                task = harness.create(
                    task_id=f"task-{run.id}",
                    objective=run.objective,
                    principal="console-operator",
                    binding=binding,
                    allowed_tools=list(scenario.allowed_tools) + extra_allowed,
                    grant=grant,
                )
                if self.case_index is not None:
                    try:
                        hits = self.case_index.search(run.objective, limit=3)
                        task = harness.record_recall(task, hits)
                    except Exception:  # noqa: BLE001 — memory must never kill a run
                        traceback.print_exc()
                max_rounds = scenario.max_rounds
            run.task_id = task.id
            observer = LiveObserver(run, recorder, store, task.id)
            watcher = threading.Thread(
                target=_watch, args=(run, recorder, store, db, task.id), name=f"watch:{run.id}", daemon=True
            )
            watcher.start()

            base_planner = module.make_planner(world)
            planner = (
                ScopedPlanner(rt, base_planner, set(scope))
                if scope else base_planner
            )
            loop = rt.Loop(
                harness,
                planner=planner,
                max_rounds=max_rounds,
                observer=observer,
                control=control,
                result_tools=module.result_tools,
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
                        planner=planner,
                        max_rounds=max_rounds,
                        observer=observer,
                        control=control,
                        result_tools=module.result_tools,
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
            if self.case_index is not None:
                try:
                    self.case_index.upsert(final, run_id=run.id)
                except Exception:  # noqa: BLE001 — memory must never kill a run
                    traceback.print_exc()
            if self.fact_store is not None:
                try:
                    self.fact_store.upsert_run(
                        run_id=run.id,
                        facts=rt.project_facts(final, run_id=run.id),
                    )
                except Exception:  # noqa: BLE001 — memory must never kill a run
                    traceback.print_exc()
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
