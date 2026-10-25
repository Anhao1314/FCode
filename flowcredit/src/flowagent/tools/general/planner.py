"""The general plan blueprints: research (fetch then write) and script
(write → run → fix → re-run → file the results).

The deterministic (mock) provider follows these blueprints the way it follows
the finance one. In research mode the write todo starts as a placeholder and
every successful fetch revises its content, so the report the model finally
*proposes* is composed from the evidence that actually arrived. In script
mode the blueprint is the honest shape of a first attempt: the agent writes a
script (with the kind of off-by-one a first draft has), the restricted
terminal runs it, an anchored edit fixes what the output showed was wrong,
the fixed script runs again, and the outputs are filed with their hashes and
the fix note. A real provider is free to propose its own steps; the gate,
the approvals and the file-state verifier treat them identically.
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


# --- script mode -----------------------------------------------------------
#
# The deliberate bug is the point: the milestone demonstrates the *full*
# loop — write, run, read the wrong output, fix it with an anchored edit,
# re-run, file the results. A perfect first draft would skip the edit and
# the second run, and prove nothing about the terminal or the editor.

SCRIPT_BUG = "    for _ in range(n - 1):  # first draft: one iteration short"
SCRIPT_FIX = "    for _ in range(n):  # fixed: n iterations for fib(n)"


def _first_draft(script_path: str) -> str:
    return "\n".join([
        "def fib(n):",
        "    \"\"\"Return fib(n): fib(0)=0, fib(1)=1.\"\"\"",
        "    if n < 0:",
        "        raise ValueError('n must be >= 0')",
        "    a, b = 0, 1",
        SCRIPT_BUG,
        "        a, b = b, a + b",
        "    return a",
        "",
        "",
        "if __name__ == \"__main__\":",
        "    for n in range(1, 11):",
        "        print(f\"fib({n}) = {fib(n)}\")",
        "",
    ])


def _results(goal: str, runs: list[dict[str, Any]]) -> str:
    lines = [f"# 运行结果：{goal}", ""]
    lines.append("脚本在受限终端（白名单 run_command）中执行，输出与退出码逐次记录如下；")
    lines.append("修复以 edit_file 的唯一锚定替换完成，前后 blob 哈希与 git commit 均在链上。")
    lines.append("")
    for index, run in enumerate(runs, start=1):
        label = "首次运行（修复前）" if index == 1 else f"第 {index} 次运行"
        lines.append(f"## {label}")
        lines.append(f"- 命令: `{run['command']}` · 退出码 {run['exit_code']} · {run['duration_ms']} ms")
        lines.append("")
        lines.append("```")
        lines.append(run["output"].rstrip() or "(no output)")
        lines.append("```")
        lines.append("")
    if len(runs) >= 2:
        lines.append("## 判读")
        lines.append("")
        lines.append("首次输出最后一行 fib(10) = 34，与 fib(9) 一致——差一轮迭代；")
        lines.append("锚定替换 `range(n - 1)` → `range(n)` 后复跑，fib(10) = 55，数列完整。")
        lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("> Runtime 复核的是文件状态哈希、预算与链完整性；命令输出的语义正确性由上述判读说明，不独立重算。")
    lines.append("")
    return "\n".join(lines)


class GeneralPlanner:
    """Decomposes a delegation into its mode's blueprint.

    Evidence (fetched sections, command runs) lives on the instance, not in
    the plan: a todo's ``arguments`` are what the model proposes, and
    metadata there would be rejected as unknown parameters. Instance state
    is safe because ``Loop.rebuild_plan`` replays every committed observation
    through ``advance`` in order — a resumed run re-derives the same content.
    """

    def __init__(
        self,
        sources: list[str],
        *,
        report_path: str = REPORT_PATH,
        mode: str = "research",
        script_path: str = "script.py",
    ) -> None:
        self.sources = list(sources)
        self.report_path = report_path
        self.mode = "script" if mode == "script" else "research"
        self.script_path = script_path
        self._sections: list[dict[str, Any]] = []
        self._runs: list[dict[str, Any]] = []

    def decompose(self, goal: str) -> Plan:
        self._sections = []
        self._runs = []
        if self.mode == "script":
            return Plan(goal=goal, todos=self._script_todos(), revision=1)
        if not self.sources:
            raise ValueError("a research delegation needs at least one source URL")
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

    def _script_todos(self) -> list[Todo]:
        return [
            Todo("t1", f"写出第一版脚本 {self.script_path}", "write_file",
                 f"written:{self.script_path}",
                 {"path": self.script_path, "content": _first_draft(self.script_path)}),
            Todo("t2", f"在受限终端运行 {self.script_path}", "run_command",
                 f"ran:{self.script_path}",
                 {"command": "python3", "args": [self.script_path]}),
            Todo("t3", "用锚定替换修复差一轮的迭代", "edit_file",
                 f"edited:{self.script_path}",
                 {"path": self.script_path, "old_text": SCRIPT_BUG, "new_text": SCRIPT_FIX}),
            Todo("t4", f"复跑修复后的 {self.script_path}", "run_command",
                 f"ran-fixed:{self.script_path}",
                 {"command": "python3", "args": [self.script_path]}),
            Todo("t5", f"把两次运行输出整理进 {self.report_path}", "write_file",
                 f"written:{self.report_path}",
                 {"path": self.report_path, "content": ""}),
        ]

    def advance(self, plan: Plan, observation: Observation) -> Plan:
        if observation.tool == "fetch_url":
            updated = self._settle_fetch(plan, observation)
            return self._compose_report(updated, observation)
        if observation.tool == "run_command":
            updated = self._settle_sequential(plan, "run_command", observation)
            return self._compose_results(updated, observation)
        if observation.tool == "edit_file":
            return self._settle_sequential(plan, "edit_file", observation)
        if observation.tool == "write_file":
            return self._settle_write(plan, observation)
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

    def _settle_sequential(self, plan: Plan, tool: str, observation: Observation) -> Plan:
        """Settle the first *pending* todo of this tool — run_command steps
        share their arguments (the same script runs twice), so order decides."""
        for todo in plan.todos:
            if todo.tool == tool and todo.status in ("pending", "active"):
                return plan.mark(todo.id, "done", evidence=(observation.result_hash,))
        return plan

    def _settle_write(self, plan: Plan, observation: Observation) -> Plan:
        path = str(observation.arguments.get("path") or "")
        for todo in plan.todos:
            if todo.tool == "write_file" and todo.arguments.get("path") == path:
                if todo.status in ("done", "abandoned"):
                    return plan
                return plan.mark(todo.id, "done", evidence=(observation.result_hash,))
        return plan

    def _compose_report(self, plan: Plan, observation: Observation) -> Plan:
        """Fold the fetched evidence into the pending report todo's content."""
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

    def _compose_results(self, plan: Plan, observation: Observation) -> Plan:
        """Fold each run's output into the pending results todo's content."""
        self._runs.append(observation.result)
        existing = next(
            (t for t in plan.todos
             if t.tool == "write_file" and t.id in ("t5", "tw")),
            None,
        )
        if existing is None or existing.status in ("done", "abandoned"):
            return plan
        content = _results(plan.goal, self._runs)
        revised = replace(
            existing,
            arguments={
                "path": existing.arguments.get("path", self.report_path),
                "content": content,
            },
        )
        todos = [revised if t.id == existing.id else t for t in plan.todos]
        return Plan(goal=plan.goal, todos=todos, revision=plan.revision)
