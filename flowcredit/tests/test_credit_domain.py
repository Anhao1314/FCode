"""Production credit domain: eight metrics, three issuers and the blueprint."""

from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from flowagent.core.contracts import AgentError  # noqa: E402
from flowagent.core.plan import Plan  # noqa: E402
from flowagent.core.receipts import ReceiptStore  # noqa: E402
from flowagent.core.store import TaskStore  # noqa: E402
from flowagent.domains import DOMAINS  # noqa: E402
from flowagent.domains.credit import CREDIT_DOMAIN  # noqa: E402
from flowagent.memory.context import WorkingMemory  # noqa: E402
from flowagent.providers.mock import MockProvider  # noqa: E402
from flowagent.runtime.budget import BudgetLimits  # noqa: E402
from flowagent.runtime.harness import Harness  # noqa: E402
from flowagent.runtime.loop import Loop  # noqa: E402
from flowagent.tools.base import EFFECT_READ, Observation  # noqa: E402
from flowagent.tools.credit.memo import (  # noqa: E402
    OPTIONAL_METRICS,
    REQUIRED_METRICS,
    build_memo,
)
from flowagent.tools.credit.planner import BLUEPRINT, DEPENDENTS, CreditPlanner  # noqa: E402
from flowagent.tools.credit.tools import CREDIT_TOOL_NAMES, build_credit_tools  # noqa: E402
from flowagent.tools.credit.verifier import verify_observation  # noqa: E402
from flowagent.tools.credit.world import (  # noqa: E402
    BLOCK_REASONS,
    DEBT_DOC,
    ISSUER_KEYS,
    METRICS,
    PERIODS,
    RATIO_METRICS,
    CreditWorld,
)
from flowagent.tools.registry import ToolRegistry  # noqa: E402
from flowagent.trajectory.exporter import verify_trace  # noqa: E402
from flowagent.trajectory.recorder import TraceRecorder  # noqa: E402
from labs.credit_dd.spike import run_case  # noqa: E402

EXPECTED_RATIO_BP: dict[str, dict[str, int]] = {
    "hengxing": {
        "net_debt_to_ebitda": 37714,
        "interest_coverage": 41667,
        "ocf_to_short_term_debt": 3000,
        "receivables_to_revenue": 2296,
        "related_party_funding_ratio": 577,
        "contingent_liabilities_to_equity": 281,
    },
    "yuanyang": {
        "net_debt_to_ebitda": 57500,
        "interest_coverage": 30000,
        "ocf_to_short_term_debt": 857,
        "receivables_to_revenue": 2952,
        "related_party_funding_ratio": 1467,
        "contingent_liabilities_to_equity": 1765,
    },
    "yunling": {
        "interest_coverage": 36000,
        "receivables_to_revenue": 2118,
    },
}
EXPECTED_CODES: dict[str, dict[str, str]] = {
    "hengxing": {"audit_opinion": "standard_unqualified", "rating_migration": "stable"},
    "yuanyang": {"audit_opinion": "qualified", "rating_migration": "downgrade"},
    "yunling": {"audit_opinion": "standard_unqualified", "rating_migration": "stable"},
}
EXPECTED_DISPLAY: dict[str, dict[str, str]] = {
    "hengxing": {
        "net_debt_to_ebitda": "3.77x",
        "interest_coverage": "4.17x",
        "ocf_to_short_term_debt": "0.30x",
        "receivables_to_revenue": "22.96%",
        "related_party_funding_ratio": "5.77%",
        "contingent_liabilities_to_equity": "2.81%",
        "audit_opinion": "standard_unqualified",
        "rating_migration": "stable",
    },
    "yuanyang": {
        "net_debt_to_ebitda": "5.75x",
        "interest_coverage": "3.00x",
        "ocf_to_short_term_debt": "0.09x",
        "receivables_to_revenue": "29.52%",
        "related_party_funding_ratio": "14.67%",
        "contingent_liabilities_to_equity": "17.65%",
        "audit_opinion": "qualified",
        "rating_migration": "downgrade",
    },
    "yunling": {
        "interest_coverage": "3.60x",
        "receivables_to_revenue": "21.18%",
        "audit_opinion": "standard_unqualified",
        "rating_migration": "stable",
    },
}


def _loaded_world(issuer: str, *, partial: bool = False) -> CreditWorld:
    world = CreditWorld(issuer=issuer, partial=partial)
    for doc_id in world.available_document_ids():
        world.read_document(doc_id)
    world.check_restatement("doc_ar_fy2024")
    return world


class CreditWorldMetricTests(unittest.TestCase):
    def test_all_issuers_match_the_exact_metric_table(self) -> None:
        for issuer in ISSUER_KEYS:
            with self.subTest(issuer=issuer):
                world = _loaded_world(issuer)
                for metric in RATIO_METRICS:
                    result = world.compute_credit_metric(metric, "FY2025")
                    expected = EXPECTED_RATIO_BP[issuer].get(metric)
                    if expected is None:
                        self.assertFalse(result["computed"])
                        self.assertEqual(result["blockers"], ["missing_debt_schedule"])
                        self.assertNotIn("value_bp", result)
                        self.assertNotIn("value_code", result)
                        self.assertNotIn("display", result)
                        continue
                    self.assertTrue(result["computed"], metric)
                    self.assertEqual(result["kind"], "ratio")
                    self.assertEqual(result["value_bp"], expected, metric)
                    self.assertIsNone(result["value_code"])
                    self.assertEqual(result["display"], EXPECTED_DISPLAY[issuer][metric])
                    self.assertEqual(result["blockers"], [])
                    self.assertGreaterEqual(len(result["citations"]), 1)
                    for citation in result["citations"]:
                        self.assertTrue(world.verify_citation(citation), citation)

                for metric in ("audit_opinion", "rating_migration"):
                    result = world.compute_credit_metric(metric, "FY2025")
                    self.assertTrue(result["computed"], metric)
                    self.assertEqual(result["kind"], "code")
                    self.assertIsNone(result["value_bp"])
                    self.assertEqual(result["value_code"], EXPECTED_CODES[issuer][metric])
                    self.assertEqual(result["display"], EXPECTED_DISPLAY[issuer][metric])
                    self.assertGreaterEqual(len(result["citations"]), 1)
                    for citation in result["citations"]:
                        self.assertTrue(world.verify_citation(citation), citation)

    def test_partial_world_removes_only_the_debt_metrics(self) -> None:
        world = _loaded_world("hengxing", partial=True)
        self.assertNotIn(DEBT_DOC, world.available_document_ids())
        for metric in ("net_debt_to_ebitda", "ocf_to_short_term_debt",
                       "related_party_funding_ratio", "contingent_liabilities_to_equity"):
            result = world.compute_credit_metric(metric, "FY2025")
            self.assertFalse(result["computed"], metric)
            self.assertEqual(result["blockers"], ["missing_debt_schedule"])
        self.assertEqual(world.compute_credit_metric("interest_coverage", "FY2025")["value_bp"], 41667)
        self.assertEqual(world.compute_credit_metric("rating_migration", "FY2025")["value_code"], "stable")

    def test_yuanyang_restatement_uses_270000_for_fy2024_interest(self) -> None:
        world = _loaded_world("yuanyang")
        restatement = world.check_restatement("doc_ar_fy2024")
        self.assertTrue(restatement["restated"])
        self.assertEqual(restatement["original_ebitda"], 300_000)
        self.assertEqual(restatement["restated_ebitda"], 270_000)
        self.assertEqual(restatement["delta"], -30_000)
        self.assertEqual(restatement["superseded_by"], "doc_restatement_fy2024")
        for citation in restatement["citations"]:
            self.assertTrue(world.verify_citation(citation))
        prior = world.compute_credit_metric("interest_coverage", "FY2024")
        self.assertTrue(prior["computed"])
        self.assertEqual(prior["value_bp"], 54000)
        self.assertEqual(prior["display"], "5.40x")
        self.assertEqual(prior["inputs"]["ebitda"], 270_000)

    def test_yunling_is_missing_the_debt_schedule_by_construction(self) -> None:
        world = CreditWorld("yunling")
        self.assertNotIn(DEBT_DOC, world.available_document_ids())
        missing = world.read_document(DEBT_DOC)
        self.assertFalse(missing["found"])
        self.assertEqual(missing["reason"], "missing_document")


class PlannerAndToolTests(unittest.TestCase):
    def test_fourteen_step_blueprint_and_dependencies(self) -> None:
        plan = CreditPlanner().decompose("credit check")
        self.assertEqual(
            [todo.id for todo in plan.todos],
            [f"c{index}" for index in range(1, 15)],
        )
        self.assertEqual(
            [todo.tool for todo in plan.todos],
            [
                "list_documents", "read_document", "check_restatement",
                "read_document", "read_document", "read_document",
                "compute_credit_metric", "compute_credit_metric",
                "compute_credit_metric", "compute_credit_metric",
                "compute_credit_metric", "compute_credit_metric",
                "compute_credit_metric", "compute_credit_metric",
            ],
        )
        self.assertEqual(plan.todos[2].arguments, {"doc_id": "doc_ar_fy2024"})
        self.assertEqual(plan.todos[6].arguments,
                         {"metric": "net_debt_to_ebitda", "period": "FY2025"})
        self.assertEqual(plan.todos[13].arguments,
                         {"metric": "rating_migration", "period": "FY2025"})
        self.assertEqual(DEPENDENTS["c5"], ("c7", "c9", "c11", "c12"))
        self.assertEqual(DEPENDENTS["c6"], ("c14",))
        self.assertEqual(len(BLUEPRINT), 14)
        self.assertEqual(
            {todo.id for todo in plan.todos if not todo.required},
            {"c6", "c11", "c12", "c14"},
        )

    def test_five_tools_are_all_read_only(self) -> None:
        specs = build_credit_tools(CreditWorld())
        self.assertEqual(tuple(spec.name for spec in specs), CREDIT_TOOL_NAMES)
        self.assertEqual(len(CREDIT_TOOL_NAMES), 5)
        self.assertTrue(all(spec.effect == EFFECT_READ for spec in specs))
        doc_enum = next(spec for spec in specs if spec.name == "read_document").params[0].enum
        self.assertIn(DEBT_DOC, doc_enum)

    def test_tool_outputs_validate_against_their_contracts(self) -> None:
        world = CreditWorld("yuanyang")
        registry = ToolRegistry(build_credit_tools(world))
        listed = registry.execute("list_documents", {})
        self.assertIn("doc_debt_fy2025", [item["doc_id"] for item in listed.result["documents"]])
        annual = registry.execute("read_document", {"doc_id": "doc_ar_fy2024"})
        self.assertTrue(annual.result["found"])
        restatement = registry.execute("check_restatement", {"doc_id": "doc_ar_fy2024"})
        self.assertTrue(restatement.result["restated"])
        registry.execute("read_document", {"doc_id": "doc_ar_fy2025"})
        registry.execute("read_document", {"doc_id": "doc_debt_fy2025"})
        metric = registry.execute(
            "compute_credit_metric",
            {"metric": "net_debt_to_ebitda", "period": "FY2025"},
        )
        self.assertTrue(metric.result["computed"])
        self.assertEqual(metric.result["value_bp"], 57500)
        blocked = registry.execute("report_blocked", {"reason": "insufficient_evidence"})
        self.assertTrue(blocked.result["acknowledged"])
        self.assertEqual(blocked.result["reason"], "insufficient_evidence")
        self.assertIn("missing_document", BLOCK_REASONS)
        self.assertEqual(PERIODS, ("FY2024", "FY2025"))
        self.assertEqual(METRICS[0], "net_debt_to_ebitda")

    def test_missing_document_output_still_validates(self) -> None:
        registry = ToolRegistry(build_credit_tools(CreditWorld("yunling")))
        missing = registry.execute("read_document", {"doc_id": "doc_debt_fy2025"})
        self.assertFalse(missing.result["found"])
        self.assertEqual(missing.result["reason"], "missing_document")
        self.assertNotIn("id", missing.result)


class VerifierAndDomainTests(unittest.TestCase):
    def test_verifier_accepts_truth_and_rejects_a_tampered_value(self) -> None:
        world = _loaded_world("hengxing")
        truth = world.compute_credit_metric("net_debt_to_ebitda", "FY2025")
        genuine = Observation(
            tool="compute_credit_metric",
            arguments={"metric": "net_debt_to_ebitda", "period": "FY2025"},
            result=truth,
        )
        verified = verify_observation(world, genuine)
        self.assertTrue(verified["verified"])
        self.assertEqual(verified["verification"], "runtime-recomputed")
        self.assertEqual(verified["result"]["value_bp"], 37714)

        tampered = dict(truth)
        tampered["value_bp"] += 1
        with self.assertRaises(AgentError) as caught:
            verify_observation(
                world,
                Observation(
                    tool="compute_credit_metric",
                    arguments={"metric": "net_debt_to_ebitda", "period": "FY2025"},
                    result=tampered,
                ),
            )
        self.assertEqual(caught.exception.code, "RESULT_VERIFICATION_FAILED")
        self.assertIn("value_bp", caught.exception.message)

    def test_non_result_observation_is_not_verifiable(self) -> None:
        world = CreditWorld()
        with self.assertRaises(AgentError) as caught:
            verify_observation(
                world,
                Observation(tool="read_document", arguments={}, result={"found": True}),
            )
        self.assertEqual(caught.exception.code, "RESULT_INCOMPLETE")

    def test_domain_is_registered_and_supplies_the_contract(self) -> None:
        self.assertIs(DOMAINS["credit-due-diligence"], CREDIT_DOMAIN)
        self.assertEqual(CREDIT_DOMAIN.key, "credit-due-diligence")
        self.assertEqual(CREDIT_DOMAIN.result_tools, ("compute_credit_metric",))
        self.assertEqual(CREDIT_DOMAIN.approval_tools, ("report_blocked",))
        world = CREDIT_DOMAIN.create_world(issuer="yunling")
        self.assertIsInstance(world, CreditWorld)
        self.assertEqual(world.issuer_key, "yunling")
        self.assertEqual(len(CREDIT_DOMAIN.build_tools(world)), 5)
        self.assertIsInstance(CREDIT_DOMAIN.make_planner(), CreditPlanner)


class _AbandonC7Planner(CreditPlanner):
    """Marks one result todo abandoned; the plan is complete but not full."""

    def decompose(self, goal):
        plan = super().decompose(goal)
        return plan.mark("c7", "abandoned", reason="test: result todo missing")


class _OptionalGapWorld(CreditWorld):
    """Hengxing with all three optional metrics undisclosed."""

    def compute_credit_metric(self, metric: str, period: str) -> dict:
        if period == "FY2025" and metric in OPTIONAL_METRICS:
            return {
                "computed": False,
                "metric": metric,
                "period": period,
                "kind": "code" if metric == "rating_migration" else "ratio",
                "inputs": {},
                "citations": [],
                "blockers": ["optional_gap"],
            }
        return super().compute_credit_metric(metric, period)


def _run_stack(world: CreditWorld, *, planner=None, specs=None):
    with tempfile.TemporaryDirectory(prefix="fcode-credit-loop-") as tmp:
        store = TaskStore(Path(tmp) / "task.sqlite")
        try:
            registry = ToolRegistry(specs or build_credit_tools(world))
            provider = MockProvider(policy="research")
            harness = Harness(
                store=store,
                registry=registry,
                provider=provider,
                world=world,
                limits=BudgetLimits(20, 20, 20_000, 20_000),
                receipts=ReceiptStore(store),
                verifier=lambda observation: CREDIT_DOMAIN.verify(world, observation),
            )
            allowed = list(CREDIT_TOOL_NAMES)
            task = harness.create(
                task_id="task-credit-loop",
                objective="credit loop regression",
                principal="test",
                binding={"scenario": "loop", "synthetic": True},
                allowed_tools=allowed,
                grant={
                    "allowed_tools": allowed,
                    "max_calls": 20,
                    "max_reads": 20,
                    "max_cost_microusd": 20_000,
                    "max_tokens": 20_000,
                },
            )
            recorder = TraceRecorder(
                store,
                provider_name=provider.name,
                model_name=provider.model,
            )
            task = Loop(
                harness,
                planner=planner or CreditPlanner(),
                max_rounds=20,
                observer=recorder,
                result_tools=CREDIT_DOMAIN.result_tools,
            ).run(task.id)
            events = store.events(task.id)
            verify_trace(recorder.build(task))
            return task, events
        finally:
            store.close()


def _observations(events) -> list[Observation]:
    observations = []
    for event in events:
        if event["type"] != "tool_succeeded":
            continue
        detail = event["payload"]["detail"]
        observations.append(
            Observation(
                tool=detail["tool"],
                arguments=dict(detail.get("arguments") or {}),
                result=dict(detail.get("result") or {}),
                result_hash=detail.get("result_hash", ""),
                tool_version=detail.get("tool_version", ""),
            )
        )
    return observations


class LoopRegressionTests(unittest.TestCase):
    def test_loop_rejects_a_tampered_result(self) -> None:
        world = CreditWorld("hengxing")
        specs = build_credit_tools(world)

        def tampered(arguments: dict) -> dict:
            result = world.compute_credit_metric(arguments["metric"], arguments["period"])
            if result.get("computed") and result.get("metric") == "net_debt_to_ebitda":
                result = dict(result)
                result["value_bp"] += 1
            return result

        specs = [
            replace(spec, handler=tampered)
            if spec.name == "compute_credit_metric"
            else spec
            for spec in specs
        ]
        task, events = _run_stack(world, specs=specs)
        self.assertEqual(task.status, "failed")
        self.assertEqual(task.failure["code"], "RESULT_VERIFICATION_FAILED")
        self.assertIsNone(task.result)

        tampered_values = [
            event["payload"]["detail"]["result"]["value_bp"]
            for event in events
            if event["type"] == "tool_succeeded"
            and event["payload"]["detail"]["tool"] == "compute_credit_metric"
            and event["payload"]["detail"]["result"].get("metric") == "net_debt_to_ebitda"
        ]
        self.assertEqual(tampered_values, [37715])

    def test_complete_plan_with_one_result_is_not_success(self) -> None:
        world = CreditWorld("hengxing")
        task, _ = _run_stack(world, planner=_AbandonC7Planner())
        self.assertEqual(task.status, "failed")
        self.assertEqual(task.failure["code"], "RESULT_INCOMPLETE")
        self.assertIn("c7", task.failure["message"])
        self.assertIsNone(task.result)

    def test_optional_computed_false_is_skipped_and_plan_succeeds(self) -> None:
        task, events = _run_stack(_OptionalGapWorld("hengxing"))
        self.assertEqual(task.status, "succeeded")
        self.assertTrue(task.result["verified"])
        plan = Plan.from_dict(task.plan_state)
        statuses = {todo.id: todo.status for todo in plan.todos}
        for todo_id in ("c11", "c12", "c14"):
            self.assertEqual(statuses[todo_id], "blocked", todo_id)
        self.assertEqual(
            [item["metric"] for item in task.result["results"]],
            list(REQUIRED_METRICS),
        )
        self.assertFalse(any(event["type"] == "task_failed" for event in events))

    def test_optional_computed_false_has_an_explicit_gap_reason(self) -> None:
        world = _OptionalGapWorld("hengxing")
        task, events = _run_stack(world)
        memo = build_memo(
            world,
            _observations(events),
            chain_head="test-chain-head",
            plan=task.plan_state,
        )
        gaps = {gap["metric"]: gap for gap in memo["optional_gaps"]}
        self.assertEqual(set(gaps), set(OPTIONAL_METRICS))
        for metric in OPTIONAL_METRICS:
            self.assertEqual(gaps[metric]["reason"], "not_disclosed", metric)
            self.assertTrue(gaps[metric]["detail"], metric)
        self.assertFalse(memo["optional_verified"])

    def test_optional_computed_true_is_still_verified(self) -> None:
        world = CreditWorld("hengxing")
        specs = build_credit_tools(world)

        def tampered(arguments: dict) -> dict:
            result = world.compute_credit_metric(arguments["metric"], arguments["period"])
            if result.get("computed") and result.get("metric") == "related_party_funding_ratio":
                result = dict(result)
                result["value_bp"] += 1
            return result

        specs = [
            replace(spec, handler=tampered)
            if spec.name == "compute_credit_metric"
            else spec
            for spec in specs
        ]
        task, _ = _run_stack(world, specs=specs)
        self.assertEqual(task.status, "failed")
        self.assertEqual(task.failure["code"], "RESULT_VERIFICATION_FAILED")

    def test_optional_verification_failure_has_an_explicit_gap_reason(self) -> None:
        world = CreditWorld("hengxing")
        specs = build_credit_tools(world)

        def tampered(arguments: dict) -> dict:
            result = world.compute_credit_metric(arguments["metric"], arguments["period"])
            if result.get("computed") and result.get("metric") == "related_party_funding_ratio":
                result = dict(result)
                result["value_bp"] += 1
            return result

        specs = [
            replace(spec, handler=tampered)
            if spec.name == "compute_credit_metric"
            else spec
            for spec in specs
        ]
        task, events = _run_stack(world, specs=specs)
        self.assertEqual(task.status, "failed")
        memo = build_memo(
            world,
            _observations(events),
            chain_head="test-chain-head",
            plan=task.plan_state,
        )
        gap = next(
            gap
            for gap in memo["optional_gaps"]
            if gap["metric"] == "related_party_funding_ratio"
        )
        self.assertEqual(gap["reason"], "verification_failed")
        self.assertIn("value_bp differs", gap["detail"])

    def test_required_gap_still_blocks_the_task(self) -> None:
        task, _ = _run_stack(CreditWorld("yunling"))
        self.assertEqual(task.status, "failed")
        self.assertEqual(task.failure["code"], "INSUFFICIENT_EVIDENCE")
        self.assertIsNone(task.result)
        plan = Plan.from_dict(task.plan_state)
        self.assertTrue(plan.is_blocked())
        self.assertFalse(plan.is_complete())

    def test_partial_memory_does_not_record_missing_debt(self) -> None:
        case = run_case("memory-partial", partial=True)
        memory = WorkingMemory(objective="credit", tool_catalog=[])
        for event in case.events:
            if event["type"] != "tool_succeeded":
                continue
            detail = event["payload"]["detail"]
            memory.record(
                int(detail.get("round", 0)),
                Observation(
                    tool=detail["tool"],
                    arguments=dict(detail.get("arguments") or {}),
                    result=dict(detail.get("result") or {}),
                    result_hash=detail.get("result_hash", ""),
                    tool_version=detail.get("tool_version", ""),
                ),
            )
        state = memory.state()
        self.assertNotIn("doc_debt_fy2025", state["read_documents"])
        self.assertEqual(
            state["metrics"],
            {
                "interest_coverage": 41667,
                "receivables_to_revenue": 2296,
                "audit_opinion": "standard_unqualified",
            },
        )
        self.assertIn("missing_document", state["blockers"])

    def test_runtime_contains_no_domain_tool_names(self) -> None:
        runtime = ROOT / "src" / "flowagent" / "runtime"
        for path in runtime.glob("*.py"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("calculate_margin", text, path.name)
            self.assertNotIn("compute_credit_metric", text, path.name)


if __name__ == "__main__":
    unittest.main()
