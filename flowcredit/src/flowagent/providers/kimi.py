"""Kimi API provider: an OpenAI-compatible, externally billed proposal source.

Kimi (Moonshot) follows the same external-call discipline as DeepSeek: the key
comes only from the host environment, prices are host-reviewed and mandatory,
budget is reserved from a conservative upper bound before dispatch, transport
failure is an unknown outcome, and there is no retry and no mock fallback.

Cache billing is deliberately simple in v1: every input token is charged at the
input price even when the API reports a cache hit. The cached-token count is
kept in receipt metadata for a later, explicit v2 pricing implementation.
"""

from __future__ import annotations

import json
import math
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from ..core.contracts import PLAN_VERSION, AgentError
from .base import Proposal
from .prompt import PROMPT_VERSION, parse_proposal_text, render_prompt

__all__ = [
    "KIMI_API_KEY_ENV",
    "KIMI_MODEL_ENV",
    "KIMI_BASE_URL_ENV",
    "KIMI_INPUT_PRICE_ENV",
    "KIMI_OUTPUT_PRICE_ENV",
    "KIMI_PRICE_AS_OF_ENV",
    "KIMI_PRICE_SOURCE_ENV",
    "KIMI_TIMEOUT_ENV",
    "KIMI_MAX_COMPLETION_TOKENS_ENV",
    "KIMI_TEMPERATURE_ENV",
    "KimiPriceSnapshot",
    "KimiCalibration",
    "KimiSettings",
    "load_kimi_settings",
    "KimiProvider",
]

KIMI_API_KEY_ENV = "KIMI_API_KEY"
KIMI_MODEL_ENV = "KIMI_MODEL"
KIMI_BASE_URL_ENV = "KIMI_BASE_URL"
KIMI_INPUT_PRICE_ENV = "KIMI_INPUT_PRICE_MICROUSD_PER_MTOK"
KIMI_OUTPUT_PRICE_ENV = "KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK"
KIMI_PRICE_AS_OF_ENV = "KIMI_PRICE_AS_OF"
KIMI_PRICE_SOURCE_ENV = "KIMI_PRICE_SOURCE"
KIMI_TIMEOUT_ENV = "KIMI_TIMEOUT_SECONDS"
KIMI_MAX_COMPLETION_TOKENS_ENV = "KIMI_MAX_COMPLETION_TOKENS"
KIMI_TEMPERATURE_ENV = "KIMI_TEMPERATURE"

_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1"
_DEFAULT_MODEL = "kimi-k3.1-pro"
_DEFAULT_TIMEOUT = 180.0
_DEFAULT_MAX_COMPLETION_TOKENS = 512
_DEFAULT_REASONING_EFFORT = "low"

RawSink = Callable[[dict[str, Any]], None]
IssueReceipt = Callable[..., str]


def _micro(tokens: int, microusd_per_mtok: int) -> int:
    return (tokens * microusd_per_mtok + 500_000) // 1_000_000


def _ceil_div(value: int, divisor: int) -> int:
    return (value + divisor - 1) // divisor


@dataclass(frozen=True)
class KimiPriceSnapshot:
    """Host-reviewed Kimi prices, in µUSD per million tokens."""

    input_microusd_per_mtok: int
    output_microusd_per_mtok: int
    as_of: str
    source: str = "host"

    def __post_init__(self) -> None:
        for name in ("input_microusd_per_mtok", "output_microusd_per_mtok"):
            value = getattr(self, name)
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if not isinstance(self.as_of, str) or not self.as_of.strip():
            raise ValueError("as_of is required")

    def cost(self, usage: dict[str, Any]) -> int:
        """Charge every input token at the input price; cache is v1 metadata."""
        prompt = max(0, int(usage.get("prompt_tokens") or 0))
        completion = max(0, int(usage.get("completion_tokens") or 0))
        return _micro(prompt, self.input_microusd_per_mtok) + _micro(
            completion, self.output_microusd_per_mtok
        )


@dataclass
class KimiCalibration:
    """Prompt-token estimate and its one-time correction from real usage.

    The initial char-based estimate is intentionally conservative for English,
    but Chinese text can tokenize above one token per three characters. If the
    first real response reports more prompt tokens than reserved, the measured
    chars-to-token ratio replaces the guess for all later rounds and scenarios.
    """

    path: Path | None = None
    measured_ratio: float | None = None
    reports: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path | None) -> "KimiCalibration":
        if path is None or not path.exists():
            return cls(path=path)
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return cls(
                path=path,
                measured_ratio=float(data.get("measured_ratio"))
                if data.get("measured_ratio") is not None
                else None,
                reports=list(data.get("reports") or []),
            )
        except (OSError, ValueError, TypeError):
            # A damaged calibration file must not become a reason to stop calling
            # the provider. Fall back to the conservative initial formula.
            return cls(path=path)

    def estimate(self, system: str, user: str) -> int:
        chars = len(system) + len(user)
        if self.measured_ratio is None:
            return max(1, _ceil_div(chars, 3)) + 64
        measured = math.ceil(chars * self.measured_ratio)
        return max(1, _ceil_div(chars, 2), measured)

    @property
    def formula(self) -> str:
        if self.measured_ratio is None:
            return "ceil(chars/3)+64"
        ratio = format(self.measured_ratio, ".6f").rstrip("0").rstrip(".")
        return f"max(ceil(chars/2), ceil(chars*{ratio}))"

    def record(self, *, chars: int, reserved: int, actual: int) -> dict[str, Any]:
        report = {
            "chars": int(chars),
            "reserved_prompt_tokens": int(reserved),
            "usage_prompt_tokens": int(actual),
            "ratio_actual_to_reserve": round(actual / reserved, 6) if reserved else None,
            "old_formula": self.formula,
            "adjusted": False,
        }
        if self.measured_ratio is None and actual > reserved and chars > 0:
            # One correction, based on the first real response. Later rounds may
            # legitimately differ in content mix; repeatedly refitting the ratio
            # would turn a budget guard into an experiment loop.
            self.measured_ratio = actual / chars
            report["adjusted"] = True
            report["new_formula"] = self.formula
        self.reports.append(report)
        self.save()
        return report

    def save(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "measured_ratio": self.measured_ratio,
            "formula": self.formula,
            "reports": self.reports,
        }
        temporary = self.path.with_name(self.path.name + ".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)


@dataclass(frozen=True)
class KimiSettings:
    """Validated host settings; the API key never appears in ``redacted``."""

    api_key: str
    base_url: str
    model: str
    price: KimiPriceSnapshot
    timeout: float = _DEFAULT_TIMEOUT
    max_completion_tokens: int = _DEFAULT_MAX_COMPLETION_TOKENS
    reasoning_effort: str = _DEFAULT_REASONING_EFFORT
    temperature: float | None = None

    def redacted(self) -> dict[str, Any]:
        return {
            "provider": "kimi",
            "apiKey": f"env:{KIMI_API_KEY_ENV}",
            "baseURL": self.base_url,
            "model": self.model,
            "timeoutSeconds": self.timeout,
            "maxCompletionTokens": self.max_completion_tokens,
            "reasoningEffort": self.reasoning_effort,
            "temperature": self.temperature,
            "price": {
                "inputMicrousdPerMtok": self.price.input_microusd_per_mtok,
                "outputMicrousdPerMtok": self.price.output_microusd_per_mtok,
                "asOf": self.price.as_of,
                "source": self.price.source,
            },
        }


def _required(env: Mapping[str, str], name: str) -> str:
    value = env.get(name)
    if value is None or not value.strip():
        raise ValueError(f"{name} is required")
    return value.strip()


def _optional_int(env: Mapping[str, str], name: str) -> int | None:
    value = env.get(name)
    if value is None or not value.strip():
        return None
    try:
        return int(value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error


def _optional_float(env: Mapping[str, str], name: str) -> float | None:
    value = env.get(name)
    if value is None or not value.strip():
        return None
    try:
        return float(value)
    except ValueError as error:
        raise ValueError(f"{name} must be a number") from error


def load_kimi_settings(
    *,
    env: Mapping[str, str] | None = None,
    model: str | None = None,
    base_url: str | None = None,
    timeout: float | None = None,
    max_completion_tokens: int | None = None,
    reasoning_effort: str | None = None,
    temperature: float | None = None,
    input_price: int | None = None,
    output_price: int | None = None,
    price_as_of: str | None = None,
    price_source: str | None = None,
) -> KimiSettings:
    """Resolve CLI overrides, then environment values, then safe defaults.

    Prices and their date never receive a default: a stale guess would turn the
    budget ceiling into a false promise.
    """
    source = os.environ if env is None else env
    resolved_input = input_price
    if resolved_input is None:
        resolved_input = _optional_int(source, KIMI_INPUT_PRICE_ENV)
    resolved_output = output_price
    if resolved_output is None:
        resolved_output = _optional_int(source, KIMI_OUTPUT_PRICE_ENV)
    if resolved_input is None or resolved_output is None:
        raise ValueError(
            f"{KIMI_INPUT_PRICE_ENV} and {KIMI_OUTPUT_PRICE_ENV} are required"
        )

    timeout_env = source.get(KIMI_TIMEOUT_ENV, "")
    resolved_timeout = timeout
    if resolved_timeout is None and timeout_env.strip():
        try:
            resolved_timeout = float(timeout_env)
        except ValueError as error:
            raise ValueError(f"{KIMI_TIMEOUT_ENV} must be a number") from error
    if resolved_timeout is None:
        resolved_timeout = _DEFAULT_TIMEOUT
    if resolved_timeout <= 0:
        raise ValueError("timeout must be positive")

    max_env = _optional_int(source, KIMI_MAX_COMPLETION_TOKENS_ENV)
    resolved_max = (
        max_completion_tokens
        if max_completion_tokens is not None
        else (max_env if max_env is not None else _DEFAULT_MAX_COMPLETION_TOKENS)
    )
    if resolved_max <= 0:
        raise ValueError("max_completion_tokens must be positive")

    resolved_temperature = temperature
    if resolved_temperature is None:
        resolved_temperature = _optional_float(source, KIMI_TEMPERATURE_ENV)

    resolved_model = model or source.get(KIMI_MODEL_ENV, "").strip() or _DEFAULT_MODEL
    resolved_base = (
        base_url or source.get(KIMI_BASE_URL_ENV, "").strip() or _DEFAULT_BASE_URL
    ).rstrip("/")
    if not resolved_base.startswith("https://"):
        raise ValueError("Kimi base_url must use https")
    if not resolved_model:
        raise ValueError("Kimi model is required")

    return KimiSettings(
        api_key=_required(source, KIMI_API_KEY_ENV),
        base_url=resolved_base,
        model=resolved_model,
        price=KimiPriceSnapshot(
            input_microusd_per_mtok=resolved_input,
            output_microusd_per_mtok=resolved_output,
            as_of=price_as_of or _required(source, KIMI_PRICE_AS_OF_ENV),
            source=price_source
            or source.get(KIMI_PRICE_SOURCE_ENV, "").strip()
            or "host",
        ),
        timeout=resolved_timeout,
        max_completion_tokens=resolved_max,
        reasoning_effort=reasoning_effort or _DEFAULT_REASONING_EFFORT,
        temperature=resolved_temperature,
    )


class _KimiClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        timeout: float,
        max_completion_tokens: int,
        reasoning_effort: str,
        temperature: float | None = None,
    ) -> None:
        if not isinstance(api_key, str) or not api_key.strip():
            raise ValueError("Kimi API key is missing")
        if not base_url.startswith("https://"):
            raise ValueError("Kimi base_url must use https")
        if max_completion_tokens <= 0:
            raise ValueError("max_completion_tokens must be positive")
        if temperature is not None and not 0 <= temperature <= 2:
            raise ValueError("temperature must be within [0, 2] when provided")
        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_completion_tokens = max_completion_tokens
        self.reasoning_effort = reasoning_effort
        self.temperature = temperature

    def chat(self, system: str, user: str) -> tuple[str, dict[str, Any], str]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "max_completion_tokens": self.max_completion_tokens,
            "stream": False,
            "response_format": {"type": "json_object"},
        }
        # K2/K3 chat models reject every temperature except 1; omitting the
        # field applies the server default unless the host pins one explicitly.
        if self.temperature is not None:
            body["temperature"] = self.temperature
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort
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
            raise AgentError(code, f"kimi HTTP {error.code}: {detail}") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise AgentError("MODEL_CALL_FAILED", f"kimi transport: {error}") from error
        except ValueError as error:
            raise AgentError("MODEL_CALL_FAILED", "kimi returned non-JSON") from error

        choices = payload.get("choices") or []
        if not choices:
            raise AgentError("MODEL_CALL_FAILED", "kimi returned no choices")
        content = ((choices[0].get("message") or {}).get("content")) or ""
        if not isinstance(content, str) or not content.strip():
            raise AgentError("MODEL_CALL_FAILED", "kimi returned empty content")
        return content, dict(payload.get("usage") or {}), str(payload.get("id") or "")


def _cached_tokens(usage: dict[str, Any]) -> int:
    details = usage.get("prompt_tokens_details") or {}
    try:
        return max(0, int(details.get("cached_tokens") or 0))
    except (TypeError, ValueError):
        return 0


def _usage_tokens(usage: dict[str, Any]) -> tuple[int, int, int]:
    prompt = int(usage.get("prompt_tokens") or 0)
    completion = int(usage.get("completion_tokens") or 0)
    total = int(usage.get("total_tokens") or (prompt + completion))
    return prompt, completion, total


class KimiProvider:
    """Full-proposal provider; Kimi never executes a tool or writes a number."""

    name = "kimi"

    def __init__(
        self,
        *,
        api_key: str,
        price: KimiPriceSnapshot,
        model: str = _DEFAULT_MODEL,
        base_url: str = _DEFAULT_BASE_URL,
        timeout: float = _DEFAULT_TIMEOUT,
        max_completion_tokens: int = _DEFAULT_MAX_COMPLETION_TOKENS,
        reasoning_effort: str = _DEFAULT_REASONING_EFFORT,
        temperature: float | None = None,
        calibration_path: Path | None = None,
        issue_receipt: IssueReceipt | None = None,
        raw_sink: RawSink | None = None,
    ) -> None:
        self.client = _KimiClient(
            api_key=api_key,
            base_url=base_url,
            model=model,
            timeout=timeout,
            max_completion_tokens=max_completion_tokens,
            reasoning_effort=reasoning_effort,
            temperature=temperature,
        )
        self.model = model
        self.price = price
        self.max_completion_tokens = max_completion_tokens
        self.reasoning_effort = reasoning_effort
        self.temperature = temperature
        self.calibration = KimiCalibration.load(calibration_path)
        self.issue_receipt = issue_receipt
        self.raw_sink = raw_sink
        self.calibration_reports: list[dict[str, Any]] = []

    @classmethod
    def from_settings(
        cls,
        settings: KimiSettings,
        *,
        calibration_path: Path | None = None,
        issue_receipt: IssueReceipt | None = None,
        raw_sink: RawSink | None = None,
    ) -> "KimiProvider":
        return cls(
            api_key=settings.api_key,
            price=settings.price,
            model=settings.model,
            base_url=settings.base_url,
            timeout=settings.timeout,
            max_completion_tokens=settings.max_completion_tokens,
            reasoning_effort=settings.reasoning_effort,
            temperature=settings.temperature,
            calibration_path=calibration_path,
            issue_receipt=issue_receipt,
            raw_sink=raw_sink,
        )

    def reserve(self, context: dict[str, Any]) -> tuple[int, int]:
        system, user = render_prompt(context)
        prompt_tokens = self.calibration.estimate(system, user)
        return (
            prompt_tokens + self.max_completion_tokens,
            _micro(prompt_tokens, self.price.input_microusd_per_mtok)
            + _micro(
                self.max_completion_tokens,
                self.price.output_microusd_per_mtok,
            ),
        )

    def propose(self, context: dict[str, Any]) -> Proposal:
        system, user = render_prompt(context)
        chars = len(system) + len(user)
        reserved_prompt_tokens = self.calibration.estimate(system, user)
        started = time.monotonic()
        content, usage, request_id = self.client.chat(system, user)
        latency_ms = int((time.monotonic() - started) * 1000)

        if self.raw_sink is not None:
            self.raw_sink(
                {
                    "round": context.get("round"),
                    "provider": self.name,
                    "model": self.model,
                    "request_id": request_id,
                    "content": content,
                    "usage": dict(usage),
                }
            )

        try:
            data = parse_proposal_text(content)
        except ValueError as error:
            raise AgentError(
                "PROPOSAL_MALFORMED",
                f"{error}: {content[:120]!r}",
                details={"raw_content": content, "request_id": request_id},
            ) from error

        prompt_tokens, _, total_tokens = _usage_tokens(usage)
        calibration_report = self.calibration.record(
            chars=chars,
            reserved=reserved_prompt_tokens,
            actual=prompt_tokens,
        )
        self.calibration_reports.append(calibration_report)
        plan = {"version": PLAN_VERSION, "steps": data["steps"]}
        metadata: dict[str, Any] = {
            "prompt_version": PROMPT_VERSION,
            "billing": "external",
            "provider_request_id": request_id,
            "input_microusd_per_mtok": self.price.input_microusd_per_mtok,
            "output_microusd_per_mtok": self.price.output_microusd_per_mtok,
            "price_as_of": self.price.as_of,
            "price_source": self.price.source,
            "reasoning_effort": self.reasoning_effort,
            "temperature": self.temperature,
            "reserved_prompt_tokens": reserved_prompt_tokens,
            "usage_prompt_tokens": prompt_tokens,
            "cached_tokens": _cached_tokens(usage),
            "cache_billing": "input-price-v1",
            "raw_content": content,
            "calibration": calibration_report,
        }
        if not usage:
            metadata["usage_missing"] = True

        receipt_ref = ""
        if self.issue_receipt is not None:
            intent = context.get("intent")
            if isinstance(intent, dict):
                receipt_ref = self.issue_receipt(
                    intent=intent,
                    plan=plan,
                    usage={
                        "provider": self.name,
                        "model": self.model,
                        "tokens": total_tokens,
                        "cost_microusd": self.price.cost(usage),
                        "request_id": request_id,
                    },
                )
                metadata["hmac_receipt_ref"] = receipt_ref

        return Proposal(
            plan=plan,
            provider=self.name,
            model=self.model,
            tokens=total_tokens,
            cost_microusd=self.price.cost(usage),
            latency_ms=latency_ms,
            todo_id=data.get("todo_id"),
            metadata=metadata,
        )
