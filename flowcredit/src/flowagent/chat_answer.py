"""One chat answer's streaming lifecycle, separate from thread management."""

from __future__ import annotations

import secrets
import time
from typing import Any, Iterator

from .chat_usage import AnswerAccounting
from .core.contracts import AgentError
from .pacing import pace_key, reserve_slot


class AnswerStream:
    def __init__(self, service, thread, user_message: dict[str, Any], model: str | None) -> None:
        self.service = service
        self.thread = thread
        self.thread_id = thread.id
        self.user_message = user_message
        self.model = model
        self.assistant_id = f"a-{secrets.token_hex(6)}"
        self.started = time.monotonic()
        self.text_parts: list[str] = []
        self.reasoning_parts: list[str] = []
        self.usage: dict[str, Any] = {}
        self.finish_reason = ""
        self.finalised = False

    def events(self) -> Iterator[dict[str, Any]]:
        try:
            self.config, self.provider = self.service._provider(self.model)
        except Exception as error:  # noqa: BLE001 — configuration errors belong in the chain
            yield self._configuration_error(error)
            return
        messages = self.service._prompt_messages(self.thread_id)
        self.accounting = AnswerAccounting.prepare(
            self.service, self.thread_id, messages, self.config,
        )
        try:
            self.accounting.reserve()
        except AgentError as error:
            yield from self._budget_error(error)
            return
        yield self._start_event()
        yield from self._wait_for_slot()
        try:
            yield from self._consume(messages)
            yield self._complete()
        except Exception as error:  # noqa: BLE001 — malformed provider chunks are errors
            yield self._stream_error(error)
        finally:
            if not self.finalised:
                self._cancel()

    def _error_detail(self, code: str, message: str) -> dict[str, Any]:
        return {
            "assistant_id": self.assistant_id,
            "user_id": self.user_message["id"],
            "code": code,
            "message": message,
            "text": "",
        }

    def _configuration_error(self, error: Exception) -> dict[str, Any]:
        code = getattr(error, "code", "CHAT_CONFIG_INVALID")
        message = getattr(error, "message", None) or f"{type(error).__name__}: {error}"
        self.thread = self.service._append(
            self.thread, "chat_error", self._error_detail(code, message),
        )
        self.finalised = True
        return {
            "type": "error",
            "thread_id": self.thread_id,
            "user_id": self.user_message["id"],
            "assistant_id": self.assistant_id,
            "code": code,
            "message": message,
        }

    def _budget_error(self, error: AgentError) -> Iterator[dict[str, Any]]:
        self.thread = self.service._append(
            self.thread, "chat_error", self._error_detail(error.code, error.message),
        )
        self.finalised = True
        yield {
            "type": "error",
            "thread_id": self.thread_id,
            "user_id": self.user_message["id"],
            "assistant_id": self.assistant_id,
            "code": error.code,
            "message": error.message,
            "budget": self.accounting.snapshot(),
        }

    def _start_event(self) -> dict[str, Any]:
        return {
            "type": "start",
            "thread_id": self.thread_id,
            "thread_title": self.thread.objective or "新对话",
            "user": self.service._public_message(self.user_message),
            "assistant_id": self.assistant_id,
            "provider": {
                "key": self.config.key, "label": self.config.label, "model": self.config.model,
            },
            "reserved": {
                "tokens": self.accounting.reserved_tokens,
                "cost_microusd": self.accounting.reserved_cost,
            },
            "budget": self.accounting.snapshot(),
        }

    def _wait_for_slot(self) -> Iterator[dict[str, Any]]:
        wait = reserve_slot(
            pace_key(self.config.key, self.config.base_url), self.config.min_interval_seconds,
        )
        if wait > 0:
            yield {"type": "wait", "seconds": int(wait + 0.999), "provider": self.config.label}
            remaining = wait
            while remaining > 0:
                time.sleep(min(0.25, remaining))
                remaining -= 0.25

    def _consume(self, messages: list[dict]) -> Iterator[dict[str, Any]]:
        for item in self.provider.stream(messages):
            if "delta" in item:
                chunk = str(item["delta"])
                self.text_parts.append(chunk)
                yield {"type": "delta", "text": chunk, "assistant_id": self.assistant_id}
            elif "reasoning" in item:
                chunk = str(item["reasoning"])
                self.reasoning_parts.append(chunk)
                yield {"type": "reasoning", "text": chunk, "assistant_id": self.assistant_id}
            elif "usage" in item and isinstance(item["usage"], dict):
                self.usage = item["usage"]
            elif "finish_reason" in item:
                self.finish_reason = str(item["finish_reason"])

    def _complete(self) -> dict[str, Any]:
        from .chat import CHAT_VERSION, parse_action_block

        raw_text = "".join(self.text_parts)
        latency_ms = int((time.monotonic() - self.started) * 1000)
        usage = self.accounting.settle(self.usage, raw_text, latency_ms)
        actual_cost = self.accounting.settle_cost(self.config, usage)
        text, action = parse_action_block(raw_text)
        receipt_ref = self.service.receipts.issue(
            intent={
                "thread_id": self.thread_id,
                "user_message_id": self.user_message["id"],
                "assistant_id": self.assistant_id,
            },
            plan={"version": CHAT_VERSION, "kind": "answer", "model": self.config.model},
            usage={
                "provider": self.config.key,
                "model": self.config.model,
                "tokens": usage["total_tokens"],
                "cost_microusd": actual_cost,
                "latency_ms": latency_ms,
                "finish_reason": self.finish_reason or "stop",
                "external_billing": "not-verified",
            },
        )
        public_usage = {
            **usage,
            "cost_microusd": actual_cost,
            "reserved_tokens": self.accounting.reserved_tokens,
            "reserved_cost_microusd": self.accounting.reserved_cost,
        }
        detail = {
            "id": self.assistant_id,
            "user_id": self.user_message["id"],
            "text": text,
            "reasoning": "".join(self.reasoning_parts),
            "status": "ok",
            "usage": public_usage,
            "receipt_ref": receipt_ref,
            "provider": self.config.key,
            "model": self.config.model,
        }
        if action:
            detail["action"] = action
        self.thread = self.service._append(self.thread, "chat_assistant", detail)
        self.finalised = True
        message = {
            "id": self.assistant_id,
            "role": "assistant",
            "text": text,
            "reasoning": detail["reasoning"],
            "status": "ok",
            "usage": public_usage,
            "receipt_ref": receipt_ref,
            "provider": self.config.key,
            "model": self.config.model,
            "error": {},
            "at": "",
            "seq": self.thread.sequence,
        }
        # Same rule as the replay: no proposal, no action field. The client
        # treats a present-but-empty action as "render the proposal card".
        if action:
            message["action"] = action
        return {
            "type": "done", "message": message,
            "budget": self.accounting.snapshot(), "thread_id": self.thread_id,
        }

    def _stream_error(self, error: Exception) -> dict[str, Any]:
        text = "".join(self.text_parts)
        code = error.code if isinstance(error, AgentError) else "CHAT_STREAM_FAILED"
        message = error.message if isinstance(error, AgentError) else f"{type(error).__name__}: {error}"
        detail = {
            "assistant_id": self.assistant_id,
            "user_id": self.user_message["id"],
            "code": code,
            "message": message,
            "text": text,
            "reasoning": "".join(self.reasoning_parts),
            "usage": self.usage,
        }
        self.thread = self.service._append(self.thread, "chat_error", detail)
        self.finalised = True
        return {
            "type": "error", "code": code, "message": message,
            "assistant_id": self.assistant_id, "partial": text,
            "budget": self.accounting.snapshot(),
        }

    def _cancel(self) -> None:
        self.service._append(self.thread, "chat_cancelled", {
            "assistant_id": self.assistant_id,
            "user_id": self.user_message["id"],
            "text": "".join(self.text_parts),
            "reasoning": "".join(self.reasoning_parts),
            "usage": self.usage,
            "provider": self.config.key,
            "model": self.config.model,
        })
