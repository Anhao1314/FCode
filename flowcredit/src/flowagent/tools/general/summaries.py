"""General memory summaries: per-tool compressors for the general toolset.

The general agent's observations are files, commands and fetches. What a
decision needs from a ``read_file`` is not the whole content but the fact that
it was read, how big it is and its hash — the content lives in the workspace
and can be re-read (a governed action) if actually needed. Long text is cut to
a head plus its true length, so the prompt never carries a file body twice.
"""

from __future__ import annotations

from typing import Any

_HEAD = 600


def _head(text: Any) -> dict[str, Any]:
    value = str(text or "")
    if len(value) <= _HEAD:
        return {"head": value}
    return {"head": value[:_HEAD], "truncated": True, "chars": len(value)}


def summarize_ls_workspace(result: dict[str, Any]) -> dict[str, Any]:
    entries = result.get("entries", [])
    return {
        "count": result.get("count", len(entries)),
        "files": [entry.get("path") for entry in entries[:20]],
        "truncated": len(entries) > 20,
    }


def summarize_read_file(result: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "path": result.get("path"),
        "bytes": result.get("bytes"),
        "sha256": result.get("sha256"),
    }
    out.update(_head(result.get("content")))
    return out


def summarize_write_file(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": result.get("path"),
        "bytes": result.get("bytes"),
        "changed": result.get("changed", True),
        "sha256_after": result.get("sha256_after"),
        "commit": result.get("commit"),
    }


def summarize_edit_file(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": result.get("path"),
        "changed": result.get("changed", True),
        "lines_added": result.get("lines_added"),
        "lines_removed": result.get("lines_removed"),
        "sha256_after": result.get("sha256_after"),
        "commit": result.get("commit"),
    }


def summarize_run_command(result: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "command": result.get("command"),
        "exit_code": result.get("exit_code"),
        "duration_ms": result.get("duration_ms"),
        "readonly": result.get("readonly"),
    }
    out.update(_head(result.get("output")))
    return out


def summarize_fetch_url(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "url": result.get("url"),
        "status": result.get("status"),
        "title": result.get("title"),
        "bytes": result.get("bytes"),
        "content_truth": result.get("content_truth"),
        "latency_ms": result.get("latency_ms"),
    }


GENERAL_SUMMARIZERS: dict[str, Any] = {
    "ls_workspace": summarize_ls_workspace,
    "read_file": summarize_read_file,
    "write_file": summarize_write_file,
    "edit_file": summarize_edit_file,
    "run_command": summarize_run_command,
    "fetch_url": summarize_fetch_url,
}
