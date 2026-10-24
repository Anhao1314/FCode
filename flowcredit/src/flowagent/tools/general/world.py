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
from .fetch import UrlFetcher
from .sandbox import WorkspaceSandbox
from .tools import build_general_tools

__all__ = ["GeneralWorld"]


def _allow_hosts_from_env() -> tuple[str, ...]:
    raw = os.environ.get("FCODE_FETCH_ALLOW_HOSTS", "")
    return tuple(host.strip() for host in raw.split(",") if host.strip())


class GeneralWorld:
    """Domain state for one general delegation."""

    def __init__(
        self,
        spec: dict[str, Any] | None = None,
        *,
        sandbox: WorkspaceSandbox | None = None,
        fetcher: UrlFetcher | None = None,
    ) -> None:
        self.spec = dict(spec or {})
        self.sources: list[str] = [
            str(url) for url in (self.spec.get("sources") or []) if str(url).strip()
        ]
        self.report_path = str(self.spec.get("reportPath") or "research.md")
        self.sandbox = sandbox or WorkspaceSandbox(Path.cwd() / "workspace-general")
        self.fetcher = fetcher or UrlFetcher(allow_hosts=_allow_hosts_from_env())

    def build_tools(self) -> list[ToolSpec]:
        return build_general_tools(self.sandbox, self.fetcher)

    def apply_state(self, state: dict[str, Any]) -> None:
        """Resume hook. The sandbox *is* the durable state (files on disk);
        the in-memory world has nothing to re-derive from the event log."""

    def verify_observation(self, observation: Observation) -> dict[str, Any]:
        """Recompute the file state the observation claims, from disk.

        Only ``write_file`` observations are results. The recompute is the
        receipt's own currency: sha256 over the bytes on disk compared with
        the recorded after-hash. A mismatch — the file drifted after the
        write, or the observation lies — fails verification.
        """
        if observation.tool != "write_file":
            raise AgentError("RESULT_INCOMPLETE", f"{observation.tool!r} is not a result tool here")
        result = observation.result
        if not result.get("computed"):
            raise AgentError("RESULT_INCOMPLETE", "the write did not compute")
        relative = str(result.get("path") or observation.arguments.get("path") or "")
        record = self.sandbox.read(relative)
        if record["sha256"] != result.get("sha256_after"):
            raise AgentError(
                "RESULT_VERIFICATION_FAILED",
                f"{relative!r} on disk hashes {record['sha256'][:12]}… but the "
                f"observation recorded {str(result.get('sha256_after'))[:12]}…",
            )
        return {
            "verified": True,
            "verification": "file-state-recomputed",
            "result": {
                "path": record["path"],
                "sha256": record["sha256"],
                "bytes": record["bytes"],
                "commit": result.get("commit", ""),
                "content_truth": "runtime-verified-file-state",
            },
        }
