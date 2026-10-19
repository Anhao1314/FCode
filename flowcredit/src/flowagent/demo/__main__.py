"""CLI entry point for the offline demo.

Design rule: every flag either works or says exactly why it cannot. ``--model``
is the clearest case — a real provider is gated off in Phase 1, so the CLI
explains the gate instead of pretending the option does not exist.
"""

from __future__ import annotations

import argparse
import sys
import webbrowser
from pathlib import Path

from .fixtures import SCENARIOS
from .runner import PROJECT_ROOT, run_scenario

__all__ = ["main"]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="flowagent-demo",
        description="Host-governed, durable, auditable agent runtime — offline demo.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  python demo.py                 run the full story\n"
            "  python demo.py full --fast     same, without pauses\n"
            "  python demo.py --list          list scenarios\n"
        ),
    )
    parser.add_argument(
        "scenario",
        nargs="?",
        default="full",
        choices=sorted(SCENARIOS),
        help="which scenario to run (default: full)",
    )
    parser.add_argument("--fast", action="store_true", help="disable pauses between rounds")
    parser.add_argument("--trace-out", metavar="PATH", help="write the trace here instead of work/demo/")
    parser.add_argument("--model", default="mock", help="proposal source (Phase 1: mock only)")
    parser.add_argument("--open", action="store_true", dest="open_viewer", help="open the trace viewer afterwards")
    parser.add_argument("--list", action="store_true", dest="list_scenarios", help="list scenarios and exit")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.list_scenarios:
        print("scenarios:")
        for key, scenario in SCENARIOS.items():
            state = "ready" if scenario.available else "phase-1b"
            print(f"  {key:<12} [{state}]  {scenario.title}")
        return 0

    code = run_scenario(
        args.scenario,
        fast=args.fast,
        trace_out=args.trace_out,
        model=args.model,
    )

    if args.open_viewer:
        viewer = PROJECT_ROOT / "viewer" / "index.html"
        if viewer.exists():
            try:
                webbrowser.open(viewer.as_uri())
            except Exception:  # noqa: BLE001 - opening a browser must never change the exit code
                print(f"could not open a browser; open {viewer} manually")
        else:
            print("viewer/index.html is scheduled for Phase 1b; the trace JSON is already written.")
    return code


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
