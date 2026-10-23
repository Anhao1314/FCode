"""Demo provider selection, fault disclosure and batch cost guard (offline)."""

from __future__ import annotations

import contextlib
import io
import os
import pathlib
import sys
import tempfile
import unittest
from dataclasses import dataclass
from typing import Any
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from flowagent.core.receipts import ReceiptStore  # noqa: E402
from flowagent.core.store import TaskStore  # noqa: E402
from flowagent.demo import __main__ as demo_cli  # noqa: E402
from flowagent.demo import runner as demo_runner  # noqa: E402
from flowagent.demo.fixtures import get_scenario  # noqa: E402
from flowagent.demo.provider_factory import (  # noqa: E402
    FaultInjectionProvider,
    build_provider,
    provider_start_line,
)
from flowagent.providers.base import Proposal  # noqa: E402
from flowagent.providers.local import LocalProvider  # noqa: E402
from flowagent.providers.mock import MockProvider  # noqa: E402


@dataclass
class FakeProvider:
    name: str = "fake-cloud"
    model: str = "fake-model"

    def reserve(self, context: dict[str, Any]) -> tuple[int, int]:
        return 11, 22

    def propose(self, context: dict[str, Any]) -> Proposal:
        return Proposal(
            plan={
                "version": "flowagent.plan/v1",
                "steps": [{"id": "t0", "tool": "write_document", "arguments": {}}],
            },
            provider=self.name,
            model=self.model,
            tokens=1,
            cost_microusd=1,
            metadata={"raw_content": "原始回复全文"},
        )


class FaultInjectionTests(unittest.TestCase):
    def test_publicly_injects_unregistered_todo_and_discloses_it(self) -> None:
        original = [
            {"id": "t1", "text": "正常步骤", "tool": "list_documents", "arguments": {}, "status": "pending"},
        ]
        provider = FakeProvider()
        seen: dict[str, Any] = {}

        def reserve(context: dict[str, Any]) -> tuple[int, int]:
            seen["reserve_plan"] = context["plan"]
            return (7, 8)

        provider.reserve = reserve  # type: ignore[method-assign]
        wrapped = FaultInjectionProvider(provider)

        reserved = wrapped.reserve({"plan": [dict(item) for item in original]})
        proposal = wrapped.propose({"plan": [dict(item) for item in original]})

        self.assertEqual(reserved, (7, 8))
        self.assertEqual(seen["reserve_plan"][0]["tool"], "write_document")
        self.assertEqual(original[0]["tool"], "list_documents")
        self.assertTrue(proposal.metadata["fault_injection"])
        self.assertEqual(
            proposal.metadata["disclosure"],
            "scenario deliberately includes an unregistered tool in the plan; "
            "test target is host gating, not model spontaneity",
        )
        self.assertEqual(proposal.metadata["raw_content"], "原始回复全文")


class ProviderFactoryTests(unittest.TestCase):
    def _receipts(self, tmp: str) -> ReceiptStore:
        return ReceiptStore(TaskStore(pathlib.Path(tmp) / "task.sqlite"))

    def test_mock_and_local_are_explicit(self) -> None:
        scenario = get_scenario("full")
        with tempfile.TemporaryDirectory() as tmp:
            provider = build_provider(
                "mock", scenario=scenario, receipts=self._receipts(tmp)
            )
            self.assertIsInstance(provider, MockProvider)

            provider = build_provider(
                "local",
                scenario=scenario,
                receipts=self._receipts(tmp),
                endpoint="http://127.0.0.1:1/v1",
                model="fcode-local",
                timeout=1.0,
                json_mode=True,
            )
            self.assertIsInstance(provider, LocalProvider)
            self.assertEqual(provider.model, "fcode-local")
        self.assertIn("所有外发调用由主机门控与审计", provider_start_line(provider))

    def test_kimi_missing_price_fails_before_request(self) -> None:
        scenario = get_scenario("full")
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"KIMI_API_KEY": "sk-not-real"}, clear=True):
            with self.assertRaisesRegex(ValueError, "KIMI_INPUT_PRICE"):
                build_provider("kimi", scenario=scenario, receipts=self._receipts(tmp))

    def test_cli_rejects_missing_kimi_config_without_network(self) -> None:
        output = io.StringIO()
        environment = {
            "KIMI_INPUT_PRICE_MICROUSD_PER_MTOK": "1000000",
            "KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK": "2000000",
            "KIMI_PRICE_AS_OF": "2026-10-24",
        }
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, environment, clear=True), \
                contextlib.redirect_stdout(output):
            code = demo_cli.main(
                [
                    "--provider", "kimi",
                    "--workdir", tmp,
                    "full",
                    "--fast",
                ]
            )
        self.assertEqual(code, 2)
        self.assertIn("PROVIDER_CONFIG_INVALID", output.getvalue())
        self.assertIn("KIMI_API_KEY", output.getvalue())


class BatchCostGuardTests(unittest.TestCase):
    def test_total_cost_guard_stops_after_completed_task(self) -> None:
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(demo_runner.SCENARIOS, {"full": get_scenario("full")}), \
                contextlib.redirect_stdout(output):
            results = demo_runner.run_all(
                workroot=pathlib.Path(tmp),
                max_total_cost=1,
            )
        self.assertEqual(len(results), 1)
        self.assertIn("batch_stopped_by_cost_guard", results[-1].note)
        self.assertIn("batch worst-case cost estimate", output.getvalue())
        self.assertIn("batch_stopped_by_cost_guard", output.getvalue())


if __name__ == "__main__":
    unittest.main()
