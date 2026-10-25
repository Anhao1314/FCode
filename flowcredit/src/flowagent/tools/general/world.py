"""The general world: a workspace sandbox plus the delegation's sources.

The finance world holds documents and recomputes margins. The general world
holds the file sandbox and recomputes *file state*: the verifier re-reads the
file from disk and re-derives its sha256, refusing to accept a write
observation whose recorded hash the disk no longer matches. That is the
generalisation of independent recomputation — recompute the accounts that
exist (file hashes, budgets, the chain), and label what does not (web
content truth) as not-verified instead of pretending.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ...core.contracts import AgentError
from ..base import Observation, ToolSpec
from .commands import CommandRunner, load_command_config
from .fetch import UrlFetcher
from .recall import build_recall_tool
from .sandbox import WorkspaceSandbox
from .tools import build_general_tools

__all__ = ["GeneralWorld"]


def _allow_hosts_from_env() -> tuple[str, ...]:
    raw = os.environ.get("FCODE_FETCH_ALLOW_HOSTS", "")
    return tuple(host.strip() for host in raw.split(",") if host.strip())


class GeneralWorld:
    """Domain state for one general delegation.

    Two delegation modes, both operator-decided in the spec:

    * ``research`` (default): fetch the listed sources, write ``research.md``;
    * ``script``: the agent writes a script into the workspace, runs it
      under the restricted terminal, fixes what it got wrong with an
      anchored edit, re-runs, and files the outputs in ``results.md``.
    """

    def __init__(
        self,
        spec: dict[str, Any] | None = None,
        *,
        sandbox: WorkspaceSandbox | None = None,
        fetcher: UrlFetcher | None = None,
        command_runner: CommandRunner | None = None,
        command_config: str | None = None,
    ) -> None:
        self.spec = dict(spec or {})
        self.mode = "script" if str(self.spec.get("mode") or "") == "script" else "research"
        self.sources: list[str] = [
            str(url) for url in (self.spec.get("sources") or []) if str(url).strip()
        ]
        self.script_path = str(self.spec.get("scriptPath") or "script.py")
        self.report_path = str(self.spec.get("reportPath") or ("results.md" if self.mode == "script" else "research.md"))
        self.sandbox = sandbox or WorkspaceSandbox(Path.cwd() / "workspace-general")
        self.fetcher = fetcher or UrlFetcher(allow_hosts=_allow_hosts_from_env())
        #: The restricted terminal's policy: the host's commands.json (same
        #: directory as mcp.json — the console injects the path) extends the
        #: code default whitelist; never replaces it.
        self.command_runner = command_runner
        self.command_config = command_config or os.environ.get("FCODE_COMMANDS_CONFIG") or None

    #: Optional provider of this run's compressed observation records; set by
    #: the assembly so ``recall_observation`` reads exactly what working memory
    #: holds — never another run, never the raw store.
    memory_records_provider: Any = None
    #: The loop publishes the live WorkingMemory here each run; the provider
    #: closes over it. An assembly may also leave both unset to skip the tool.
    recall_holder: Any = None

    def build_tools(self) -> list[ToolSpec]:
        runner = self.command_runner
        if runner is None:
            runner = CommandRunner(self.sandbox, load_command_config(self.command_config))
            self.command_runner = runner
        tools = build_general_tools(self.sandbox, self.fetcher, command_runner=runner)
        if self.memory_records_provider is not None:
            tools.append(build_recall_tool(self.memory_records_provider))
        return tools

    def apply_state(self, state: dict[str, Any]) -> None:
        """Resume hook. The sandbox *is* the durable state (files on disk);
        the in-memory world has nothing to re-derive from the event log."""

    def verify_observation(self, observation: Observation) -> dict[str, Any]:
        """Recompute the file state the observation claims, from disk.

        Only ``write_file`` observations are results. The primary recompute is
        the receipt's own currency: sha256 over the bytes on disk compared
        with the recorded after-hash. A file that was *legitimately edited
        later* (edit_file is a first-class capability) no longer matches its
        earlier write on disk — so the fallback re-derives the historical
        state from the git commit the receipt names. Every write observation
        must be either the file's current state or a real, git-recorded
        state; anything else fails verification.
        """
        if observation.tool != "write_file":
            raise AgentError("RESULT_INCOMPLETE", f"{observation.tool!r} is not a result tool here")
        result = observation.result
        if not result.get("computed"):
            raise AgentError("RESULT_INCOMPLETE", "the write did not compute")
        relative = str(result.get("path") or observation.arguments.get("path") or "")
        record = self.sandbox.read(relative)
        if record["sha256"] == result.get("sha256_after"):
            return self._verified(record, "file-state-recomputed", result)
        commit = str(result.get("commit") or "")
        if commit:
            import hashlib
            import subprocess

            try:
                blob = subprocess.run(
                    ["git", "show", f"{commit}:{relative}"],
                    cwd=str(self.sandbox.root),
                    capture_output=True,
                    timeout=15,
                    check=True,
                ).stdout
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
                blob = None
            if blob is not None and hashlib.sha256(blob).hexdigest() == result.get("sha256_after"):
                return self._verified(record, "git-history-recomputed", result)
        raise AgentError(
            "RESULT_VERIFICATION_FAILED",
            f"{relative!r} on disk hashes {record['sha256'][:12]}… but the "
            f"observation recorded {str(result.get('sha256_after'))[:12]}… "
            "and no git state matches that hash",
        )

    @staticmethod
    def _verified(record: dict[str, Any], verification: str, result: dict[str, Any]) -> dict[str, Any]:
        return {
            "verified": True,
            "verification": verification,
            "result": {
                "path": record["path"],
                "sha256": record["sha256"],
                "bytes": record["bytes"],
                "commit": result.get("commit", ""),
                "content_truth": "runtime-verified-file-state",
            },
        }
