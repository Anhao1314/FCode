"""CLI entry point for the offline demo.

Design rule: every flag either works or says exactly why it cannot. ``--model``
is the clearest case — a real provider is gated off in Phase 1, so the CLI
explains the gate instead of pretending the option does not exist.

With no arguments and a terminal attached, the CLI offers a menu. With no
arguments and no terminal (CI, a pipe, a test), it runs the full scenario, so
`python demo.py` is never interactive by accident.
"""

from __future__ import annotations

import argparse
import sys
import webbrowser

from ..core.contracts import AgentError
from .fixtures import SCENARIOS
from .runner import PROJECT_ROOT, WORK_DIR, run_all, run_scenario
from .serve import serve

__all__ = ["main"]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="flowagent-demo",
        description="Host-governed, durable, auditable agent runtime — offline demo.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  python demo.py                 menu in a terminal, full scenario otherwise\n"
            "  python demo.py full --fast     the main story, no pauses\n"
            "  python demo.py all             every scenario, then a summary table\n"
            "  python demo.py --serve         open the trace viewer in a browser\n"
        ),
    )
    parser.add_argument(
        "scenario",
        nargs="?",
        default=None,
        choices=sorted(SCENARIOS) + ["all"],
        help="which scenario to run (default: menu in a terminal, otherwise full)",
    )
    parser.add_argument("--fast", action="store_true", help="disable pauses between rounds")
    parser.add_argument("--trace-out", metavar="PATH", help="write the trace here instead of work/demo/")
    parser.add_argument("--model", default="mock", help="proposal source (Phase 1: mock only)")
    parser.add_argument("--open", action="store_true", dest="open_viewer", help="open the trace viewer afterwards")
    parser.add_argument("--serve", action="store_true", help="serve the viewer on 127.0.0.1 and open it")
    parser.add_argument("--port", type=int, default=0, help="port for --serve (default: pick a free one)")
    parser.add_argument("--list", action="store_true", dest="list_scenarios", help="list scenarios and exit")
    return parser


def _menu() -> str:
    """Ask which scenario to run; default to the full story on an empty answer."""
    keys = list(SCENARIOS)
    print("\n可运行场景：")
    for index, key in enumerate(keys, start=1):
        scenario = SCENARIOS[key]
        print(f"  {index}) {key:<12} {scenario.title}")
    print(f"  a) {'all':<12} 顺序跑完全部并汇总")
    raw = input(f"\n选择 [1-{len(keys)}]，回车默认 1：").strip().lower()
    if raw == "a":
        return "all"
    if not raw:
        return keys[0]
    try:
        index = int(raw)
        if 1 <= index <= len(keys):
            return keys[index - 1]
    except ValueError:
        pass
    print("无法识别，按默认执行 full。")
    return keys[0]


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.list_scenarios:
        print("scenarios:")
        for key, scenario in SCENARIOS.items():
            print(f"  {key:<12} {scenario.title}")
        return 0

    if args.serve:
        missing = [key for key in SCENARIOS if not (WORK_DIR / f"{key}.trace.json").exists()]
        if missing:
            print(f"generating {len(missing)} missing trace(s) before serving…")
            run_all()
        return serve(PROJECT_ROOT, port=args.port)

    key = args.scenario
    if key is None:
        interactive = sys.stdin.isatty() and not args.fast and not args.trace_out
        key = _menu() if interactive else "full"

    try:
        if key == "all":
            results = run_all()
            code = 0 if all(result.ok for result in results) else 1
        else:
            result = run_scenario(key, fast=args.fast, trace_out=args.trace_out, model=args.model)
            code = result.exit_code
    except KeyError:
        print(f"unknown scenario {key!r}; run with --list to see the options")
        return 2
    except AgentError as error:
        if error.code == "PROVIDER_GATED":
            print(error.message)
            print("a real provider requires a one-time transmission approval, a credential provider,")
            print("a host-reviewed price snapshot and a hard budget. See docs/design-decisions.md.")
            return 2
        print(f"{error.code}: {error.message}")
        return 1

    if args.open_viewer:
        viewer = PROJECT_ROOT / "viewer" / "index.html"
        if viewer.exists():
            try:
                webbrowser.open(viewer.as_uri())
            except Exception:  # noqa: BLE001 - opening a browser must never change the exit code
                print(f"could not open a browser; open {viewer} manually")
        else:
            print("viewer/index.html is missing from this checkout.")
    return code


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
