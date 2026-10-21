"""Independent recomputation for the eight credit metrics.

The verifier never reads ``observation.result["inputs"]`` as an answer. It asks
the world for the metric again, then compares every model-visible field with
the recomputed one. A single changed digit raises
``RESULT_VERIFICATION_FAILED`` and the run cannot be marked succeeded.

The loop invokes this function once per committed ``compute_credit_metric``
observation, so a later metric cannot hide an earlier one.
"""

from __future__ import annotations

from typing import Any

from flowagent.core.contracts import AgentError
from flowagent.tools.base import Observation

from .world import METRICS, PERIODS, CreditWorld

__all__ = ["VERIFIED_FIELDS", "verify_observation"]

VERIFIED_FIELDS: tuple[str, ...] = (
    "computed",
    "metric",
    "period",
    "kind",
    "value_bp",
    "value_code",
    "display",
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
    return {
        "verified": True,
        "verification": "runtime-recomputed",
        "result": recomputed,
    }
