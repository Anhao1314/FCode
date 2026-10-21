"""Run one frozen scenario against the DeepSeek API.

This is the external-provider lab, not a console integration. The host still
gates, budgets, executes and verifies; DeepSeek only proposes.

Prices are required and must come from the host's billing page. The budget is
reserved from an upper bound before the request; the receipt records estimated
actual usage, and any transport timeout is an unknown outcome (no retry).

Example:
    export DEEPSEEK_API_KEY=...
    PYTHONPATH=src python3 -m flowagent.demo.api \
      --workdir /tmp/fcode-deepseek-full --scenario full --fresh \
      --input-price-microusd-per-mtok 270000 \
      --output-price-microusd-per-mtok 1100000 \
      --price-as-of 2026-10-21
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from ..providers.deepseek import DeepSeekProvider, PriceSnapshot
from ..runtime.budget import BudgetLimits
from .fixtures import get_scenario
from .local import run

__all__ = ["main"]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flowagent-api-lab")
    parser.add_argument("--workdir", required=True, help="isolated experiment directory")
    parser.add_argument("--scenario", default="full")
    parser.add_argument("--fresh", action="store_true")
    parser.add_argument("--model", default="deepseek-chat")
    parser.add_argument("--base-url", default="https://api.deepseek.com/v1")
    parser.add_argument("--api-key-env", default="DEEPSEEK_API_KEY")
    parser.add_argument("--input-price-microusd-per-mtok", type=int, required=True)
    parser.add_argument("--output-price-microusd-per-mtok", type=int, required=True)
    parser.add_argument("--cache-hit-price-microusd-per-mtok", type=int, default=None)
    parser.add_argument("--price-as-of", required=True)
    parser.add_argument("--price-source", default="host")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--max-prompt-tokens", type=int, default=4096)
    parser.add_argument("--max-rounds", type=int, default=0)
    parser.add_argument("--max-calls", type=int, default=None)
    parser.add_argument("--max-reads", type=int, default=None)
    parser.add_argument("--max-cost-microusd", type=int, default=None)
    parser.add_argument("--max-tokens-budget", type=int, default=None)
    parser.add_argument("--no-json-mode", action="store_false", dest="json_mode")
    args = parser.parse_args(argv)

    api_key = os.environ.get(args.api_key_env, "")
    if not api_key.strip():
        parser.error(f"{args.api_key_env} is not set")
    try:
        price = PriceSnapshot(
            input_microusd_per_mtok=args.input_price_microusd_per_mtok,
            output_microusd_per_mtok=args.output_price_microusd_per_mtok,
            cache_hit_microusd_per_mtok=args.cache_hit_price_microusd_per_mtok,
            as_of=args.price_as_of,
            source=args.price_source,
        )
        provider = DeepSeekProvider(
            api_key=api_key,
            price=price,
            model=args.model,
            base_url=args.base_url,
            timeout=args.timeout,
            max_tokens=args.max_tokens,
            max_prompt_tokens=args.max_prompt_tokens,
            json_mode=args.json_mode,
        )
    except ValueError as error:
        parser.error(str(error))

    limits = None
    if any(value is not None for value in (
        args.max_calls, args.max_reads, args.max_cost_microusd, args.max_tokens_budget,
    )):
        base = get_scenario(args.scenario).limits
        limits = BudgetLimits(
            max_calls=args.max_calls if args.max_calls is not None else base.max_calls,
            max_reads=args.max_reads if args.max_reads is not None else base.max_reads,
            max_cost_microusd=(
                args.max_cost_microusd
                if args.max_cost_microusd is not None
                else base.max_cost_microusd
            ),
            max_tokens=(
                args.max_tokens_budget
                if args.max_tokens_budget is not None
                else base.max_tokens
            ),
        )

    summary = run(
        workdir=Path(args.workdir),
        scenario_key=args.scenario,
        fresh=args.fresh,
        endpoint=args.base_url,
        model=args.model,
        timeout=args.timeout,
        max_rounds=args.max_rounds or None,
        provider=provider,
        limits=limits,
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["verified"] and summary["outcome_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
