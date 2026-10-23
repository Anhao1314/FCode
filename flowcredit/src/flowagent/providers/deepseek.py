"""DeepSeek API provider: external OpenAI-compatible proposals and choices.

This is deliberately not a subclass of the local provider. Local inference is
zero-cost and free to retry; an external call is billed, may time out after the
provider has already charged, and therefore follows FCode's stricter rules:

* price snapshot is supplied by the host, never guessed;
* budget is reserved from an upper bound before dispatch;
* transport failure is an unknown outcome, never retried;
* no fallback to mock;
* the API key is read from the environment and never written to a trace.

The provider returns a proposal the host still has to gate, execute and verify.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from ..core.contracts import PLAN_VERSION, AgentError
from ..runtime.policy import ActionChoice, DecisionPacket
from .base import Proposal
from .packet_prompt import parse_choice_text, render_policy_prompt
from .prompt import PROMPT_VERSION, parse_proposal_text, render_prompt

__all__ = ["PriceSnapshot", "DeepSeekProvider", "DeepSeekPolicy"]


def _micro(tokens: int, microusd_per_mtok: int) -> int:
    return (tokens * microusd_per_mtok + 500_000) // 1_000_000


@dataclass(frozen=True)
class PriceSnapshot:
    """Host-reviewed prices, in µUSD per million tokens.

    The host must supply the numbers from its own billing page and the date they
    were read. This object is copied into the receipt metadata so an audit can
    see which prices produced the cost estimate.
    """

    input_microusd_per_mtok: int
    output_microusd_per_mtok: int
    as_of: str
    source: str = "host"
    cache_hit_microusd_per_mtok: int | None = None

    def __post_init__(self) -> None:
        for name in ("input_microusd_per_mtok", "output_microusd_per_mtok"):
            value = getattr(self, name)
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if self.cache_hit_microusd_per_mtok is not None:
            if not isinstance(self.cache_hit_microusd_per_mtok, int) or self.cache_hit_microusd_per_mtok < 0:
                raise ValueError("cache_hit_microusd_per_mtok must be a non-negative integer")
        if not isinstance(self.as_of, str) or not self.as_of.strip():
            raise ValueError("as_of is required")

    def cost(self, usage: dict[str, Any]) -> int:
        prompt = int(usage.get("prompt_tokens") or 0)
        completion = int(usage.get("completion_tokens") or 0)
        hit = int(usage.get("prompt_cache_hit_tokens") or 0)
        hit = max(0, min(hit, prompt))
        miss = max(0, prompt - hit)
        cache_price = (
            self.cache_hit_microusd_per_mtok
            if self.cache_hit_microusd_per_mtok is not None
            else self.input_microusd_per_mtok
        )
        return (
            _micro(hit, cache_price)
            + _micro(miss, self.input_microusd_per_mtok)
            + _micro(completion, self.output_microusd_per_mtok)
        )


def _usage_tokens(usage: dict[str, Any]) -> tuple[int, int, int]:
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    total = int(usage.get("total_tokens") or (prompt + completion))
    return prompt, completion, total


def _reservation(price: PriceSnapshot, prompt_tokens: int, output_tokens: int) -> tuple[int, int]:
    tokens = prompt_tokens + output_tokens
    cost = _micro(prompt_tokens, price.input_microusd_per_mtok) + _micro(
        output_tokens, price.output_microusd_per_mtok
    )
    return tokens, cost


def _estimate_prompt_tokens(system: str, user: str) -> int:
    """Conservative char-based estimate; actual usage is recorded in the receipt."""
    return max(1, (len(system) + len(user) + 2) // 3) + 64


class _DeepSeekClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        timeout: float,
        max_tokens: int,
        json_mode: bool,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("DeepSeek API key is missing")
        if not base_url.startswith("https://"):
            raise ValueError("DeepSeek base_url must use https")
        if max_tokens <= 0:
            raise ValueError("max_tokens must be positive")
        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.json_mode = json_mode

    def chat(self, system: str, user: str) -> tuple[str, dict[str, Any], str]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": self.max_tokens,
            "stream": False,
        }
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
        request = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
                "User-Agent": "fcode-runtime/1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:200]
            code = "MODEL_AUTH_FAILED" if error.code in (401, 403) else "MODEL_CALL_FAILED"
            raise AgentError(code, f"deepseek HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise AgentError("MODEL_CALL_FAILED", f"deepseek transport: {error}") from error
        except ValueError as error:
            raise AgentError("MODEL_CALL_FAILED", "deepseek returned non-JSON") from error

        choices = payload.get("choices") or []
        if not choices:
            raise AgentError("MODEL_CALL_FAILED", "deepseek returned no choices")
        content = ((choices[0].get("message") or {}).get("content")) or ""
        if not isinstance(content, str) or not content.strip():
            raise AgentError("MODEL_CALL_FAILED", "deepseek returned empty content")
        return content, dict(payload.get("usage") or {}), str(payload.get("id") or "")


class DeepSeekProvider:
    """Full-proposal provider. The host still validates and verifies the plan."""

    name = "deepseek"

    def __init__(
        self,
        *,
        api_key: str,
        price: PriceSnapshot,
        model: str = "deepseek-chat",
        base_url: str = "https://api.deepseek.com/v1",
        timeout: float = 120.0,
        max_tokens: int = 256,
        max_prompt_tokens: int = 4_096,
        json_mode: bool = True,
    ) -> None:
        self.client = _DeepSeekClient(
            api_key=api_key,
            base_url=base_url,
            model=model,
            timeout=timeout,
            max_tokens=max_tokens,
            json_mode=json_mode,
        )
        self.model = model
        self.price = price
        self.max_tokens = max_tokens
        self.max_prompt_tokens = max_prompt_tokens
        self.reserve_tokens, self.reserve_cost_microusd = _reservation(
            price, max_prompt_tokens, max_tokens
        )

    def reserve(self, context: dict[str, Any]) -> tuple[int, int]:
        """Reserve against the actual rendered prompt, not a fixed 4k guess."""
        system, user = render_prompt(context)
        prompt_tokens = _estimate_prompt_tokens(system, user)
        return _reservation(self.price, prompt_tokens, self.max_tokens)

    def propose(self, context: dict[str, Any]) -> Proposal:
        system, user = render_prompt(context)
        started = time.monotonic()
        content, usage, request_id = self.client.chat(system, user)
        latency_ms = int((time.monotonic() - started) * 1000)
        try:
            data = parse_proposal_text(content)
        except ValueError as error:
            raise AgentError("PROPOSAL_MALFORMED", f"{error}: {content[:120]!r}") from error
        _, _, total_tokens = _usage_tokens(usage)
        metadata = {
            "prompt_version": PROMPT_VERSION,
            "billing": "external",
            "provider_request_id": request_id,
            "price_as_of": self.price.as_of,
            "price_source": self.price.source,
        }
        if not usage:
            metadata["usage_missing"] = True
        return Proposal(
            plan={"version": PLAN_VERSION, "steps": data["steps"]},
            provider=self.name,
            model=self.model,
            tokens=total_tokens,
            cost_microusd=self.price.cost(usage),
            latency_ms=latency_ms,
            todo_id=data.get("todo_id"),
            metadata=metadata,
        )


class DeepSeekPolicy:
    """Choice-only policy head. One call; no repair, no hidden second charge."""

    name = "deepseek-policy"

    def __init__(
        self,
        *,
        api_key: str,
        price: PriceSnapshot,
        model: str = "deepseek-chat",
        base_url: str = "https://api.deepseek.com/v1",
        timeout: float = 120.0,
        max_tokens: int = 64,
        max_packet_tokens: int = 4_096,
        json_mode: bool = True,
    ) -> None:
        self.client = _DeepSeekClient(
            api_key=api_key,
            base_url=base_url,
            model=model,
            timeout=timeout,
            max_tokens=max_tokens,
            json_mode=json_mode,
        )
        self.model = model
        self.price = price
        self.max_tokens = max_tokens
        self.max_packet_tokens = max_packet_tokens
        self.reserve_tokens, self.reserve_cost_microusd = _reservation(
            price, max_packet_tokens, max_tokens
        )

    def reserve(self, packet: DecisionPacket) -> tuple[int, int]:
        system, user = render_policy_prompt(packet)
        prompt_tokens = _estimate_prompt_tokens(system, user)
        return _reservation(self.price, prompt_tokens, self.max_tokens)

    def choose(self, packet: DecisionPacket) -> ActionChoice:
        system, user = render_policy_prompt(packet)
        started = time.monotonic()
        content, usage, request_id = self.client.chat(system, user)
        latency_ms = int((time.monotonic() - started) * 1000)
        try:
            choice = parse_choice_text(content)
        except ValueError as error:
            raise AgentError("POLICY_INVALID_CHOICE", f"{error}: {content[:120]!r}") from error
        if packet.candidate(choice) is None:
            raise AgentError("POLICY_INVALID_CHOICE", f"{choice!r} is not a candidate id")
        _, _, total_tokens = _usage_tokens(usage)
        metadata = {
            "billing": "external",
            "price_as_of": self.price.as_of,
            "price_source": self.price.source,
        }
        if not usage:
            metadata["usage_missing"] = True
        return ActionChoice(
            choice,
            tokens=total_tokens,
            latency_ms=latency_ms,
            cost_microusd=self.price.cost(usage),
            request_id=request_id,
            metadata=metadata,
        )
