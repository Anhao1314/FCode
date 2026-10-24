"""Versioned contracts, task state and validation rules.

This module is the Python counterpart of ``contracts.mjs`` plus the task body
defined in ``harness.mjs``. It deliberately keeps validation *strict and
narrow*: unknown keys are rejected rather than ignored, because a silently
accepted extra field is how a model escapes a schema without anyone noticing.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Any, Iterable

__all__ = [
    "PLAN_VERSION",
    "TOOL_VERSION",
    "TASK_VERSION",
    "EVENT_VERSION",
    "TRACE_VERSION",
    "TASK_STATES",
    "MODEL_STATES",
    "STEP_STATES",
    "AgentError",
    "Step",
    "Plan",
    "ModelState",
    "Task",
    "exact_keys",
    "validate_plan",
]

PLAN_VERSION = "flowagent.plan/v1"
TOOL_VERSION = "flowagent.tools/v1"
TASK_VERSION = "flowagent.task/v1"
EVENT_VERSION = "flowagent.event/v1"
TRACE_VERSION = "flowagent.trace/v1"

TASK_STATES = (
    "created",
    "planning",
    "planned",
    "running",
    "verifying",
    "succeeded",
    "paused",
    "failed",
    "denied",
    "recovery_required",
)

MODEL_STATES = ("not_started", "started", "validated", "failed", "unknown")

STEP_STATES = ("pending", "started", "succeeded", "failed", "denied")

#: Legal task transitions. Anything not listed is rejected by the store, so a
#: crash cannot silently move a task into a state the design never allowed.
#:
#: ``running -> recovery_required`` exists because an unknown model outcome can
#: happen in any round, not only the first. ``recovery_required -> running``
#: exists because reconciliation returns the task to the round it was in.
TASK_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "created": ("created", "planning", "denied"),
    "planning": ("planning", "planned", "failed", "recovery_required"),
    "planned": ("planned", "running", "denied"),
    "running": ("running", "paused", "verifying", "failed", "denied", "recovery_required"),
    "paused": ("paused", "running", "denied"),
    "verifying": ("verifying", "succeeded", "failed", "denied"),
    "failed": ("failed", "running", "denied"),
    "denied": ("denied",),
    "succeeded": ("succeeded",),
    "recovery_required": ("recovery_required", "planned", "running", "failed"),
}

#: Each round is a fresh call, so ``validated`` may return to ``started``. Without
#: that edge a timeout in round two would have no legal state to move to, and the
#: task would be forced into ``failed`` instead of the honest ``unknown``.
MODEL_TRANSITIONS: dict[str, tuple[str, ...]] = {
    "not_started": ("not_started", "started"),
    "started": ("started", "unknown", "validated", "failed"),
    "unknown": ("unknown", "validated", "failed"),
    "validated": ("validated", "started"),
    "failed": ("failed",),
}

_STEP_ID = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
_TOOL_NAME = re.compile(r"^[a-z][a-z0-9_.]{0,63}$")
#: Proposals stay bounded so a plan event is small and hashable. The original
#: 1 KiB ceiling assumed read-only tools with identifier-sized arguments; the
#: governed general capabilities (write_file) carry authored content, so the
#: bound is re-bounded — not removed — at 96 KiB. The tool schema still caps
#: any single content parameter far below this (see Param.max_length).
_MAX_STEP_ARGUMENT_BYTES = 96 * 1024


class AgentError(Exception):
    """A failure carrying a stable machine-readable ``code``.

    Codes are part of the observable contract: the demo prints them, the trace
    stores them, and tests assert on them. ``retryable`` is only True for the
    two cases where re-running the same step is provably safe.
    """

    def __init__(
        self,
        code: str,
        message: str = "",
        *,
        retryable: bool = False,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.retryable = retryable
        self.details = details or {}

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.code}: {self.message}" if self.message != self.code else self.code

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


def exact_keys(value: Any, keys: Iterable[str]) -> bool:
    """Return True when *value* is a dict whose key set is exactly *keys*."""
    expected = set(keys)
    return isinstance(value, dict) and set(value.keys()) == expected


@dataclass(frozen=True)
class Step:
    """One tool call proposed by the model.

    ``arguments`` is validated against the tool schema *and* the host policy.
    In Phase 1 the finance tools accept a small, closed set of parameters; the
    model can choose values but never the tool's identity, effect or scope.
    """

    id: str
    tool: str
    arguments: dict[str, Any] = field(default_factory=dict)
    status: str = "pending"
    result: dict[str, Any] | None = None
    result_hash: str | None = None
    attempts: int = 0
    error_code: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tool": self.tool,
            "arguments": self.arguments,
            "status": self.status,
            "result": self.result,
            "result_hash": self.result_hash,
            "attempts": self.attempts,
            "error_code": self.error_code,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Step":
        return cls(
            id=data["id"],
            tool=data["tool"],
            arguments=dict(data.get("arguments") or {}),
            status=data.get("status", "pending"),
            result=data.get("result"),
            result_hash=data.get("result_hash"),
            attempts=int(data.get("attempts", 0)),
            error_code=data.get("error_code"),
        )


@dataclass(frozen=True)
class Plan:
    """A validated proposal: one to six ordered steps."""

    version: str
    steps: tuple[Step, ...]

    def to_dict(self) -> dict[str, Any]:
        return {"version": self.version, "steps": [step.to_dict() for step in self.steps]}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Plan":
        return cls(
            version=data["version"],
            steps=tuple(Step.from_dict(item) for item in data["steps"]),
        )


def validate_plan(value: Any) -> Plan:
    """Validate a model proposal and return an immutable :class:`Plan`.

    Rules are intentionally identical to the Node prototype: version must
    match, 1-6 steps, unique snake/kebab ids, a registered-looking tool name,
    a dict of arguments no larger than 1 KiB. Tool *existence* is checked by
    the runtime gate, not here, so an unknown tool produces a denial receipt
    instead of a schema error.
    """
    if not exact_keys(value, ("version", "steps")):
        raise AgentError("PLAN_SCHEMA_INVALID", "plan must contain exactly version and steps")
    if value["version"] != PLAN_VERSION:
        raise AgentError("PLAN_SCHEMA_INVALID", f"unsupported plan version {value['version']!r}")
    steps = value["steps"]
    if not isinstance(steps, list) or not 1 <= len(steps) <= 6:
        raise AgentError("PLAN_SCHEMA_INVALID", "plan must contain 1-6 steps")

    seen: set[str] = set()
    validated: list[Step] = []
    for raw in steps:
        if not exact_keys(raw, ("id", "tool", "arguments")):
            raise AgentError("PLAN_SCHEMA_INVALID", "each step must contain exactly id, tool, arguments")
        step_id, tool, arguments = raw["id"], raw["tool"], raw["arguments"]
        if not isinstance(step_id, str) or not _STEP_ID.match(step_id) or step_id in seen:
            raise AgentError("PLAN_SCHEMA_INVALID", f"invalid or duplicate step id {step_id!r}")
        if not isinstance(tool, str) or not _TOOL_NAME.match(tool):
            raise AgentError("PLAN_SCHEMA_INVALID", f"invalid tool name {tool!r}")
        if not isinstance(arguments, dict):
            raise AgentError("PLAN_SCHEMA_INVALID", "step arguments must be an object")
        from .hashing import canonical_json

        if len(canonical_json(arguments).encode("utf-8")) > _MAX_STEP_ARGUMENT_BYTES:
            raise AgentError("PLAN_SCHEMA_INVALID", "step arguments exceed 96 KiB")
        seen.add(step_id)
        validated.append(Step(id=step_id, tool=tool, arguments=dict(arguments)))
    return Plan(version=PLAN_VERSION, steps=tuple(validated))


@dataclass
class ModelState:
    """What the runtime knows about the model call, independent of the model."""

    status: str = "not_started"
    attempts: int = 0
    proposal: dict[str, Any] | None = None
    receipt: dict[str, Any] | None = None
    receipt_ref: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "attempts": self.attempts,
            "proposal": self.proposal,
            "receipt": self.receipt,
            "receipt_ref": self.receipt_ref,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ModelState":
        return cls(
            status=data.get("status", "not_started"),
            attempts=int(data.get("attempts", 0)),
            proposal=data.get("proposal"),
            receipt=data.get("receipt"),
            receipt_ref=data.get("receipt_ref"),
        )


@dataclass
class Task:
    """The durable body of one research task.

    ``sequence`` is the number of committed events. It is the optimistic
    concurrency token: every write must present ``expected_sequence`` and the
    store refuses anything else.
    """

    id: str
    status: str = "created"
    sequence: int = 0
    version: str = TASK_VERSION
    principal: str = ""
    objective: str = ""
    binding: dict[str, Any] = field(default_factory=dict)
    allowed_tools: list[str] = field(default_factory=list)
    model_grant: dict[str, Any] = field(default_factory=dict)
    model: ModelState = field(default_factory=ModelState)
    plan: Plan | None = None
    #: Durable snapshot of the agent's current plan (see core/plan.py). Kept as
    #: a plain dict so the contract layer does not import the plan module and
    #: create a cycle; the loop owns the typed view.
    plan_state: dict[str, Any] | None = None
    steps: list[Step] = field(default_factory=list)
    failure: dict[str, Any] | None = None
    result: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "sequence": self.sequence,
            "version": self.version,
            "principal": self.principal,
            "objective": self.objective,
            "binding": self.binding,
            "allowed_tools": list(self.allowed_tools),
            "model_grant": self.model_grant,
            "model": self.model.to_dict(),
            "plan": self.plan.to_dict() if self.plan else None,
            "plan_state": self.plan_state,
            "steps": [step.to_dict() for step in self.steps],
            "failure": self.failure,
            "result": self.result,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Task":
        plan = Plan.from_dict(data["plan"]) if data.get("plan") else None
        return cls(
            id=data["id"],
            status=data["status"],
            sequence=int(data["sequence"]),
            version=data.get("version", TASK_VERSION),
            principal=data.get("principal", ""),
            objective=data.get("objective", ""),
            binding=dict(data.get("binding") or {}),
            allowed_tools=list(data.get("allowed_tools") or []),
            model_grant=dict(data.get("model_grant") or {}),
            model=ModelState.from_dict(data.get("model") or {}),
            plan=plan,
            plan_state=data.get("plan_state"),
            steps=[Step.from_dict(item) for item in data.get("steps") or []],
            failure=data.get("failure"),
            result=data.get("result"),
        )

    def advance(self, status: str) -> "Task":
        """Return a copy moved to *status*, rejecting illegal transitions."""
        allowed = TASK_TRANSITIONS.get(self.status, ())
        if status not in allowed:
            raise AgentError(
                "ILLEGAL_STATE_TRANSITION",
                f"cannot move task from {self.status!r} to {status!r}",
            )
        return replace(self, status=status)

    def with_model(self, **changes: Any) -> "Task":
        """Return a copy with model fields updated, rejecting illegal transitions."""
        target = changes.get("status")
        if target is not None:
            allowed = MODEL_TRANSITIONS.get(self.model.status, ())
            if target not in allowed:
                raise AgentError(
                    "ILLEGAL_MODEL_TRANSITION",
                    f"cannot move model from {self.model.status!r} to {target!r}",
                )
        updated = replace(self.model, **changes)
        return replace(self, model=updated)
