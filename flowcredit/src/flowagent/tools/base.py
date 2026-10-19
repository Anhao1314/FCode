"""Tool abstractions: a closed schema, a declared effect, and an observation.

A tool is the only way the model can touch the world, so the shape of this
module matters more than its size. Two rules are encoded here:

* a tool declares its parameters as data, not as Python signature inspection,
  so the host can show the model exactly the same schema it will enforce;
* every tool declares an ``effect``. Phase 1 registers read-only effects only,
  and the runtime refuses to execute anything else. That refusal is what lets
  the demo say "the model cannot write" and mean it literally.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from ..core.contracts import AgentError

__all__ = [
    "EFFECT_READ",
    "Param",
    "ToolSpec",
    "Observation",
    "validate_arguments",
]

EFFECT_READ = "read"


@dataclass(frozen=True)
class Param:
    """One declared parameter of a tool."""

    name: str
    kind: str  # "string" | "integer"
    required: bool = True
    enum: tuple[str, ...] | None = None
    minimum: int | None = None
    maximum: int | None = None
    description: str = ""

    def to_schema(self) -> dict[str, Any]:
        schema: dict[str, Any] = {"type": self.kind, "required": self.required}
        if self.enum is not None:
            schema["enum"] = list(self.enum)
        if self.minimum is not None:
            schema["minimum"] = self.minimum
        if self.maximum is not None:
            schema["maximum"] = self.maximum
        if self.description:
            schema["description"] = self.description
        return schema


@dataclass(frozen=True)
class ToolSpec:
    """A registered tool: schema, effect and the callable that implements it."""

    name: str
    summary: str
    effect: str
    params: tuple[Param, ...]
    handler: Callable[[Mapping[str, Any]], dict[str, Any]]

    def to_schema(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "summary": self.summary,
            "effect": self.effect,
            "parameters": {param.name: param.to_schema() for param in self.params},
        }


@dataclass(frozen=True)
class Observation:
    """What a tool returned, plus the hash the runtime will re-check later."""

    tool: str
    arguments: dict[str, Any]
    result: dict[str, Any]
    result_hash: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "arguments": self.arguments,
            "result": self.result,
            "result_hash": self.result_hash,
        }


def validate_arguments(spec: ToolSpec, arguments: Mapping[str, Any]) -> dict[str, Any]:
    """Validate *arguments* against *spec* and return a normalised copy.

    Unknown keys are rejected rather than ignored. A model that invents a
    parameter has escaped the schema, and silently dropping the extra key would
    hide that from the trace.
    """
    if not isinstance(arguments, Mapping):
        raise AgentError("TOOL_ARGUMENTS_INVALID", f"{spec.name} expects an object of arguments")

    declared = {param.name: param for param in spec.params}
    unknown = set(arguments) - set(declared)
    if unknown:
        raise AgentError(
            "TOOL_ARGUMENTS_INVALID",
            f"{spec.name} does not accept {sorted(unknown)}",
        )

    normalised: dict[str, Any] = {}
    for param in spec.params:
        if param.name not in arguments:
            if param.required:
                raise AgentError(
                    "TOOL_ARGUMENTS_INVALID",
                    f"{spec.name} requires {param.name!r}",
                )
            continue
        value = arguments[param.name]
        if param.kind == "string":
            if not isinstance(value, str) or not value:
                raise AgentError("TOOL_ARGUMENTS_INVALID", f"{param.name!r} must be a non-empty string")
            if param.enum is not None and value not in param.enum:
                raise AgentError(
                    "TOOL_ARGUMENTS_INVALID",
                    f"{param.name!r} must be one of {list(param.enum)}",
                )
        elif param.kind == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise AgentError("TOOL_ARGUMENTS_INVALID", f"{param.name!r} must be an integer")
            if param.minimum is not None and value < param.minimum:
                raise AgentError("TOOL_ARGUMENTS_INVALID", f"{param.name!r} is below {param.minimum}")
            if param.maximum is not None and value > param.maximum:
                raise AgentError("TOOL_ARGUMENTS_INVALID", f"{param.name!r} is above {param.maximum}")
        else:  # pragma: no cover - guards a programming error, not user input
            raise AgentError("TOOL_SCHEMA_INVALID", f"unknown parameter kind {param.kind!r}")
        normalised[param.name] = value
    return normalised
