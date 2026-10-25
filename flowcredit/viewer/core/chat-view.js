/* Chat message rendering: pure functions over one message projection.
 *
 * State (which message is being edited) is passed in, so the renderer can be
 * tested with the Node runner and cannot read a global by accident.
 */

import { esc, num } from "./format.js";
import { renderMarkdown } from "./chat-format.js";

export function chatMessageHtml(message, editingId = null) {
  const id = esc(message.id);
  const streaming = message.status === "streaming";
  if (message.role === "user") {
    if (editingId === message.id) {
      return `<div class="chat-msg user editing" data-msg-id="${id}">
        <div class="chat-edit-box">
          <textarea id="chat-edit-input" class="chat-edit-input">${esc(message.text)}</textarea>
          <div class="chat-msg-actions always">
            <button class="chat-act" type="button" data-chat-cancel>取消</button>
            <button class="chat-act strong" type="button" data-chat-save="${id}">保存并重新生成</button>
          </div>
        </div>
      </div>`;
    }
    const files = (message.attachments || [])
      .map(file => `<span class="chat-file">${esc(file.name || "")}</span>`).join("");
    return `<div class="chat-msg user" data-msg-id="${id}">
      <div class="chat-bubble">${esc(message.text)}${files ? `<div class="chat-files">${files}</div>` : ""}</div>
      <div class="chat-msg-actions">
        <button class="chat-act" type="button" data-chat-edit="${id}">编辑</button>
        <button class="chat-act" type="button" data-chat-delegate="${id}">转为委托</button>
      </div>
    </div>`;
  }
  const actions = [];
  if (!streaming) {
    actions.push(`<button class="chat-act" type="button" data-chat-copy="${id}">复制</button>`);
    if (message.status !== "error") {
      actions.push(`<button class="chat-act" type="button" data-chat-regen="${id}">重新生成</button>`);
    }
  }
  const reasoning = message.reasoning
    ? `<details class="chat-reasoning"><summary>思考过程</summary><pre>${esc(message.reasoning)}</pre></details>`
    : "";
  const error = message.error && message.error.message
    ? `<div class="chat-error">${esc(message.error.code || "CHAT_FAILED")} · ${esc(message.error.message)}</div>`
    : "";
  const wait = streaming && message.waiting
    ? `<div class="chat-wait">等待 ${esc(message.waiting)} 秒额度窗口…</div>`
    : "";
  const typing = streaming && !message.text
    ? `<span class="chat-typing" aria-label="正在生成"><i></i><i></i><i></i></span>`
    : "";
  const usage = message.usage && message.usage.total_tokens
    ? `<div class="chat-meta">${num(message.usage.total_tokens)} tokens · ${num(message.usage.cost_microusd)} µUSD${message.receipt_ref ? " · 已签收据" : ""}</div>`
    : "";
  const stopped = message.status === "cancelled" ? `<div class="chat-meta">已停止生成</div>` : "";
  return `<div class="chat-msg assistant${streaming ? " streaming" : ""}${message.status === "cancelled" ? " cancelled" : ""}" data-msg-id="${id}"${streaming ? ' data-streaming="1"' : ""}>
    <div class="chat-md">${renderMarkdown(message.text)}</div>
    ${wait}${typing}${reasoning}${error}${usage}${stopped}
    <div class="chat-msg-actions">${actions.join("")}</div>
  </div>`;
}
