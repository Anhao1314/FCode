import test from "node:test";
import assert from "node:assert/strict";
import { chatMessageHtml } from "../core/chat-view.js";

test("user text and attachment names are escaped", () => {
  const html = chatMessageHtml({
    id: 'm"1',
    role: "user",
    text: "<script>alert(1)</script>",
    attachments: [{ name: "<a>.md" }],
  });
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;a&gt;.md"));
  assert.ok(html.includes('data-msg-id="m&quot;1"'));
});

test("editing a user message swaps in the textarea", () => {
  const html = chatMessageHtml(
    { id: "m1", role: "user", text: "旧消息" },
    "m1",
  );
  assert.ok(html.includes("chat-edit-input"));
  assert.ok(html.includes("保存并重新生成"));
  assert.ok(html.includes("旧消息"));
});

test("assistant text is rendered as markdown with usage", () => {
  const html = chatMessageHtml({
    id: "a1",
    role: "assistant",
    text: "**粗体** 和 `code`",
    status: "ok",
    usage: { total_tokens: 363, cost_microusd: 0 },
    receipt_ref: "ref",
  });
  assert.ok(html.includes("<strong>粗体</strong>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes("363 tokens"));
  assert.ok(html.includes("已签收据"));
  assert.ok(html.includes("重新生成"));
});

test("an error is escaped and cannot be regenerated", () => {
  const html = chatMessageHtml({
    id: "e1",
    role: "assistant",
    text: "",
    status: "error",
    error: { code: "CHAT_STREAM_FAILED", message: "<boom>" },
  });
  assert.ok(html.includes("CHAT_STREAM_FAILED"));
  assert.ok(html.includes("&lt;boom&gt;"));
  assert.ok(!html.includes("data-chat-regen"));
});

test("a cancelled answer keeps the partial text and can be regenerated", () => {
  const html = chatMessageHtml({
    id: "c1",
    role: "assistant",
    text: "半句",
    status: "cancelled",
  });
  assert.ok(html.includes("已停止生成"));
  assert.ok(html.includes("半句"));
  assert.ok(html.includes("data-chat-regen"));
  assert.ok(html.includes("data-chat-copy"));
});

test("a streaming answer shows typing and the rate-limit wait", () => {
  const html = chatMessageHtml({
    id: "s1",
    role: "assistant",
    text: "",
    status: "streaming",
    waiting: 7,
  });
  assert.ok(html.includes("chat-typing"));
  assert.equal((html.match(/<i><\/i>/g) || []).length, 5);
  assert.ok(html.includes('data-streaming="1"'));
  assert.ok(html.includes("等待 7 秒"));
  assert.ok(!html.includes("data-chat-regen"));
});

test("extraHtml rides inside the answer, above the actions", () => {
  const html = chatMessageHtml(
    { id: "a1", role: "assistant", text: "回答", status: "ok" },
    null,
    '<div class="run-card" data-run-card="a1"></div>',
  );
  assert.ok(html.includes('data-run-card="a1"'));
  assert.ok(html.indexOf("run-card") < html.indexOf("chat-msg-actions"));
  // A user message has no card slot: it is the model that proposes work.
  const user = chatMessageHtml({ id: "u1", role: "user", text: "问" }, null, "<div></div>");
  assert.ok(!user.includes("<div></div>"));
});

test("助手消息带 AI 头像，用户消息不带（形象只属于回答）", () => {
  const assistant = chatMessageHtml({ id: "a1", role: "assistant", text: "你好", status: "ok" });
  assert.match(assistant, /class="chat-msg-row"/);
  assert.match(assistant, /class="ai-avatar ai-avatar--idle/);
  assert.match(assistant, /role="img" aria-label="FCode"/);

  const user = chatMessageHtml({ id: "u1", role: "user", text: "你好" });
  assert.equal(user.includes("ai-avatar"), false);
});

test("生成中的回答换成落印章并带呼吸环；失败换叉眼", () => {
  const streaming = chatMessageHtml({ id: "a2", role: "assistant", text: "…", status: "streaming" });
  assert.match(streaming, /ai-avatar--thinking/);
  assert.match(streaming, /ai-avatar-ring/);

  const failed = chatMessageHtml({ id: "a3", role: "assistant", text: "", status: "error" });
  assert.match(failed, /ai-avatar--bad/);
  assert.match(failed, /aria-label="FCode · 调用失败"/);
});
