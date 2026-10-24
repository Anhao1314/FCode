"""The general toolset: workspace files and web fetches, both governed.

Registration order is the contract the tests pin. ``ls_workspace`` and
``read_file`` are reads; ``write_file`` declares the write effect (the grant
decides whether that class ever runs) and is named consequential by the
domain, so the console asks a human before executing; ``fetch_url`` declares
the network effect. All four flow through the same gate → budget → receipt
path as every finance tool.
"""

from __future__ import annotations

from typing import Any, Callable

from ...core.contracts import AgentError
from ..base import EFFECT_NETWORK, EFFECT_READ, EFFECT_WRITE, Param, ToolSpec
from .fetch import UrlFetcher
from .sandbox import MAX_WRITE_CHARS, WorkspaceSandbox

__all__ = ["GENERAL_TOOLS", "build_general_tools"]


def _out(name: str, kind: str, required: bool = True, nullable: bool = False) -> Param:
    return Param(name=name, kind=kind, required=required, nullable=nullable)


def build_general_tools(
    sandbox: WorkspaceSandbox,
    fetcher: UrlFetcher,
    *,
    fetch_guard: Callable[[str], None] | None = None,
) -> list[ToolSpec]:
    """Bind the sandbox and fetcher to their tool specs.

    ``fetch_guard`` is an optional host hook that sees every URL before the
    network is touched (an allowlist the operator set for a run, say). It
    raises to refuse; it never rewrites the URL.
    """

    def ls_workspace(_: dict[str, Any]) -> dict[str, Any]:
        entries = sandbox.ls()
        return {"entries": entries, "count": len(entries)}

    def read_file(arguments: dict[str, Any]) -> dict[str, Any]:
        record = sandbox.read(arguments["path"])
        return record

    def write_file(arguments: dict[str, Any]) -> dict[str, Any]:
        record = sandbox.write(arguments["path"], arguments["content"])
        record["computed"] = True
        return record

    def fetch_url(arguments: dict[str, Any]) -> dict[str, Any]:
        url = arguments["url"].strip()
        if fetch_guard is not None:
            fetch_guard(url)
        result = fetcher.fetch(url)
        if not result["text"].strip():
            raise AgentError("FETCH_EMPTY", f"{result['host']!r} returned no readable text")
        return result

    tools = [
        ToolSpec(
            name="ls_workspace",
            summary="List files in this run's workspace sandbox with content hashes",
            effect=EFFECT_READ,
            params=(),
            handler=ls_workspace,
            outputs=(_out("entries", "array"),),
            version="1.0",
        ),
        ToolSpec(
            name="read_file",
            summary="Read one file from the workspace sandbox; paths are jailed and escapes refused",
            effect=EFFECT_READ,
            params=(
                Param(
                    name="path",
                    kind="string",
                    required=True,
                    description="path relative to the workspace root (absolute and .. are refused)",
                ),
            ),
            handler=read_file,
            outputs=(
                _out("path", "string"),
                _out("content", "string"),
                _out("sha256", "string"),
                _out("bytes", "integer"),
            ),
            version="1.0",
        ),
        ToolSpec(
            name="write_file",
            summary="Write one file into the workspace sandbox; approval-gated, hashed and git-committed",
            effect=EFFECT_WRITE,
            params=(
                Param(
                    name="path",
                    kind="string",
                    required=True,
                    description="path relative to the workspace root (absolute and .. are refused)",
                ),
                Param(
                    name="content",
                    kind="string",
                    required=True,
                    max_length=MAX_WRITE_CHARS,
                    description=f"full file content, at most {MAX_WRITE_CHARS} characters",
                ),
            ),
            handler=write_file,
            outputs=(
                _out("path", "string"),
                _out("bytes", "integer"),
                _out("sha256_before", "string", required=False, nullable=True),
                _out("sha256_after", "string"),
                _out("commit", "string", required=False, nullable=True),
                _out("changed", "boolean"),
                _out("computed", "boolean"),
            ),
            version="1.0",
        ),
        ToolSpec(
            name="fetch_url",
            summary="Fetch one http(s) URL as text; SSRF-guarded, size-capped, content marked not-verified",
            effect=EFFECT_NETWORK,
            params=(
                Param(
                    name="url",
                    kind="string",
                    required=True,
                    description="absolute http/https URL; private and loopback destinations are refused",
                ),
            ),
            handler=fetch_url,
            outputs=(
                _out("url", "string"),
                _out("host", "string"),
                _out("status", "integer"),
                _out("content_type", "string"),
                _out("sha256", "string"),
                _out("bytes", "integer"),
                _out("title", "string", required=False),
                _out("text", "string"),
                _out("content_truth", "string"),
                _out("retrieved_at", "string"),
                _out("latency_ms", "integer"),
            ),
            version="1.0",
        ),
    ]
    return tools


#: Registration order, pinned by tests the way finance pins its catalogue.
GENERAL_TOOLS: tuple[str, ...] = ("ls_workspace", "read_file", "write_file", "fetch_url")
