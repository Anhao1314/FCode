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

**Profiles.** There is more than one line of work now, and one high-level
behaviour contract cannot serve both. The financial v10 prompt is a frozen
artifact — 2271 SFT samples, a golden hash, and every stored context were
rendered against it — so it stays byte-for-byte as it was and remains the
profile a context gets when it selects none. A general delegation selects its
own profile through ``context["prompt_profile"]``; that key is emitted *only*
by a domain that is not the default, which is what keeps every finance context
(and therefore the golden hash) unchanged. Selection is by the domain the
runtime is running, never by inspecting the user's text.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

__all__ = [
    "DEFAULT_PROMPT_PROFILE",
    "FINANCE_PROMPT_PROFILE",
    "GENERAL_PROMPT_PROFILE",
    "GENERAL_PROMPT_VERSION",
    "GENERAL_SYSTEM_PROMPT",
    "PROMPT_PROFILES",
    "PROMPT_VERSION",
    "PromptProfile",
    "SYSTEM_PROMPT",
    "build_proposal_plan",
    "build_target_json",
    "parse_proposal_text",
    "prompt_profile_for",
    "render_prompt",
]

from ..core.contracts import AgentError, PLAN_VERSION

#: The frozen financial profile version. Its bytes, its version string and its
#: rendered user message are all under the SFT golden hash; none of them change
#: in this phase, and the exporter still consumes exactly this.
PROMPT_VERSION = "fcode.prompt/v10"

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

#: The general profile version. Separate from v10 so a dataset built for one
#: contract can never be confused with the other, and a receipt says which
#: contract produced the proposal.
GENERAL_PROMPT_VERSION = "fcode.prompt/general-v2"

#: The general delegation's behaviour contract. It must not inherit the
#: financial rules (no numeric-evidence-only rule, no read-only assumption),
#: and it has to describe what this domain actually does: explore the
#: workspace, plan work the blueprint did not anticipate, run whitelisted
#: commands, read their failures, fix and re-run, and stop honestly when the
#: evidence runs out.
GENERAL_SYSTEM_PROMPT = (
    "你是 FCode 运行时内的模型。你只能提议动作，永远不能执行，也不能宣告任务完成。"
    "每次回复输出恰好一个 JSON 对象，不要输出任何其他文字：\n"
    '{"version": "' + PLAN_VERSION + '", '
    '"steps": [{"id": "<todo_id>", "tool": "<工具名>", "arguments": {…}}], '
    '"todo_id": "<todo_id>", '
    '"additions": [{"id": "<新 todo id>", "text": "<要做什么>", "tool": "<工具名>", '
    '"done_when": "<可判定的完成条件>", "arguments": {…}}], '
    '"evidence": [{"claim": "<产物里的一条断言>", "tool": "<你据此写下的工具名>", '
    '"path": "<工作区相对路径>", "sha256": "<那次读取记录的 sha256>"}]}\n'
    "规则：\n"
    "1. 这是开放式的工程任务，不限于任何固定流程：先看现状（列目录、读文件、跑命令），再决定下一步；\n"
    "2. 从用户消息里的 plan（剩余待办）中选一个 todo 推进，一次只提议一个动作；\n"
    "3. 计划不够用时用 additions 提议新增 todo：可以一次提多个，每个都必须映射到 tools 里已注册的工具，"
    "并给出可判定的 done_when。主机校验通过后才会进入计划；additions 本身不会被执行；\n"
    "4. 不要提议未列出的工具或未声明的参数：那会被门控拒绝并终止本次运行；\n"
    "5. 用真实观测决定下一步：run_command 的退出码与输出、read_file 的内容、rejected_proposals 里的形状错误。"
    "命令或测试失败就改代码再跑一次，不要只写一份计划就当作完成；\n"
    "6. 写产物那一步可以带 evidence，把你据以写下每条断言的读取列出来（工具名、路径、那次读取给出的 sha256）。"
    "运行时会去持久记录里核对每一条引用：引用不上的断言会让本次运行失败。"
    "没有把握的来源就不要引用——运行时不判断断言是否**正确**，只核对来源是否**存在**；\n"
    "7. 不要编造命令输出、测试结果或文件内容。运行时会独立重跑操作者声明的验证命令，"
    "你执行过的记录不构成验证。完成由运行时独立复核，不由你宣告；\n"
    "8. 确实做不下去时（信息不足、缺少依据、工作无法完成）提议 report_blocked 并写清缺什么——这是诚实的出口；\n"
    "9. 权限、预算与审批由主机掌握：被拒绝的提议不要用同一个形状重试。"
)


@dataclass(frozen=True)
class PromptProfile:
    """One domain's high-level contract with the model.

    ``frozen`` marks a profile whose bytes and version are pinned by an
    external commitment (the SFT golden hash). A frozen profile is not edited
    in place; a new contract gets a new profile instead.
    """

    key: str
    version: str
    system: str
    frozen: bool = False


FINANCE_PROMPT_PROFILE = PromptProfile(
    key="finance", version=PROMPT_VERSION, system=SYSTEM_PROMPT, frozen=True,
)
GENERAL_PROMPT_PROFILE = PromptProfile(
    key="general", version=GENERAL_PROMPT_VERSION, system=GENERAL_SYSTEM_PROMPT,
)

PROMPT_PROFILES: dict[str, PromptProfile] = {
    profile.key: profile for profile in (FINANCE_PROMPT_PROFILE, GENERAL_PROMPT_PROFILE)
}

#: The profile a context gets when it selects none. That is the compatibility
#: policy, and it is the frozen financial contract on purpose: every context
#: stored before profiles existed — and every SFT sample — carries no selector,
#: and re-rendering any of them under a different system prompt would silently
#: rewrite the training set. A context that *names* an unknown profile is a
#: programming error and fails loudly instead of being routed somewhere.
DEFAULT_PROMPT_PROFILE = FINANCE_PROMPT_PROFILE


def prompt_profile_for(context: dict[str, Any]) -> PromptProfile:
    """Resolve the profile a context selects, or explain why it cannot."""
    key = context.get("prompt_profile")
    if key is None:
        return DEFAULT_PROMPT_PROFILE
    if not isinstance(key, str) or not key.strip():
        raise AgentError(
            "PROMPT_PROFILE_INVALID",
            f"prompt_profile must be a non-empty string, got {key!r}",
        )
    profile = PROMPT_PROFILES.get(key)
    if profile is None:
        raise AgentError(
            "PROMPT_PROFILE_UNKNOWN",
            f"{key!r} is not a known prompt profile; known: {sorted(PROMPT_PROFILES)}",
        )
    return profile


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

    The system text and the version string come from the profile the context
    selects. A context that selects none renders exactly the frozen v10 pair it
    always did — byte for byte, which the SFT golden hash depends on.
    """
    profile = prompt_profile_for(context)
    user = (
        '{"context": ' + canonical(context)
        + ", " + '"prompt_version": ' + json.dumps(profile.version) + "}"
    )
    return profile.system, user


def build_proposal_plan(data: dict[str, Any]) -> dict[str, Any]:
    """Turn one parsed reply into the plan object the runtime validates.

    Centralised so every provider carries the same optional fields across the
    wire. ``additions`` and ``evidence`` are present only when the model sent
    them; neither is authority — the host validates proposed todos before they
    can enter the plan, and the loop resolves evidence references against the
    durable chain before they can be cited.
    """
    plan: dict[str, Any] = {"version": PLAN_VERSION, "steps": data["steps"]}
    additions = data.get("additions")
    if additions is not None:
        plan["additions"] = additions
    evidence = data.get("evidence")
    if evidence is not None:
        plan["evidence"] = evidence
    return plan


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
