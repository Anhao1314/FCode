"""End-to-end scenario tests: each failure mode must actually happen.

These are the assertions the demo's claims rest on. They run the real stack —
real SQLite, real gate, real loop, and for the crash scenario a real SIGKILL —
because a mocked-out failure would prove nothing about the runtime.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from flowagent.demo.runner import run_scenario  # noqa: E402
from flowagent.trajectory.exporter import verify_trace  # noqa: E402


class FullScenarioTest(unittest.TestCase):
    def test_full_story_reaches_a_verified_result(self) -> None:
        result = run_scenario("full", fast=True, quiet=True)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.rounds, 9)
        self.assertEqual(result.model_calls, 9)
        self.assertTrue(result.trace_verified)
        self.assertEqual(result.failure_code, "")


class ToolDeniedTest(unittest.TestCase):
    def test_unregistered_tool_is_denied_and_never_executed(self) -> None:
        result = run_scenario("tool-denied", fast=True, quiet=True)
        self.assertEqual(result.status, "denied")
        self.assertEqual(result.failure_code, "TOOL_NOT_REGISTERED")
        # The decisive assertion: a denied call must not consume a read.
        self.assertEqual(result.reads, 0)
        self.assertTrue(result.trace_verified)


class BudgetTest(unittest.TestCase):
    def test_budget_stops_before_dispatch_and_keeps_what_was_spent(self) -> None:
        result = run_scenario("budget", fast=True, quiet=True)
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.failure_code, "BUDGET_EXCEEDED")
        self.assertEqual(result.calls, 4)  # the grant ceiling, not one more
        self.assertEqual(result.reads, 4)
        self.assertTrue(result.trace_verified)


class CrashRecoveryTest(unittest.TestCase):
    def test_process_is_killed_then_resumes_without_repeating_a_round(self) -> None:
        result = run_scenario("crash", fast=True, quiet=True)
        self.assertEqual(result.status, "succeeded")
        self.assertTrue(result.recovered, "the worker should have been killed by a signal")
        # Nine rounds and nine calls: recovery did not re-propose anything.
        self.assertEqual(result.rounds, 9)
        self.assertEqual(result.model_calls, 9)
        self.assertTrue(result.trace_verified)


class UnknownReconcileTest(unittest.TestCase):
    def test_unknown_stops_without_retry_and_resumes_only_on_a_matching_receipt(self) -> None:
        result = run_scenario("unknown", fast=True, quiet=True)
        self.assertEqual(result.status, "succeeded")
        self.assertTrue(result.reconciled, "the unknown round should have been reconciled")
        # Nine rounds, not ten: the reconciled round is executed, not re-asked.
        self.assertEqual(result.model_calls, 9)
        self.assertEqual(result.rounds, 9)
        self.assertTrue(result.trace_verified)


class TraceFileTest(unittest.TestCase):
    def test_every_scenario_writes_a_verifiable_trace(self) -> None:
        import json

        for key in ("full", "tool-denied", "budget", "crash", "unknown"):
            with self.subTest(scenario=key):
                path = ROOT / "work" / "demo" / f"{key}.trace.json"
                self.assertTrue(path.exists(), f"{key} did not write a trace")
                trace = json.loads(path.read_text(encoding="utf-8"))
                summary = verify_trace(trace)
                self.assertTrue(summary["verified"])
                self.assertGreater(summary["events"], 3)


if __name__ == "__main__":
    unittest.main()
