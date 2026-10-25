"""FCode desktop shell — the same runtime and console, packaged as an app.

Three properties matter and are all deliberate:

* **No second implementation.** The window loads the exact same static console
  the browser serves; the runtime is the same Python package. Desktop is a
  distribution layer, not a fork.
* **The agent is not exposed to other local pages.** The embedded server binds
  a random loopback port and requires a per-launch token (HttpOnly cookie,
  bootstrapped from ``/?token=…``). Without it every request is 401.
* **User data lives outside the bundle.** Run records go to the platform's
  application-data directory, because a packaged ``.app`` is read-only and
  because audit trails belong to the user, not to an installer.

Build: ``bash desktop/build.sh``. The resulting bundle is self-contained.
"""

from __future__ import annotations

import importlib.util
import json
import os
import platform as _platform
import secrets
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from pathlib import Path

APP_NAME = "FCode"
APP_VERSION = "0.3.0-desktop"


# --------------------------------------------------------------------- paths

def app_data_dir() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / APP_NAME
    elif os.name == "nt":
        base = Path(os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming")) / APP_NAME
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")) / APP_NAME
    base.mkdir(parents=True, exist_ok=True)
    return base


def log_path() -> Path:
    if sys.platform == "darwin":
        directory = Path.home() / "Library" / "Logs" / APP_NAME
    else:
        directory = app_data_dir() / "logs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / "desktop.log"


def log(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n"
    try:
        with log_path().open("a", encoding="utf-8") as handle:
            handle.write(line)
    except OSError:
        pass
    sys.stderr.write(line)


def repo_root() -> Path:
    """Where the bundled (or checkout) repo lives."""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
        return base / "repo"
    return Path(__file__).resolve().parent.parent


# -------------------------------------------------------------------- server

def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_health(port: int, token: str, timeout: float = 25.0) -> bool:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/health",
        headers={"Authorization": f"Bearer {token}"},
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(request, timeout=0.5) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.15)
    return False


def load_server_module(server_py: Path):
    spec = importlib.util.spec_from_file_location("fcode_viewer_server", server_py)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {server_py}")
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves cls.__module__ through sys.modules; exec'ing a module
    # that is not registered there makes every @dataclass in it crash.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def start_server(repo: Path, port: int, token: str) -> dict:
    """Run the console server in-process on a daemon thread."""
    os.environ["FCODE_RUNS_DIR"] = str(app_data_dir() / "runs")
    server_module = load_server_module(repo / "flowcredit" / "viewer" / "server.py")
    argv = [
        "--repo", str(repo),
        "--host", "127.0.0.1",
        "--port", str(port),
        "--token", token,
        "--pace", "1.4",
    ]
    thread = threading.Thread(
        target=lambda: server_module.main(argv),
        name="fcode-server",
        daemon=True,
    )
    thread.start()
    if not wait_health(port, token):
        raise RuntimeError(f"console server did not become healthy on port {port}")
    return {"thread": thread, "module": server_module}


# ------------------------------------------------------------------- bridge

class Bridge:
    """JS-facing native API (``window.pywebview.api``)."""

    def save_report(self, filename: str, content: str) -> dict:
        import webview

        window = webview.windows[0]
        result = window.create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=filename,
            file_types=("HTML (*.html)",),
        )
        if not result:
            return {"saved": False}
        path = result[0] if isinstance(result, (tuple, list)) else result
        Path(path).write_text(content, encoding="utf-8")
        log(f"report saved: {path}")
        return {"saved": True, "path": str(path)}

    def reveal(self, path: str) -> dict:
        try:
            if sys.platform == "darwin":
                subprocess.run(["open", "-R", path], check=False)
            elif os.name == "nt":
                subprocess.run(["explorer", "/select,", path], check=False)
            else:
                subprocess.run(["xdg-open", str(Path(path).parent)], check=False)
            return {"ok": True}
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "error": str(error)}

    def notify(self, title: str, body: str) -> dict:
        try:
            if sys.platform == "darwin":
                script = (
                    f"display notification {json.dumps(body, ensure_ascii=False)} "
                    f"with title {json.dumps(title, ensure_ascii=False)}"
                )
                subprocess.run(["osascript", "-e", script], check=False)
            elif os.name == "nt":
                # Windows toast without extra dependencies: PowerShell balloon.
                ps = (
                    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
                    "ContentType=WindowsRuntime] > $null; "
                    f"$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); "
                    f"$t.GetElementsByTagName('text')[0].AppendChild($t.CreateTextNode('{title}')) > $null;"
                )
                subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False)
            return {"ok": True}
        except Exception as error:  # noqa: BLE001
            return {"ok": False, "error": str(error)}

    def set_title(self, title: str) -> dict:
        try:
            import webview

            webview.windows[0].set_title(title)
        except Exception:  # noqa: BLE001 — cosmetic only
            pass
        return {"ok": True}

    def platform(self) -> str:
        return sys.platform

    def version(self) -> str:
        return APP_VERSION

    def data_dir(self) -> str:
        return str(app_data_dir())


# --------------------------------------------------------------------- main

def main() -> int:
    log(f"starting {APP_NAME} {APP_VERSION} on {_platform.platform()}")
    repo = repo_root()
    log(f"repo: {repo}")
    if not (repo / "flowcredit" / "viewer" / "server.py").exists():
        log("ERROR: bundled repo missing; run desktop/build.sh")
        return 1

    port = free_port()
    token = secrets.token_urlsafe(24)
    try:
        start_server(repo, port, token)
    except Exception as error:  # noqa: BLE001
        log(f"ERROR: {error}\n{traceback.format_exc()}")
        return 1
    log(f"server ready on 127.0.0.1:{port}")

    import webview

    url = f"http://127.0.0.1:{port}/?token={token}&desktop=1"
    webview.create_window(
        APP_NAME,
        url,
        width=1500,
        height=950,
        min_size=(1080, 680),
        background_color="#FAFAFB",
        js_api=Bridge(),
    )
    log("window created")
    try:
        webview.start(debug=os.environ.get("FCODE_DEBUG") == "1")
    finally:
        log("window closed; exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
