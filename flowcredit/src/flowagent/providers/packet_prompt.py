"""Prompt contract for the policy head: pick one candidate, nothing else.

This is deliberately much smaller than the legacy prompt. The model sees one
packet and answers one JSON object. Training and inference use this renderer,
so a choice-format SFT sample cannot drift from the runtime.
"""

from __future__ import annotations

import json
from typing import Any

__all__ = [
    "POLICY_PROMPT_VERSION",
    "POLICY_SYSTEM_PROMPT",
    "parse_choice_text",
    "render_policy_prompt",
]

from .prompt import canonical

POLICY_PROMPT_VERSION = "fcode.packet-prompt/v1"

POLICY_SYSTEM_PROMPT = (
    "你是 FCode 运行时的决策策略头。你只能从 candidates 里选择一个动作。"
    "每次回复输出恰好一个 JSON 对象，不要输出任何其他文字：\n"
    '{"choice": "<candidate id>"}\n'
    "规则：\n"
    "1. choice 必须是 candidates 中存在的 id；\n"
    "2. 一次只选一个；\n"
    "3. 证据不足或 candidates 里有 report_blocked 时，可以选择它；\n"
    "4. 不要生成 tool、参数、解释或计划；\n"
    "5. 不确定时选择最保守、最可复核的候选。"
)


def render_policy_prompt(packet: Any) -> tuple[str, str]:
    """Render the packet into (system, user). ``packet`` is a DecisionPacket."""
    payload = packet.to_dict() if hasattr(packet, "to_dict") else dict(packet)
    user = (
        '{"packet": ' + canonical(payload)
        + ', "prompt_version": ' + json.dumps(POLICY_PROMPT_VERSION) + "}"
    )
    return POLICY_SYSTEM_PROMPT, user


def _extract_json(text: str) -> str:
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
                return cleaned[start:index + 1]
    raise ValueError("unbalanced JSON object in reply")


def parse_choice_text(text: str) -> str:
    """Parse exactly one candidate id from a model reply."""
    try:
        payload = json.loads(_extract_json(text))
    except (ValueError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid choice JSON: {error}") from error
    choice = payload.get("choice") if isinstance(payload, dict) else None
    if not isinstance(choice, str) or not choice.strip():
        raise ValueError("reply must contain a non-empty string 'choice'")
    return choice.strip()
