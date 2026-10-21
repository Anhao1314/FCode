"""Credit-DD Phase 0 spike: world, tools, planner, verifier and real Loop.

The happy path is driven through the real ``Harness``/``Loop``; the verifier
recomputes both metrics from the world. The failure case removes the debt
schedule and asserts that no computed net-debt figure ever enters the trace.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from flowagent.core.contracts import AgentError  # noqa: E402
from flowagent.domains import DOMAINS  # noqa: E402
from flowagent.tools.base import EFFECT_READ, Observation  # noqa: E402
from flowagent.tools.registry import ToolRegistry  # noqa: E402

from labs.credit_dd.module import CREDIT_DD_DOMAIN  # noqa: E402
from labs.credit_dd.planner import CreditPlanner  # noqa: E402
from labs.credit_dd.spike import EXPECTED_METRICS, run_case  # noqa: E402
from labs.credit_dd.tools import DOCUMENT_IDS, METRICS, TOOL_NAMES, build_credit_tools  # noqa: E402
from labs.credit_dd.verifier import verify_observation  # noqa: E402
from labs.credit_dd.world import BLOCK_REASONS, CreditWorld  # noqa: E402


def _tool_details(case, tool: str | None = None) -> list[dict]:
    details = [
        event["payload"]["detail"]
        for event in case.events
        if event["type"] == "tool_succeeded"
    ]
    if tool is None:
        return details
    return [detail for detail in details if detail["tool"] == tool]


class CreditWorldTests(unittest.TestCase):
    def test_full_world_recomputes_the_two_expected_metrics(self) -> None:
        world = CreditWorld()
        world.read_document("doc_ar_fy2025")
        world.read_document("doc_debt_fy2025")

        net_debt = world.compute_credit_metric("net_debt_to_ebitda", "FY2025")
        coverage = world.compute_credit_metric("interest_coverage", "FY2025")

        self.assertTrue(net_debt["computed"])
        self.assertEqual(net_debt["value_x100"], 377)
        self.assertEqual(net_debt["inputs"], {"total_debt": 780_000, "cash": 120_000, "ebitda": 175_000})
        self.assertTrue(coverage["computed"])
        self.assertEqual(coverage["value_x100"], 417)
        self.assertEqual(coverage["inputs"], {"ebitda": 175_000, "interest_expense": 42_000})

        for result in (net_debt, coverage):
            self.assertEqual(result["blockers"], [])
            for citation in result["citations"]:
                document = world.read_document(citation["doc_id"])
                self.assertIn(citation["field"], document["line_refs"])
                self.assertEqual(document["line_refs"][citation["field"]], citation["line"])
                self.assertLessEqual(citation["line"], len(document["body"].splitlines()))

    def test_partial_world_refuses_net_debt_with_the_named_blocker(self) -> None:
        world = CreditWorld(partial=True)
        listed = [item["doc_id"] for item in world.list_documents()["documents"]]
        self.assertNotIn("doc_debt_fy2025", listed)

        missing = world.read_document("doc_debt_fy2025")
        self.assertEqual(
            missing,
            {"found": False, "doc_id": "doc_debt_fy2025", "reason": "missing_document"},
        )
        net_debt = world.compute_credit_metric("net_debt_to_ebitda", "FY2025")
        self.assertFalse(net_debt["computed"])
        self.assertEqual(net_debt["blockers"], ["missing_debt_schedule"])
        self.assertNotIn("value_x100", net_debt)


class ToolContractTests(unittest.TestCase):
    def test_blueprint_order_and_tool_whitelist(self) -> None:
        plan = CreditPlanner().decompose("credit check")
        self.assertEqual([todo.id for todo in plan.todos], ["c1", "c2", "c3", "c4", "c5", "c6"])
        self.assertEqual(
            [todo.tool for todo in plan.todos],
            ["list_documents", "read_document", "read_document", "read_document",
             "compute_credit_metric", "compute_credit_metric"],
        )
        self.assertEqual(plan.todos[3].arguments, {"doc_id": "doc_debt_fy2025"})
        self.assertEqual(plan.todos[4].arguments, {"metric": "net_debt_to_ebitda", "period": "FY2025"})
        self.assertEqual(plan.todos[5].arguments, {"metric": "interest_coverage", "period": "FY2025"})

        specs = build_credit_tools(CreditWorld())
        self.assertEqual(tuple(spec.name for spec in specs), TOOL_NAMES)
        self.assertEqual(
            TOOL_NAMES,
            ("list_documents", "read_document", "compute_credit_metric", "report_blocked"),
        )
        self.assertTrue(all(spec.effect == EFFECT_READ for spec in specs))
        self.assertIn("doc_debt_fy2025", DOCUMENT_IDS)
        self.assertEqual(METRICS, ("net_debt_to_ebitda", "interest_coverage"))
        self.assertEqual(
            BLOCK_REASONS,
            ("missing_document", "insufficient_evidence", "basis_unresolved"),
        )

    def test_tool_outputs_validate_against_their_contracts(self) -> None:
        world = CreditWorld()
        registry = ToolRegistry(build_credit_tools(world))

        listed = registry.execute("list_documents", {})
        self.assertEqual(len(listed.result["documents"]), 3)

        annual = registry.execute("read_document", {"doc_id": "doc_ar_fy2025"})
        self.assertTrue(annual.result["found"])
        self.assertEqual(annual.result["fields"]["ebitda"], 175_000)
        self.assertIn("ebitda", annual.result["line_refs"])

        debt = registry.execute("read_document", {"doc_id": "doc_debt_fy2025"})
        self.assertTrue(debt.result["found"])

        metric = registry.execute(
            "compute_credit_metric",
            {"metric": "net_debt_to_ebitda", "period": "FY2025"},
        )
        self.assertTrue(metric.result["computed"])
        self.assertEqual(metric.result["value_x100"], 377)

        blocked = registry.execute("report_blocked", {"reason": "insufficient_evidence"})
        self.assertTrue(blocked.result["acknowledged"])
        self.assertEqual(blocked.result["reason"], "insufficient_evidence")

    def test_missing_document_output_still_validates(self) -> None:
        registry = ToolRegistry(build_credit_tools(CreditWorld(partial=True)))
        missing = registry.execute("read_document", {"doc_id": "doc_debt_fy2025"})
        self.assertFalse(missing.result["found"])
        self.assertEqual(missing.result["reason"], "missing_document")
        self.assertNotIn("id", missing.result)


class SpikeTests(unittest.TestCase):
    def test_happy_path_succeeds_with_runtime_recomputed_metrics(self) -> None:
        case = run_case("happy-test")
        self.assertTrue(case.ok)
        self.assertEqual(case.task.status, "succeeded")
        self.assertEqual(case.summary["metrics"], EXPECTED_METRICS)
        self.assertTrue(case.summary["verified"])
        self.assertTrue(case.plan.is_complete())
        self.assertTrue(all(todo.status == "done" for todo in case.plan.todos))
        self.assertEqual(case.events[-1]["type"], "task_succeeded")

        computed = _tool_details(case, "compute_credit_metric")
        self.assertEqual(
            [(detail["result"]["metric"], detail["result"]["value_x100"]) for detail in computed],
            [("net_debt_to_ebitda", 377), ("interest_coverage", 417)],
        )
        self.assertTrue(all(detail["result"]["computed"] for detail in computed))
        self.assertNotIn(
            "report_blocked",
            [detail["tool"] for detail in _tool_details(case)],
        )
        self.assertEqual(case.summary["chain_head"], case.verification["head_hash"])

    def test_partial_world_blocks_instead_of_inventing_net_debt(self) -> None:
        case = run_case("partial-test", partial=True)
        self.assertTrue(case.ok)
        self.assertEqual(case.task.status, "failed")
        self.assertEqual(case.summary["failure_code"], "INSUFFICIENT_EVIDENCE")
        self.assertEqual(case.summary["metrics"], {})
        self.assertTrue(case.summary["verified"])
        self.assertTrue(case.plan.is_blocked())

        statuses = {todo.id: todo.status for todo in case.plan.todos}
        self.assertEqual(statuses["c4"], "blocked")
        self.assertEqual(statuses["c5"], "abandoned")
        self.assertEqual(statuses["c6"], "done")
        c4 = next(todo for todo in case.plan.todos if todo.id == "c4")
        self.assertEqual(c4.reason, "missing_document")

        computed = _tool_details(case, "compute_credit_metric")
        self.assertEqual(len(computed), 1)
        self.assertEqual(computed[0]["result"]["metric"], "interest_coverage")
        self.assertEqual(computed[0]["result"]["value_x100"], 417)
        self.assertFalse(case.has_computed_net_debt())
        self.assertFalse(
            any(
                detail["result"].get("metric") == "net_debt_to_ebitda"
                for detail in computed
            )
        )
        self.assertNotIn(
            "report_blocked",
            [detail["tool"] for detail in _tool_details(case)],
        )
        self.assertEqual(case.events[-1]["type"], "task_stopped")

    def test_verifier_rejects_a_one_digit_tamper(self) -> None:
        case = run_case("tamper-test")
        computed = _tool_details(case, "compute_credit_metric")
        self.assertEqual(len(computed), 2)

        for detail in computed:
            genuine = Observation(
                tool=detail["tool"],
                arguments=detail["arguments"],
                result=detail["result"],
            )
            recomputed = verify_observation(case.world, genuine)
            self.assertEqual(recomputed["value_x100"], detail["result"]["value_x100"])

            tampered_result = dict(detail["result"])
            tampered_result["value_x100"] += 1
            tampered = Observation(
                tool=detail["tool"],
                arguments=detail["arguments"],
                result=tampered_result,
            )
            with self.assertRaises(AgentError) as caught:
                verify_observation(case.world, tampered)
            self.assertEqual(caught.exception.code, "RESULT_VERIFICATION_FAILED")
            self.assertIn("value_x100", caught.exception.message)


class ModuleBoundaryTests(unittest.TestCase):
    def test_domain_module_exists_only_in_the_lab(self) -> None:
        self.assertEqual(set(DOMAINS), {"finance-research"})
        self.assertEqual(CREDIT_DD_DOMAIN.key, "credit-due-diligence")
        self.assertEqual(CREDIT_DD_DOMAIN.title, "信用尽调")
        self.assertEqual(CREDIT_DD_DOMAIN.approval_tools, ("report_blocked",))

        partial = CREDIT_DD_DOMAIN.create_world(partial=True)
        self.assertTrue(partial.partial)
        self.assertEqual(
            tuple(spec.name for spec in CREDIT_DD_DOMAIN.build_tools(partial)),
            TOOL_NAMES,
        )
        self.assertIsInstance(CREDIT_DD_DOMAIN.make_planner(), CreditPlanner)


if __name__ == "__main__":
    unittest.main()
