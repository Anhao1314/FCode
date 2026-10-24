"""The general plan blueprint: fetch the sources, then write the report.

The deterministic (mock) provider follows this blueprint the way it follows
the finance one. The write todo starts as a placeholder; every successful
fetch observation revises its content, so the report the model finally
*proposes* is composed from the evidence that actually arrived — with each
source's hash and retrieval time cited, and the honesty footer stating what
the runtime does not verify. A real provider is free to propose its own
``write_file``; the gate, the approval and the file-state verifier treat it
identically.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from ...core.plan import Plan, Todo
from ..base import Observation

__all__ = ["GeneralPlanner", "REPORT_PATH", "EXCERPT_CHARS"]

REPORT_PATH = "research.md"
EXCERPT_CHARS = 900

_FOOTER = (
    "\n---\n\n"
    "> 说明：以上网页内容由 `fetch_url` 抓取，字节级 sha256 与抓取时间已随收据入链；\n"
    "> Runtime 复核的是文件状态哈希、预算与链完整性，**不独立核实网页内容真伪**\n"
    "> （content_truth: not-verified）。\n"
)


def _report(goal: str, sections: list[dict[str, Any]]) -> str:
    lines = [f"# 调研底稿：{goal}", ""]
    lines.append("来源摘录（按抓取顺序）：")
    lines.append("")
    for index, section in enumerate(sections, start=1):
        excerpt = section["text"][:EXCERPT_CHARS]
        if len(section["text"]) > EXCERPT_CHARS:
            excerpt += "…"
        title = section.get("title") or section["url"]
        lines.append(f"## 来源 {index}：{title}")
        lines.append(f"- URL: {section['url']}")
        lines.append(f"- 抓取时间: {section['retrieved_at']} · sha256: `{section['sha256'][:16]}…` · {section['bytes']} bytes")
        lines.append("")
        lines.append(excerpt)
        lines.append("")
    lines.append("## 小结")
    lines.append("")
    lines.append(f"围绕目标整理了 {len(sections)} 份来源的要点；结论以上文摘录为准，均可在事件链中回溯。")
    lines.append(_FOOTER)
    return "".join(lines)


class GeneralPlanner:
    """Decomposes a research goal into fetch todos plus one report write.

    The fetched sections live on the instance, not in the plan: a todo's
    ``arguments`` are what the model proposes, and evidence metadata there
    would be rejected as unknown parameters. Instance state is safe because
    ``Loop.rebuild_plan`` replays every committed observation through
    ``advance`` in order — a resumed run re-derives the same report.
    """

    def __init__(self, sources: list[str], *, report_path: str = REPORT_PATH) -> None:
        if not sources:
            raise ValueError("a general delegation needs at least one source URL")
        self.sources = list(sources)
        self.report_path = report_path
        self._sections: list[dict[str, Any]] = []

    def decompose(self, goal: str) -> Plan:
        self._sections = []
        todos: list[Todo] = []
        for index, url in enumerate(self.sources, start=1):
            todos.append(Todo(
                id=f"t{index}",
                text=f"抓取来源 {url}",
                tool="fetch_url",
                done_when=f"fetched:{url}",
                arguments={"url": url},
            ))
        todos.append(Todo(
            id="tw",
            text=f"撰写 {self.report_path}（内容来自已抓取来源）",
            tool="write_file",
            done_when=f"written:{self.report_path}",
            arguments={"path": self.report_path, "content": ""},
        ))
        return Plan(goal=goal, todos=todos, revision=1)

    def advance(self, plan: Plan, observation: Observation) -> Plan:
        if observation.tool == "fetch_url":
            updated = self._settle_fetch(plan, observation)
            return self._compose_report(updated, observation)
        if observation.tool == "write_file":
            path = str(observation.arguments.get("path") or "")
            todo = next((t for t in plan.todos if t.tool == "write_file"), None)
            if todo is None or todo.status in ("done", "abandoned") or path != todo.arguments.get("path"):
                return plan
            return plan.mark(todo.id, "done", evidence=(observation.result_hash,))
        return plan

    # ------------------------------------------------------------------ private

    def _settle_fetch(self, plan: Plan, observation: Observation) -> Plan:
        url = str(observation.arguments.get("url") or "")
        for todo in plan.todos:
            if todo.tool == "fetch_url" and todo.arguments.get("url") == url:
                if todo.status in ("done", "abandoned"):
                    return plan
                return plan.mark(todo.id, "done", evidence=(observation.result_hash,))
        return plan

    def _compose_report(self, plan: Plan, observation: Observation) -> Plan:
        """Fold the fetched evidence into the pending write todo's content."""
        self._sections.append(observation.result)
        existing = next((t for t in plan.todos if t.tool == "write_file"), None)
        if existing is None or existing.status in ("done", "abandoned"):
            return plan
        content = _report(plan.goal, self._sections)
        revised = replace(
            existing,
            arguments={
                "path": existing.arguments.get("path", REPORT_PATH),
                "content": content,
            },
        )
        todos = [revised if t.id == existing.id else t for t in plan.todos]
        return Plan(goal=plan.goal, todos=todos, revision=plan.revision)
