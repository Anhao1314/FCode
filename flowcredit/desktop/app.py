#!/usr/bin/env python3
"""FCode desktop shell: one embedded console and one native webview window.

The HTTP server runs in this process. Frozen builds therefore never assume
that ``python`` or a source checkout exists on the user's machine.
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import secrets
import sys
import threading
import urllib.request
from collections.abc import MutableMapping
from pathlib import Path
from urllib.parse import urlencode


def isolate_provider_environment(env: MutableMapping[str, str]) -> None:
    """Keep a parent agent's provider credentials out of the desktop app.

    Desktop providers are configured in FCode's settings page. Inheriting
    ``KIMI_*`` from the agent that launched the app can otherwise override the
    saved key and redirect it to that agent's private proxy. Advanced users
    who intentionally configure the desktop through the shell can opt in.
    """
    if env.get("FCODE_USE_HOST_PROVIDER_ENV", "").strip() == "1":
        return
    for name in tuple(env):
        if name.startswith(("KIMI_", "DEEPSEEK_")):
            env.pop(name, None)


def bundle_root() -> Path:
    frozen = getattr(sys, "_MEIPASS", None)
    return Path(frozen) if frozen else Path(__file__).resolve().parent.parent


def data_dir() -> Path:
    override = os.environ.get("FCODE_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "FCode"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming")) / "FCode"
    return Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / "fcode"


class DesktopConsole:
    """Own the loopback server, its authentication token and its lifetime."""

    def __init__(self, repo: Path) -> None:
        self.repo = repo
        self.token = secrets.token_hex(32)
        self.httpd = None
        self.thread: threading.Thread | None = None

    def start(self) -> str:
        if self.httpd is not None:
            return self.url
        isolate_provider_environment(os.environ)
        state = data_dir()
        state.mkdir(parents=True, exist_ok=True)
        os.environ["FCODE_RUNS_DIR"] = str(state / "runs")
        os.environ["FCODE_CONFIG_DIR"] = str(state / "config")
        # These imports read FCODE_* paths at module import time; set them first.
        viewer = str(self.repo / "viewer")
        if viewer not in sys.path:
            sys.path.insert(0, viewer)
        console = importlib.import_module("server")
        self.httpd = console.create_server(
            repo=self.repo,
            host="127.0.0.1",
            port=0,
            token=self.token,
            pace=0.0,
            local_endpoint=os.environ.get("FCODE_LOCAL_ENDPOINT", ""),
        )
        self.thread = threading.Thread(
            target=self.httpd.serve_forever,
            name="fcode:console",
            daemon=True,
        )
        self.thread.start()
        return self.url

    @property
    def url(self) -> str:
        if self.httpd is None:
            raise RuntimeError("desktop console is not running")
        query = urlencode({"desktop": "1", "token": self.token})
        return f"http://127.0.0.1:{self.httpd.server_port}/?{query}"

    def health(self) -> dict:
        if self.httpd is None:
            raise RuntimeError("desktop console is not running")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.httpd.server_port}/api/health",
            headers={"Authorization": f"Bearer {self.token}"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.load(response)
        if not payload.get("ok") or not payload.get("live"):
            raise RuntimeError(f"desktop runtime is unavailable: {payload}")
        return payload

    def stop(self) -> None:
        httpd, thread = self.httpd, self.thread
        self.httpd = None
        self.thread = None
        if httpd is None:
            return
        if thread is not None and thread.is_alive():
            httpd.shutdown()
        httpd.server_close()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)
        # Disconnect host-configured MCP children as part of application exit.
        bridge = httpd.RequestHandlerClass.manager.mcp.get("bridge")
        if bridge is not None:
            bridge.disconnect()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FCode desktop application")
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="start the embedded console, verify its authenticated health API, and exit",
    )
    args = parser.parse_args(argv)
    console = DesktopConsole(bundle_root())
    console.start()
    try:
        if args.smoke_test:
            health = console.health()
            print(json.dumps({"ok": True, "live": health["live"], "templates": health["templates"]}))
            return 0
        import webview

        webview.create_window(
            "FCode",
            console.url,
            width=1500,
            height=950,
            min_size=(1080, 680),
            background_color="#FBFAF9",
        )
        webview.start()
        return 0
    finally:
        console.stop()


if __name__ == "__main__":
    sys.exit(main())
