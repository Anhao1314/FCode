"use strict";

/* 对话线程、消息流与模式切换。运行镜像和 Provider 设置分别在独立模块。 */
export function createChatUI(deps) {
  const d = deps;
  const { chat, chatModelChoice } = d;

  async function loadChatThreads(reset = true) {
    const health = d.getHealth();
    if (!health || !health.live) return;
    const threads = d.getChatThreads();
    const offset = reset ? 0 : threads.length;
    try {
      const data = await fetch(`/api/chat/threads?limit=${chat.limit}&offset=${offset}`, { cache: "no-store" }).then(r => r.ok ? r.json() : null);
      const list = data && Array.isArray(data.threads) ? data.threads : [];
      if (data && Number.isFinite(Number(data.total))) chat.total = Number(data.total);
      const next = reset ? list : threads.concat(list.filter(thread => !threads.some(item => item.id === thread.id)));
      d.setChatThreads(next);
      chat.threads = next;
      renderChats();
    } catch { /* 侧栏列表失败不阻塞对话 */ }
  }

  function renderChats() {
    const nav = document.getElementById("chat-nav");
    if (!nav) return;
    const threads = d.getChatThreads();
    const head = document.getElementById("chat-chats");
    if (head) head.innerHTML = d.chatSectionHtml(threads.length);
    const list = threads.filter(thread => !d.isChatPinned(thread.id));
    nav.innerHTML = d.chatRowsHtml(list, {
      activeId: chat.current ? chat.current.id : null,
      total: chat.total,
      pinnedOf: d.isChatPinned,
    });
  }

  function handleChatDelete(threadId, el) {
    if (chat.deleteArmed !== threadId) {
      chat.deleteArmed = threadId;
      el.textContent = "确认";
      el.classList.add("armed");
      clearTimeout(chat.deleteTimer);
      chat.deleteTimer = setTimeout(() => {
        chat.deleteArmed = null;
        chat.deleteTimer = null;
        renderChats();
      }, 3000);
      return;
    }
    chat.deleteArmed = null;
    clearTimeout(chat.deleteTimer);
    (async () => {
      try {
        const response = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        const next = d.getChatThreads().filter(thread => thread.id !== threadId);
        d.setChatThreads(next);
        chat.threads = next;
        chat.total = Math.max(0, chat.total - 1);
        if (chat.current && chat.current.id === threadId) newChat();
        renderChats();
        d.toast("对话已从列表移除（事件链保留）");
      } catch (error) { d.toast("删除失败：" + error.message); }
    })();
  }

  function leaveChat() {
    if (chat.abort) { try { chat.abort.abort(); } catch { /* settled */ } }
    if (chat.paintTimer) { clearTimeout(chat.paintTimer); chat.paintTimer = null; }
    const wasActive = chat.active, wasStreaming = chat.streaming;
    chat.active = false;
    chat.streaming = false;
    chat.abort = null;
    chat.editing = null;
    chat.current = null;
    chat.attachments = [];
    renderChatAttachChips();
    document.getElementById("app")?.classList.remove("chat-mode");
    paintChatChrome(false);
    if (wasActive || wasStreaming) restoreSendButton();
  }

  function paintChatChrome(on) {
    const show = (id, visible) => {
      const el = document.getElementById(id);
      if (el) el.style.display = visible ? "" : "none";
    };
    show("chain-badge", !on);
    show("rail-toggle", !on);
    show("approval-btn", !on);
    show("composer-open", !on);
    const attach = document.getElementById("chat-attach");
    if (attach) { attach.hidden = !on; attach.style.display = on ? "" : "none"; }
    const runChip = document.getElementById("run-chip");
    if (runChip && on) runChip.hidden = true;
    if (on) {
      const panel = document.getElementById("attach-panel");
      if (panel) panel.hidden = true;
      const open = document.getElementById("composer-open");
      if (open) open.setAttribute("aria-expanded", "false");
      document.getElementById("composer-box")?.classList.remove("open-attach");
    }
  }

  function renderChatHead() {
    const title = chat.current && chat.current.title ? chat.current.title : "新对话";
    document.getElementById("tb-title").textContent = title;
    document.getElementById("tb-chips").innerHTML = `<span class="chip">对话</span>`;
  }

  function detachChatChrome() {
    if (chat.abort) { try { chat.abort.abort(); } catch { /* settled */ } }
    if (chat.paintTimer) { clearTimeout(chat.paintTimer); chat.paintTimer = null; }
    chat.active = false;
    chat.streaming = false;
    chat.abort = null;
    chat.editing = null;
    chat.attachments = [];
    renderChatAttachChips();
    document.getElementById("app")?.classList.remove("chat-mode");
    paintChatChrome(false);
    restoreSendButton();
  }

  function openWorkHome() {
    detachChatChrome();
    if (d.intake.active) d.closeIntake(false);
    if (d.getSettingsOpen()) d.closeSettingsPage(false);
    d.setLedgerOpen(false);
    if (d.activeSession()) d.detachLive();
    d.setChromeState({ rail: false });
    d.store.key = null;
    d.store.trace = null;
    chat.active = false;
    chat.streaming = false;
    chat.editing = null;
    d.renderNav();
    d.renderMain(d.stageEmptyHtml(d.WORK_STAGE_NOTE, { work: true }), { mode: "empty" });
    paintChatChrome(false);
    document.getElementById("tb-title").textContent = "FCode";
    document.getElementById("tb-chips").innerHTML = "";
    const ta = document.getElementById("composer-ta");
    if (ta) { ta.value = ""; d.autosize(ta); ta.placeholder = d.WORK_PLACEHOLDER; ta.focus(); }
    renderChatAttachChips();
    paintSendState();
  }

  function switchToChat() {
    if (chat.current && (chat.current.messages || []).length) {
      chat.active = true;
      chat.streaming = false;
      chat.editing = null;
      d.renderNav();
      renderChat({ forceBottom: true });
      paintChatChrome(true);
      const ta = document.getElementById("composer-ta");
      if (ta) { ta.value = ""; d.autosize(ta); ta.placeholder = "给 FCode 发消息…"; }
      paintSendState();
    } else newChat();
  }

  function setUiMode(mode) {
    if (d.getUiMode() !== mode) {
      d.setUiModeValue(mode);
      try { localStorage.setItem("fa.uiMode", mode); } catch { /* quota */ }
    }
    d.setSidebarMode(mode);
    const app = document.getElementById("app");
    app.classList.toggle("mode-chat", mode === "chat");
    app.classList.toggle("mode-work", mode === "work");
    const chatTab = document.getElementById("mode-chat"), workTab = document.getElementById("mode-work");
    if (chatTab) {
      chatTab.classList.toggle("active", mode === "chat");
      chatTab.setAttribute("aria-selected", mode === "chat" ? "true" : "false");
    }
    if (workTab) {
      workTab.classList.toggle("active", mode === "work");
      workTab.setAttribute("aria-selected", mode === "work" ? "true" : "false");
    }
    const paneChat = document.getElementById("pane-chat"), paneWork = document.getElementById("pane-work");
    if (paneChat) paneChat.hidden = mode !== "chat";
    if (paneWork) paneWork.hidden = mode !== "work";
    const chrome = d.modeChrome(mode);
    const newLabel = document.getElementById("new-label");
    if (newLabel) newLabel.textContent = chrome.newLabel;
    const flavor = document.getElementById("side-flavor");
    if (flavor) { flavor.textContent = chrome.flavor; flavor.hidden = !chrome.flavor; }
    const newBtn = document.getElementById("new-run");
    if (newBtn) newBtn.title = chrome.newTitle;
    d.renderNav();
    d.paintSections();
    if (mode === "chat") {
      if (chat.active && document.getElementById("main")?.dataset.view === "empty") return;
      if (chat.current && (chat.current.messages || []).length) switchToChat();
      else if (!chat.active) newChat();
    } else {
      const view = document.getElementById("main")?.dataset.view;
      if (view === "empty" && !chat.active) {
        d.renderMain(d.stageEmptyHtml(d.WORK_STAGE_NOTE, { work: true }), { mode: "empty" });
        const ta = document.getElementById("composer-ta");
        if (ta) ta.placeholder = d.WORK_PLACEHOLDER;
        return;
      }
      if (d.activeSession()) d.selectRun(d.activeSession().id); else openWorkHome();
    }
  }

  function resetForChat() {
    if (d.intake.active) d.closeIntake(false);
    if (d.getSettingsOpen()) d.closeSettingsPage(false);
    d.setLedgerOpen(false);
    if (d.activeSession()) d.detachLive();
    d.setChromeState({ rail: false });
    d.store.key = null;
    d.store.trace = null;
    chat.active = true;
    chat.current = null;
    chat.streaming = false;
    chat.editing = null;
    chat.attachments = [];
    d.renderNav();
  }

  function newChat() {
    leaveChat();
    resetForChat();
    d.renderMain(d.stageEmptyHtml("向 FCode 提问，或让 FCode 帮你整理思路", { chat: true }), { mode: "empty" });
    paintChatChrome(true);
    document.getElementById("tb-title").textContent = "FCode";
    document.getElementById("tb-chips").innerHTML = "";
    const ta = document.getElementById("composer-ta");
    if (ta) { ta.value = ""; d.autosize(ta); ta.placeholder = "给 FCode 发消息…"; ta.focus(); }
    renderChatAttachChips();
    paintSendState();
    d.adoptDefaultChatModel(d.getChatConfig() && d.getChatConfig().default_model);
    d.loadChatModels();
  }

  async function openChat(threadId) {
    leaveChat();
    resetForChat();
    d.renderMain(`<div class="empty">加载对话…</div>`, { mode: "loading" });
    try {
      const response = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      chat.current = await response.json();
      await d.prepareCardRuns(chat.current);
    } catch (error) {
      d.toast("对话加载失败：" + error.message);
      newChat();
      return;
    }
    paintChatChrome(true);
    renderChatHead();
    renderChat({ forceBottom: true });
    d.renderNav();
    const ta = document.getElementById("composer-ta");
    if (ta) { ta.value = ""; d.autosize(ta); ta.placeholder = "给 FCode 发消息…"; ta.focus(); }
    paintSendState();
  }

  function renderChat({ forceBottom = false } = {}) {
    const thread = chat.current;
    if (!thread || !(thread.messages || []).length) {
      d.renderMain(`<div class="chat-empty">${d.aiAvatarHtml("idle", 64)}<div class="chat-empty-mark">FCode</div><p>开始一段对话。对话只回答，不执行工具；需要读写文件或运行命令时，用「委托运行」。</p></div>`, { mode: "chat" });
      return;
    }
    const stick = forceBottom || d.nearMainBottom();
    d.renderMain(`<div class="chat-thread" aria-live="polite">${thread.messages.map(message => d.chatMessageHtml(d.withRunStatus(message), chat.editing, d.chatCardHtml(message))).join("")}</div>`, { mode: "chat" });
    if (stick) requestAnimationFrame(d.scrollMainBottom);
  }

  function renderChatAttachChips() {
    const slot = document.getElementById("chat-attach-chips");
    if (!slot) return;
    slot.hidden = !chat.attachments.length;
    slot.innerHTML = chat.attachments.map((file, index) => `<span class="chat-file">${d.esc(file.name)}<button class="chat-file-x" type="button" data-chat-attach-remove="${index}" title="移除">×</button></span>`).join("");
  }

  async function handleChatFiles(event) {
    const files = [...(event.target.files || [])];
    for (const file of files) {
      if (chat.attachments.length >= 3) { d.toast("最多 3 个附件"); break; }
      if (file.size > 64 * 1024) { d.toast(`${file.name} 超过 64 KiB`); continue; }
      let text;
      try { text = await file.text(); } catch { d.toast(`${file.name} 读取失败`); continue; }
      if (text.includes("\u0000")) { d.toast(`${file.name} 不是纯文本文件`); continue; }
      chat.attachments.push({ name: file.name, text });
    }
    event.target.value = "";
    renderChatAttachChips();
    paintSendState();
  }

  function paintSendState() {
    const btn = document.getElementById("send");
    if (!btn || !chat.active) return;
    if (chat.streaming) {
      btn.disabled = false;
      btn.classList.add("stop");
      btn.title = "停止生成";
      btn.innerHTML = `<span class="stop-glyph"></span>`;
      return;
    }
    btn.classList.remove("stop");
    btn.title = "发送消息";
    btn.innerHTML = `<span data-doodle="arrow-up"></span>`;
    d.hydrateDoodles(btn);
    const ta = document.getElementById("composer-ta");
    const hasText = !!(ta && ta.value.trim());
    const health = d.getHealth();
    btn.disabled = !(health && health.live) || (!hasText && !chat.attachments.length);
  }

  function restoreSendButton() {
    const btn = document.getElementById("send");
    if (!btn) return;
    btn.classList.remove("stop");
    btn.title = "发送任务";
    btn.innerHTML = `<span data-doodle="arrow-up"></span>`;
    d.hydrateDoodles(btn);
    const health = d.getHealth();
    btn.disabled = !(health && health.live);
  }

  function setChatStreaming(on) {
    chat.streaming = on;
    if (on) {
      const chip = document.getElementById("run-chip");
      if (chip) chip.hidden = true;
    }
    paintSendState();
  }

  function stopChat() {
    if (!chat.streaming || !chat.abort) return;
    try { chat.abort.abort(); } catch { /* settled */ }
  }

  function scheduleChatPaint(assistant) {
    chat.paintAssistant = assistant;
    if (chat.paintTimer) return;
    chat.paintTimer = setTimeout(() => {
      chat.paintTimer = null;
      paintStreamingAssistant(chat.paintAssistant);
    }, 70);
  }

  function paintStreamingAssistant(assistant) {
    if (!assistant || !chat.current) return;
    const node = document.querySelector(`.chat-msg[data-msg-id="${String(assistant.id)}"]`);
    if (!node) { renderChat(); return; }
    const stick = d.nearMainBottom();
    const body = node.querySelector(".chat-md");
    if (body) body.innerHTML = d.renderMarkdown(assistant.text);
    const typing = node.querySelector(".chat-typing");
    if (typing && assistant.text) typing.remove();
    let wait = node.querySelector(".chat-wait");
    if (assistant.waiting) {
      if (!wait) {
        wait = document.createElement("div");
        wait.className = "chat-wait";
        const actions = node.querySelector(".chat-msg-actions");
        node.insertBefore(wait, actions || null);
      }
      wait.textContent = `等待 ${assistant.waiting} 秒额度窗口…`;
    } else if (wait) wait.remove();
    if (stick) d.scrollMainBottom();
  }

  function pushOptimisticAnswer() {
    chat.current.messages.push({ id: "pending-assistant", role: "assistant", text: "", reasoning: "", status: "streaming", usage: {}, error: {} });
  }

  async function sendChatFromComposer() {
    if (chat.streaming) return;
    const health = d.getHealth();
    if (!health || !health.live) { d.toast("回放模式：启动 server.py 后才能对话"); return; }
    const ta = document.getElementById("composer-ta");
    const text = (ta.value || "").trim();
    const attachments = chat.attachments.map(file => ({ name: file.name, text: file.text }));
    if (!text && !attachments.length) return;
    ta.value = "";
    d.autosize(ta);
    chat.attachments = [];
    renderChatAttachChips();
    const threadId = chat.current && chat.current.id ? chat.current.id : null;
    const model = chatModelChoice.key || "mock";
    if (!chat.current) chat.current = { id: null, title: (text || attachments[0].name || "新对话").slice(0, 30), messages: [] };
    if (!chat.current.messages) chat.current.messages = [];
    chat.current.messages.push({ id: "pending-user-" + Date.now(), role: "user", text, attachments: attachments.map(file => ({ name: file.name, bytes: file.text.length })), status: "ok" });
    pushOptimisticAnswer();
    renderChatHead();
    renderChat({ forceBottom: true });
    setChatStreaming(true);
    await streamChat("/api/chat/send", { threadId, text, attachments, model });
  }

  async function streamChat(url, payload) {
    const threadRef = chat.current;
    const assistant = threadRef && threadRef.messages ? threadRef.messages[threadRef.messages.length - 1] : null;
    if (!assistant || assistant.role !== "assistant") { setChatStreaming(false); return; }
    const controller = new AbortController();
    chat.abort = controller;
    let aborted = false;
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("浏览器没有拿到流式响应");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = d.parseSseFrame(frame);
          if (event && chat.current === threadRef) handleChatEvent(event, assistant, threadRef);
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        aborted = true;
        assistant.status = "cancelled";
        if (!assistant.text) assistant.text = "";
      } else {
        assistant.status = "error";
        assistant.error = { code: "CHAT_FAILED", message: error.message };
        d.toast("对话失败：" + error.message);
      }
    } finally {
      const belongs = chat.active && chat.current === threadRef;
      if (belongs) {
        if (chat.paintTimer) { clearTimeout(chat.paintTimer); chat.paintTimer = null; }
        setChatStreaming(false);
        if (chat.abort === controller) chat.abort = null;
        if (assistant.status === "streaming") {
          assistant.status = "error";
          assistant.error = { code: "CHAT_STREAM_ENDED", message: "连接在回答完成前结束" };
        }
        if (aborted) await new Promise(resolve => setTimeout(resolve, 250));
        if (threadRef.id) {
          try {
            const response = await fetch(`/api/chat/threads/${encodeURIComponent(threadRef.id)}`, { cache: "no-store" });
            if (response.ok) {
              const thread = await response.json();
              if (thread && Array.isArray(thread.messages) && chat.current === threadRef) chat.current = thread;
            }
          } catch { /* 保留乐观视图 */ }
        }
        renderChat();
        renderChatHead();
      } else if (chat.abort === controller) chat.abort = null;
      await loadChatThreads();
    }
  }

  function handleChatEvent(event, assistant, threadRef) {
    if (!threadRef || chat.current !== threadRef) return;
    switch (event.type) {
      case "start":
        if (event.thread_id) {
          threadRef.id = event.thread_id;
          if (event.thread_title) threadRef.title = event.thread_title;
          if (event.user) {
            const pending = [...threadRef.messages].reverse().find(message => message.role === "user" && String(message.id).startsWith("pending-user-"));
            if (pending) Object.assign(pending, event.user);
          }
          if (event.assistant_id) assistant.id = event.assistant_id;
          renderChatHead();
          renderChat();
        }
        break;
      case "wait": assistant.waiting = Number(event.seconds) || 0; scheduleChatPaint(assistant); break;
      case "reasoning": assistant.reasoning = (assistant.reasoning || "") + String(event.text || ""); scheduleChatPaint(assistant); break;
      case "delta": assistant.text = (assistant.text || "") + String(event.text || ""); scheduleChatPaint(assistant); break;
      case "done":
        if (event.message) {
          assistant.id = event.message.id || assistant.id;
          assistant.text = event.message.text || assistant.text;
          assistant.reasoning = event.message.reasoning || assistant.reasoning;
          assistant.usage = event.message.usage || {};
          assistant.receipt_ref = event.message.receipt_ref || "";
          assistant.status = "ok";
        }
        assistant.waiting = 0;
        renderChat();
        break;
      case "error":
        if (event.thread_id && !threadRef.id) threadRef.id = event.thread_id;
        assistant.status = "error";
        assistant.error = { code: event.code || "CHAT_FAILED", message: event.message || "对话失败" };
        if (event.partial) assistant.text = event.partial;
        renderChat();
        break;
      case "stopped": assistant.status = "cancelled"; renderChat(); break;
      default: break;
    }
  }

  function beginChatEdit(messageId) {
    chat.editing = messageId;
    renderChat();
    requestAnimationFrame(() => document.getElementById("chat-edit-input")?.focus());
  }

  function cancelChatEdit() { chat.editing = null; renderChat(); }

  function saveChatEdit(messageId) {
    if (!chat.current || !chat.current.id) return;
    const input = document.getElementById("chat-edit-input");
    const text = (input && input.value || "").trim();
    if (!text) { d.toast("消息不能为空"); return; }
    const index = chat.current.messages.findIndex(message => message.id === messageId);
    if (index < 0) return;
    chat.editing = null;
    chat.current.messages = chat.current.messages.slice(0, index);
    chat.current.messages.push({ id: "pending-user-" + Date.now(), role: "user", text, attachments: [], status: "ok" });
    pushOptimisticAnswer();
    renderChat({ forceBottom: true });
    setChatStreaming(true);
    streamChat(`/api/chat/threads/${encodeURIComponent(chat.current.id)}/edit`, { messageId, text, model: chatModelChoice.key || "mock" });
  }

  function regenerateChat(messageId) {
    if (!chat.current || !chat.current.id) return;
    const index = chat.current.messages.findIndex(message => message.id === messageId);
    if (index < 0) return;
    chat.current.messages = chat.current.messages.slice(0, index);
    pushOptimisticAnswer();
    renderChat({ forceBottom: true });
    setChatStreaming(true);
    streamChat(`/api/chat/threads/${encodeURIComponent(chat.current.id)}/regenerate`, { messageId, model: chatModelChoice.key || "mock" });
  }

  function copyChatMessage(messageId) {
    if (!chat.current) return;
    const message = chat.current.messages.find(item => item.id === messageId);
    if (!message) return;
    d.copyText(message.text).then(ok => d.toast(ok ? "已复制回答" : "复制失败"));
  }

  function delegateChatMessage(messageId) {
    if (!chat.current) return;
    const message = chat.current.messages.find(item => item.id === messageId);
    if (!message || message.role !== "user") return;
    d.startIntake(message.text, { origin: d.threadOrigin(chat.current) });
  }

  return {
    loadChatThreads, renderChats, handleChatDelete, leaveChat, paintChatChrome, renderChatHead,
    detachChatChrome, openWorkHome, switchToChat, setUiMode, newChat, openChat, renderChat,
    renderChatAttachChips, handleChatFiles, paintSendState, restoreSendButton, setChatStreaming,
    stopChat, sendChatFromComposer, streamChat, beginChatEdit, cancelChatEdit, saveChatEdit,
    regenerateChat, copyChatMessage, delegateChatMessage,
  };
}
