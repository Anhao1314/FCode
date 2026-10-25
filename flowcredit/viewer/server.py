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
                                  (?module=...&template=...&outcome=...; all optional)
    POST /api/runs                {"objective": "...", "template": "full", "approval": "consequential"}
                                  -> {"id": "run-..."}
    GET  /api/runs/{id}/stream    server-sent events: trace snapshots as they grow
    POST /api/runs/{id}/stop      stop at the next round boundary
    POST /api/runs/{id}/decision  {"approvalId": "...", "allow": true, "remember": false}
    POST /api/runs/{id}/plan      {"action": "skip"|"promote", "todoId": "t4"}
    POST /api/runs/{id}/budget    raise limits; applies at the next round
    POST /api/runs/{id}/resume    add budget and continue a failed run
    POST /api/runs/{id}/review    {"decision": "accept", "reason": "...", "reviewer": "..."}
                                  append a human decision to a terminal run's chain
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
from urllib.parse import parse_qs, unquote, urlencode, urlparse
import urllib.request

__all__ = ["main"]

#: The first domain module. Scenarios still come from demo fixtures; the
#: vocabulary of the runtime already comes from the module registry.
DOMAIN_KEY = "finance-research"

VIEWER_DIR = Path(__file__).resolve().parent
#: The desktop shell points this at the user's Application Support directory:
#: a packaged .app bundle is read-only, and run records belong to the user.
RUNS_DIR = Path(os.environ.get("FCODE_RUNS_DIR") or (VIEWER_DIR / "runs"))
os.environ.setdefault("FCODE_MEMORY_DB", str(RUNS_DIR.parent / "memory" / "cases.sqlite"))

TERMINAL_STATUS = ("succeeded", "failed", "denied", "recovery_required")
#: Run statuses a review may be recorded against. ``stopped`` and ``error`` are
#: terminal in the console even though the task itself ends as ``failed``.
REVIEWABLE_STATUS = ("succeeded", "failed", "denied", "stopped", "error")


# ---------------------------------------------------------------- model catalog

#: Effort levels accepted for providers that expose reasoning effort.
EFFORT_LEVELS = ("low", "medium", "high")
EFFORT_LABELS = {"low": "低", "medium": "中", "high": "高"}
#: Local-endpoint probes are cheap but not free; cache the answer for 60s.
LOCAL_PROBE_TIMEOUT = 0.5
LOCAL_PROBE_TTL = 60.0
_local_probe_cache: dict[str, tuple[float, bool]] = {}


def _probe_local_endpoint(endpoint: str) -> bool:
    """Probe an Ollama-compatible endpoint once, caching the result for 60s."""
    now = time.monotonic()
    cached = _local_probe_cache.get(endpoint)
    if cached is not None and now - cached[0] < LOCAL_PROBE_TTL:
        return cached[1]
    root = endpoint.rstrip("/")
    if root.endswith("/v1"):
        root = root[: -len("/v1")]
    ok = False
    for path in ("/api/tags", "/v1/models"):
        try:
            req = urllib.request.Request(root + path, method="GET")
            with urllib.request.urlopen(req, timeout=LOCAL_PROBE_TIMEOUT) as resp:
                ok = resp.status == 200
                break
        except Exception:  # noqa: BLE001 — any probe failure means "not reachable now"
            ok = False
    _local_probe_cache[endpoint] = (now, ok)
    return ok


def _kimi_env_ready() -> bool:
    return all(
        os.environ.get(name, "").strip()
        for name in ("KIMI_API_KEY", "KIMI_INPUT_PRICE_MICROUSD_PER_MTOK", "KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK")
    )


def _scaled_budget_for_prices(limits, price, max_completion_tokens: int) -> dict:
    """外部计费模型的价格天花板（创建与恢复共用一套算法）。

    scenario 的成本顶按 mock 免费价拟定；换成真实价格后一次预留就会击穿。
    按 provider 声明的价格快照重算成本顶与 token 顶（调用 / 读取次数沿用
    场景草案）。上限是天花板不是目标：实际计费仍以收据为准并逐轮展示。
    """
    est_prompt_tokens = 6_000
    per_call_microusd = (
        est_prompt_tokens * price.input_microusd_per_mtok
        + max_completion_tokens * price.output_microusd_per_mtok
        + 999_999
    ) // 1_000_000
    return {
        "max_calls": limits.max_calls,
        "max_reads": limits.max_reads,
        "max_cost_microusd": max(limits.max_cost_microusd, per_call_microusd * limits.max_calls),
        "max_tokens": max(limits.max_tokens, (est_prompt_tokens + max_completion_tokens) * limits.max_calls),
    }


def model_catalog(local_endpoint: str | None) -> list[dict]:
    """The selectable-model list, judged live at request time.

    An unavailable model is reported with its reason and must never be shown
    as selectable; creation re-checks the same facts and fails closed.
    """
    kimi_model = os.environ.get("KIMI_MODEL", "").strip() or "kimi-k2.6"
    catalog: list[dict] = [
        {
            "key": "mock", "label": "offline-mock", "model": "offline-deterministic-mock-v1",
            "supportsEffort": False, "available": True, "reason": "",
        }
    ]
    if local_endpoint:
        probed = _probe_local_endpoint(local_endpoint)
        catalog.append({
            "key": "local", "label": "本地 Qwen", "model": "fcode-qwen3-4b",
            "supportsEffort": False, "available": probed,
            "reason": "" if probed else "本地推理端点探活失败",
        })
    else:
        catalog.append({
            "key": "local", "label": "本地 Qwen", "model": "fcode-qwen3-4b",
            "supportsEffort": False, "available": False,
            "reason": "未配置本地推理端点",
        })
    kimi_ready = _kimi_env_ready()
    catalog.append({
        "key": "kimi", "label": "Kimi 云端", "model": kimi_model,
        "supportsEffort": True, "available": kimi_ready,
        "reason": "" if kimi_ready else "Host 未配置 KIMI_API_KEY/价格",
    })
    return catalog


class StopRequested(Exception):
    """Raised inside an observer callback when the operator stops the run."""


class ScopedPlanner:
    """A domain planner narrowed to the operator's document scope.

    The runtime contract is unchanged: decompose() still returns a Plan and
    advance() still delegates settlement to the domain. Only the initial todos
    are filtered, so a scoped delegation never asks the model for documents it
    is not allowed to read. The world is filtered to the same ids, which is what
    enforces the scope for any provider that proposes outside the plan.
    """

    def __init__(self, runtime: Runtime, inner, scope: set[str]) -> None:
        self.runtime = runtime
        self.inner = inner
        self.scope = scope

    def decompose(self, goal: str):
        plan = self.inner.decompose(goal)
        todos = [
            todo for todo in plan.todos
            if not getattr(todo, "arguments", {}).get("doc_id") or todo.arguments["doc_id"] in self.scope
        ]
        return self.runtime.Plan(goal=plan.goal, todos=todos, revision=plan.revision)

    def advance(self, plan, observation):
        return self.inner.advance(plan, observation)


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
        m = imp("flowagent.memory.cases")
        self.CaseIndex = m.CaseIndex
        m = imp("flowagent.memory.facts")
        self.FactStore = m.FactStore
        m = imp("flowagent.tools.finance.facts")
        self.project_facts = m.project_facts
        m = imp("flowagent.intake")
        self.clarify = m.clarify
        m = imp("flowagent.chat")
        self.ChatService = m.ChatService
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
        m = imp("flowagent.review")
        self.record_review = m.record_review
        self.REVIEW_DECISIONS = m.DECISIONS
        self.MAX_REASON = m.MAX_REASON
        self.MAX_REVIEWER = m.MAX_REVIEWER
        m = imp("flowagent.review_profile")
        self.build_profile = m.build_profile
        m = imp("flowagent.tools.general.sandbox")
        self.WorkspaceSandbox = m.WorkspaceSandbox

    def _module_for(self, template_key: str | None):
        """The domain module a template runs on.

        The general module is the product's default entry. The finance module
        stays registered as the reference workload: when no template is named
        (the corpus browser) or an unknown key arrives, the reference world is
        the only one with a canned corpus to show.
        """
        key = DOMAIN_KEY
        if template_key:
            try:
                key = self.get_scenario(template_key).module
            except Exception:  # noqa: BLE001 — unknown template falls back
                key = DOMAIN_KEY
        return self.get_domain(key)

    def tool_contracts(self) -> list[dict]:
        """The registered contracts (name, effect, version, schemas)."""
        module = self.get_domain(DOMAIN_KEY)
        world = module.create_world()
        registry = self.ToolRegistry(module.build_tools(world))
        return [registry.get(tool["name"]).contract() for tool in registry.catalog()]

    def corpus(self, template_key: str | None = None) -> list[dict]:
        """The document corpus a template will run against (operator-facing)."""
        module = self._module_for(template_key)
        if module.key != DOMAIN_KEY:
            return []  # general delegations select sources, not corpus documents
        partial = False
        if template_key:
            partial = self.get_scenario(template_key).partial_corpus
        world = module.create_world(partial=partial)
        return world.list_documents()["documents"]

    def template_tools(self, template_key: str) -> list[dict]:
        """This template's closed tool registry, in registration order."""
        scenario = self.get_scenario(template_key)
        module = self._module_for(template_key)
        world = module.create_world(partial=scenario.partial_corpus)
        registry = self.ToolRegistry(module.build_tools(world))
        allowed = set(scenario.allowed_tools)
        return [registry.get(name).contract() for name in registry.names if name in allowed]

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
        # The general module is the product's default entry, so its scenarios
        # lead the picker even though the reference workload is declared first
        # in the scenario table. The sort is stable within each group.
        keys = sorted(
            self.AVAILABLE,
            key=lambda key: 0 if self.SCENARIOS[key].module == "general-work" else 1,
        )
        out = []
        for key in keys:
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
                    "module": scenario.module,
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
    model: str = "mock"              # operator-selected provider key for this run
    effort: str = ""                 # reasoning effort (kimi only); mock ignores it
    pending: dict | None = None
    queue: list | None = None
    cost: dict | None = None
    spec: dict | None = None
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
            "spec": self.spec,
        }
        if detail:
            out["error"] = self.error
            out["pending"] = self.pending
            out["queue"] = self.queue or []
            out["model"] = self.model
            out["effort"] = self.effort
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
    def __init__(
        self,
        runtime: Runtime | None,
        runtime_error: str,
        pace: float,
        approval_timeout: float = 300.0,
        local_endpoint: str | None = None,
    ) -> None:
        self.runtime = runtime
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
                # desktop bundle), so audit records survive app upgrades.
                self.chat = runtime.ChatService(RUNS_DIR.parent / "chat.sqlite")
            except Exception:  # noqa: BLE001 — chat must not take the console down
                traceback.print_exc()
        self._lock = threading.Lock()
        self._seq = 0
        RUNS_DIR.mkdir(exist_ok=True)
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
        if m["key"] == "kimi":
            if not m["available"]:
                return None
            try:
                from flowagent.providers.kimi import load_kimi_settings

                settings = load_kimi_settings()
            except Exception:  # noqa: BLE001 — env drifted since the catalog check
                return None
            return _scaled_budget_for_prices(limits, settings.price, settings.max_completion_tokens)
        # mock / local 不产生外部计费，预算顶即模板草案
        return {
            "max_calls": limits.max_calls,
            "max_reads": limits.max_reads,
            "max_cost_microusd": limits.max_cost_microusd,
            "max_tokens": limits.max_tokens,
        }

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
        if self.case_index is not None:
            try:
                self.case_index.tombstone(run_id)
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
        for trace_path in sorted(RUNS_DIR.glob("run-*/trace.json")):
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
        run_dir = RUNS_DIR / run.id
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
            reasoning_effort=run.effort or None if run.model == "kimi" else None,
        )

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

    def __init__(
        self,
        run: Run,
        harness,
        runtime: Runtime,
        approval_tools,
        timeout: float,
        preview=None,
        classify_consequential=None,
    ) -> None:
        self.run = run
        self.harness = harness
        self.Plan = runtime.Plan
        self.BudgetLimits = runtime.BudgetLimits
        self.RoundControl = runtime.RoundControl
        self.ToolControl = runtime.ToolControl
        self.approval_tools = set(approval_tools)
        #: Optional host hook: (tool, arguments) -> a preview payload the
        #: approval dialog renders (write_file/edit_file's real diff,
        #: run_command's full command line). Host-side by construction;
        #: nothing executes before the decision.
        self.preview = preview
        #: Optional host hook: (tool, arguments) -> True when this specific
        #: call is consequential. The command registry uses it to classify
        #: run_command per program (readonly utilities skip the approval);
        #: every other tool falls back to the approval set.
        self.classify_consequential = classify_consequential
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
        if command.get("kind") == "message":
            # 发布权威队列：任何客户端入队后，所有客户端的排队面板立即同步
            self._publish_queue()

    def queue_snapshot(self) -> list[dict]:
        """The authoritative queued-message list (server order is truth)."""
        with self._lock:
            return [
                {"id": c.get("id"), "text": c.get("text", ""), "steered": bool(c.get("steered"))}
                for c in self._commands
                if c.get("kind") == "message"
            ]

    def _publish_queue(self) -> None:
        """Mirror the queue onto the run and wake SSE subscribers."""
        snapshot = self.queue_snapshot()
        with self.run.lock:
            self.run.queue = snapshot
            self.run.bump()

    def steer_message(self, message_id: str) -> dict:
        """Promote a queued operator message to the front, flagged ``steered``.

        Steer never bypasses the chain: the message is still applied by the run
        thread at the next round boundary, only earlier in the queue and with a
        visible ``steered`` mark on its ``operator_message`` event.
        """
        return self.mutate_message(message_id, "steer")

    def mutate_message(self, message_id: str, op: str, new_text: str | None = None) -> dict:
        """Edit / remove / reorder / steer a queued operator message by id."""
        with self._lock:
            idx = next(
                (
                    i
                    for i, c in enumerate(self._commands)
                    if c.get("kind") == "message" and c.get("id") == message_id
                ),
                None,
            )
            if idx is None:
                return {"ok": False, "error": "no queued message with that id"}
            if op == "remove":
                del self._commands[idx]
            elif op == "moveUp":
                prev = next(
                    (
                        j
                        for j in range(idx - 1, -1, -1)
                        if self._commands[j].get("kind") == "message"
                    ),
                    None,
                )
                if prev is not None:
                    self._commands[idx], self._commands[prev] = (
                        self._commands[prev],
                        self._commands[idx],
                    )
            elif op == "edit":
                text = str(new_text or "").strip()
                if not text:
                    return {"ok": False, "error": "text is required"}
                self._commands[idx]["text"] = text[:600]
            elif op == "steer":
                command = self._commands[idx]
                del self._commands[idx]
                command["steered"] = True
                self._commands.appendleft(command)
            else:
                return {"ok": False, "error": "op must be edit, remove, moveUp or steer"}
        self._publish_queue()
        return {"ok": True, "queue": self.queue_snapshot()}

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
        if any(c["kind"] == "message" for c in commands):
            # 队列在本边界被消费：把权威队列的新状态推给所有订阅者
            self._publish_queue()
        return self.RoundControl(task=task, plan=plan)

    def before_tool(self, *, round_no: int, task, step: dict, decision):
        mode = self.run.approval
        tool = step["tool"]
        required = mode == "all" or (mode == "consequential" and tool in self.approval_tools)
        if required and mode == "consequential" and self.classify_consequential is not None:
            # 命令级豁免：主机注册表判定为纯读的调用（如 run_command 的
            # ls/cat/git status）与读工具同等待遇，不过审批。
            try:
                if self.classify_consequential(tool, step.get("arguments") or {}) is False:
                    required = False
            except Exception:  # noqa: BLE001 — 分类失败按需要审批处理
                required = True
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
        if self.preview is not None:
            try:
                payload = self.preview(tool, step.get("arguments") or {})
            except Exception:  # noqa: BLE001 — a preview must never block the gate
                payload = None
            if payload is not None:
                approval["preview"] = payload
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
        # A steered message keeps its queue priority visible on the event:
        # ``steered`` is an annotation, never a bypass of the round boundary.
        text = str(command.get("text") or "").strip()
        if not text:
            return task
        detail: dict = {"round": round_no, "text": text[:600], "by": "operator"}
        if command.get("id"):
            detail["message_id"] = str(command["id"])
        if command.get("steered"):
            detail["steered"] = True
        return self.harness.record(task, "operator_message", detail)


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
    module = rt.get_domain(scenario.module)
    memory = rt.Loop(
        harness, planner=module.make_planner(world), result_tools=module.result_tools,
    ).restore(resumed)
    world.apply_state(memory.state())
    return rt.Loop(
        harness, planner=module.make_planner(world), max_rounds=scenario.max_rounds, observer=observer,
        result_tools=module.result_tools,
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
            return self._json({"threads": mgr.chat.list_threads()})
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

    runtime: Runtime | None = None
    runtime_error = ""
    if args.repo:
        try:
            runtime = Runtime(Path(args.repo).expanduser())
        except Exception as exc:  # noqa: BLE001
            runtime_error = f"{type(exc).__name__}: {exc}"
    else:
        runtime_error = "no --repo given; set it to the FCode checkout to enable live runs"

    manager = RunManager(
        runtime, runtime_error, args.pace, args.approval_timeout,
        local_endpoint=args.local_endpoint.strip() or None,
    )
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
