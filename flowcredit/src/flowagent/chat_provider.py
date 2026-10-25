"""Chat transport: the mock and the streaming OpenAI-compatible client.

The service owns threads, budgets and the event chain; this module only turns
messages into a stream of deltas, usage and a finish reason. A malformed SSE
line is skipped, never treated as an answer, and a transport failure surfaces
as an AgentError the service classifies.
"""

from __future__ import annotations

import json
import os
import socket
import time
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Iterator
from urllib.parse import urlsplit

from .chat_config import ChatProviderConfig
from .core.contracts import AgentError

# --------------------------------------------------------------------- SSE


def parse_sse_data(line: str | bytes) -> dict[str, Any] | None:
    """Return one JSON object from an SSE ``data:`` line, or None.

    The parser is deliberately strict about the framing and lenient about
    whitespace; a malformed provider line is skipped, not treated as an answer.
    """
    if isinstance(line, bytes):
        line = line.decode("utf-8", errors="replace")
    text = line.strip()
    if not text or text.startswith(":"):
        return None
    if not text.startswith("data:"):
        return None
    payload = text[5:].strip()
    if not payload or payload == "[DONE]":
        return None
    try:
        value = json.loads(payload)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _estimate_tokens(messages: list[dict[str, Any]]) -> int:
    characters = sum(len(str(message.get("content") or "")) for message in messages)
    return max(1, characters // 3) + 256


def _cost(prompt_tokens: int, completion_tokens: int, config: ChatProviderConfig) -> int:
    micros = (
        prompt_tokens * config.input_price_microusd_per_mtok
        + completion_tokens * config.output_price_microusd_per_mtok
    )
    return int((micros + 999_999) // 1_000_000)


class _MockProvider:
    name = "offline-mock"

    def __init__(self, model: str) -> None:
        self.model = model

    def stream(self, messages: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        last_user = next(
            (str(m.get("content") or "") for m in reversed(messages) if m.get("role") == "user"),
            "",
        )
        snippet = " ".join(last_user.split())[:80]
        text = (
            f"离线 Mock 回复：我收到了「{snippet}」。\n\n"
            "这是没有调用真实模型时的对话通道，用来验证流式输出、追问、重新生成、"
            "编辑上一条和停止生成。\n\n"
            "在模型菜单里选择 Kimi / DeepSeek，或配置对应的 API 环境变量后，"
            "同一段对话会交给真实模型回答。"
        )
        delay = float(os.environ.get("FCODE_CHAT_MOCK_DELAY", "0.012") or 0)
        for index in range(0, len(text), 8):
            if delay:
                time.sleep(delay)
            yield {"delta": text[index:index + 8]}
        prompt_tokens = _estimate_tokens(messages)
        completion_tokens = max(1, len(text) // 3)
        yield {
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
            "finish_reason": "stop",
        }


class _RemoteProvider:
    def __init__(self, config: ChatProviderConfig) -> None:
        self.config = config
        self.name = config.key
        self.model = config.model

    def stream(self, messages: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
        parsed = urlsplit(self.config.base_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise AgentError("CHAT_CONFIG_INVALID", f"invalid base URL {self.config.base_url!r}")
        path = (parsed.path.rstrip("/") or "") + "/chat/completions"
        if parsed.query:
            path += "?" + parsed.query
        connection_cls = HTTPSConnection if parsed.scheme == "https" else HTTPConnection
        connection = connection_cls(
            parsed.hostname,
            parsed.port,
            timeout=self.config.timeout_seconds,
        )
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Accept-Encoding": "identity",
            "Connection": "close",
        }
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        payload = {
            "model": self.config.model,
            "messages": messages,
            "stream": True,
            self.config.completion_field: self.config.max_completion_tokens,
        }
        try:
            connection.request("POST", path, body=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                body = response.read(2_000).decode("utf-8", errors="replace")
                raise AgentError(
                    "CHAT_PROVIDER_ERROR",
                    f"{self.config.key} HTTP {response.status}: {body[:300]}",
                )
            for line in response:
                item = parse_sse_data(line)
                if item is None:
                    continue
                usage = item.get("usage")
                if isinstance(usage, dict) and usage:
                    yield {"usage": usage}
                choices = item.get("choices") or []
                if not isinstance(choices, list) or not choices:
                    continue
                choice = choices[0] if isinstance(choices[0], dict) else {}
                delta = choice.get("delta") or {}
                if not isinstance(delta, dict):
                    delta = {}
                reasoning = delta.get("reasoning_content")
                if isinstance(reasoning, str) and reasoning:
                    yield {"reasoning": reasoning}
                content = delta.get("content")
                if isinstance(content, str) and content:
                    yield {"delta": content}
                finish = choice.get("finish_reason")
                if finish:
                    yield {"finish_reason": str(finish)}
        except (socket.timeout, TimeoutError) as error:
            raise AgentError("CHAT_TIMEOUT", f"{self.config.key} stream timed out: {error}")
        except AgentError:
            raise
        except OSError as error:
            raise AgentError("CHAT_STREAM_FAILED", f"{self.config.key} stream failed: {error}")
        finally:
            try:
                connection.close()
            except OSError:
                pass
