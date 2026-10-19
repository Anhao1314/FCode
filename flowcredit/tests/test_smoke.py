"""Phase 1a smoke tests.

Scope note: this is the smallest set that proves the Phase 1a acceptance
criteria — the demo runs, the chain detects tampering, and the state machine
refuses an illegal move. The full suite (permissions, budget, recovery
idempotency, unknown reconciliation, trace tampering via the viewer) is Phase 1b
and will replace nothing here; it will extend it.

Run with:

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from flowagent.core.contracts import AgentError, Task  # noqa: E402
from flowagent.core.store import TaskStore  # noqa: E402
from flowagent.trajectory.exporter import TraceTampered, verify_trace  # noqa: E402


class DemoSmokeTest(unittest.TestCase):
    """The demo must run from a clean directory with no arguments."""

    def test_full_demo_exits_zero(self) -> None:
        result = subprocess.run(
            [sys.executable, "demo.py", "full", "--fast"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("SUCCEEDED", result.stdout)
        self.assertIn("-2.50 pp", result.stdout)
        self.assertIn("轨迹自检", result.stdout)

    def test_trace_file_is_written_and_verifies(self) -> None:
        subprocess.run(
            [sys.executable, "demo.py", "full", "--fast"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        import json

        trace = json.loads((ROOT / "work" / "demo" / "full.trace.json").read_text(encoding="utf-8"))
        summary = verify_trace(trace)
        self.assertTrue(summary["verified"])
        self.assertGreaterEqual(summary["events"], 30)


class StoreSecurityTest(unittest.TestCase):
    """The three properties the README claims, tested directly."""

    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.store = TaskStore(self.tmp / "task.sqlite")

    def tearDown(self) -> None:
        self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_edited_event_is_detected(self) -> None:
        self.store.create(Task(id="task-1", principal="p", objective="o"))
        self.store._conn.execute("UPDATE event SET type='forged' WHERE task_id='task-1'")
        with self.assertRaises(AgentError) as caught:
            self.store.load("task-1")
        self.assertEqual(caught.exception.code, "CHAIN_TAMPERED")

    def test_illegal_transition_is_rejected(self) -> None:
        task = self.store.create(Task(id="task-2", principal="p", objective="o"))
        with self.assertRaises(AgentError) as caught:
            task.advance("succeeded")
        self.assertEqual(caught.exception.code, "ILLEGAL_STATE_TRANSITION")

    def test_stale_writer_loses_the_compare_and_swap(self) -> None:
        task = self.store.create(Task(id="task-3", principal="p", objective="o"))
        first = self.store.save(task.advance("planning"), task.sequence, "model_started", {})
        # A second writer that still believes the task is at the old sequence must
        # lose, even though its body would otherwise be a legal transition.
        stale = task.advance("planning")
        with self.assertRaises(AgentError) as caught:
            self.store.save(stale, task.sequence, "model_started", {})
        self.assertEqual(caught.exception.code, "SEQUENCE_CONFLICT")
        self.assertEqual(first.sequence, 2)


class TraceTamperTest(unittest.TestCase):
    """A trace that has been edited must fail verification, not warn."""

    def test_edited_trace_event_is_rejected(self) -> None:
        trace = {
            "events": [
                {
                    "sequence": 1,
                    "type": "task_created",
                    "payload": {"body_hash": "x", "detail": {}},
                    "prev_hash": None,
                    "hash": "0" * 64,
                    "at": "2026-01-01T00:00:00.000Z",
                }
            ],
            "chain": {"event_count": 1, "head_hash": "0" * 64},
        }
        with self.assertRaises(TraceTampered) as caught:
            verify_trace(trace)
        self.assertEqual(caught.exception.code, "TRACE_TAMPERED")


if __name__ == "__main__":
    unittest.main()
