"""Working memory: the observation summary the model is allowed to see.

Two design choices are worth defending in an interview.

**It is derived, not stored.** The context is rebuilt from the observation log
every round rather than mutated in place. A model that could mutate memory could
rewrite history; a derived view cannot drift from the record.

**It is compressed, not raw.** Each observation is reduced to the fields a
decision actually needs. Passing full tool output forward is how a context window
fills with text nobody reads — and it also makes the next action depend on
phrasing rather than on facts.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from ..core.hashing import canonical_json
from ..tools.base import Observation

__all__ = ["ObservationRecord", "WorkingMemory", "default_summarize"]


def _arguments_head(arguments: dict[str, Any], limit: int = 80) -> str:
    flat = " ".join(f"{key}={str(value)[:24]}" for key, value in arguments.items())
    return flat[:limit]


def default_summarize(result: dict[str, Any]) -> dict[str, Any]:
    """Shape-based fallback for tools that do not declare a summarizer.

    Scalars survive whole (long strings as head + true length); lists become a
    count plus a peek at the first scalar item; nested objects become their
    sorted key list. Tools that declare ``summarize`` on their spec always win.
    """
    out: dict[str, Any] = {}
    for key, value in result.items():
        if value is None or isinstance(value, (str, int, float, bool)):
            if isinstance(value, str) and len(value) > 240:
                out[key] = {"head": value[:240], "chars": len(value)}
            else:
                out[key] = value
        elif isinstance(value, list):
            scalars = [item for item in value if isinstance(item, (str, int, float, bool))]
            entry: dict[str, Any] = {"count": len(value)}
            if scalars:
                entry["first"] = scalars[0]
            out[key] = entry
        elif isinstance(value, dict):
            out[key] = {"keys": sorted(value)[:8]}
        else:
            out[key] = str(value)[:120]
    return out


@dataclass(frozen=True)
class ObservationRecord:
    """One compressed observation, kept for the whole task."""

    round: int
    tool: str
    arguments: dict[str, Any]
    result: dict[str, Any]
    result_hash: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "round": self.round,
            "tool": self.tool,
            "arguments": self.arguments,
            "result": self.result,
            "result_hash": self.result_hash,
        }


@dataclass
class WorkingMemory:
    """Accumulates observations and derives the next context."""

    objective: str
    tool_catalog: list[dict[str, Any]]
    records: list[ObservationRecord] = field(default_factory=list)
    #: Frozen at delegation time and recorded in the chain. Re-ranking on every
    #: round would make the prompt depend on wall-clock time and on cases
    #: created by the run itself.
    prior_cases: list[dict[str, Any]] = field(default_factory=list)
    #: Per-tool compressors declared on their ToolSpecs (memory does not know
    #: tool names). Tools without one use :func:`default_summarize`.
    summarizers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = field(
        default_factory=dict
    )
    #: The domain's "what has been established so far" view. Registered on the
    #: DomainModule; without one a neutral fallback keeps the context honest.
    state_fn: Callable[[Any], dict[str, Any]] | None = None
    #: Character budget for the inlined compressed observations. Older rounds
    #: fold into ``observation_index`` rows — prompt-level forgetting while the
    #: store keeps everything (auditability is store-level, not prompt-level).
    observation_budget: int = 24_000
    #: Highest round folded into the index so far; the loop turns a fresh fold
    #: into a ``context_compacted`` chain event and clears the pending marker.
    folded_through: int = 0
    pending_compaction: dict[str, Any] | None = None
    #: The conversation a delegation was handed off from (chat → work bridge).
    #: Operator input, frozen in the task binding, sanitised by the console
    #: (role/text pairs, capped) — carried so temporal/place references in the
    #: objective ("周三", "当天", "到了后") resolve against what was actually
    #: said. Absent for direct delegations; the key then never appears in the
    #: context, so the finance v10 prompt bytes are untouched.
    conversation: list[dict[str, Any]] | None = None

    def record(self, round_no: int, observation: Observation) -> ObservationRecord:
        record = ObservationRecord(
            round=round_no,
            tool=observation.tool,
            arguments=dict(observation.arguments),
            result=dict(observation.result),
            result_hash=observation.result_hash,
        )
        self.records.append(record)
        return record

    # ------------------------------------------------------------------- state

    def state(self) -> dict[str, Any]:
        """The domain's derived state; neutral fallback without a state_fn."""
        if self.state_fn is not None:
            return self.state_fn(self.records)
        return {
            "rounds_recorded": len(self.records),
            "tools_used": sorted({record.tool for record in self.records}),
        }

    # ----------------------------------------------------------------- context

    def last_evidence(self) -> dict[str, Any] | None:
        """One compressed card for the policy packet, not the whole history."""
        if not self.records:
            return None
        record = self.records[-1]
        return {
            "round": record.round,
            "tool": record.tool,
            "arguments": dict(record.arguments),
            "summary": self._summarise(record),
        }

    def build(
        self,
        round_no: int,
        budget_snapshot: dict[str, Any],
        plan: Any | None = None,
    ) -> dict[str, Any]:
        """Return the context object handed to the provider this round.

        ``plan`` is the open-todo view, not the whole plan: the model needs to
        know what is left, not the history of how it got there.

        The observation list is budgeted: the newest compressed rounds stay
        inline; older rounds fold into ``observation_index`` rows (round, tool,
        argument head, result hash). Folding is prompt-level forgetting — the
        store keeps every record, and the loop turns a fresh fold into a
        ``context_compacted`` chain event.
        """
        all_observations = [
            {
                "round": record.round,
                "tool": record.tool,
                "arguments": record.arguments,
                "summary": self._summarise(record),
            }
            for record in self.records
        ]
        index_rows: list[dict[str, Any]] = []
        inline = all_observations
        total = sum(len(canonical_json(o)) for o in all_observations)
        if total > self.observation_budget and len(all_observations) > 1:
            running = total
            keep_from = len(all_observations)
            for i in range(len(all_observations) - 1):
                running -= len(canonical_json(all_observations[i]))
                if running <= self.observation_budget:
                    keep_from = i + 1
                    break
            keep_from = max(keep_from, 1)
            folded = all_observations[:keep_from]
            inline = all_observations[keep_from:]
            index_rows = [
                {
                    "round": row["round"],
                    "tool": row["tool"],
                    "arguments_head": _arguments_head(record.arguments),
                    "result_hash": record.result_hash[:12],
                }
                for row, record in zip(folded, self.records[:keep_from])
            ]
            last_folded = index_rows[-1]["round"]
            if last_folded > self.folded_through:
                self.pending_compaction = {
                    "from_round": index_rows[0]["round"],
                    "through_round": last_folded,
                    "inlined_from_round": inline[0]["round"],
                    "folded_count": len(index_rows),
                }
                self.folded_through = last_folded

        context = {
            "objective": self.objective,
            "round": round_no,
            "tools": self.tool_catalog,
            "plan": plan.to_context() if plan is not None else [],
            "state": self.state(),
            "observations": inline,
            "budget": budget_snapshot,
            "instruction": (
                "Propose exactly one read-only action. You cannot execute it, "
                "cannot mark the task complete, and cannot pass a financial value. "
                "The runtime decides when the evidence is sufficient."
            ),
        }
        if index_rows:
            context["observation_index"] = index_rows
        if self.conversation:
            context["conversation"] = [
                {"role": item.get("role"), "text": item.get("text")}
                for item in self.conversation
                if item.get("role") in ("user", "assistant") and item.get("text")
            ]
        if self.prior_cases:
            context["prior_cases"] = [
                {
                    "run_id": hit.get("run_id"),
                    "objective": hit.get("objective"),
                    "outcome": hit.get("outcome"),
                    "summary": hit.get("summary"),
                    "chain_head": hit.get("chain_head"),
                    "score_bp": hit.get("score_bp"),
                }
                for hit in self.prior_cases[:3]
            ]
        return context

    def _summarise(self, record: ObservationRecord) -> dict[str, Any]:
        """Compress one observation to the fields a decision needs.

        The tool's own ``summarize`` contract wins; the shape-based default
        keeps unknown tools honest without the memory layer knowing tool names.
        """
        summarizer = self.summarizers.get(record.tool)
        if summarizer is not None:
            return summarizer(record.result)
        return default_summarize(record.result)
