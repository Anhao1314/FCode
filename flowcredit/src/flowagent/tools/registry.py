"""Tool registry: the single source of truth for what the model may call.

The registry does three things and nothing else: hold the specs, expose a
schema catalogue to the model, and dispatch a validated call. It never decides
*permission* — that is the runtime's gate. Keeping dispatch and authorisation
apart is what lets the demo show a denied call that still had a valid schema.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from ..core.contracts import AgentError
from ..core.hashing import digest
from .base import EFFECT_READ, Observation, ToolSpec, validate_arguments

__all__ = ["ToolRegistry"]


class ToolRegistry:
    """An immutable, ordered collection of :class:`ToolSpec`."""

    def __init__(self, specs: Iterable[ToolSpec]) -> None:
        ordered = list(specs)
        names = [spec.name for spec in ordered]
        if len(names) != len(set(names)):
            raise AgentError("TOOL_REGISTRY_INVALID", "duplicate tool name")
        self._specs: dict[str, ToolSpec] = {spec.name: spec for spec in ordered}

    def __contains__(self, name: object) -> bool:
        return name in self._specs

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._specs)

    def get(self, name: str) -> ToolSpec:
        spec = self._specs.get(name)
        if spec is None:
            raise AgentError("TOOL_NOT_REGISTERED", f"{name!r} is not a registered tool")
        return spec

    def catalog(self) -> list[dict[str, Any]]:
        """Return the schema list handed to the model."""
        return [spec.to_schema() for spec in self._specs.values()]

    def execute(self, name: str, arguments: Mapping[str, Any]) -> Observation:
        """Validate, run and wrap the result in an :class:`Observation`."""
        spec = self.get(name)
        if spec.effect != EFFECT_READ:
            raise AgentError(
                "TOOL_EFFECT_DENIED",
                f"{name!r} has effect {spec.effect!r}; Phase 1 only executes read-only tools",
            )
        normalised = validate_arguments(spec, arguments)
        result = spec.handler(normalised)
        return Observation(
            tool=name,
            arguments=normalised,
            result=result,
            result_hash=digest(result),
        )
