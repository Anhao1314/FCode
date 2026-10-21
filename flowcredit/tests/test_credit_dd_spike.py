"""Phase 0 lab seam proof, now backed by the production credit module.

The detailed eight-metric and memo tests live in ``test_credit_domain`` and
``test_credit_memo``. This file only proves that the lab is a thin wrapper and
that the original success/refusal seam still holds through the real runtime.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from flowagent.domains import DOMAINS  # noqa: E402
from flowagent.domains.credit import CREDIT_DOMAIN  # noqa: E402

import flowagent.tools.credit.planner as prod_planner  # noqa: E402
import flowagent.tools.credit.tools as prod_tools  # noqa: E402
import flowagent.tools.credit.verifier as prod_verifier  # noqa: E402
import flowagent.tools.credit.world as prod_world  # noqa: E402
import labs.credit_dd.module as lab_module  # noqa: E402
import labs.credit_dd.planner as lab_planner  # noqa: E402
import labs.credit_dd.tools as lab_tools  # noqa: E402
import labs.credit_dd.verifier as lab_verifier  # noqa: E402
import labs.credit_dd.world as lab_world  # noqa: E402
from labs.credit_dd.spike import EXPECTED_METRICS, run_case  # noqa: E402


class LabSeamTests(unittest.TestCase):
    def test_happy_path_still_reaches_verified_success(self) -> None:
        case = run_case("happy-test")
        self.assertTrue(case.ok)
        self.assertEqual(case.task.status, "succeeded")
        self.assertEqual(case.summary["metrics"], EXPECTED_METRICS)
        self.assertEqual(case.summary["failure_code"], "")
        self.assertTrue(case.summary["verified"])
        self.assertTrue(case.plan.is_complete())
        self.assertTrue(all(todo.status == "done" for todo in case.plan.todos))
        self.assertEqual(case.events[-1]["type"], "task_succeeded")
        self.assertEqual(case.summary["chain_head"], case.verification["head_hash"])

    def test_partial_world_still_refuses_without_fabricating_net_debt(self) -> None:
        case = run_case("partial-test", partial=True)
        self.assertTrue(case.ok)
        self.assertEqual(case.task.status, "failed")
        self.assertEqual(case.summary["failure_code"], "INSUFFICIENT_EVIDENCE")
        self.assertTrue(case.summary["verified"])
        self.assertTrue(case.plan.is_blocked())

        statuses = {todo.id: todo.status for todo in case.plan.todos}
        self.assertEqual(statuses["c5"], "blocked")
        for todo_id in ("c6", "c7", "c9", "c11", "c12", "c14"):
            self.assertEqual(statuses[todo_id], "abandoned")
        for todo_id in ("c8", "c10", "c13"):
            self.assertEqual(statuses[todo_id], "done")
        self.assertFalse(case.has_computed_net_debt())
        self.assertEqual(case.summary["metrics"], {})
        self.assertEqual(case.events[-1]["type"], "task_stopped")

    def test_lab_modules_are_re_exports_not_copies(self) -> None:
        self.assertIs(lab_world.CreditWorld, prod_world.CreditWorld)
        self.assertIs(lab_tools.build_credit_tools, prod_tools.build_credit_tools)
        self.assertIs(lab_planner.CreditPlanner, prod_planner.CreditPlanner)
        self.assertIs(lab_verifier.verify_observation, prod_verifier.verify_observation)
        self.assertIs(lab_module.CREDIT_DD_DOMAIN, CREDIT_DOMAIN)

    def test_credit_domain_is_registered(self) -> None:
        self.assertIs(DOMAINS["credit-due-diligence"], CREDIT_DOMAIN)
        self.assertEqual(CREDIT_DOMAIN.result_tools, ("compute_credit_metric",))


if __name__ == "__main__":
    unittest.main()
