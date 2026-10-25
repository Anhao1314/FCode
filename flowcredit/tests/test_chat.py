"""Chat: streaming, branching and cancellation on the same event chain."""

from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from flowagent.chat import (  # noqa: E402
    ChatService,
    parse_sse_data,
    resolve_chat_provider,
)
from flowagent.core.contracts import AgentError  # noqa: E402


class ChatServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"FCODE_CHAT_MOCK_DELAY": "0"}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.service = ChatService(pathlib.Path(self._tmp.name) / "chat.sqlite")
        self.addCleanup(self.service.close)

    def send(self, text: str, thread_id: str | None = None, **kwargs):
        return list(self.service.send(thread_id=thread_id, text=text, model="mock", **kwargs))

    def test_streaming_answer_is_chained_and_receipted(self) -> None:
        events = self.send("介绍一下 FCode")
        kinds = [event["type"] for event in events]
        self.assertEqual(kinds[0], "start")
        self.assertIn("delta", kinds)
        self.assertEqual(kinds[-1], "done")
        thread_id = events[0]["thread_id"]
        thread = self.service.get_thread(thread_id)
        self.assertEqual([message["role"] for message in thread["messages"]], ["user", "assistant"])
        self.assertEqual(thread["messages"][1]["status"], "ok")
        self.assertEqual(thread["budget"]["calls_used"], 1)
        self.assertGreater(thread["budget"]["tokens_used"], 0)
        self.assertGreaterEqual(self.service.receipts.count(), 1)
        # The chain is append-only and independently verifiable.
        self.service.store.verify_chain(thread_id)
        self.assertEqual(thread["events"], 3)

    def test_follow_up_keeps_the_thread_history(self) -> None:
        first = self.send("第一问")
        thread_id = first[0]["thread_id"]
        self.send("第二问", thread_id=thread_id)
        thread = self.service.get_thread(thread_id)
        self.assertEqual(
            [message["role"] for message in thread["messages"]],
            ["user", "assistant", "user", "assistant"],
        )
        self.assertEqual(thread["messages"][2]["text"], "第二问")
        self.assertEqual(thread["budget"]["calls_used"], 2)
        self.service.store.verify_chain(thread_id)

    def test_regenerate_supersedes_only_the_answer(self) -> None:
        events = self.send("问题")
        thread_id = events[0]["thread_id"]
        thread = self.service.get_thread(thread_id)
        answer = thread["messages"][-1]
        list(self.service.regenerate(
            thread_id=thread_id, message_id=answer["id"], model="mock",
        ))
        thread = self.service.get_thread(thread_id)
        self.assertEqual([message["role"] for message in thread["messages"]], ["user", "assistant"])
        self.assertNotEqual(thread["messages"][-1]["id"], answer["id"])
        self.service.store.verify_chain(thread_id)

    def test_edit_supersedes_the_later_branch(self) -> None:
        first = self.send("第一问")
        thread_id = first[0]["thread_id"]
        self.send("第二问", thread_id=thread_id)
        thread = self.service.get_thread(thread_id)
        target = next(message for message in thread["messages"] if message["role"] == "user")
        list(self.service.edit(
            thread_id=thread_id,
            message_id=target["id"],
            text="改问",
            model="mock",
        ))
        thread = self.service.get_thread(thread_id)
        self.assertEqual([message["role"] for message in thread["messages"]], ["user", "assistant"])
        self.assertEqual(thread["messages"][0]["text"], "改问")
        self.assertEqual(thread["messages"][0]["edited"], True)
        # The old branch is still in the chain, just not in the active projection.
        self.assertGreater(thread["events"], 6)
        self.service.store.verify_chain(thread_id)

    def test_stop_records_a_partial_cancelled_answer(self) -> None:
        events = self.send("会中途停止")
        thread_id = events[0]["thread_id"]
        generator = self.service.send(
            thread_id=thread_id, text="再写一段", model="mock",
        )
        seen = 0
        for event in generator:
            if event["type"] == "delta":
                seen += 1
                if seen >= 3:
                    generator.close()
                    break
        thread = self.service.get_thread(thread_id)
        self.assertEqual(thread["messages"][-1]["status"], "cancelled")
        self.assertTrue(thread["messages"][-1]["text"])
        self.service.store.verify_chain(thread_id)

    def test_attachments_are_stored_but_not_echoed_in_public_payloads(self) -> None:
        events = self.send("看看这个", attachments=[
            {"name": "notes.md", "text": "# 标题\n正文"},
        ])
        thread_id = events[0]["thread_id"]
        public = self.service.get_thread(thread_id)
        self.assertEqual(public["messages"][0]["attachments"], [{"name": "notes.md", "bytes": len("# 标题\n正文".encode())}])
        raw = [
            event for event in self.service.store.events(thread_id)
            if event["type"] == "chat_user"
        ][0]
        stored = raw["payload"]["detail"]["attachments"][0]
        self.assertEqual(stored["text"], "# 标题\n正文")

    def test_attachment_limits_fail_closed(self) -> None:
        with self.assertRaises(AgentError) as too_many:
            self.send("x", attachments=[{"name": f"{i}.txt", "text": "x"} for i in range(4)])
        self.assertEqual(too_many.exception.code, "CHAT_ATTACHMENT_INVALID")
        with self.assertRaises(AgentError) as too_large:
            self.send("x", attachments=[{"name": "big.txt", "text": "x" * (64 * 1024 + 1)}])
        self.assertEqual(too_large.exception.code, "CHAT_ATTACHMENT_INVALID")

    def test_budget_exhaustion_is_an_error_event_not_a_retry(self) -> None:
        with mock.patch.dict(os.environ, {"FCODE_CHAT_MAX_CALLS": "1"}, clear=False):
            first = self.send("第一问")
            thread_id = first[0]["thread_id"]
            second = self.send("第二问", thread_id=thread_id)
        self.assertEqual(second[0]["type"], "error")
        self.assertEqual(second[0]["thread_id"], thread_id)
        self.assertEqual(second[0]["code"], "BUDGET_EXCEEDED")
        thread = self.service.get_thread(thread_id)
        self.assertEqual(thread["messages"][-1]["status"], "error")
        self.service.store.verify_chain(thread_id)

    def test_thread_list_is_ordered_and_titled(self) -> None:
        first = self.send("标题来自第一条消息 " + "x" * 40)
        thread_id = first[0]["thread_id"]
        threads = self.service.list_threads()
        self.assertEqual(len(threads), 1)
        self.assertEqual(threads[0]["id"], thread_id)
        self.assertTrue(threads[0]["title"].startswith("标题来自第一条消息"))
        self.assertLessEqual(len(threads[0]["title"]), 31)

    def test_unknown_thread_is_not_silently_created(self) -> None:
        with self.assertRaises(AgentError) as error:
            list(self.service.send(thread_id="chat-missing", text="hi", model="mock"))
        self.assertEqual(error.exception.code, "CHAT_THREAD_NOT_FOUND")


class ProviderConfigTests(unittest.TestCase):
    def test_mock_needs_nothing(self) -> None:
        config = resolve_chat_provider("mock")
        self.assertEqual(config.key, "mock")
        self.assertFalse(config.remote)

    def test_kimi_without_key_or_prices_fails_closed(self) -> None:
        cleared = {
            "KIMI_API_KEY": "",
            "KIMI_INPUT_PRICE_MICROUSD_PER_MTOK": "",
            "KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK": "",
        }
        with mock.patch.dict(os.environ, cleared, clear=False):
            with self.assertRaises(AgentError) as error:
                resolve_chat_provider("kimi")
        self.assertEqual(error.exception.code, "CHAT_PROVIDER_UNAVAILABLE")
        self.assertIn("KIMI_API_KEY", error.exception.message)

    def test_unknown_provider_is_rejected(self) -> None:
        with self.assertRaises(AgentError) as error:
            resolve_chat_provider("not-a-provider")
        self.assertEqual(error.exception.code, "CHAT_PROVIDER_UNAVAILABLE")


class SSEParserTests(unittest.TestCase):
    def test_data_lines(self) -> None:
        self.assertEqual(
            parse_sse_data('data: {"choices":[{"delta":{"content":"你"}}]}')["choices"][0]["delta"]["content"],
            "你",
        )
        self.assertIsNone(parse_sse_data("data: [DONE]"))
        self.assertIsNone(parse_sse_data(": keepalive"))
        self.assertIsNone(parse_sse_data("event: message"))
        self.assertIsNone(parse_sse_data("data: not-json"))
        self.assertIsNone(parse_sse_data(b""))

    def test_bytes_lines(self) -> None:
        parsed = parse_sse_data(b'data: {"usage":{"total_tokens":3}}')
        self.assertEqual(parsed["usage"]["total_tokens"], 3)


class RemoteStreamTests(unittest.TestCase):
    """The OpenAI-compatible SSE client, against a local fake provider."""

    def test_kimi_stream_uses_sse_and_kimi_completion_field(self) -> None:
        captured: dict = {}

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                captured["body"] = json.loads(self.rfile.read(length))
                captured["auth"] = self.headers.get("Authorization")
                captured["path"] = self.path
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for payload in (
                    {"choices": [{"delta": {"content": "你"}}]},
                    {"choices": [{"delta": {"content": "好"}}]},
                    {
                        "choices": [{"delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
                    },
                ):
                    self.wfile.write(("data: " + json.dumps(payload) + "\n\n").encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

            def log_message(self, *args) -> None:  # noqa: D401
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        environment = {
            "KIMI_API_KEY": "test-key",
            "KIMI_BASE_URL": f"http://127.0.0.1:{port}/v1",
            "KIMI_MODEL": "test-model",
            "KIMI_INPUT_PRICE_MICROUSD_PER_MTOK": "1000",
            "KIMI_OUTPUT_PRICE_MICROUSD_PER_MTOK": "2000",
            "KIMI_MIN_CALL_INTERVAL_SECONDS": "0",
            "CHAT_MAX_COMPLETION_TOKENS": "64",
        }
        with mock.patch.dict(os.environ, environment, clear=False):
            with tempfile.TemporaryDirectory() as tmp:
                service = ChatService(pathlib.Path(tmp) / "chat.sqlite")
                self.addCleanup(service.close)
                events = list(service.send(thread_id=None, text="你好", model="kimi"))
                done = next(event for event in events if event["type"] == "done")
                thread_id = events[0]["thread_id"]
                self.assertEqual(done["message"]["text"], "你好")
                self.assertEqual(captured["auth"], "Bearer test-key")
                self.assertTrue(captured["path"].endswith("/v1/chat/completions"))
                body = captured["body"]
                self.assertTrue(body["stream"])
                self.assertIn("max_completion_tokens", body)
                self.assertNotIn("max_tokens", body)
                self.assertNotIn("temperature", body)
                self.assertEqual(body["messages"][0]["role"], "system")
                self.assertEqual(body["messages"][-1]["content"], "你好")
                self.assertGreater(done["message"]["usage"]["cost_microusd"], 0)
                self.assertGreaterEqual(service.receipts.count(), 1)
                service.store.verify_chain(thread_id)


if __name__ == "__main__":
    unittest.main()
