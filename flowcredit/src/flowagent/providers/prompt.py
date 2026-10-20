"""The single prompt contract between FCode and any model that replaces the mock.

One renderer, three consumers:

* the SFT exporter — training data must match inference exactly;
* the local provider — Qwen3 served behind an OpenAI-compatible endpoint;
* any future cloud provider.

If the prompt ever changes, all three change together. A training set rendered
by an old prompt against an inference path that renders a new one is a silent,
self-inflicted distribution shift — which is why PROMPT_VERSION is pinned here
and written into every sample and every receipt metadata.

The assistant wire format is exactly one JSON object::

    {"version": "flowagent.plan/v1",
     "steps": [{"id": "t3", "tool": "read_document", "arguments": {"doc_id": "doc_fy2025"}}],
     "todo_id": "t3"}

Nothing else. The deterministic mock builds the same shape, so a model trained
on mock traces drops straight into the runtime without a translation layer.
"""

from __future__ import annotations

import json
from typing import Any

__all__ = [
    "PROMPT_VERSION",
    "SYSTEM_PROMPT",
    "render_prompt",
    "build_target_json",
    "parse_proposal_text",
]

from ..core.contracts import PLAN_VERSION

PROMPT_VERSION = "fcode.prompt/v6"

SYSTEM_PROMPT = (
    "你是 FCode 运行时内的模型。你只能提议动作，永远不能执行。"
    "每次回复输出恰好一个 JSON 对象，不要输出任何其他文字：\n"
    '{"version": "' + PLAN_VERSION + '", '
    '"steps": [{"id": "<todo_id>", "tool": "<工具名>", "arguments": {…}}], '
    '"todo_id": "<todo_id>"}\n'
    "规则：\n"
    "1. 从用户消息里的 plan（剩余待办）中选择一个 todo 推进；\n"
    "2. 一次只提议一个动作，arguments 只能使用该工具 schema 里声明的字段；\n"
    "3. 不要编造财务数值，所有数字只能来自 observations 里已有的观测；\n"
    "4. 证据不足、或计划里已没有待办时，提议 report_blocked 并说明原因；\n"
    "5. 运行时负责校验、计费与执行，结果不由你宣告。"
)


def canonical(value: Any) -> str:
    """Sorted-key compact JSON — the same determinism the hash chain relies on."""
    if value is None or isinstance(value, (bool, int, float, str)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(str(k), ensure_ascii=False) + ":" + canonical(v)
            for k, v in sorted(value.items())
        ) + "}"
    return canonical(str(value))


def render_prompt(context: dict[str, Any]) -> tuple[str, str]:
    """Render one runtime context into (system, user) texts.

    The user message is the canonical JSON of the context dict — the exact
    object :class:`~flowagent.memory.context.WorkingMemory.build` produces. No
    prose wrapper, no trimming: the context design (compressed observations) is
    what keeps this small, and any editorialising here would drift between
    training and inference.
    """
    user = '{"context": ' + canonical(context) + ", " + '"prompt_version": ' + json.dumps(PROMPT_VERSION) + "}"
    return SYSTEM_PROMPT, user


def build_target_json(steps: list[dict[str, Any]], todo_id: str | None) -> str:
    """Render the assistant target for one proposal."""
    return canonical({
        "version": PLAN_VERSION,
        "steps": steps,
        "todo_id": todo_id,
    })


def _extract_json(text: str) -> str:
    """Pull the first balanced JSON object out of a model reply.

    Tolerates Qwen3's thinking blocks and any stray prose around the JSON —
    the runtime contract is enforced after parsing, not by trusting format.
    """
    cleaned = text
    while "<think>" in cleaned and "</think>" in cleaned:
        start = cleaned.index("<think>")
        end = cleaned.index("</think>") + len("</think>")
        cleaned = cleaned[:start] + cleaned[end:]
    start = cleaned.find("{")
    if start < 0:
        raise ValueError("no JSON object in reply")
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(cleaned)):
        char = cleaned[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return cleaned[start : index + 1]
    raise ValueError("unbalanced JSON object in reply")


def parse_proposal_text(text: str) -> dict[str, Any]:
    """Parse and validate one assistant reply into the wire-format dict.

    Raises ValueError with a short reason — the caller turns that into a
    runtime failure, never into a silent fallback to the mock.
    """
    import re

    data = json.loads(_extract_json(text))
    if not isinstance(data, dict):
        raise ValueError("reply is not a JSON object")
    steps = data.get("steps")
    if not isinstance(steps, list) or not steps:
        raise ValueError("steps must be a non-empty list")
    for step in steps:
        if not isinstance(step, dict) or not step.get("tool"):
            raise ValueError("each step needs a tool")
        if not isinstance(step.get("arguments", {}), dict):
            raise ValueError("step arguments must be an object")
    todo_id = data.get("todo_id")
    if todo_id is not None and not isinstance(todo_id, str):
        raise ValueError("todo_id must be a string or null")
    version = data.get("version")
    if version != PLAN_VERSION:
        raise ValueError(f"unexpected plan version {version!r}")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(steps[0].get("tool"))):
        raise ValueError("tool name is not a bare identifier")
    return data
