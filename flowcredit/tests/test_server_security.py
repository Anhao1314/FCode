"""HTTP boundary: config redaction, cross-site writes and static deny rules."""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
SERVER = ROOT / "viewer" / "server.py"
sys.path.insert(0, str(ROOT / "src"))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def request(url: str, *, method: str = "GET", body: bytes | None = None, headers: dict | None = None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


class StaticDenyTests(unittest.TestCase):
    def test_config_and_temp_paths_are_forbidden(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["FCODE_CONFIG_DIR"] = tmp
            spec = importlib.util.spec_from_file_location("fcode_server_security", SERVER)
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)  # type: ignore[union-attr]
        self.assertTrue(module.forbidden_static_path("/chat-config.json"))
        self.assertTrue(module.forbidden_static_path("/chat-config.json.tmp"))
        self.assertTrue(module.forbidden_static_path("/runs/x/task.sqlite"))
        self.assertFalse(module.forbidden_static_path("/index.html"))
        self.assertFalse(module.forbidden_static_path("/brand/logo.svg"))


class ServerBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        root = pathlib.Path(cls.tmp.name)
        cls.port = free_port()
        env = dict(os.environ)
        env.update({
            "FCODE_RUNS_DIR": str(root / "runs"),
            "FCODE_CONFIG_DIR": str(root / "config"),
            "FCODE_SKIP_LEGACY_CONFIG_MIGRATION": "1",
        })
        cls.process = subprocess.Popen(
            [sys.executable, str(SERVER), "--repo", str(ROOT), "--port", str(cls.port)],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        cls.addClassCleanup(cls._stop)
        deadline = time.time() + 12
        while time.time() < deadline:
            try:
                status, _ = request(f"http://127.0.0.1:{cls.port}/api/health")
                if status == 200:
                    return
            except Exception:
                pass
            time.sleep(0.2)
        raise RuntimeError("server did not become healthy")

    @classmethod
    def _stop(cls) -> None:
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def test_config_is_redacted_and_never_static(self) -> None:
        body = json.dumps({
            "provider": "kimi",
            "values": {
                "api_key": "sk-security-test-123456",
                "input_price_microusd_per_mtok": "950000",
                "output_price_microusd_per_mtok": "4000000",
            },
        }).encode()
        status, _ = request(
            f"{self.base}/api/settings/chat-config",
            method="POST", body=body,
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)
        status, text = request(f"{self.base}/api/settings/chat-config")
        self.assertEqual(status, 200)
        self.assertNotIn("sk-security-test-123456", text)
        self.assertTrue(json.loads(text)["config"]["providers"]["kimi"]["api_key_set"])
        # The static handler must not serve the settings file even if a legacy
        # copy exists in the viewer directory.
        legacy = ROOT / "viewer" / "chat-config.json"
        created = False
        if not legacy.exists():
            legacy.write_text('{"legacy": true}', encoding="utf-8")
            created = True
        try:
            status, _ = request(f"{self.base}/chat-config.json")
            self.assertEqual(status, 404)
        finally:
            if created:
                legacy.unlink(missing_ok=True)
        clear = json.dumps({"provider": "kimi", "values": {"api_key": ""}}).encode()
        request(
            f"{self.base}/api/settings/chat-config",
            method="POST", body=clear,
            headers={"Content-Type": "application/json"},
        )

    def test_cross_site_and_non_json_writes_are_refused(self) -> None:
        payload = json.dumps({"default_model": "mock"}).encode()
        status, _ = request(
            f"{self.base}/api/settings/chat-config",
            method="POST", body=payload,
            headers={"Content-Type": "text/plain"},
        )
        self.assertEqual(status, 415)
        status, _ = request(
            f"{self.base}/api/settings/chat-config",
            method="POST", body=payload,
            headers={"Content-Type": "application/json", "Origin": "http://evil.example"},
        )
        self.assertEqual(status, 403)
        status, _ = request(
            f"{self.base}/api/settings/chat-config",
            method="POST", body=payload,
            headers={"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"},
        )
        self.assertEqual(status, 403)
        status, _ = request(
            f"{self.base}/api/settings/chat-config",
            method="POST", body=payload,
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 200)

    def test_delete_requires_same_origin(self) -> None:
        status, _ = request(
            f"{self.base}/api/chat/threads/chat-missing",
            method="DELETE",
            headers={"Origin": "http://evil.example"},
        )
        self.assertEqual(status, 403)
        status, _ = request(
            f"{self.base}/api/chat/threads/chat-missing",
            method="DELETE",
            headers={"Sec-Fetch-Site": "cross-site"},
        )
        self.assertEqual(status, 403)
        status, _ = request(f"{self.base}/api/chat/threads/chat-missing", method="DELETE")
        self.assertEqual(status, 404)

    def test_oversized_body_is_refused_before_parsing(self) -> None:
        status, _ = request(
            f"{self.base}/api/settings/chat-config",
            method="POST", body=b"{" + b"x" * 1_048_576,
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(status, 413)


class HostGuardTests(unittest.TestCase):
    def test_non_loopback_without_token_is_refused(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        result = subprocess.run(
            [sys.executable, str(SERVER), "--repo", str(ROOT),
             "--host", "0.0.0.0", "--port", str(port)],
            cwd=str(ROOT), capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("non-loopback", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
