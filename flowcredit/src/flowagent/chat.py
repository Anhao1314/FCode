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

The provider layer is a small OpenAI-compatible SSE client (stdlib only). The
mock provider keeps the whole surface usable offline; Kimi/DeepSeek require the
same host-reviewed prices as the agent providers and fail closed without them.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlsplit

from .core.contracts import AgentError, Task
from .core.receipts import ReceiptStore
from .core.store import TaskStore
from .runtime.budget import Budget, BudgetLimits

__all__ = [
    "CHAT_VERSION",
    "CHAT_CONFIG_VERSION",
    "ChatService",
    "ChatProviderConfig",
    "resolve_chat_provider",
    "load_chat_config",
    "save_chat_config",
    "redact_chat_config",
    "parse_sse_data",
]

CHAT_VERSION = "flowagent.chat/v1"
CHAT_CONFIG_VERSION = "fcode.chat-config/v1"
#: Providers a settings page may configure. ``mock`` needs nothing.
CONFIGURABLE_PROVIDERS = ("kimi", "deepseek", "local")
CHAT_PROVIDER_KEYS = ("mock",) + CONFIGURABLE_PROVIDERS

CHAT_SYSTEM_PROMPT = (
    "你是 FCode 里的对话助手。用中文、清楚、简洁地回答。"
    "你只能回答，不能执行工具、读写文件或运行命令；"
    "如果用户需要执行任务，明确告诉他切换到“委托运行”，不要声称你已经执行了任何动作。"
    "不知道就直说，不要编造。"
)

MAX_TEXT = 8_000
MAX_ATTACHMENTS = 3
MAX_ATTACHMENT_BYTES = 64 * 1024
MAX_ATTACHMENTS_BYTES = 128 * 1024
MAX_HISTORY_MESSAGES = 24
DEFAULT_MAX_COMPLETION = 2_048
DEFAULT_CHAT_LIMITS = BudgetLimits(60, 0, 300_000, 200_000)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must be an integer")
    if value <= 0:
        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must be positive")
    return value


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(0.0, float(raw))
    except ValueError:
        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must be a number")


def _require_price(name: str) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        raise AgentError("CHAT_PROVIDER_UNAVAILABLE", f"missing {name}")
    try:
        value = int(raw)
    except ValueError:
        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must be an integer")
    if value < 0:
        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must not be negative")
    return value


@dataclass(frozen=True)
class ChatProviderConfig:
    key: str
    label: str
    model: str
    base_url: str = ""
    api_key: str = ""
    input_price_microusd_per_mtok: int = 0
    output_price_microusd_per_mtok: int = 0
    min_interval_seconds: float = 0.0
    timeout_seconds: float = 120.0
    max_completion_tokens: int = DEFAULT_MAX_COMPLETION
    completion_field: str = "max_tokens"

    @property
    def remote(self) -> bool:
        return bool(self.base_url)


def _ov_str(overrides: dict[str, Any], name: str) -> str:
    value = overrides.get(name)
    if value is None:
        return ""
    text = str(value).strip()
    return text


def _ov_int(overrides: dict[str, Any], name: str) -> int | None:
    raw = overrides.get(name)
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return int(str(raw).strip())
    except ValueError:
        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must be an integer")


def _ov_float(overrides: dict[str, Any], name: str) -> float | None:
    raw = overrides.get(name)
    if raw is None or str(raw).strip() == "":
        return None
    try:
        return float(raw)
    except ValueError:
        raise AgentError("CHAT_CONFIG_INVALID", f"{name} must be a number")


def _remote_config(
    key: str,
    label: str,
    overrides: dict[str, Any],
    *,
    api_env: str,
    model_env: str,
    base_env: str,
    base_default: str,
    model_default: str,
    in_price_env: str,
    out_price_env: str,
    interval_env: str,
) -> ChatProviderConfig:
    """Resolve one remote provider: settings override > environment > default.

    Nothing is ever silently free: if neither settings nor env provide the key
    or both prices, the provider stays unavailable with the exact missing list.
    """
    override_api = _ov_str(overrides, "api_key")
    api_key = override_api or os.environ.get(api_env, "").strip()
    model = _ov_str(overrides, "model") or os.environ.get(model_env, "").strip() or model_default
    base_url = _ov_str(overrides, "base_url") or os.environ.get(base_env, "").strip() or base_default

    missing: list[str] = []
    if not api_key:
        missing.append(api_env)

    input_price = _ov_int(overrides, "input_price_microusd_per_mtok")
    if input_price is None:
        raw = os.environ.get(in_price_env, "").strip()
        if raw:
            try:
                input_price = int(raw)
            except ValueError:
                raise AgentError("CHAT_CONFIG_INVALID", f"{in_price_env} must be an integer")
        else:
            input_price = None
            missing.append(in_price_env)
    elif input_price <= 0:
        raise AgentError("CHAT_CONFIG_INVALID", "input price must be positive")
    output_price = _ov_int(overrides, "output_price_microusd_per_mtok")
    if output_price is None:
        raw = os.environ.get(out_price_env, "").strip()
        if raw:
            try:
                output_price = int(raw)
            except ValueError:
                raise AgentError("CHAT_CONFIG_INVALID", f"{out_price_env} must be an integer")
        else:
            output_price = None
            missing.append(out_price_env)
    elif output_price <= 0:
        raise AgentError("CHAT_CONFIG_INVALID", "output price must be positive")
    if missing:
        raise AgentError(
            "CHAT_PROVIDER_UNAVAILABLE",
            f"{label} 未配置：缺少 " + "、".join(missing),
        )

    interval = _ov_float(overrides, "min_interval_seconds")
    if interval is None:
        interval = _env_float(interval_env, 0.0)
    max_completion = _ov_int(overrides, "max_completion_tokens")
    if max_completion is None:
        max_completion = _env_int("CHAT_MAX_COMPLETION_TOKENS", DEFAULT_MAX_COMPLETION)
    if not 1 <= max_completion <= 32768:
        raise AgentError("CHAT_CONFIG_INVALID", "max completion tokens must be 1..32768")
    return ChatProviderConfig(
        key=key,
        label=label,
        model=model,
        base_url=base_url,
        api_key=api_key,
        input_price_microusd_per_mtok=input_price,
        output_price_microusd_per_mtok=output_price,
        min_interval_seconds=max(0.0, interval),
        timeout_seconds=_env_float("CHAT_STREAM_TIMEOUT_SECONDS", 120.0),
        max_completion_tokens=max_completion,
        completion_field="max_completion_tokens" if key == "kimi" else "max_tokens",
    )


def _kimi_config(overrides: dict[str, Any]) -> ChatProviderConfig:
    return _remote_config(
        "kimi",
        "Kimi",
        overrides,
        api_env="KIMI_API_KEY",
        model_env="KIMI_MODEL",
        base_env="KIMI_BASE_URL",
        base_default="https://api.moonshot.cn/v1",
        model_default="kimi-k2.6",
        in_price_env="KIMI_INPUT_PRICE_MICROUSD_PER_MTOK",
        out_price_env="KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK",
        interval_env="KIMI_MIN_CALL_INTERVAL_SECONDS",
    )


def _deepseek_config(overrides: dict[str, Any]) -> ChatProviderConfig:
    return _remote_config(
        "deepseek",
        "DeepSeek",
        overrides,
        api_env="DEEPSEEK_API_KEY",
        model_env="DEEPSEEK_MODEL",
        base_env="DEEPSEEK_BASE_URL",
        base_default="https://api.deepseek.com/v1",
        model_default="deepseek-chat",
        in_price_env="DEEPSEEK_INPUT_PRICE_MICROUSD_PER_MTOK",
        out_price_env="DEEPSEEK_OUTPUT_PRICE_MICROUSD_PER_MTOK",
        interval_env="DEEPSEEK_MIN_CALL_INTERVAL_SECONDS",
    )


def _local_config(overrides: dict[str, Any]) -> ChatProviderConfig:
    endpoint = _ov_str(overrides, "base_url") or os.environ.get("FCODE_LOCAL_ENDPOINT", "").strip()
    if not endpoint:
        raise AgentError("CHAT_PROVIDER_UNAVAILABLE", "本地模型未配置：缺少 FCODE_LOCAL_ENDPOINT")
    max_completion = _ov_int(overrides, "max_completion_tokens")
    if max_completion is None:
        max_completion = _env_int("CHAT_MAX_COMPLETION_TOKENS", DEFAULT_MAX_COMPLETION)
    if not 1 <= max_completion <= 32768:
        raise AgentError("CHAT_CONFIG_INVALID", "max completion tokens must be 1..32768")
    return ChatProviderConfig(
        key="local",
        label="本地模型",
        model=_ov_str(overrides, "model") or os.environ.get("FCODE_LOCAL_MODEL", "").strip() or "fcode-qwen3-4b",
        base_url=endpoint,
        api_key=_ov_str(overrides, "api_key") or os.environ.get("FCODE_LOCAL_API_KEY", "").strip(),
        timeout_seconds=_env_float("CHAT_STREAM_TIMEOUT_SECONDS", 120.0),
        max_completion_tokens=max_completion,
    )


def _peek_model(key: str, overrides: dict[str, Any]) -> str:
    """The model name to display even when the provider is unavailable."""
    if key == "kimi":
        return _ov_str(overrides, "model") or os.environ.get("KIMI_MODEL", "").strip() or "kimi-k2.6"
    if key == "deepseek":
        return _ov_str(overrides, "model") or os.environ.get("DEEPSEEK_MODEL", "").strip() or "deepseek-chat"
    if key == "local":
        return _ov_str(overrides, "model") or os.environ.get("FCODE_LOCAL_MODEL", "").strip() or "fcode-qwen3-4b"
    return "offline-chat-mock-v1"


def resolve_chat_provider(
    key: str | None,
    overrides: dict[str, Any] | None = None,
) -> ChatProviderConfig:
    normalized = (key or "mock").strip().lower()
    override = overrides if isinstance(overrides, dict) else {}
    if normalized == "mock":
        return ChatProviderConfig(
            key="mock",
            label="离线 Mock",
            model="offline-chat-mock-v1",
            max_completion_tokens=_env_int("CHAT_MAX_COMPLETION_TOKENS", DEFAULT_MAX_COMPLETION),
        )
    if normalized == "kimi":
        return _kimi_config(override)
    if normalized == "deepseek":
        return _deepseek_config(override)
    if normalized == "local":
        return _local_config(override)
    raise AgentError(
        "CHAT_PROVIDER_UNAVAILABLE",
        f"对话模型 {normalized!r} 未接入；可用：mock / kimi / deepseek / local",
    )


# ------------------------------------------------------------ settings store


def load_chat_config(path: Path | None) -> dict[str, Any]:
    """Read the local settings file; anything unexpected reads as empty."""
    if path is None:
        return {"version": CHAT_CONFIG_VERSION, "providers": {}}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": CHAT_CONFIG_VERSION, "providers": {}}
    if not isinstance(raw, dict) or raw.get("version") != CHAT_CONFIG_VERSION:
        return {"version": CHAT_CONFIG_VERSION, "providers": {}}
    providers = raw.get("providers")
    config: dict[str, Any] = {"version": CHAT_CONFIG_VERSION, "providers": {}}
    if isinstance(providers, dict):
        for key in CONFIGURABLE_PROVIDERS:
            block = providers.get(key)
            if not isinstance(block, dict):
                continue
            clean = {
                name: value for name, value in block.items()
                if isinstance(value, (str, int, float)) and str(value).strip() != ""
            }
            if key in ("kimi", "deepseek"):
                clean.pop("base_url", None)
            if clean:
                config["providers"][key] = clean
    default = raw.get("default_model")
    if default in CHAT_PROVIDER_KEYS:
        config["default_model"] = str(default)
    return config


def save_chat_config(path: Path | None, config: dict[str, Any]) -> None:
    """Atomic write with owner-only permissions; the key never goes anywhere else."""
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def redact_chat_config(config: dict[str, Any]) -> dict[str, Any]:
    """The API-facing copy: never the key itself, only set/masked flags."""
    providers: dict[str, Any] = {}
    for key, block in (config.get("providers") or {}).items():
        shown = {name: value for name, value in block.items() if name != "api_key"}
        api_key = str(block.get("api_key") or "")
        shown["api_key_set"] = bool(api_key)
        shown["api_key_masked"] = (api_key[:3] + "…" + api_key[-4:]) if len(api_key) > 8 else ("已设置" if api_key else "")
        providers[key] = shown
    return {
        "version": CHAT_CONFIG_VERSION,
        "providers": providers,
        "default_model": config.get("default_model", "mock"),
    }


# --------------------------------------------------------------------- SSE


def parse_sse_data(line: str | bytes) -> dict[str, Any] | None:
    """Return one JSON object from an SSE ``data:`` line, or None.

    The parser is deliberately strict about the framing and lenient about
    whitespace; a malformed provider line is skipped, not treated as an answer.
    """
    if isinstance(line, bytes):
        line = line.decode("utf-8", errors="replace")
    text = line.strip()
    if not text or text.startswith(":"):
        return None
    if not text.startswith("data:"):
        return None
    payload = text[5:].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        value = json.loads(payload)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


_PACE_LOCK = threading.Lock()
_LAST_CALL: dict[str, float] = {}


def _pace_wait(key: str, interval: float) -> float:
    if interval <= 0:
        return 0.0
    now = time.monotonic()
    with _PACE_LOCK:
        last = _LAST_CALL.get(key, 0.0)
    return max(0.0, interval - (now - last))


def _mark_call(key: str) -> None:
    with _PACE_LOCK:
        _LAST_CALL[key] = time.monotonic()


def _estimate_tokens(messages: list[dict[str, Any]]) -> int:
    characters = sum(len(str(message.get("content") or "")) for message in messages)
    return max(1, characters // 3) + 256


def _cost(prompt_tokens: int, completion_tokens: int, config: ChatProviderConfig) -> int:
    micros = (
        prompt_tokens * config.input_price_microusd_per_mtok
        + completion_tokens * config.output_price_microusd_per_mtok
    )
    return int((micros + 999_999) // 1_000_000)


class _MockProvider:
    name = "offline-mock"

    def __init__(self, model: str) -> None:
        self.model = model

    def stream(self, messages: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        last_user = next(
            (str(m.get("content") or "") for m in reversed(messages) if m.get("role") == "user"),
            "",
        )
        snippet = " ".join(last_user.split())[:80]
        text = (
            f"离线 Mock 回复：我收到了「{snippet}」。\n\n"
            "这是没有调用真实模型时的对话通道，用来验证流式输出、追问、重新生成、"
            "编辑上一条和停止生成。\n\n"
            "在模型菜单里选择 Kimi / DeepSeek，或配置对应的 API 环境变量后，"
            "同一段对话会交给真实模型回答。"
        )
        delay = float(os.environ.get("FCODE_CHAT_MOCK_DELAY", "0.012") or 0)
        for index in range(0, len(text), 8):
            if delay:
                time.sleep(delay)
            yield {"delta": text[index:index + 8]}
        prompt_tokens = _estimate_tokens(messages)
        completion_tokens = max(1, len(text) // 3)
        yield {
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
            "finish_reason": "stop",
        }


class _RemoteProvider:
    def __init__(self, config: ChatProviderConfig) -> None:
        self.config = config
        self.name = config.key
        self.model = config.model

    def stream(self, messages: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        parsed = urlsplit(self.config.base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise AgentError("CHAT_CONFIG_INVALID", f"invalid base URL {self.config.base_url!r}")
        path = (parsed.path.rstrip("/") or "") + "/chat/completions"
        if parsed.query:
            path += "?" + parsed.query
        connection_cls = HTTPSConnection if parsed.scheme == "https" else HTTPConnection
        connection = connection_cls(
            parsed.hostname,
            parsed.port,
            timeout=self.config.timeout_seconds,
        )
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Accept-Encoding": "identity",
            "Connection": "close",
        }
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        payload = {
            "model": self.config.model,
            "messages": messages,
            "stream": True,
            self.config.completion_field: self.config.max_completion_tokens,
        }
        try:
            connection.request("POST", path, body=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                body = response.read(2_000).decode("utf-8", errors="replace")
                raise AgentError(
                    "CHAT_PROVIDER_ERROR",
                    f"{self.config.key} HTTP {response.status}: {body[:300]}",
                )
            for line in response:
                item = parse_sse_data(line)
                if item is None:
                    continue
                usage = item.get("usage")
                if isinstance(usage, dict) and usage:
                    yield {"usage": usage}
                choices = item.get("choices") or []
                if not isinstance(choices, list) or not choices:
                    continue
                choice = choices[0] if isinstance(choices[0], dict) else {}
                delta = choice.get("delta") or {}
                if not isinstance(delta, dict):
                    delta = {}
                reasoning = delta.get("reasoning_content")
                if isinstance(reasoning, str) and reasoning:
                    yield {"reasoning": reasoning}
                content = delta.get("content")
                if isinstance(content, str) and content:
                    yield {"delta": content}
                finish = choice.get("finish_reason")
                if finish:
                    yield {"finish_reason": str(finish)}
        except (socket.timeout, TimeoutError) as error:
            raise AgentError("CHAT_TIMEOUT", f"{self.config.key} stream timed out: {error}")
        except AgentError:
            raise
        except OSError as error:
            raise AgentError("CHAT_STREAM_FAILED", f"{self.config.key} stream failed: {error}")
        finally:
            try:
                connection.close()
            except OSError:
                pass


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

    def list_threads(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = self.store._conn.execute(
            "SELECT id, body, updated_at FROM task"
            " WHERE id LIKE 'chat-%' ORDER BY updated_at DESC LIMIT ?",
            (max(1, min(int(limit), 200)),),
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

        wait = _pace_wait(config.key, config.min_interval_seconds)
        if wait > 0:
            yield {"type": "wait", "seconds": int(wait + 0.999), "provider": config.label}
            remaining = wait
            while remaining > 0:
                time.sleep(min(0.25, remaining))
                remaining -= 0.25
        _mark_call(config.key)

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
