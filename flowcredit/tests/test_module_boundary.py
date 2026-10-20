"""The tool catalog is a composition: domain tools + shared workspace tools.

This is the guardrail for the module split. A second domain (audit, quant) must
add its own tools *next to* the workspace set, never re-implement ingestion or
push generic capabilities into the kernel.
"""

from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from flowagent.tools.artifacts import ArtifactStore  # noqa: E402
from flowagent.tools.connectors import default_registry  # noqa: E402
from flowagent.tools.evidence import EvidenceStore  # noqa: E402
from flowagent.tools.finance.fixtures import FinanceWorld  # noqa: E402
from flowagent.tools.finance.tools import build_finance_tools  # noqa: E402
from flowagent.tools.registry import ToolRegistry  # noqa: E402
from flowagent.tools.workspace import build_workspace_tools  # noqa: E402

FINANCE_TOOLS = [
    "list_documents",
    "read_document",
    "normalize_units",
    "reconcile_basis",
    "check_restatement",
    "calculate_margin",
    "report_blocked",
]
WORKSPACE_TOOLS = [
    "ingest_file",
    "search_corpus",
    "read_slice",
    "working_paper_append",
    "search_cases",
    "read_case",
    "query_facts",
    "fetch_source",
]


class ModuleBoundaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self._tmp.name)
        self.evidence = EvidenceStore(root)
        self.artifacts = ArtifactStore(root / "artifacts")
        self.connectors = default_registry()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_catalog_is_domain_then_workspace_and_order_is_stable(self) -> None:
        registry = ToolRegistry(build_finance_tools(
            FinanceWorld(), self.evidence, self.artifacts, self.connectors,
        ))
        names = [schema["name"] for schema in registry.catalog()]
        self.assertEqual(names, FINANCE_TOOLS + WORKSPACE_TOOLS)

    def test_workspace_tools_are_one_shared_set(self) -> None:
        specs = build_workspace_tools(self.evidence, self.artifacts, self.connectors)
        self.assertEqual([spec.name for spec in specs], WORKSPACE_TOOLS)
        effects = {spec.name: spec.effect for spec in specs}
        self.assertEqual(effects["working_paper_append"], "write")
        self.assertEqual(effects["fetch_source"], "network")

    def test_domain_tools_do_not_duplicate_workspace_names(self) -> None:
        self.assertEqual(set(FINANCE_TOOLS) & set(WORKSPACE_TOOLS), set())


if __name__ == "__main__":
    unittest.main()
