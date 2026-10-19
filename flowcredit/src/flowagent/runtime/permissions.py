"""The host gate: the only place that decides whether a proposal may run.

A model proposal is a *request*, never an instruction. This module turns that
request into a decision with a stable code, so the trace can show a denial and
the reason for it. Three independent scopes must all agree:

1. the tool must be registered at all,
2. the task must list it in ``allowed_tools``,
3. the current grant must list it too.

Checking three times looks redundant until you remember that the grant is
re-read from the host on every round: a permission revoked mid-task must stop
the very next call, which is impossible if only the task body is consulted.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from ..core.contracts import AgentError
from ..tools.base import EFFECT_READ, validate_arguments
from ..tools.registry import ToolRegistry

__all__ = ["GateDecision", "Permissions"]


@dataclass(frozen=True)
class GateDecision:
    """The outcome of one gate check, with a code suitable for a trace."""

    allowed: bool
    code: str
    reason: str
    tool: str

    def to_dict(self) -> dict[str, Any]:
        return {"allowed": self.allowed, "code": self.code, "reason": self.reason, "tool": self.tool}


class Permissions:
    """Evaluates proposals against the registry, the task scope and the grant."""

    def __init__(
        self,
        registry: ToolRegistry,
        allowed_tools: list[str],
        grant: Mapping[str, Any],
    ) -> None:
        self._registry = registry
        self._allowed_tools = list(allowed_tools)
        self._grant = dict(grant)

    def gate(self, tool: str, arguments: Mapping[str, Any]) -> GateDecision:
        """Return a decision; never raises for an ordinary denial."""
        if tool not in self._registry:
            return GateDecision(False, "TOOL_NOT_REGISTERED", f"{tool!r} is not a registered tool", tool)
        if tool not in self._allowed_tools:
            return GateDecision(
                False,
                "TOOL_NOT_IN_TASK_SCOPE",
                f"{tool!r} is not in this task's allowed_tools",
                tool,
            )
        grant_tools = self._grant.get("allowed_tools", [])
        if tool not in grant_tools:
            return GateDecision(
                False,
                "TOOL_NOT_IN_GRANT",
                f"{tool!r} is not covered by the current host grant",
                tool,
            )

        spec = self._registry.get(tool)
        if spec.effect != EFFECT_READ:
            return GateDecision(
                False,
                "TOOL_EFFECT_DENIED",
                f"{tool!r} has effect {spec.effect!r}; only read effects are permitted",
                tool,
            )

        try:
            validate_arguments(spec, arguments)
        except AgentError as error:
            return GateDecision(False, error.code, error.message, tool)
        return GateDecision(True, "PASS", "schema, scope and grant all agree", tool)
