import test from "node:test";
import assert from "node:assert/strict";

import { applyChatEvent, createChatStreamRegistry } from "../core/chat-streams.js";

function thread(id = null) {
  return { id, title: "新对话", messages: [] };
}

function assistant() {
  return { id: "pending-assistant", role: "assistant", text: "", status: "streaming" };
}

test("每个线程拥有独立的流条目与控制器", () => {
  const streams = createChatStreamRegistry();
  const a = thread("chat-a");
  const b = thread("chat-b");
  const ca = new AbortController();
  const cb = new AbortController();
  const ea = streams.begin(a, { controller: ca, assistant: assistant() });
  const eb = streams.begin(b, { controller: cb, assistant: assistant() });

  assert.notEqual(ea, eb);
  assert.equal(streams.get(a), ea);
  assert.equal(streams.get(b), eb);
  assert.equal(streams.getByThreadId("chat-b"), eb);
  ca.abort();
  assert.equal(ca.signal.aborted, true);
  assert.equal(cb.signal.aborted, false, "停止 A 不能触发 B 的控制器");
});

test("同一线程的新一轮流会推进世代号，旧回读可据此失效", () => {
  const streams = createChatStreamRegistry();
  const a = thread("chat-a");
  const first = streams.begin(a, { controller: new AbortController(), assistant: assistant() });
  assert.equal(first.generation, 1);
  assert.equal(streams.generationFor(a), 1);
  streams.end(first);
  const second = streams.begin(a, { controller: new AbortController(), assistant: assistant() });
  assert.equal(second.generation, 2);
  assert.equal(streams.generationFor(a), 2);
  assert.equal(first.generation, 1, "旧条目保留自己的世代号");
});

test("没有正式 thread id 的本地线程也有稳定 key，收到 id 后仍能按 id 找回", () => {
  const streams = createChatStreamRegistry();
  const a = thread(null);
  const entry = streams.begin(a, { controller: new AbortController(), assistant: assistant() });
  const key = entry.key;
  assert.match(key, /^local:/);
  applyChatEvent(a, entry.assistant, { type: "start", thread_id: "chat-real", thread_title: "正式标题" });
  assert.equal(a.id, "chat-real");
  assert.equal(streams.keyFor(a), key, "本地 key 不随 id 迁移而丢失");
  assert.equal(streams.getByThreadId("chat-real"), entry);
});

test("A 的 delta/done 只写入 A，不影响 B", () => {
  const a = thread("chat-a");
  const b = thread("chat-b");
  const aa = assistant();
  const ba = assistant();
  a.messages.push(aa);
  b.messages.push(ba);

  applyChatEvent(a, aa, { type: "delta", text: "A1" });
  applyChatEvent(a, aa, { type: "delta", text: "A2" });
  applyChatEvent(a, aa, { type: "done", message: { id: "m-a", text: "A final" } });

  assert.equal(aa.text, "A final");
  assert.equal(aa.status, "ok");
  assert.equal(ba.text, "", "B 不接收 A 的增量");
  assert.equal(ba.status, "streaming");
  assert.equal(b.messages.length, 1);
});

test("stop 事件只把对应线程标记为 cancelled 并保留部分文本", () => {
  const a = thread("chat-a");
  const aa = assistant();
  applyChatEvent(a, aa, { type: "delta", text: "部分回答" });
  applyChatEvent(a, aa, { type: "stopped" });
  assert.equal(aa.status, "cancelled");
  assert.equal(aa.text, "部分回答");
});

test("start 事件把 pending 用户消息替换为服务端事实", () => {
  const a = thread(null);
  const aa = assistant();
  a.messages.push(
    { id: "pending-user-1", role: "user", text: "旧文本", status: "ok" },
    aa,
  );
  const outcome = applyChatEvent(a, aa, {
    type: "start",
    thread_id: "chat-1",
    thread_title: "标题",
    assistant_id: "m-1",
    user: { id: "u-1", text: "服务端文本" },
  });
  assert.equal(a.id, "chat-1");
  assert.equal(a.title, "标题");
  assert.equal(a.messages[0].id, "u-1");
  assert.equal(a.messages[0].text, "服务端文本");
  assert.equal(aa.id, "m-1");
  assert.equal(outcome.render, true);
  assert.equal(outcome.head, true);
});