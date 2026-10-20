"""Clarifying intake: the model answers first, then offers choices.

This module is deliberately stateless. The client sends the user's latest
message, the accumulated spec and (when applicable) the option the user chose.
The clarifier returns a short reply, a *rationale summary* (not hidden
chain-of-thought), the next 0–4 choices, and a task card when the spec is
complete.

The current implementation is deterministic so the console can work before the
local Qwen adapter is ready. The interface is the same one a model-backed
clarifier will use: replace :func:`clarify` with a provider call and keep the
response schema.
"""

from __future__ import annotations

import re
from typing import Any

__all__ = ["clarify", "CHOICES"]

INTENTS: dict[str, dict[str, str]] = {
    "compare": {
        "label": "判断两期能不能直接比",
        "short": "两期可比性",
        "desc": "核对单位、口径、重述后，再决定能不能算",
    },
    "restatement": {
        "label": "重点看重述与口径变化",
        "short": "重述与口径",
        "desc": "解释 FY2024 重述和 FY2025 的桥接口径",
    },
    "missing": {
        "label": "资料可能不全，先看能否下结论",
        "short": "资料不全",
        "desc": "缺证据时明确阻塞，不编数字",
    },
}
OUTPUTS: dict[str, dict[str, str]] = {
    "memo": {
        "label": "一页结论 + 审计底稿",
        "short": "结论 + 底稿",
        "desc": "完成后自动打开可签发的底稿",
    },
    "trace": {
        "label": "详细过程 + 原始 trace",
        "short": "详细过程",
        "desc": "保留运行现场，自己检查证据链",
    },
    "conclusion": {
        "label": "只要结论",
        "short": "只要结论",
        "desc": "不自动打开底稿，需要时再签发",
    },
}
APPROVALS: dict[str, dict[str, str]] = {
    "consequential": {"label": "关键审批", "desc": "只在会改变结论或宣告受阻的动作前暂停"},
    "all": {"label": "逐步审批", "desc": "每次工具调用都等你确认"},
    "off": {"label": "自动", "desc": "不暂停；权限门控与预算仍然生效"},
}
CHOICES = {"intent": INTENTS, "output": OUTPUTS, "approval": APPROVALS}
FIELDS = ("intent", "output", "approval")


def _infer(text: str) -> dict[str, str]:
    value = str(text or "")
    found: dict[str, str] = {}
    if re.search(r"重述|调整后|口径|桥接", value):
        found["intent"] = "restatement"
    elif re.search(r"不全|缺|没有|找不到|不足", value):
        found["intent"] = "missing"
    elif re.search(r"可比|对比|比较|毛利率|两期|变化", value):
        found["intent"] = "compare"
    if re.search(r"底稿|报告|审计", value):
        found["output"] = "memo"
    elif re.search(r"过程|trace|证据链|详细", value):
        found["output"] = "trace"
    elif re.search(r"只要结论|结论就行|不需要底稿", value):
        found["output"] = "conclusion"
    if re.search(r"逐步|每次确认", value):
        found["approval"] = "all"
    elif re.search(r"自动|不用审批|免审批", value):
        found["approval"] = "off"
    elif re.search(r"关键审批|关键步骤", value):
        found["approval"] = "consequential"
    return found


def _choice_payload(field: str, choices: dict[str, dict[str, str]]) -> list[dict[str, Any]]:
    return [
        {
            "id": f"{field}:{key}",
            "field": field,
            "value": key,
            "label": item["label"],
            "description": item["desc"],
            "badge": "推荐" if key == ("compare" if field == "intent" else "memo" if field == "output" else "consequential") else "",
        }
        for key, item in choices.items()
    ]


def _thought(spec: dict[str, Any]) -> str:
    seen = []
    if spec.get("intent"):
        seen.append(INTENTS[spec["intent"]]["short"])
    if spec.get("output"):
        seen.append(OUTPUTS[spec["output"]]["short"])
    if spec.get("approval"):
        seen.append(APPROVALS[spec["approval"]]["label"])
    missing = [name for name in FIELDS if not spec.get(name)]
    parts = []
    if seen:
        parts.append("已识别：" + " · ".join(seen))
    if missing:
        label = {"intent": "关注点", "output": "输出方式", "approval": "审批方式"}[missing[0]]
        parts.append("还缺：" + label)
    return "；".join(parts) + "。"


def _normalise(spec: dict[str, Any] | None) -> dict[str, str]:
    clean = {}
    for field in FIELDS:
        value = (spec or {}).get(field)
        if value in CHOICES[field]:
            clean[field] = str(value)
    original = (spec or {}).get("original")
    if isinstance(original, str) and original.strip():
        clean["original"] = original.strip()[:2000]
    return clean


def _apply_choice(spec: dict[str, str], choice: dict[str, Any] | None) -> None:
    if not isinstance(choice, dict):
        return
    field = choice.get("field")
    value = choice.get("value")
    if field in CHOICES and value in CHOICES[field]:
        spec[field] = str(value)


def _task(spec: dict[str, str], original: str) -> dict[str, Any]:
    template = "open-ended" if spec["intent"] == "missing" else "full"
    base = (original.strip() or "判断恒星智算 2024 与 2025 两期合并毛利率是否可比")[:520]
    objective = f"{base}；关注点：{INTENTS[spec['intent']]['label']}"[:600]
    task_spec = {
        "version": "fcode.intake/v1",
        "task": "financial-check",
        "intent": spec["intent"],
        "output": spec["output"],
        "approval": spec["approval"],
        "materials": "builtin-synthetic",
        "subject": "恒星智算",
        "periods": ["FY2024", "FY2025"],
        "source": "console-intake",
    }
    return {
        "objective": objective,
        "template": template,
        "approval": spec["approval"],
        "spec": task_spec,
    }


def clarify(
    *,
    message: str = "",
    history: list[dict[str, Any]] | None = None,
    spec: dict[str, Any] | None = None,
    choice: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Return one clarifying turn. Pure function; no model call today.

    ``history`` is accepted for the model-backed implementation and for future
    audit; the deterministic clarifier only needs the latest message and spec.
    """
    message = str(message or "").strip()[:2000]
    current = _normalise(spec)
    _apply_choice(current, choice)
    if message:
        current.update(_infer(message))
        current.setdefault("original", message)

    # The opening turn: no user message yet, so do not dump a questionnaire.
    if not message and not current:
        return {
            "reply": "先说说你想做什么。比如：帮我看看这两份财报能不能直接比。",
            "thought": "还没有收到任务描述。",
            "choices": [],
            "spec": {},
            "ready": False,
            "task": None,
        }

    if not current.get("intent"):
        return {
            "reply": "我还没确定你最关心什么。先从这三个方向里选一个：",
            "thought": _thought(current) or "没识别到明确关注点。",
            "choices": _choice_payload("intent", INTENTS),
            "spec": current,
            "ready": False,
            "task": None,
        }
    if not current.get("output"):
        return {
            "reply": f"我理解你关注「{INTENTS[current['intent']]['short']}」。结果怎么用？",
            "thought": _thought(current),
            "choices": _choice_payload("output", OUTPUTS),
            "spec": current,
            "ready": False,
            "task": None,
        }
    if not current.get("approval"):
        return {
            "reply": f"输出是「{OUTPUTS[current['output']]['short']}」。审批怎么设？",
            "thought": _thought(current),
            "choices": _choice_payload("approval", APPROVALS),
            "spec": current,
            "ready": False,
            "task": None,
        }

    task = _task(current, current.get("original", ""))
    return {
        "reply": "我准备这样执行。确认后才会创建运行。",
        "thought": _thought(current),
        "choices": [],
        "spec": current,
        "ready": True,
        "task": task,
    }
