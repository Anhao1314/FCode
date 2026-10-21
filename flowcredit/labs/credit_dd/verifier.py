"""Independent credit-metric recomputation.

The verifier never reads ``observation.result["inputs"]`` as an answer. It asks
the world for the metric again, then compares every field of the model-visible
result with the recomputed one. A single changed digit raises
``RESULT_VERIFICATION_FAILED`` and the run cannot be marked succeeded.
"""

from __future__ import annotations

from typing import Any

from flowagent.core.contracts import AgentError
from flowagent.tools.base import Observation

from .world import COMPANY, METRICS, PERIODS, CreditWorld

__all__ = ["VERIFIED_FIELDS", "verify_observation", "CreditVerifier"]

#: Every field a successful metric observation promises. The comparison is
#: exhaustive on purpose: a tool that silently changes its citation or inputs
#: is as suspect as one that changes the number.
VERIFIED_FIELDS: tuple[str, ...] = (
    "computed",
    "metric",
    "period",
    "value_x100",
    "inputs",
    "citations",
    "blockers",
)


def verify_observation(world: CreditWorld, observation: Observation) -> dict[str, Any]:
    """Recompute one metric from the world and compare it field by field."""
    if observation.tool != "compute_credit_metric":
        raise AgentError("RESULT_INCOMPLETE", "no credit metric to verify")

    recorded = observation.result
    if not recorded.get("computed"):
        raise AgentError(
            "RESULT_INCOMPLETE",
            f"{recorded.get('metric')} for {recorded.get('period')} was not computed",
        )

    metric = recorded.get("metric")
    period = recorded.get("period")
    if metric not in METRICS or period not in PERIODS:
        raise AgentError(
            "RESULT_VERIFICATION_FAILED",
            f"unknown metric/period in observation: {metric!r}/{period!r}",
        )

    recomputed = world.compute_credit_metric(metric, period)
    if not recomputed.get("computed"):
        raise AgentError(
            "RESULT_INCOMPLETE",
            f"the world refuses to recompute {metric} for {period}: "
            f"{recomputed.get('blockers')}",
        )

    for key in VERIFIED_FIELDS:
        if recomputed.get(key) != recorded.get(key):
            raise AgentError(
                "RESULT_VERIFICATION_FAILED",
                f"{key} differs: recorded {recorded.get(key)!r} "
                f"vs recomputed {recomputed.get(key)!r}",
            )
    return recomputed


class CreditVerifier:
    """Harness-facing verifier that checks every metric in the committed chain.

    ``Harness.verify`` receives one observation, but a credit memo has two.
    This adapter reads the task's ``tool_succeeded`` events, recomputes each
    ``compute_credit_metric`` observation independently, and returns the merged
    metric map. It is still the same path to ``succeeded``: no model-produced
    number is accepted without a world recomputation.
    """

    def __init__(self, world: CreditWorld, store: Any) -> None:
        self.world = world
        self.store = store
        self.task_id = ""

    def bind(self, task_id: str) -> None:
        self.task_id = task_id

    def __call__(self, observation: Observation) -> dict[str, Any]:
        observations = self._observations()
        if not observations:
            raise AgentError(
                "RESULT_INCOMPLETE",
                "no compute_credit_metric observation to verify",
            )

        metrics: dict[str, int] = {}
        periods: set[str] = set()
        for item in observations:
            recomputed = verify_observation(self.world, item)
            metrics[recomputed["metric"]] = recomputed["value_x100"]
            periods.add(recomputed["period"])

        return {
            "verified": True,
            "verification": "runtime-recomputed",
            "result": {
                "company": COMPANY,
                "periods": sorted(periods),
                "metrics": metrics,
                "verified_observations": len(observations),
            },
        }

    def _observations(self) -> list[Observation]:
        if not self.task_id:
            raise AgentError("RESULT_INCOMPLETE", "the verifier is not bound to a task")
        observations: list[Observation] = []
        for event in self.store.events(self.task_id):
            if event["type"] != "tool_succeeded":
                continue
            detail = event["payload"].get("detail", {})
            if detail.get("tool") != "compute_credit_metric":
                continue
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
