"""Chat: the conversational surface, still budgeted and chained.

The console's agent runs execute tools; a chat answer executes nothing. That
difference is deliberate:

* a chat turn is **one model call**, charged before dispatch and recorded as an
  event in the same SHA-256 chain as a run;
* it never touches the tool registry, the gate or the verifier, because there is
  no action to gate and no result to recompute;
* attachments are text folded into the user message, not files read by a tool;
* "regenerate" and "edit" append events and supersede old messages — the chain
  stays append-only, the active branch is a projection.

Provider resolution lives in :mod:`flowagent.chat_config`, the streaming
transport in :mod:`flowagent.chat_provider`; this module owns threads, budgets
and the append-only projection. The names are re-exported here so callers see
one chat surface.
"""

from __future__ import annotations

import json
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .chat_config import (
    CHAT_CONFIG_VERSION,
    CHAT_PROVIDER_KEYS,
    CONFIGURABLE_PROVIDERS,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    MAX_ATTACHMENTS_BYTES,
    MAX_HISTORY_MESSAGES,
    MAX_TEXT,
    ChatProviderConfig,
    _env_int,
    _peek_model,
    load_chat_config,
    redact_chat_config,
    resolve_chat_provider,
    save_chat_config,
)
from .chat_provider import (  # noqa: F401 - re-exported transport
    _MockProvider,
    _RemoteProvider,
    _cost,
    _estimate_tokens,
    parse_sse_data,
)
from .core.contracts import AgentError, Task
from .core.receipts import ReceiptStore
from .core.store import TaskStore, utc_now
from .pacing import pace_key, reserve_slot
from .runtime.budget import Budget, BudgetLimits

__all__ = [
    "CHAT_VERSION",
    "CHAT_CONFIG_VERSION",
    "CONFIGURABLE_PROVIDERS",
    "CHAT_PROVIDER_KEYS",
    "ChatService",
    "ChatProviderConfig",
    "resolve_chat_provider",
    "load_chat_config",
    "save_chat_config",
    "redact_chat_config",
    "parse_sse_data",
]

CHAT_VERSION = "flowagent.chat/v1"

CHAT_SYSTEM_PROMPT = (
    "你是 FCode 里的对话助手。用中文、清楚、简洁地回答。"
    "你只能回答，不能执行工具、读写文件或运行命令；"
    "如果用户需要执行任务，明确告诉他切换到“委托运行”，不要声称你已经执行了任何动作。"
    "不知道就直说，不要编造。"
)

DEFAULT_CHAT_LIMITS = BudgetLimits(60, 0, 300_000, 200_000)

DEFAULT_CHAT_LIMITS = BudgetLimits(60, 0, 300_000, 200_000)

# ------------------------------------------------------------------ service


class ChatService:
    """Threads, messages and streaming answers, backed by the task chain."""

    def __init__(self, db_path: Path, config_path: Path | None = None) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.store = TaskStore(db_path)
        self.receipts = ReceiptStore(self.store)
        self._lock = threading.RLock()
        self._db_path = db_path
        # Settings overrides live next to the chat database (Application
        # Support in the desktop bundle), win over the environment, and never
        # enter the event chain, traces or logs.
        self._config_path = config_path
        self._config = load_chat_config(config_path)
        # Archiving is a tombstone, not a delete: the event chain and receipts
        # stay verifiable; only the sidebar hides the thread.
        self.store._conn.executescript("""
CREATE TABLE IF NOT EXISTS chat_thread_meta (
    thread_id   TEXT PRIMARY KEY,
    archived    INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT NOT NULL DEFAULT ''
);
""")

    # -------------------------------------------------------------- helpers

    def limits(self) -> BudgetLimits:
        return BudgetLimits(
            max_calls=_env_int("FCODE_CHAT_MAX_CALLS", DEFAULT_CHAT_LIMITS.max_calls),
            max_reads=0,
            max_cost_microusd=_env_int(
                "FCODE_CHAT_MAX_COST_MICROUSD", DEFAULT_CHAT_LIMITS.max_cost_microusd
            ),
            max_tokens=_env_int("FCODE_CHAT_MAX_TOKENS", DEFAULT_CHAT_LIMITS.max_tokens),
        )

    def _overrides_for(self, model: str | None) -> dict[str, Any]:
        key = (model or "mock").strip().lower()
        if key not in CONFIGURABLE_PROVIDERS:
            return {}
        return (self._config.get("providers") or {}).get(key) or {}

    def check_model(self, model: str | None) -> dict[str, Any]:
        config = resolve_chat_provider(model, self._overrides_for(model))
        return {
            "key": config.key,
            "label": config.label,
            "model": config.model,
            "remote": config.remote,
            "maxCompletionTokens": config.max_completion_tokens,
            "price": {
                "inputMicrousdPerMtok": config.input_price_microusd_per_mtok,
                "outputMicrousdPerMtok": config.output_price_microusd_per_mtok,
            },
        }

    def default_model(self) -> str:
        return str(self._config.get("default_model") or "mock")

    def config_snapshot(self) -> dict[str, Any]:
        """Redacted settings + model menu, the shape the settings page renders."""
        return {
            "config": redact_chat_config(self._config),
            "models": self.chat_models(),
            "default": self.default_model(),
        }

    def chat_models(self) -> list[dict[str, Any]]:
        """The chat model menu: availability judged from overrides + env."""
        models: list[dict[str, Any]] = []
        labels = {"mock": "离线 Mock", "kimi": "Kimi 云端", "deepseek": "DeepSeek 云端", "local": "本地模型"}
        for key in CHAT_PROVIDER_KEYS:
            overrides = self._overrides_for(key)
            try:
                config = resolve_chat_provider(key, overrides)
                models.append({
                    "key": key,
                    "label": labels[key],
                    "model": config.model,
                    "available": True,
                    "reason": "",
                    "remote": config.remote,
                    "price": {
                        "inputMicrousdPerMtok": config.input_price_microusd_per_mtok,
                        "outputMicrousdPerMtok": config.output_price_microusd_per_mtok,
                    } if config.remote else None,
                })
            except AgentError as error:
                models.append({
                    "key": key,
                    "label": labels[key],
                    "model": _peek_model(key, overrides),
                    "available": False,
                    "reason": error.message,
                    "remote": key != "mock",
                    "price": None,
                })
        return models

    def update_config(
        self,
        *,
        provider: str | None = None,
        values: dict[str, Any] | None = None,
        default_model: str | None = None,
    ) -> dict[str, Any]:
        """Validate and persist settings overrides; empty string clears a field.

        Returns the redacted config plus the refreshed model menu. The stored
        file is the only place the API key is written — never the chain, traces
        or logs — and it lives outside the repository.
        """
        if provider is not None and provider not in CONFIGURABLE_PROVIDERS:
            raise AgentError(
                "CHAT_CONFIG_INVALID",
                f"provider must be one of {', '.join(CONFIGURABLE_PROVIDERS)}",
            )
        clean: dict[str, str] = {}
        if provider is not None:
            allowed = {
                "api_key", "model",
                "input_price_microusd_per_mtok", "output_price_microusd_per_mtok",
                "min_interval_seconds", "max_completion_tokens",
            }
            # Endpoint overrides for the cloud providers are an exfiltration
            # path (a stolen settings write could redirect the stored key).
            # Their base URL stays host/env-configured; only local endpoints
            # are editable from the UI.
            if provider == "local":
                allowed.add("base_url")
            if not isinstance(values, dict):
                raise AgentError("CHAT_CONFIG_INVALID", "values must be an object")
            for name, raw in values.items():
                if name not in allowed:
                    raise AgentError("CHAT_CONFIG_INVALID", f"unknown field {name!r}")
                text = "" if raw is None else str(raw).strip()
                if text == "":
                    clean[name] = ""  # explicit clear: fall back to env/default
                    continue
                if name == "api_key" and len(text) > 300:
                    raise AgentError("CHAT_CONFIG_INVALID", "api key is too long")
                if name == "model" and len(text) > 120:
                    raise AgentError("CHAT_CONFIG_INVALID", "model name is too long")
                if name == "base_url" and not text.startswith(("http://", "https://")):
                    raise AgentError("CHAT_CONFIG_INVALID", "base url must start with http(s)://")
                if name in ("input_price_microusd_per_mtok", "output_price_microusd_per_mtok"):
                    try:
                        price = int(text)
                    except ValueError:
                        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must be an integer")
                    if price <= 0:
                        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must be positive")
                    clean[name] = str(price)
                    continue
                if name == "min_interval_seconds":
                    try:
                        interval = float(text)
                    except ValueError:
                        raise AgentError("CHAT_CONFIG_INVALID", "min_interval_seconds must be a number")
                    if interval < 0 or interval > 3600:
                        raise AgentError("CHAT_CONFIG_INVALID", "min_interval_seconds must be 0..3600")
                    clean[name] = text
                    continue
                if name == "max_completion_tokens":
                    try:
                        tokens = int(text)
                    except ValueError:
                        raise AgentError("CHAT_CONFIG_INVALID", "max_completion_tokens must be an integer")
                    if not 1 <= tokens <= 32768:
                        raise AgentError("CHAT_CONFIG_INVALID", "max_completion_tokens must be 1..32768")
                    clean[name] = str(tokens)
                    continue
                clean[name] = text
        with self._lock:
            providers = dict(self._config.get("providers") or {})
            if provider is not None:
                block = dict(providers.get(provider) or {})
                for name, value in clean.items():
                    if value == "":
                        block.pop(name, None)
                    else:
                        block[name] = value
                if block:
                    providers[provider] = block
                else:
                    providers.pop(provider, None)
            config = {"version": CHAT_CONFIG_VERSION, "providers": providers}
            if default_model is not None:
                if default_model not in CHAT_PROVIDER_KEYS:
                    raise AgentError("CHAT_CONFIG_INVALID", f"default model must be one of {', '.join(CHAT_PROVIDER_KEYS)}")
                config["default_model"] = default_model
            elif self._config.get("default_model"):
                config["default_model"] = self._config["default_model"]
            self._config = config
            save_chat_config(self._config_path, config)
        return self.config_snapshot()

    def _thread_exists(self, thread_id: str) -> bool:
        row = self.store._conn.execute(
            "SELECT 1 FROM task WHERE id=?", (thread_id,)
        ).fetchone()
        return row is not None

    def _create_thread(self, title: str) -> Task:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        thread_id = f"chat-{stamp}-{secrets.token_hex(2)}"
        task = Task(
            id=thread_id,
            principal="console-operator",
            objective=(title or "新对话")[:80],
            binding={"kind": "chat"},
            allowed_tools=[],
            model_grant={},
        )
        return self.store.create(task)

    def _load_task(self, thread_id: str) -> Task:
        if not thread_id.startswith("chat-"):
            raise AgentError("CHAT_THREAD_NOT_FOUND", f"no chat thread {thread_id!r}")
        try:
            return self.store.load(thread_id)
        except AgentError as error:
            if error.code == "TASK_NOT_FOUND":
                raise AgentError("CHAT_THREAD_NOT_FOUND", f"no chat thread {thread_id!r}")
            raise

    def _append(self, task: Task, event: str, detail: dict[str, Any]) -> Task:
        with self._lock:
            return self.store.save(task, task.sequence, event, detail)

    @staticmethod
    def _title(text: str) -> str:
        compact = " ".join(str(text or "").split())
        return (compact[:30] + "…") if len(compact) > 30 else (compact or "新对话")

    def _replay(self, thread_id: str) -> list[dict[str, Any]]:
        """Project the append-only events onto the active message branch."""
        messages: list[dict[str, Any]] = []
        superseded: set[str] = set()
        by_id: dict[str, dict[str, Any]] = {}
        for event in self.store.events(thread_id):
            detail = (event.get("payload") or {}).get("detail") or {}
            kind = event["type"]
            seq = int(event["sequence"])
            if kind == "chat_user":
                message = {
                    "id": str(detail.get("id") or f"m-{seq}"),
                    "role": "user",
                    "text": str(detail.get("text") or ""),
                    "attachments": list(detail.get("attachments") or []),
                    "status": "ok",
                    "seq": seq,
                    "at": event["at"],
                }
                messages.append(message)
                by_id[message["id"]] = message
            elif kind == "chat_assistant":
                message = {
                    "id": str(detail.get("id") or f"a-{seq}"),
                    "role": "assistant",
                    "text": str(detail.get("text") or ""),
                    "reasoning": str(detail.get("reasoning") or ""),
                    "status": str(detail.get("status") or "ok"),
                    "usage": dict(detail.get("usage") or {}),
                    "receipt_ref": str(detail.get("receipt_ref") or ""),
                    "provider": str(detail.get("provider") or ""),
                    "model": str(detail.get("model") or ""),
                    "error": dict(detail.get("error") or {}),
                    "seq": seq,
                    "at": event["at"],
                }
                messages.append(message)
                by_id[message["id"]] = message
            elif kind == "chat_edit":
                target = str(detail.get("target_id") or "")
                target_seq = int((by_id.get(target) or {}).get("seq", seq))
                superseded.add(target)
                for message in messages:
                    if int(message.get("seq", 0)) > target_seq:
                        superseded.add(message["id"])
                new = detail.get("message") or {}
                message = {
                    "id": str(new.get("id") or f"m-{seq}"),
                    "role": "user",
                    "text": str(new.get("text") or ""),
                    "attachments": list(new.get("attachments") or []),
                    "status": "ok",
                    "edited": True,
                    "seq": seq,
                    "at": event["at"],
                }
                messages.append(message)
                by_id[message["id"]] = message
            elif kind == "chat_regenerate":
                target = str(detail.get("target_id") or "")
                target_seq = int((by_id.get(target) or {}).get("seq", seq))
                superseded.add(target)
                for message in messages:
                    if int(message.get("seq", 0)) > target_seq:
                        superseded.add(message["id"])
            elif kind == "chat_cancelled":
                target = str(detail.get("assistant_id") or "")
                text = str(detail.get("text") or "")
                reasoning = str(detail.get("reasoning") or "")
                existing = by_id.get(target)
                if existing is not None:
                    existing["status"] = "cancelled"
                    existing["text"] = text or existing["text"]
                    existing["reasoning"] = reasoning or existing.get("reasoning", "")
                else:
                    message = {
                        "id": target or f"a-{seq}",
                        "role": "assistant",
                        "text": text,
                        "reasoning": reasoning,
                        "status": "cancelled",
                        "usage": dict(detail.get("usage") or {}),
                        "receipt_ref": "",
                        "provider": str(detail.get("provider") or ""),
                        "model": str(detail.get("model") or ""),
                        "error": {},
                        "seq": seq,
                        "at": event["at"],
                    }
                    messages.append(message)
                    by_id[message["id"]] = message
            elif kind == "chat_error":
                target = str(detail.get("assistant_id") or "")
                existing = by_id.get(target)
                if existing is not None:
                    existing["status"] = "error"
                    existing["error"] = {
                        "code": str(detail.get("code") or "CHAT_FAILED"),
                        "message": str(detail.get("message") or ""),
                    }
                else:
                    message = {
                        "id": target or f"a-{seq}",
                        "role": "assistant",
                        "text": str(detail.get("text") or ""),
                        "reasoning": "",
                        "status": "error",
                        "usage": dict(detail.get("usage") or {}),
                        "receipt_ref": "",
                        "provider": "",
                        "model": "",
                        "error": {
                            "code": str(detail.get("code") or "CHAT_FAILED"),
                            "message": str(detail.get("message") or ""),
                        },
                        "seq": seq,
                        "at": event["at"],
                    }
                    messages.append(message)
                    by_id[message["id"]] = message
        return [message for message in messages if message["id"] not in superseded]

    @staticmethod
    def _public_message(message: dict[str, Any]) -> dict[str, Any]:
        """Strip attachment bodies before a message leaves the server."""
        public = {key: value for key, value in message.items() if key != "attachments"}
        public["attachments"] = [
            {"name": item.get("name", ""), "bytes": int(item.get("bytes") or 0)}
            for item in message.get("attachments") or []
            if isinstance(item, dict)
        ]
        return public

    def list_threads(self, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        offset = max(0, int(offset))
        rows = self.store._conn.execute(
            "SELECT t.id, t.body, t.updated_at FROM task t"
            " WHERE t.id LIKE 'chat-%' AND NOT EXISTS ("
            "   SELECT 1 FROM chat_thread_meta m"
            "   WHERE m.thread_id = t.id AND m.archived = 1)"
            " ORDER BY t.updated_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
        threads = []
        for row in rows:
            try:
                body = json.loads(row["body"])
            except ValueError:
                continue
            threads.append({
                "id": row["id"],
                "title": str(body.get("objective") or "新对话"),
                "updated_at": row["updated_at"],
            })
        return threads

    def thread_count(self) -> int:
        row = self.store._conn.execute(
            "SELECT COUNT(*) AS n FROM task t"
            " WHERE t.id LIKE 'chat-%' AND NOT EXISTS ("
            "   SELECT 1 FROM chat_thread_meta m"
            "   WHERE m.thread_id = t.id AND m.archived = 1)",
        ).fetchone()
        return int(row["n"] or 0)

    def archive_thread(self, thread_id: str) -> dict[str, Any]:
        """Hide a thread from the sidebar without destroying its evidence."""
        with self._lock:
            self._load_task(thread_id)
            with self.store.transaction():
                self.store._conn.execute(
                    "INSERT INTO chat_thread_meta (thread_id, archived, archived_at)"
                    " VALUES (?, 1, ?)"
                    " ON CONFLICT(thread_id) DO UPDATE SET"
                    " archived = 1, archived_at = excluded.archived_at",
                    (thread_id, utc_now()),
                )
        return {"id": thread_id, "archived": True}

    def archive_stale(self, days: int, *, now: datetime | None = None) -> int:
        """Archive threads untouched for ``days`` days; never delete events.

        Retention is a visibility policy, not a shredder: the tombstone hides
        the thread from the sidebar while the chain and receipts stay auditable.
        ``days <= 0`` disables it.
        """
        if days <= 0:
            return 0
        moment = now or datetime.now(timezone.utc)
        cutoff = (moment - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        with self._lock, self.store.transaction():
            rows = self.store._conn.execute(
                "SELECT t.id FROM task t WHERE t.id LIKE 'chat-%'"
                " AND t.updated_at < ? AND NOT EXISTS ("
                "   SELECT 1 FROM chat_thread_meta m"
                "   WHERE m.thread_id = t.id AND m.archived = 1)",
                (cutoff,),
            ).fetchall()
            for row in rows:
                self.store._conn.execute(
                    "INSERT INTO chat_thread_meta (thread_id, archived, archived_at)"
                    " VALUES (?, 1, ?)"
                    " ON CONFLICT(thread_id) DO UPDATE SET"
                    " archived = 1, archived_at = excluded.archived_at",
                    (row["id"], utc_now()),
                )
        return len(rows)

    def get_thread(self, thread_id: str) -> dict[str, Any]:
        task = self._load_task(thread_id)
        events = self.store.events(thread_id)
        messages = self._replay(thread_id)
        budget = Budget(self.store, f"chat:{thread_id}", self.limits()).snapshot()
        return {
            "id": thread_id,
            "title": task.objective or "新对话",
            "created_at": events[0]["at"] if events else "",
            "updated_at": events[-1]["at"] if events else "",
            "model": task.binding.get("model", ""),
            "messages": [self._public_message(message) for message in messages],
            "budget": budget,
            "events": len(events),
            "chain_head": events[-1]["hash"] if events else "",
        }

    # ------------------------------------------------------------- validation

    @staticmethod
    def _normalise_attachments(attachments: Any) -> list[dict[str, Any]]:
        if attachments is None:
            return []
        if not isinstance(attachments, list):
            raise AgentError("CHAT_ATTACHMENT_INVALID", "attachments must be a list")
        if len(attachments) > MAX_ATTACHMENTS:
            raise AgentError("CHAT_ATTACHMENT_INVALID", f"at most {MAX_ATTACHMENTS} attachments")
        clean: list[dict[str, Any]] = []
        total = 0
        for item in attachments:
            if not isinstance(item, dict):
                raise AgentError("CHAT_ATTACHMENT_INVALID", "each attachment must be an object")
            name = str(item.get("name") or "").strip()[:120]
            text = item.get("text")
            if not name or not isinstance(text, str):
                raise AgentError("CHAT_ATTACHMENT_INVALID", "attachment needs name and text")
            size = len(text.encode("utf-8"))
            if size > MAX_ATTACHMENT_BYTES:
                raise AgentError(
                    "CHAT_ATTACHMENT_INVALID",
                    f"{name} is larger than {MAX_ATTACHMENT_BYTES // 1024} KiB",
                )
            total += size
            clean.append({"name": name, "text": text, "bytes": size})
        if total > MAX_ATTACHMENTS_BYTES:
            raise AgentError("CHAT_ATTACHMENT_INVALID", "attachments exceed the total size limit")
        return clean

    # ---------------------------------------------------------------- prompts

    @staticmethod
    def _attachment_block(attachments: list[dict[str, Any]]) -> str:
        if not attachments:
            return ""
        parts = []
        for item in attachments:
            parts.append(
                f"\n\n[附件：{item['name']}]\n```text\n{item['text']}\n```"
            )
        return "".join(parts)

    def _prompt_messages(self, thread_id: str) -> list[dict[str, Any]]:
        messages = [{"role": "system", "content": CHAT_SYSTEM_PROMPT}]
        active = self._replay(thread_id)[-MAX_HISTORY_MESSAGES:]
        for message in active:
            if message["role"] == "user":
                content = message["text"] + self._attachment_block(message.get("attachments") or [])
                messages.append({"role": "user", "content": content})
            elif message["status"] == "ok" and message["text"]:
                messages.append({"role": "assistant", "content": message["text"]})
        return messages

    # --------------------------------------------------------------- streaming

    def _provider(self, model: str | None):
        config = resolve_chat_provider(model, self._overrides_for(model))
        if config.key == "mock":
            return config, _MockProvider(config.model)
        return config, _RemoteProvider(config)

    def _answer(
        self,
        thread: Task,
        user_message: dict[str, Any],
        model: str | None,
    ) -> Iterator[dict[str, Any]]:
        thread_id = thread.id
        assistant_id = f"a-{secrets.token_hex(6)}"
        started = time.monotonic()
        try:
            config, provider = self._provider(model)
        except Exception as error:  # noqa: BLE001 — configuration errors belong in the chain
            code = getattr(error, "code", "CHAT_CONFIG_INVALID")
            message = getattr(error, "message", None) or f"{type(error).__name__}: {error}"
            thread = self._append(thread, "chat_error", {
                "assistant_id": assistant_id,
                "user_id": user_message["id"],
                "code": code,
                "message": message,
                "text": "",
            })
            yield {
                "type": "error",
                "thread_id": thread_id,
                "user_id": user_message["id"],
                "assistant_id": assistant_id,
                "code": code,
                "message": message,
            }
            return
        messages = self._prompt_messages(thread_id)

        prompt_estimate = _estimate_tokens(messages)
        reserve_tokens = prompt_estimate + config.max_completion_tokens
        reserve_cost = _cost(prompt_estimate, config.max_completion_tokens, config)
        budget = Budget(self.store, f"chat:{thread_id}", self.limits())
        try:
            budget.charge_call(tokens=reserve_tokens, cost_microusd=reserve_cost)
        except AgentError as error:
            detail = {
                "assistant_id": assistant_id,
                "user_id": user_message["id"],
                "code": error.code,
                "message": error.message,
                "text": "",
            }
            thread = self._append(thread, "chat_error", detail)
            yield {
                "type": "error",
                "thread_id": thread_id,
                "user_id": user_message["id"],
                "assistant_id": assistant_id,
                "code": error.code,
                "message": error.message,
                "budget": budget.snapshot(),
            }
            return

        yield {
            "type": "start",
            "thread_id": thread_id,
            "thread_title": thread.objective or "新对话",
            "user": self._public_message(user_message),
            "assistant_id": assistant_id,
            "provider": {"key": config.key, "label": config.label, "model": config.model},
            "reserved": {"tokens": reserve_tokens, "cost_microusd": reserve_cost},
            "budget": budget.snapshot(),
        }

        wait = reserve_slot(
            pace_key(config.key, config.base_url),
            config.min_interval_seconds,
        )
        if wait > 0:
            yield {"type": "wait", "seconds": int(wait + 0.999), "provider": config.label}
            remaining = wait
            while remaining > 0:
                time.sleep(min(0.25, remaining))
                remaining -= 0.25

        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        usage: dict[str, Any] = {}
        finish_reason = ""
        finalised = False
        try:
            for item in provider.stream(messages):
                if "delta" in item:
                    chunk = str(item["delta"])
                    text_parts.append(chunk)
                    yield {"type": "delta", "text": chunk, "assistant_id": assistant_id}
                elif "reasoning" in item:
                    chunk = str(item["reasoning"])
                    reasoning_parts.append(chunk)
                    yield {"type": "reasoning", "text": chunk, "assistant_id": assistant_id}
                elif "usage" in item and isinstance(item["usage"], dict):
                    usage = item["usage"]
                elif "finish_reason" in item:
                    finish_reason = str(item["finish_reason"])

            text = "".join(text_parts)
            reasoning = "".join(reasoning_parts)
            prompt_tokens = int(usage.get("prompt_tokens") or prompt_estimate)
            completion_tokens = int(
                usage.get("completion_tokens")
                or max(1, len(text) // 3)
            )
            total_tokens = int(usage.get("total_tokens") or (prompt_tokens + completion_tokens))
            actual_cost = _cost(prompt_tokens, completion_tokens, config)
            latency_ms = int((time.monotonic() - started) * 1000)
            receipt_ref = self.receipts.issue(
                intent={
                    "thread_id": thread_id,
                    "user_message_id": user_message["id"],
                    "assistant_id": assistant_id,
                },
                plan={"version": CHAT_VERSION, "kind": "answer", "model": config.model},
                usage={
                    "provider": config.key,
                    "model": config.model,
                    "tokens": total_tokens,
                    "cost_microusd": actual_cost,
                    "latency_ms": latency_ms,
                    "finish_reason": finish_reason or "stop",
                    "external_billing": "not-verified",
                },
            )
            detail = {
                "id": assistant_id,
                "user_id": user_message["id"],
                "text": text,
                "reasoning": reasoning,
                "status": "ok",
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": total_tokens,
                    "cost_microusd": actual_cost,
                    "latency_ms": latency_ms,
                    "reserved_tokens": reserve_tokens,
                    "reserved_cost_microusd": reserve_cost,
                },
                "receipt_ref": receipt_ref,
                "provider": config.key,
                "model": config.model,
            }
            thread = self._append(thread, "chat_assistant", detail)
            finalised = True
            message = {
                "id": assistant_id,
                "role": "assistant",
                "text": text,
                "reasoning": reasoning,
                "status": "ok",
                "usage": detail["usage"],
                "receipt_ref": receipt_ref,
                "provider": config.key,
                "model": config.model,
                "error": {},
                "at": "",
                "seq": thread.sequence,
            }
            yield {
                "type": "done",
                "message": message,
                "budget": budget.snapshot(),
                "thread_id": thread_id,
            }
        except Exception as error:  # noqa: BLE001 — a malformed provider chunk is an error, not a cancel
            text = "".join(text_parts)
            reasoning = "".join(reasoning_parts)
            code = error.code if isinstance(error, AgentError) else "CHAT_STREAM_FAILED"
            message = (
                error.message if isinstance(error, AgentError)
                else f"{type(error).__name__}: {error}"
            )
            detail = {
                "assistant_id": assistant_id,
                "user_id": user_message["id"],
                "code": code,
                "message": message,
                "text": text,
                "reasoning": reasoning,
                "usage": usage,
            }
            thread = self._append(thread, "chat_error", detail)
            finalised = True
            yield {
                "type": "error",
                "code": code,
                "message": message,
                "assistant_id": assistant_id,
                "partial": text,
                "budget": budget.snapshot(),
            }
        finally:
            if not finalised:
                text = "".join(text_parts)
                reasoning = "".join(reasoning_parts)
                self._append(thread, "chat_cancelled", {
                    "assistant_id": assistant_id,
                    "user_id": user_message["id"],
                    "text": text,
                    "reasoning": reasoning,
                    "usage": usage,
                    "provider": config.key,
                    "model": config.model,
                })

    def send(
        self,
        *,
        thread_id: str | None,
        text: str,
        attachments: Any = None,
        model: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        clean_text = str(text or "").strip()
        clean_attachments = self._normalise_attachments(attachments)
        if not clean_text and not clean_attachments:
            raise AgentError("CHAT_MESSAGE_INVALID", "message is empty")
        if len(clean_text) > MAX_TEXT:
            raise AgentError("CHAT_MESSAGE_INVALID", f"message exceeds {MAX_TEXT} characters")

        with self._lock:
            thread = self._load_task(thread_id) if thread_id else self._create_thread(self._title(clean_text))
        message_id = f"m-{secrets.token_hex(6)}"
        detail = {
            "id": message_id,
            "text": clean_text,
            "attachments": clean_attachments,
            "model": str(model or "mock"),
        }
        thread = self._append(thread, "chat_user", detail)
        user_message = {
            "id": message_id,
            "role": "user",
            "text": clean_text,
            "attachments": clean_attachments,
            "status": "ok",
            "seq": thread.sequence,
            "at": "",
        }
        yield from self._answer(thread, user_message, model)

    def edit(
        self,
        *,
        thread_id: str,
        message_id: str,
        text: str,
        attachments: Any = None,
        model: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        clean_text = str(text or "").strip()
        clean_attachments = self._normalise_attachments(attachments)
        if not clean_text and not clean_attachments:
            raise AgentError("CHAT_MESSAGE_INVALID", "message is empty")
        if len(clean_text) > MAX_TEXT:
            raise AgentError("CHAT_MESSAGE_INVALID", f"message exceeds {MAX_TEXT} characters")
        with self._lock:
            thread = self._load_task(thread_id)
            target = next(
                (message for message in self._replay(thread_id)
                 if message["id"] == message_id and message["role"] == "user"),
                None,
            )
            if target is None:
                raise AgentError("CHAT_MESSAGE_NOT_FOUND", f"no user message {message_id!r}")
            new_user = {
                "id": f"m-{secrets.token_hex(6)}",
                "text": clean_text,
                "attachments": clean_attachments,
                "model": str(model or "mock"),
            }
            thread = self._append(thread, "chat_edit", {
                "target_id": message_id,
                "message": new_user,
            })
        user_message = {
            "id": new_user["id"],
            "role": "user",
            "text": clean_text,
            "attachments": clean_attachments,
            "status": "ok",
            "seq": thread.sequence,
            "at": "",
        }
        yield from self._answer(thread, user_message, model)

    def regenerate(
        self,
        *,
        thread_id: str,
        message_id: str,
        model: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        with self._lock:
            thread = self._load_task(thread_id)
            active = self._replay(thread_id)
            index = next(
                (position for position, message in enumerate(active) if message["id"] == message_id),
                None,
            )
            if index is None or active[index]["role"] != "assistant":
                raise AgentError("CHAT_MESSAGE_NOT_FOUND", f"no assistant message {message_id!r}")
            user_index = index
            while user_index >= 0 and active[user_index]["role"] != "user":
                user_index -= 1
            if user_index < 0:
                raise AgentError("CHAT_MESSAGE_NOT_FOUND", "no user message precedes this answer")
            user_message = active[user_index]
            thread = self._append(thread, "chat_regenerate", {"target_id": message_id})
        yield from self._answer(thread, user_message, model)

    def close(self) -> None:
        self.store.close()
