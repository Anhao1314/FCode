"""Shared console configuration: paths, static guard and model catalog.

Kept separate from the HTTP handler and the run manager so the security
helpers can be unit-tested and imported without constructing a server.
"""

from __future__ import annotations

import os
import sys
import time
import urllib.request
from pathlib import Path

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


def app_config_dir() -> Path:
    """User-scoped config that is never under the static root.

    Desktop bundles already run with ``FCODE_RUNS_DIR`` in Application Support;
    the repo server would otherwise put ``chat-config.json`` next to the served
    assets, where a plain GET could download an API key.
    """
    override = os.environ.get("FCODE_CONFIG_DIR", "").strip()
    if override:
        base = Path(override).expanduser()
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "FCode"
    elif os.name == "nt":
        base = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming")) / "FCode"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")) / "fcode"
    base.mkdir(parents=True, exist_ok=True)
    return base


CHAT_CONFIG_PATH = app_config_dir() / "chat-config.json"
LEGACY_CHAT_CONFIG = VIEWER_DIR / "chat-config.json"

#: Bodies larger than this are refused before reading; no endpoint needs more.
MAX_REQUEST_BODY = 1_048_576


def forbidden_static_path(path: str) -> bool:
    """Paths the static handler must never serve (configs, databases, temp)."""
    name = Path(path).name
    return (
        name.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm"))
        or name.startswith("chat-config.json")
        or name.endswith(".tmp")
    )


def migrate_legacy_chat_config() -> None:
    """Move an older viewer/chat-config.json out of the static root, once."""
    if os.environ.get("FCODE_SKIP_LEGACY_CONFIG_MIGRATION") == "1":
        return
    if not LEGACY_CHAT_CONFIG.exists():
        return
    try:
        if not CHAT_CONFIG_PATH.exists():
            CHAT_CONFIG_PATH.write_text(
                LEGACY_CHAT_CONFIG.read_text(encoding="utf-8"), encoding="utf-8",
            )
            os.chmod(CHAT_CONFIG_PATH, 0o600)
        LEGACY_CHAT_CONFIG.unlink()
    except OSError as error:
        print(f"[console] WARNING: could not migrate {LEGACY_CHAT_CONFIG}: {error}")

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
    """The selectable-model list, enumerated from what the host configured.

    The menu's single source of truth is the provider catalog: the offline
    mock, the local endpoint probe, the built-in presets (kimi, deepseek) and
    every prefix declared in FCODE_OPENAI_COMPAT_PROVIDERS. An endpoint
    appears the moment its configuration is complete; an incomplete one
    appears with the exact reason it is unavailable. Creation re-checks the
    same facts and fails closed.
    """
    try:
        from flowagent.providers.catalog import provider_catalog
    except ImportError:  # pragma: no cover — static mode; /api/models needs live anyway
        return []
    return provider_catalog(
        local_endpoint=local_endpoint,
        local_probe=(lambda: _probe_local_endpoint(local_endpoint)) if local_endpoint else None,
    )
