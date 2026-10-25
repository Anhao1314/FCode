"use strict";

import {
  canonical, sha256Hex, verifyChain, esc, pct, pp, num, shortHash, stripTags,
} from "./core/format.js";
import { parseSseFrame, renderMarkdown } from "./core/chat-format.js";
import { chatMessageHtml } from "./core/chat-view.js";
import { actionCardHtml, mirrorFrom, runMirrorHtml } from "./core/run-card.js";
import { foldRuns, foldSummary, isQuietRound } from "./core/round-fold.js";

/* =================================================================== 边界声明
   本轮结构重构只允许改“生成 DOM 的渲染函数”。
   - 不可改：core/format.js 的链验证；store/sessions 状态机；SSE apply/attach；
     预算比较与提交；审批/插话/报告/设置等 API 调用；data-* 事件契约。
   - 可改：下面标成 RENDER LAYER 的模板函数，以及混合函数里的模板字符串。
   - 混合函数（render/liveApply/syncLiveRounds 等）只允许更换模板与插槽
     包装，不允许改比较时机、缓存字段或调用顺序。
   ------------------------------------------------------------------- data */

const SCENARIOS = [
  ["full",          "完整研究"],
  ["tool-denied",   "越权工具"],
  ["budget",        "预算耗尽"],
  ["budget-resume", "预算追加"],
  ["crash",         "崩溃恢复"],
  ["unknown",       "未知对账"],
  ["open-ended",    "开放问题"],
];
/* SCENARIOS 现在只作 label 字典：把运行记录的 template key 翻译成中文标题。
   内置示例场景入口已随打包 mock traces 一并移除；数据可由 demo.py 生成到
   work/demo/ 后经 ?trace= 加载，或由 server.py 的真实运行产生。 */

const EVENT_DOT = {
  task_created: "", model_started: "info", model_unknown: "warn", model_reconciled: "ok",
  plan_validated: "", plan_updated: "", execution_started: "", tool_started: "info",
  tool_denied: "bad", tool_succeeded: "ok", verification_started: "info",
  task_succeeded: "ok", task_failed: "bad", task_stopped: "warn",
  approval_requested: "warn", approval_granted: "ok", approval_denied: "bad", approval_aborted: "warn",
  plan_steered: "info", budget_adjusted: "info", control_rejected: "bad", task_resumed: "info",
  operator_message: "you", memory_recalled: "info",
  policy_requested: "info", policy_decided: "info", auto_action: "ok",
  review_decided: "you",
};

/* 人的决定：审批、计划修订、预算调整、续跑、运行中消息、判断记录 */
const HUMAN_EVENTS = new Set([
  "approval_requested", "approval_granted", "approval_denied", "approval_aborted",
  "plan_steered", "budget_adjusted", "control_rejected", "task_resumed", "operator_message",
  "review_decided",
]);

const APPROVAL_MODES = [
  ["consequential", "关键审批", "只在会改变结论或宣告受阻的动作前暂停"],
  ["all", "逐步审批", "每次工具调用都等你确认"],
  ["off", "自动", "不暂停；权限门控与预算仍然生效"],
];


const ICON = {
  folder:  '<svg class="i" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  branch:  '<svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="9" r="2.4"/><path d="M6 8.4v7.2M6 12h6a4 4 0 0 0 4-4v-.6"/></svg>',
  key:     '<svg class="i" viewBox="0 0 24 24"><circle cx="8" cy="14" r="3.4"/><path d="m10.5 11.5 8-8M15 7l2.5 2.5M12.5 9.5 15 12"/></svg>',
  file:    '<svg class="i" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  term:    '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
  alert:   '<svg class="i" viewBox="0 0 24 24"><path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4M12 17h.01"/></svg>',
  check:   '<svg class="i" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  x:       '<svg class="i" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  circle:  '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/></svg>',
  lock:    '<svg class="i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  thought: '<svg class="i" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
  inkTick: '<svg class="i ink-tick" viewBox="0 0 24 24"><path d="M4.5 12.8c2.2 1.4 4 3.1 5.6 5.1 2.9-4.4 6-7.6 9.4-9.8" /></svg>',
};

/* 失败原因的用户语言；代码仍保留在结果卡下方，方便审计 */
const FAILURE_REASONS = {
  BUDGET_EXCEEDED: "预算已耗尽",
  ROUND_LIMIT: "达到轮次上限",
  OPERATOR_DENIED: "操作员拒绝了关键工具调用",
  PLAN_BLOCKED: "计划被阻塞",
  PLAN_EXHAUSTED: "计划已没有可执行步骤",
  INSUFFICIENT_EVIDENCE: "证据不足，Runtime 拒绝给出未经证明的数字",
  STOPPED_BY_OPERATOR: "操作员停止了运行",
};

/* 判断记录：决定写进签名链，标签同时用于结果面与事件摘要。 */
const REVIEW_DECISIONS = [
  { key: "accept", label: "接受判断", requiresReason: false, hint: "理由可选", placeholder: "可补充接受依据（可选）" },
  { key: "needs_evidence", label: "需要补材料", requiresReason: true, hint: "写明缺什么", placeholder: "缺哪份材料、哪个口径，下一步由谁补" },
  { key: "qualified", label: "保留意见", requiresReason: true, hint: "写明保留措辞", placeholder: "保留意见的措辞与适用范围" },
  { key: "redo", label: "退回重做", requiresReason: true, hint: "写明退回原因", placeholder: "退回原因与需要重做的范围" },
];
const REVIEW_LABEL = Object.fromEntries(REVIEW_DECISIONS.map(item => [item.key, item.label]));
const REVIEW_DECISION = Object.fromEntries(REVIEW_DECISIONS.map(item => [item.key, item]));
/* 历史判断的计数行用短标签，避免在窄屏上折成两行 */
const REVIEW_COUNT_LABEL = {
  accept: "接受",
  needs_evidence: "补材料",
  qualified: "保留意见",
  redo: "退回",
};
const dot = cls => `<span class="ev-dot ${cls || ""}"></span>`;

/* 桌面壳桥：浏览器里返回 null，桌面端返回 pywebview 原生 API */
function desktopBridge() {
  return (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
}
window.addEventListener("pywebviewready", () => {
  window.__fcodeDesktop = true;
  document.body.classList.add("desktop");
});

/* ------------------------------------- MIXED — 统计计算（不改）+ 状态行渲染 */
/* Codex TUI 的底栏：当前模型、轮次、预算用量与快捷键，常驻不占正文。 */
function setStatusline(leftHtml, rightText) {
  const el = document.getElementById("statusline");
  if (!el) return;
  el.innerHTML = `<span class="sl-left">${leftHtml}</span><span class="sl-right">${esc(rightText || "")}</span>`;
}

function updateStatusline() {
  paintModelBadge();
  if (ledgerOpen) {
    const finished = runHistory.filter(r => r.status !== "running");
    const succeeded = finished.filter(r => r.status === "succeeded").length;
    const totalCost = finished.reduce((sum, r) => sum + ((r.cost && r.cost.costMicrousd) || 0), 0);
    const rate = finished.length ? Math.round((succeeded / finished.length) * 100) : 0;
    setStatusline(`<b>工作台</b><span class="sl-sep">·</span>委托 ${runHistory.length} 项`,
      `成功率 ${rate}% · 总成本 ${num(totalCost)} µUSD · ⌘N 新建`);
    return;
  }
  const trace = shownTrace();
  if (!trace) {
    setStatusline("<b>FCode</b>", "⌘K 命令 · ⌘N 新建对话 · ⌘. 停止 · ↑↓ 历史");
    return;
  }
  const budget = lastBudget(trace);
  const lim = (budget && budget.limits) || {};
  const model = trace.model || {};
  const rounds = (trace.rounds || []).length;
  const statusMap = { succeeded: "成功", failed: "失败", denied: "拒绝", stopped: "已停止" };
  const s = activeSession();
  const state = s ? (s.finished ? "已结束" : `第 ${rounds} 轮`)
    : (statusMap[(trace.terminal && trace.terminal.status) || ""] || (trace.terminal && trace.terminal.status) || "");
  const left = `<b>${esc(model.provider || "offline-mock")}</b> <span class="sl-sep">·</span> ${state ? esc(state) : "—"}`;
  const right = budget
    ? `calls ${budget.calls_used}/${lim.max_calls ?? "?"} · reads ${budget.reads_used}/${lim.max_reads ?? "?"} · ${num(budget.cost_used_microusd)} µUSD · tokens ${num(budget.tokens_used)}`
    : "⌘K 命令 · ⌘N 新建对话";
  setStatusline(left, right);
}

const cache = new Map();
/* LOGIC LAYER — 单一 UI 状态源：视图键、激活会话、静态 trace、链校验与主区模式；sessions 仍只是会话注册表。 */
const store = {
  key: null,        // 当前视图键
  sessionId: null,  // 当前激活会话 id
  trace: null,      // 非会话视图的 trace
  check: null,      // 当前链校验结果
  mode: "run",      // 最近一次主区模式
};

function activeSession() {
  return store.sessionId ? sessions.get(store.sessionId) || null : null;
}

function shownTrace() {
  const s = activeSession();
  return (s && s.trace) || store.trace;
}
let railTab = "events";
/* 证据面板是浮层，默认收起；打开动作只改变 CSS 状态，不影响任何运行数据。 */
let railOpen = false;
let railFilter = localStorage.getItem("fa.railFilter") || "key";
if (!["all", "human", "key"].includes(railFilter)) railFilter = "key";
const evExpanded = new Set();
let approvalMode = localStorage.getItem("fa.approval") || "consequential";
if (!APPROVAL_MODES.some(([key]) => key === approvalMode)) approvalMode = "consequential";
const MOTION_KEY = "fa.motion";
let motionOn = localStorage.getItem(MOTION_KEY) !== "0";

/* live console state */
const TPL_FALLBACK = { full: "完整研究", "tool-denied": "越权工具", budget: "预算耗尽", "budget-resume": "预算追加", crash: "崩溃恢复", unknown: "未知对账", "open-ended": "开放问题" };
let health = null;      // /api/health payload
let templates = [];     // /api/templates
let tplKey = "full";    // selected template
let chatThreads = [];   // /api/chat/threads（侧栏「对话」）
let chatModels = [];    // /api/chat/models（对话模式模型菜单）
let chatConfig = null;  // /api/settings/chat-config（脱敏后的配置）
let chatConfigSource = null; // 这份配置从哪来、是否比进程里的新（见 config_source）
const CHAT_MODEL_KEY = "fa.chatModel";
function loadChatModelChoice() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHAT_MODEL_KEY) || "{}");
    return {
      key: typeof parsed.key === "string" ? parsed.key : "mock",
      touched: parsed.touched === true,
    };
  } catch {
    return { key: "mock", touched: false };
  }
}
const chatModelChoice = loadChatModelChoice();
let chatModelTouched = chatModelChoice.touched === true;
function saveChatModelChoice(touched = chatModelTouched) {
  chatModelTouched = touched;
  try {
    localStorage.setItem(CHAT_MODEL_KEY, JSON.stringify({
      key: chatModelChoice.key,
      touched: chatModelTouched,
    }));
  } catch { /* quota */ }
}
const chat = {
  active: false,        // composer 当前属于一段对话，而不是委托/运行
  current: null,        // 打开的线程（含 messages）
  threads: [],
  streaming: false,
  abort: null,
  attachments: [],
  editing: null,
  paintTimer: null,
  limit: 50,
  total: 0,
  deleteArmed: null,
  deleteTimer: null,
  cards: new Map(),     // messageId -> proposal card state (draft/mode/sources/busy/error)
  mirrors: new Map(),   // messageId -> { runId, trace, live, es } — the run's own facts
};
let runHistory = [];    // /api/runs
let runFilter = "";     // 运行记录搜索词
let toolContracts = null; // /api/tools，工具契约（含版本与 effect）
let modules = [];         // /api/modules，域模块（金融研究 / 审计 / 量化…）
let olderOpen = false;  // 「更早」分组是否展开

/* 模型与思考强度选择（对齐 kimi.com composer 的模型徽章形态）。
   选择只作用于“下一个新委托”；运行中的徽章只读展示该 run 实际模型。 */
const EFFORT_LEVELS = ["low", "medium", "high"];
const EFFORT_LABEL = { low: "低", medium: "中", high: "高" };
let modelCatalog = [];  // /api/models
let modelChoice = (() => {
  try { return JSON.parse(localStorage.getItem("fa.model") || "") || {}; } catch { return {}; }
})();
modelChoice = {
  key: typeof modelChoice.key === "string" ? modelChoice.key : "mock",
  effort: EFFORT_LEVELS.includes(modelChoice.effort) ? modelChoice.effort : "medium",
};
/* 草稿预览的预算联动：/api/models?template= 返回各模型在该模板下真实生效的
   预算顶（服务端是缩放的单一事实源），按模板缓存，选择器变更即失效。 */
let modelBudget = { template: "", models: null };
/* “+”附加面板：资料选择 / 工具注册表 / 预算微调。
   三项都是真实委托输入：scope 与 budget 随 spec 提交并被 run 线程消费。 */
const attach = {
  open: false,
  openGroup: null,       // 手风琴单开：null | tpl | sources | tools | budget
  corpus: [],
  tools: [],
  loadedTemplate: "",
  scope: new Set(),
  budget: null,          // null = 未改，用当前模型/模板的服务端草案
  sources: [],           // 通用委托：fetch_url 可访问的 URL 清单（spec.sources）
  sourcesDraft: "",
  mcp: { servers: [], loaded: false },  // MCP 导入的真实可用性
};
let scenesOpen = localStorage.getItem("fa.scenesOpen"); // null | "1" | "0"

/* 多会话：每个 run 一个会话对象；后台会话保持 SSE 流，只是不渲染 */
const sessions = new Map();

/* ---------------------------------------------------------------- helpers */

/* RENDER LAYER — 主区唯一 DOM 入口；innerHTML/dataset/scroll 可调，状态赋值只保留 mode。 */
function renderMain(html, { mode = "run", scroll = null } = {}) {
  const main = document.getElementById("main");
  if (!main) return;
  // 救援：舞台态时 composer 住在 #main 的 stage-dock 里，必须先搬回 footer，
  // 否则下面的 innerHTML 替换会连同单实例节点与其事件绑定一起销毁
  const liveComposer = document.querySelector(".stage-dock > .composer");
  if (liveComposer) {
    const wrap = document.querySelector(".composer-wrap");
    if (wrap) wrap.appendChild(liveComposer);
    document.getElementById("app")?.classList.remove("stage-mode");
  }
  main.innerHTML = html;
  main.dataset.view = mode;
  store.mode = mode;
  setStageMode(mode === "empty");
  document.getElementById("app")?.classList.toggle("chat-mode", mode === "chat");
  // composer 只属于对话语境：功能页（账本 / 判断记录 / 定时任务 / 设置）不显示输入框
  const composerWrap = document.querySelector(".composer-wrap");
  if (composerWrap) composerWrap.hidden = (mode === "reviews" || mode === "scheduled"
    || mode === "ledger" || mode === "settings");
  const scroller = document.querySelector(".main");
  if (scroll === "top" && scroller) scroller.scrollTop = 0;
  else if (scroll === "bottom" && scroller) scroller.scrollTop = scroller.scrollHeight;
}

/* 主区视图入口：只有导航动作走这里；各渲染函数是具体实现。 */
const MODE_ENTRY = {
  run: payload => render(payload.trace, payload.title),
  intake: () => renderIntake(),
  ledger: () => openLedger(),
  settings: () => openSettingsPage(),
  reviews: () => renderReviews(),
  scheduled: () => renderScheduledPage(),
};

function renderMode(mode, payload = {}) {
  if (mode !== "chat") leaveChat();
  const entry = MODE_ENTRY[mode];
  if (!entry) throw new Error(`unknown view mode: ${mode}`);
  store.mode = mode;
  return entry(payload);
}

const runLabel = run => run.name || shortObjective(run.objective);

const stateClass = status =>
  status === "succeeded" ? "ok" : (status === "denied" || status === "failed") ? "bad" : "warn";
const stateText = status =>
  ({ succeeded: "成功", failed: "失败", denied: "拒绝",
     recovery_required: "待恢复", running: "运行中", stopped: "已停止" }[status] || (status || "?"));

function lastBudget(trace) {
  const rounds = trace.rounds || [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    const b = rounds[i].budget_after;
    if (b && b.calls_used !== undefined) return b;
  }
  return null;
}

function lastPlan(trace) {
  const rounds = trace.rounds || [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    if (rounds[i].plan_after) return rounds[i].plan_after;
    if (rounds[i].plan) return rounds[i].plan;
  }
  return null;
}

/* ------------------------------------------------ RENDER LAYER — 工具摘要 */

function describe(observation) {
  const tool = observation.tool;
  const r = observation.result || {};
  switch (tool) {
    case "list_documents":
      return [(r.documents || []).map(d => `${d.id}(${d.unit_label}/${d.basis})`).join("  ")];
    case "read_document":
      return [`${r.period} · ${r.unit_label} · ${r.basis}`, `<span class="dim">${esc((r.body || "").slice(0, 72))}…</span>`];
    case "normalize_units":
      return [`${r.source_unit} → ${r.target_unit} ×${num(r.factor)} · 毛利 ${num(r.gross_profit_cny)} 元`];
    case "reconcile_basis":
      if (r.reconciled === false) return [`${r.period} · <span class="yel">无法桥接：${esc(r.reason || "没有公布的桥接说明")}</span>`];
      return [`${r.period} ${r.from_basis} → ${r.to_basis} · 差异 ${r.delta >= 0 ? "+" : ""}${r.delta}`, `<span class="dim">${esc(r.reason)}</span>`];
    case "check_restatement":
      return r.restated
        ? [`<span class="yel">已重述</span> ${num(r.original_gross_profit)} → ${num(r.restated_gross_profit)}（${r.delta >= 0 ? "+" : ""}${r.delta}）`, `<span class="dim">${esc(r.reason || "")}</span>`]
        : ["无重述"];
    case "calculate_margin":
      return r.computed
        ? [`2024 ${pct(r.margin_bp_2024)} · 2025 ${pct(r.margin_bp_2025)} · <span class="grn">${pp(r.change_bp)}</span>`]
        : [`<span class="red">无法计算：${esc((r.blockers || []).join("；"))}</span>`];
    case "report_blocked":
      return [`声明受阻：${esc(r.reason)}`];
    case "ls_workspace": {
      const entries = r.entries || [];
      return [`${num(entries.length)} 个文件`, `<span class="dim">${esc((entries[0] || {}).path || "空工作区")}</span>`];
    }
    case "read_file":
      return [`${esc(r.path || "")} · ${num(r.bytes)} bytes`, `<span class="dim">${esc(String(r.content || "").slice(0, 72))}…</span>`];
    case "write_file":
      return [`${esc(r.path || "")} · ${r.changed ? "已写入" : "无变化"} · ${num(r.bytes)} bytes`, `<span class="dim">sha ${esc(shortHash(r.sha256_after))}…${r.commit ? " · " + esc(r.commit) : ""}</span>`];
    case "edit_file":
      return [`${esc(r.path || "")} · 锚定替换 · ${num(r.bytes)} bytes`, `<span class="dim">sha ${esc(shortHash(r.sha256_after))}…</span>`];
    case "run_command":
      return [`${esc(r.command || "")} · 退出码 ${esc(r.exit_code)} · ${num(r.duration_ms)} ms`, `<span class="dim">${esc(String(r.output || "").split("\n")[0].slice(0, 72))}…</span>`];
    case "fetch_url":
      return [`${esc(r.host || r.url || "")} · HTTP ${esc(r.status)} · ${num(r.bytes)} bytes`, `<span class="dim">${esc(r.title || r.url || "")}</span>`];
    default:
      return [esc(JSON.stringify(r))];
  }
}

/* ------------------------------------------------ RENDER LAYER — 侧栏导航 */

const labelOf = key => (SCENARIOS.find(s => s[0] === key) || [key, key])[1];
const tplTitle = key => {
  const template = templates.find(t => t.key === key);
  return template ? template.title.split("：")[0] : (TPL_FALLBACK[key] || key || "—");
};
function templateGroups() {
  const groups = new Map();
  for (const template of templates) {
    const key = template.module || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(template);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    title: (modules.find(module => module.key === key) || {}).title || key || "模块",
    items,
  }));
}

const shortObjective = text => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > 22 ? s.slice(0, 22) + "…" : s;
};

let ledgerOpen = false;
let ledgerConfirmId = null;

function renderNav() {
  const desk = document.getElementById("desk-btn");
  if (desk) desk.classList.toggle("active", ledgerOpen);
  paintMoreNav();
  renderChats();
  renderProjects();
  renderRuns();
}

/* 侧栏「更多」：Kimi 把功能行收在同一层级，多余的直接折叠。
   两个治理页（看板·账本、判断记录）放在这里可达但不占前门。 */
const MORE_KEY = "fa.sideMore";

function moreOpen() {
  try { return localStorage.getItem(MORE_KEY) === "1"; } catch { return false; }
}

function paintMoreNav() {
  const wrap = document.getElementById("more-nav");
  const toggle = document.getElementById("nav-more");
  if (!wrap || !toggle) return;
  const open = moreOpen();
  wrap.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.classList.toggle("open", open);
}

function setMoreNav(open) {
  try { localStorage.setItem(MORE_KEY, open ? "1" : "0"); } catch { /* quota */ }
  paintMoreNav();
}

/* ================= Projects（运行分组，v1 单设备存储） ================= */
let projects = JSON.parse(localStorage.getItem("fa.projects") || "[]");
let runProjects = JSON.parse(localStorage.getItem("fa.runProjects") || "{}");
let projectFilter = null;
const saveProjects = () => {
  localStorage.setItem("fa.projects", JSON.stringify(projects));
  localStorage.setItem("fa.runProjects", JSON.stringify(runProjects));
};

function renderProjects() {
  const nav = document.getElementById("project-nav");
  if (!nav) return;
  const count = pid => Object.values(runProjects).filter(x => x === pid).length;
  nav.innerHTML = projects.map(prj => '<button class="session proj-row' + (projectFilter === prj.id ? " active" : "") + '" data-proj="' + esc(prj.id) + '"><span class="slabel">' + esc(prj.name) + '</span><span class="smeta">' + (count(prj.id) || "") + '</span></button>').join("")
    + '<button class="proj-add" id="proj-add">＋ 新建项目</button>';
  const cnt = document.getElementById("proj-count");
  if (cnt) cnt.textContent = String(projects.length);
}

function clearNavActive() {
  for (const id of ["desk-btn", "nav-reviews", "nav-scheduled"]) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("active");
  }
}

/* ------------------ MIXED — trace 成本回填逻辑（不改）+ 账本渲染模板 */

function openLedger() {
  setMoreNav(true);
  leaveChat();
  if (intake.active) closeIntake(false);
  if (settingsOpen) closeSettingsPage(false);
  ledgerOpen = true;
  if (activeSession()) detachLive();
  store.key = null;
  store.trace = null;
  renderNav();
  renderTabs();
  document.getElementById("tb-title").textContent = "工作台";
  document.getElementById("tb-chips").innerHTML = "";
  const badge = document.getElementById("chain-badge");
  if (badge) {
    badge.className = "chain-pill";
    badge.innerHTML = `<span class="dot"></span><span>未加载</span>`;
  }
  const scroller = document.querySelector(".main");
  if (scroller) scroller.scrollTop = 0;
  renderLedger();
}

/* 运行轨迹一律走 API，而不是 `runs/<id>/trace.json` 这个静态路径：静态路径只在
   运行目录恰好位于 viewer 检出内（本地开发默认）时才取得到，桌面版把运行放在
   Application Support，于是重启后点开任何已结束的运行都是 404。服务端从运行目录
   读并做 jail 校验，两种部署走同一条路。 */
function runTraceUrl(runId) {
  return `/api/runs/${encodeURIComponent(runId)}/trace`;
}

async function renderLedger() {
  const main = document.getElementById("main");
  if (!main || !ledgerOpen) return;
  renderMain(`<div class="empty">统计账本…</div>`, { mode: "ledger" });
  // 旧运行 meta 里没有成本摘要：按需拉 trace 补齐（有缓存）
  const missing = runHistory.filter(run => !run.cost && run.tracePath);
  await Promise.all(missing.map(async run => {
    try {
      const response = await fetch(runTraceUrl(run.id), { cache: "no-store" });
      if (!response.ok) return;
      const trace = await response.json();
      cache.set("run:" + run.id, trace);
      const rounds = trace.rounds || [];
      for (let i = rounds.length - 1; i >= 0; i--) {
        const b = rounds[i].budget_after;
        if (b && b.calls_used !== undefined) {
          const lim = b.limits || {};
          run.cost = {
            calls: b.calls_used, reads: b.reads_used,
            costMicrousd: b.cost_used_microusd, tokens: b.tokens_used,
            maxCalls: lim.max_calls, maxCostMicrousd: lim.max_cost_microusd,
          };
          break;
        }
      }
    } catch { /* 单条失败不拖垮账本 */ }
  }));

  const finished = runHistory.filter(run => run.status !== "running");
  const totalCost = finished.reduce((s, r) => s + ((r.cost && r.cost.costMicrousd) || 0), 0);
  const totalCalls = finished.reduce((s, r) => s + ((r.cost && r.cost.calls) || 0), 0);
  const succeeded = finished.filter(run => run.status === "succeeded").length;
  const running = runHistory.filter(run => run.status === "running").length;
  const rate = finished.length ? Math.round((succeeded / finished.length) * 100) : 0;
  const rows = runHistory.slice(0, 30).map(run => {
    const cost = run.cost ? `${num(run.cost.costMicrousd)} µUSD` : "—";
    const created = String(run.created || "").replace("T", " ").slice(5, 16);
    const confirmDelete = ledgerConfirmId === run.id;
    return `<tr data-led-row="${esc(run.id)}" title="${esc(run.objective)}">
      <td><span class="sdot ${run.status === "running" ? "live" : stateClass(run.status)}"></span> ${esc(stateText(run.status))}</td>
      <td class="led-name">${esc(runLabel(run))}</td>
      <td class="dim">${esc(tplTitle(run.template))}</td>
      <td class="num">${run.rounds || "—"}</td>
      <td class="num">${cost}</td>
      <td class="dim">${esc(created)}</td>
      <td><button class="a-btn${confirmDelete ? " danger" : ""}" data-led-del="${esc(run.id)}">${confirmDelete ? "确认删除？" : "删除"}</button></td>
    </tr>`;
  }).join("");

  renderMain(`
    <section class="prompt">
      <div class="prompt-kicker"><span class="kicker-label">WORKBENCH</span><span>委托账本</span></div>
      <p class="prompt-text">委托账本</p>
      <p class="prompt-note">所有委托的状态、轮次与成本。点击行打开对应运行；删除会移除运行目录，运行中不可删。</p>
    </section>
    <div class="led-stats">
      <div class="led-stat"><div class="k">委托总数</div><div class="v">${runHistory.length}</div></div>
      <div class="led-stat"><div class="k">运行中</div><div class="v">${running}</div></div>
      <div class="led-stat"><div class="k">成功率</div><div class="v">${rate}<i>%</i></div></div>
      <div class="led-stat"><div class="k">总成本</div><div class="v">${num(totalCost)}<i> µUSD</i></div></div>
      <div class="led-stat"><div class="k">总调用</div><div class="v">${num(totalCalls)}</div></div>
    </div>
    <div class="card led-card">
      <table class="led-table">
        <tr><th>状态</th><th>委托</th><th>类型</th><th>轮次</th><th>成本</th><th>创建</th><th></th></tr>
        ${rows || `<tr><td colspan="7" class="dim" style="text-align:center;padding:22px">还没有委托 — 点上方「新建委托」开始</td></tr>`}
      </table>
    </div>`, { mode: "ledger" });
  updateStatusline();
}

async function deleteRun(id) {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
  } catch (error) {
    toast("删除失败：" + error.message);
    return;
  }
  const s = sessions.get(id);
  if (s) { if (s.es) s.es.close(); sessions.delete(id); }
  if (store.sessionId === id) store.sessionId = null;
  cache.delete("run:" + id);
  if (store.key === "run:" + id) {
    store.key = null;
    store.trace = null;
    renderMode("ledger");
  } else if (ledgerOpen) {
    renderLedger();
  }
  renderTabs();
  refreshRuns();
  toast("委托已删除");
}

function runGroupOf(created) {
  const when = new Date(created || "");
  if (Number.isNaN(when.getTime())) return 2;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (when.getTime() >= today) return 0;
  if (when.getTime() >= today - 86400000) return 1;
  return 2;
}

function runTimeText(created) {
  const when = new Date(created || "");
  if (Number.isNaN(when.getTime())) return "—";
  if (runGroupOf(created) === 2) {
    return `${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
  }
  return when.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function setFoot(text, cls = "") {
  const label = document.getElementById("foot-text");
  if (label) label.textContent = text;
  const dotEl = document.getElementById("foot-dot");
  if (dotEl) dotEl.className = "fdot" + (cls ? " " + cls : "");
}

const STATUS_MARK = {
  ok: '<svg viewBox="0 0 12 12"><path d="M2.3 6.5c1.2.9 2.1 1.9 2.8 2.9 1.1-2.3 2.4-4 4.1-5.4"/></svg>',
  bad: '<svg viewBox="0 0 12 12"><path d="M3 3.1c2 1.9 4 3.9 5.9 5.9"/><path d="M9 3c-2 2-3.9 4-5.8 6"/></svg>',
  warn: '<svg viewBox="0 0 12 12"><path d="M2.4 8.2c1.3-1.5 2.5-2.2 3.3-1.8 1 .5.2 1.9 1.2 2.1.8.1 1.6-.6 2.5-1.7"/></svg>',
  live: '<svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="2.4" fill="currentColor" stroke="none"/></svg>',
};

function runRowHtml(run) {
  const active = store.key === "run:" + run.id;
  const running = run.status === "running";
  const cls = running ? "live" : stateClass(run.status);
  const meta = running ? "运行中" : runTimeText(run.created);
  const pinMark = run.pinned ? `<span class="pin-mark" title="已固定">${doodleSvg("star")}</span>` : "";
  const bits = [tplTitle(run.template)];
  if (running) bits.push(`第 ${run.rounds || 0} 轮`);
  else if (run.rounds) bits.push(`${run.rounds} 轮`);
  if (!running && run.cost && run.cost.costMicrousd !== undefined) {
    bits.push(`${num(run.cost.costMicrousd)} µ`);
  }
  const sub = bits.filter(Boolean).join(" · ");
  const mark = `<span class="smark ${cls}">${STATUS_MARK[cls] || STATUS_MARK.warn}</span>`;
  return `<div class="session run-row${active ? " active" : ""}${run.pinned ? " pinned" : ""}" data-run="${esc(run.id)}" tabindex="0" title="${esc(run.objective)}${run.rounds ? " · " + run.rounds + " 轮" : ""}">
    <div class="r-top">
      ${mark}
      <span class="slabel" data-name>${esc(runLabel(run))}</span>
      ${pinMark}
      <span class="smeta">${meta}</span>
      <button class="row-more" data-more="${esc(run.id)}" title="更多">${doodleSvg("ellipsis")}</button>
    </div>
    <div class="r-sub">${esc(sub)}</div>
    <div class="row-menu" data-menu="${esc(run.id)}" hidden>
      <button data-row-act="pin">${run.pinned ? "取消固定" : "固定"}</button>
      <button data-row-act="rename">重命名</button>
      <button data-row-act="project">移动到项目…</button>
      <button data-row-act="delete">删除</button>
    </div>
  </div>`;
}

function closeRowMenus() {
  for (const menu of document.querySelectorAll(".row-menu")) menu.hidden = true;
}

/* ================= 判断记录（My Kimi 对应：操作者判断聚合） ================= */
async function renderReviews() {
  clearNavActive();
  const nav = document.getElementById("nav-reviews");
  if (nav) nav.classList.add("active");
  document.getElementById("tb-title").textContent = "判断记录";
  document.getElementById("tb-chips").innerHTML = "";
  setFoot("判断记录 · 只读汇总", "");
  const ta = document.getElementById("composer-ta");
  if (ta) ta.value = "";
  renderMain('<div class="empty">读取判断记录…</div>', { mode: "reviews" });
  let d;
  try {
    const r = await fetch("/api/review-profile", { cache: "no-store" });
    d = await r.json();
  } catch (e) {
    renderMain('<div class="empty">无法加载判断记录：' + esc(e.message) + '</div>', { mode: "reviews" });
    return;
  }
  const cards = [
    ["接受判断", d.counts.accept], ["需要补材料", d.counts.needs_evidence],
    ["保留意见", d.counts.qualified], ["退回重做", d.counts.redo],
  ];
  const rows = (d.recent || []).map(item => '<div class="rev-row">'
    + '<span class="rev-dec">' + esc(item.decision || item.decision_label || "—") + '</span>'
    + '<span class="rev-what">' + esc(item.reason || item.note || item.objective || "") + '</span>'
    + '<span class="rev-at">' + esc(item.at || item.created || "") + '</span></div>').join("");
  renderMain(
    '<section class="page-head"><p class="eyebrow">REVIEW PROFILE</p>'
    + '<h1 class="page-title">判断记录</h1>'
    + '<p class="page-meta">你在各次委托判断面里做出的选择，按时间聚合。判断以标签随签名链记录，此处只作汇总展示。</p></section>'
    + '<div class="rev-cards">'
    + cards.map(pair => '<div class="rev-card"><span class="rev-num">' + (pair[1] ?? 0) + '</span><span class="rev-k">' + pair[0] + '</span></div>').join("")
    + '</div>'
    + ((d.recent || []).length ? '<div class="rev-list">' + rows + '</div>'
      : '<div class="empty">还没有判断记录——在任一运行的「判断面」里做出选择后，这里会开始积累。</div>'),
    { mode: "reviews" });
}

/* ================= 定时任务（Scheduled，v1 前端骨架） ================= */
function scheduledList() {
  return JSON.parse(localStorage.getItem("fa.scheduled") || "[]");
}

function renderScheduledPage() {
  clearNavActive();
  const nav = document.getElementById("nav-scheduled");
  if (nav) nav.classList.add("active");
  document.getElementById("tb-title").textContent = "定时任务";
  document.getElementById("tb-chips").innerHTML = "";
  setFoot("定时任务 · 草稿在本机", "");
  const list = scheduledList();
  const rows = list.map((t, i) => '<div class="sch-row">'
    + '<div class="sch-main"><b>' + esc(t.objective || "（未命名）") + '</b>'
    + '<span class="sch-meta">' + esc(t.template || "full") + ' · ' + esc(t.approval || "consequential") + ' · ' + esc(t.frequency) + ' ' + esc(t.time || "") + '</span></div>'
    + '<span class="sch-badge">' + esc(t.status || "等待调度器") + '</span>'
    + '<button class="row-more sch-del" data-sch-del="' + i + '" title="删除">×</button></div>').join("");
  renderMain(
    '<section class="page-head"><p class="eyebrow">SCHEDULED</p>'
    + '<h1 class="page-title">定时任务</h1>'
    + '<p class="page-meta">把重复的委托排上日程。调度器属于运行时侧——接入前任务不会自动触发，草稿保存在本机。</p></section>'
    + '<div class="sch-form">'
    + '<label>目标<textarea id="sch-objective" rows="2" placeholder="例如：每天早上核对昨日新增的口径变更"></textarea></label>'
    + '<div class="sch-grid">'
    + '<label>模板<select id="sch-template">' + SCENARIOS.map(pair => '<option value="' + pair[0] + '">' + pair[1] + '</option>').join("") + '</select></label>'
    + '<label>审批档位<select id="sch-approval"><option value="consequential">关键审批</option><option value="all">逐步审批</option><option value="off">自动</option></select></label>'
    + '<label>频率<select id="sch-frequency"><option>每天</option><option>每周</option><option>工作日</option></select></label>'
    + '<label>时间<input id="sch-time" type="time" value="09:00"></label>'
    + '</div><div class="sch-actions">'
    + '<span class="sch-honest">调度器待运行时侧接入——创建的条目保存在本机，不会自动触发</span>'
    + '<button id="sch-save">保存草稿</button></div></div>'
    + '<div class="sch-list">' + (rows || '<div class="empty">还没有定时任务草稿。</div>') + '</div>',
    { mode: "scheduled" });
  const save = document.getElementById("sch-save");
  if (save) save.addEventListener("click", () => {
    const objective = document.getElementById("sch-objective").value.trim();
    if (!objective) { toast("先描述定时任务的目标"); return; }
    const list2 = scheduledList();
    list2.push({
      objective,
      template: document.getElementById("sch-template").value,
      approval: document.getElementById("sch-approval").value,
      frequency: document.getElementById("sch-frequency").value,
      time: document.getElementById("sch-time").value,
      status: "等待调度器",
      created: new Date().toISOString(),
    });
    localStorage.setItem("fa.scheduled", JSON.stringify(list2));
    toast("草稿已保存（本机）");
    renderScheduledPage();
  });
  for (const btn of document.querySelectorAll("[data-sch-del]")) {
    btn.addEventListener("click", () => {
      const list2 = scheduledList();
      list2.splice(Number(btn.dataset.schDel), 1);
      localStorage.setItem("fa.scheduled", JSON.stringify(list2));
      renderScheduledPage();
    });
  }
}

function updateRunCounts() {
  const total = String(runHistory.length);
  for (const id of ["run-count", "desk-count"]) {
    const el = document.getElementById(id);
    if (el) el.textContent = total;
  }
}

function renderRuns() {
  const runNav = document.getElementById("run-nav");
  if (!runNav) return;
  updateRunCounts();
  const query = runFilter.trim().toLowerCase();
  let runs = runHistory
    .filter(run => !query || `${run.name || ""} ${run.objective} ${run.id}`.toLowerCase().includes(query));
  if (projectFilter) {
    runs = runs.filter(run => runProjects[run.id] === projectFilter);
  }
  runs = runs.slice()
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  if (!runs.length) {
    runNav.innerHTML = query
      ? `<div class="side-empty side-empty-search">${doodleSvg("search")}<div>没有匹配的委托</div><div class="dim">换个关键词试试</div></div>`
      : `<div class="side-empty">还没有运行记录<br>点上方「新建委托」开始</div>`;
    return;
  }

  let html = "";
  if (query) {
    html += `<div class="side-head-label">${runs.length} 条结果</div>`;
    html += runs.map(runRowHtml).join("");
  } else {
    const pinned = runs.filter(run => run.pinned);
    if (pinned.length) {
      html += `<div class="side-head-label"><span>${doodleSvg("star")}已固定</span><span class="grp-count">${pinned.length}</span></div>`;
      html += pinned.map(runRowHtml).join("");
    }
    const groups = [
      { label: "今天", items: [] },
      { label: "昨天", items: [] },
      { label: "更早", items: [] },
    ];
    for (const run of runs) {
      if (run.pinned) continue;
      groups[runGroupOf(run.created)].items.push(run);
    }
    for (const group of groups) {
      if (!group.items.length) continue;
      html += `<div class="side-head-label"><span>${group.label}</span><span class="grp-count">${group.items.length}</span></div>`;
      const visible = group.label === "更早" && !olderOpen ? group.items.slice(0, 5) : group.items;
      html += visible.map(runRowHtml).join("");
      if (group.label === "更早" && group.items.length > 5) {
        html += olderOpen
          ? `<button class="side-more" data-collapse-older>收起</button>`
          : `<button class="side-more" data-more-older>显示全部 ${group.items.length} 条</button>`;
      }
    }
  }
  runNav.innerHTML = html;
}

/* ------------------------------- RENDER LAYER — 证据面板内容与事件列表 */

const MACHINE_EVENTS = new Set([
  "model_started", "plan_validated", "plan_updated", "execution_started",
  "policy_requested", "policy_decided", "auto_action",
  "execution_resumed", "tool_started",
]);

function setTabCount(name, value) {
  const el = document.querySelector(`[data-count="${name}"]`);
  if (el) el.textContent = value === "" ? "" : String(value);
}

function railEmptyHtml() {
  return `<div class="rail-empty-doc">${doodleSvg("file-text")}
    <div class="t">案卷尚未展开</div>
    <div class="dim">从左侧选择一条委托，或运行一个新的任务</div>
  </div>`;
}

function eventItemHtml(e) {
  const human = HUMAN_EVENTS.has(e.type);
  const detail = summariseEvent(e);
  const mark = human
    ? `<span class="ev-human">人</span>`
    : `<span class="ev-mark ${EVENT_DOT[e.type] || ""}"></span>`;
  return `<div class="ev-item${human ? " human" : ""}">
    <div class="ev-line">
      ${mark}
      <span class="ev-type">${esc(e.type)}</span>
      <span class="grow"></span>
      <span class="ev-ref" data-copy="${esc(e.hash || "")}" title="点击复制完整哈希">#${e.sequence} · ${esc(shortHash(e.hash))}</span>
    </div>
    ${detail ? `<div class="ev-detail">${detail}</div>` : ""}
  </div>`;
}

function renderEvents(trace, check) {
  const all = trace.events || [];
  const byRound = new Map();
  for (const event of all) {
    const round = Number((event.payload || {}).detail?.round) || 0;
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round).push(event);
  }
  const chips = [
    ["key", "关键"], ["all", "全部"], ["human", "人工"],
  ].map(([key, label]) => `<button class="rf${railFilter === key ? " active" : ""}" data-rail-filter="${key}">${label}</button>`).join("");

  let html = `<div class="rail-filters">${chips}</div>`;
  const rounds = [...byRound.keys()].sort((a, b) => a - b);
  for (const round of rounds) {
    const events = byRound.get(round);
    const human = events.filter(e => HUMAN_EVENTS.has(e.type));
    const machines = events.filter(e => MACHINE_EVENTS.has(e.type));
    const shown = railFilter === "human"
      ? human
      : events.filter(e => railFilter === "all" || !MACHINE_EVENTS.has(e.type));
    const expandable = railFilter === "key" && machines.length > 0;
    const expanded = evExpanded.has(round);
    if (!shown.length && !expandable) continue;
    html += `<div class="ev-round">${round === 0 ? "任务" : "第 " + round + " 轮"}</div>`;
    if (expanded) {
      html += shown.concat(machines)
        .sort((a, b) => a.sequence - b.sequence)
        .map(eventItemHtml).join("");
      html += `<button class="ev-more" data-ev-group="${round}">收起过程 · ${machines.length} 条</button>`;
    } else {
      html += shown.map(eventItemHtml).join("");
      if (expandable) {
        html += `<button class="ev-more" data-ev-group="${round}">过程 ${machines.length} 条 ▸</button>`;
      }
    }
  }
  if (!html.includes("ev-item")) {
    html += `<div class="rail-empty">${railFilter === "human" ? "这条轨迹里还没有人工决定" : "没有可显示的事件"}</div>`;
  }
  return html;
}

function renderChain(trace, check) {
  const events = trace.events || [];
  const chain = trace.chain || {};
  const ok = !!(check && check.ok);
  const shield = doodleSvg("shield-check", "draw");
  const head = chain.head_hash || "";
  return `<div class="seal ${ok ? "ok" : "bad"}">
    <div class="seal-head">${shield}<span>${check && check.live ? "签名中" : ok ? "全链验证通过" : "链验证失败"}</span><span class="grow"></span><span class="seal-count">${events.length} 事件</span></div>
    ${!ok && check && check.reason ? `<div class="seal-reason">${esc(check.reason)}</div>` : ""}
    <div class="seal-row"><span class="k">链头</span><span class="seal-hash" data-copy="${esc(head)}" title="点击复制">${esc(head)}</span></div>
    <div class="seal-row"><span class="k">算法</span><span>${esc(chain.algorithm || "sha256 · canonical json")}</span></div>
  </div>
  <div class="rail-sec-title">链接明细</div>
  <div class="chain-list">${events.map(e => `<div class="link-row">
    <span class="n">#${e.sequence}</span>
    <span class="h">${esc(shortHash(e.hash))}</span>
    <span class="arrow">←</span>
    <span class="p">${esc(shortHash(e.prev_hash))}${e.prev_hash ? "" : " (genesis)"}</span>
  </div>`).join("")}</div>`;
}

function renderRaw(trace) {
  const json = JSON.stringify(trace, null, 2);
  const lines = json.split("\n").map((line, index) => `<span class="raw-line"><i>${index + 1}</i>${esc(line)}</span>`).join("");
  return `<div class="raw-head">
      <button class="rf" data-copy-raw>复制原文</button>
      <button class="rf" data-download-raw>下载 trace</button>
    </div>
    <pre class="raw-pre">${lines}</pre>`;
}

function renderRail(trace, check) {
  const body = document.getElementById("rail-body");
  if (!trace) { body.innerHTML = railEmptyHtml(); return; }
  for (const button of document.querySelectorAll("#rail-tabs button")) {
    button.classList.toggle("active", button.dataset.tab === railTab);
  }
  const events = trace.events || [];
  const count = document.getElementById("rail-count");
  if (count) count.textContent = events.length ? `${events.length} 事件` : "";
  setTabCount("events", events.length);
  setTabCount("tools", toolContracts ? toolContracts.length : "");
  setTabCount("chain", events.length);

  if (railTab === "events") {
    body.innerHTML = renderEvents(trace, check);
    return;
  }
  if (railTab === "tools") {
    body.innerHTML = renderTools(trace, check);
    return;
  }
  if (railTab === "chain") {
    body.innerHTML = renderChain(trace, check);
    return;
  }
  body.innerHTML = renderRaw(trace);
}

const TOOL_DOODLE_ICON = {
  list_documents: "list",
  read_document: "doc",
  normalize_units: "table",
  reconcile_basis: "link",
  check_restatement: "refresh-cw",
  calculate_margin: "gauge",
  report_blocked: "flag",
  ingest_file: "upload",
  search_corpus: "search",
  read_slice: "file-text",
  working_paper_append: "pen",
  fetch_source: "globe",
  search_cases: "search",
  read_case: "file-text",
  query_facts: "database",
  ls_workspace: "layout-grid",
  read_file: "book-open",
  write_file: "report",
  edit_file: "tool",
  run_command: "gate",
  fetch_url: "link",
};

function renderTools(trace, check) {
  const task = trace.task || {};
  const allowed = new Set(task.allowed_tools || []);
  const granted = new Set((task.model_grant || {}).allowed_tools || []);
  const usage = new Map();
  const touch = name => {
    if (!usage.has(name)) usage.set(name, { calls: 0, denied: 0, tokens: 0, cost: 0, latency: 0 });
    return usage.get(name);
  };
  for (const round of trace.rounds || []) {
    const denied = (round.decision || {}).allowed === false;
    const tool = (round.observation || {}).tool
      || (round.decision || {}).tool
      || (((round.proposal || {}).steps || [])[0] || {}).tool;
    if (!tool) continue;
    const stat = touch(tool);
    stat.calls += 1;
    if (denied) stat.denied += 1;
    const receipt = round.receipt || {};
    if (receipt.tokens !== undefined) stat.tokens += Number(receipt.tokens) || 0;
    if (receipt.cost_microusd !== undefined) stat.cost += Number(receipt.cost_microusd) || 0;
    if (receipt.latency_ms !== undefined) stat.latency += Number(receipt.latency_ms) || 0;
  }
  if (!toolContracts) return `<div class="rail-empty">正在加载工具契约…</div>`;
  const activeRound = [...(trace.rounds || [])].reverse().find(round =>
    !round.observation && (round.decision || {}).allowed !== false);
  const activeTool = activeRound
    ? (((activeRound.proposal || {}).steps || [])[0] || {}).tool || (activeRound.decision || {}).tool
    : null;
  const rows = toolContracts
    .slice()
    .sort((a, b) => {
      const ua = usage.get(a.name), ub = usage.get(b.name);
      if ((ub ? ub.calls : 0) !== (ua ? ua.calls : 0)) return (ub ? ub.calls : 0) - (ua ? ua.calls : 0);
      if (allowed.has(b.name) !== allowed.has(a.name)) return allowed.has(b.name) ? 1 : -1;
      return a.name.localeCompare(b.name);
    })
    .map(contract => {
      const stat = usage.get(contract.name);
      const inScope = allowed.has(contract.name);
      const inGrant = granted.has(contract.name);
      const effect = contract.effect || "read";
      const usageText = stat
        ? `${stat.calls} 次${stat.denied ? " · 拒绝 " + stat.denied : ""}${stat.tokens ? " · " + num(stat.tokens) + " tokens" : ""}${stat.cost ? " · " + num(stat.cost) + " µUSD" : ""}${stat.latency ? " · " + num(stat.latency) + " ms" : ""}`
        : "未使用";
      const still = (window.DOODLE_ICONS && window.DOODLE_ICONS.still) || {};
      const iconName = TOOL_DOODLE_ICON[contract.name];
      const icon = iconName
        ? `<span class="tr-ic">${doodleSvg(iconName, contract.name === activeTool)}</span>`
        : "";
      return `<div class="tool-row${inScope ? "" : " out-of-scope"}" title="${esc(contract.summary || "")}">
        <div class="tr-head">
          ${icon}
          <span class="tr-name">${esc(contract.name)}</span>
          <span class="eff eff-${esc(effect)}">${esc(effect)}</span>
          <span class="tr-ver">v${esc(contract.version || "?")}</span>
          <span class="grow"></span>
          <span class="tr-scope">${inScope ? (inGrant ? "允许 · 已授权" : "允许 · 未授权") : "不在任务范围"}</span>
        </div>
        <div class="tr-usage">${esc(usageText)}</div>
      </div>`;
    }).join("");
  return `<div class="rail-tools">
      <span class="rf-hint">${allowed.size} 个允许 · ${granted.size} 个授权 · 契约来自注册表</span>
    </div>${rows}`;
}

function summariseEvent(e) {
  if (e.type === "review_decided") {
    const detail = (e.payload && e.payload.detail) || (e.payload || {});
    const label = REVIEW_LABEL[detail.decision] || detail.decision || "判断记录";
    return detail.reason ? `${esc(label)} · ${esc(detail.reason)}` : esc(label);
  }
  const d = e.payload && e.payload.detail;
  if (!d || Object.keys(d).length === 0) return "";
  if (e.type === "tool_started" || e.type === "tool_succeeded") return `${esc(d.tool || "")} ${d.arguments && Object.keys(d.arguments).length ? "(" + Object.entries(d.arguments).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(", ") + ")" : "()"}`;
  if (e.type === "model_started") return `round ${esc(d.round)}`;
  if (e.type === "policy_requested") return `${esc((d.packet && d.packet.candidates || []).length)} 个候选 · packet ${esc(shortHash(d.packet_hash))}…`;
  if (e.type === "policy_decided") return `选择 ${esc(d.candidate_id || "—")} · packet ${esc(shortHash(d.packet_hash))}…`;
  if (e.type === "auto_action") return `${esc((d.step || {}).tool || "")} · 无需模型调用`;
  if (e.type === "memory_recalled") return `参考 ${esc(d.count || (d.hits || []).length)} 则旧案 · ${esc(((d.hits || [])[0] || {}).run_id || "")}`;
  if (e.type === "model_unknown") return esc(d.cause || "");
  if (e.type === "model_reconciled") return `receipt ${esc(shortHash(d.receipt_ref))}…`;
  if (e.type === "plan_updated") { const p = d.plan || {}; const done = (p.todos || []).filter(t => t.status === "done").length; return `revision ${esc(p.revision)} · ${done}/${(p.todos || []).length} settled`; }
  if (e.type === "plan_validated") return d.plan && d.plan.steps ? esc(d.plan.steps.map(s => s.id + ":" + s.tool).join(" ")) : "";
  if (e.type === "approval_requested") {
    const args = d.arguments && Object.keys(d.arguments).length
      ? "(" + Object.entries(d.arguments).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(", ") + ")" : "";
    return `${esc(d.tool)} ${args} · ${esc(d.policy)}`;
  }
  if (e.type === "approval_granted") return `${esc(d.tool)} · ${esc(d.by || "operator")}${d.remember ? " · 本运行免询" : ""}`;
  if (e.type === "approval_denied") return `${esc(d.tool)} · ${esc(d.code || "OPERATOR_DENIED")}`;
  if (e.type === "approval_aborted") return `${esc(d.tool)} · ${esc(d.code || "ABORTED")}`;
  if (e.type === "plan_steered") {
    const p = d.plan || {};
    return `revision ${esc(p.revision)} · ${esc(d.action)} ${esc(d.todo_id)}${d.note ? " · " + esc(d.note) : ""}`;
  }
  if (e.type === "budget_adjusted") {
    const before = d.before || {}, after = d.after || {};
    return `calls ${esc(before.max_calls)}→${esc(after.max_calls)} · µUSD ${esc(before.max_cost_microusd)}→${esc(after.max_cost_microusd)}`;
  }
  if (e.type === "control_rejected") return `${esc(d.kind)} · ${esc(d.reason)}`;
  if (e.type === "task_resumed") return `by ${esc(d.by || "operator")}${d.limits ? " · calls " + esc(d.limits.max_calls) : ""}`;
  if (e.type === "operator_message") return `第 ${esc(d.round)} 轮前 · ${esc(d.text || "")}`;
  return esc(JSON.stringify(d).slice(0, 120));
}

/* ------------- MIXED — render() 内链验证/状态赋值不可改；阅读列模板可改 */

function renderPlan(plan, opts = {}) {
  if (!plan || !plan.todos || !plan.todos.length) return "";
  const done = plan.todos.filter(t => t.status === "done").length;
  const glyph = { done: "✓", blocked: "✕", abandoned: "–", active: "◐", pending: "○" };
  const editable = !!opts.editable;
  const editing = editable && !!opts.editing;
  return `<div class="card plan${editing ? " editing" : ""}">
    <div class="card-head">
      <span class="card-title">${doodleSvg("clipboard-list", opts.editable ? "draw" : false)} Plan</span>
      <span class="grow"></span>
      <span class="card-meta">revision ${esc(plan.revision)} · <span style="color:var(--green)">${done}/${plan.todos.length}</span> 已完成</span>
      ${editable ? `<button class="p-edit${editing ? " active" : ""}" data-plan-edit>${editing ? "完成" : "调整"}</button>` : ""}
    </div>
    <div class="card-rows">
      ${plan.todos.map(t => `<div class="row ${esc(t.status)}">
        <span class="r-icon">${glyph[t.status] || "○"}</span>
        <span class="r-text">${esc(t.text)}</span>
        <span class="r-meta">${esc(t.tool)}</span>
        ${editing && (t.status === "pending" || t.status === "active") ? planActions(t, opts.confirmId) : ""}
      </div>`).join("")}
    </div>
    ${opts.queued ? `<div class="plan-foot">${esc(opts.queued)}</div>` : ""}
  </div>`;
}

function planActions(todo, confirmId) {
  if (confirmId === todo.id) {
    return `<span class="r-act confirm"><span class="q">跳过？</span><button data-plan-action="skip-confirm" data-todo="${esc(todo.id)}">是</button><button data-plan-action="cancel">否</button></span>`;
  }
  return `<span class="r-act">
    <button data-plan-action="promote" data-todo="${esc(todo.id)}" title="提前：下一轮先做这一步">↑</button>
    <button data-plan-action="skip" data-todo="${esc(todo.id)}" title="跳过：不再执行（不可撤销）">–</button>
  </span>`;
}

/* token 分类计量（对照官方 ChatStatus 的分类显示）：
   数据源是收据 metadata 的 usage_prompt_tokens / cached_tokens；
   completion 由 total − prompt 推导。收据没有分类字段时如实说明。 */
function tokenSplit(trace) {
  let prompt = 0, cached = 0, total = 0, known = false;
  for (const r of (trace.rounds || [])) {
    const receipt = r.receipt || {};
    const meta = receipt.metadata || {};
    total += Number(receipt.tokens || 0);
    if (meta.usage_prompt_tokens !== undefined && meta.usage_prompt_tokens !== null) {
      known = true;
      prompt += Number(meta.usage_prompt_tokens) || 0;
      cached += Number(meta.cached_tokens) || 0;
    }
  }
  return { prompt, cached, total, completion: known ? Math.max(0, total - prompt) : null, known };
}

function tokenSplitHtml(trace) {
  const t = tokenSplit(trace);
  if (!t.total) return "";
  if (!t.known) {
    return `<div class="tok-split unknown"><span class="tok-note">tokens ${num(t.total)} · 当前收据未含 token 分类（offline-mock 不产生 usage_prompt_tokens）</span></div>`;
  }
  return `<div class="tok-split">
    <div class="tok-row"><span class="k">prompt</span><span class="v">${num(t.prompt)}</span></div>
    <div class="tok-row"><span class="k">cached</span><span class="v">${num(t.cached)}</span><span class="note">缓存命中按输入价计费（v1）</span></div>
    <div class="tok-row"><span class="k">completion</span><span class="v">${num(t.completion)}</span></div>
  </div>`;
}

/* 运行中双轨：已完成轮的累计之外，再显示当前进行中轮已计入的增量
   （含发送前预留）。只读 trace 预算快照推导，不参与治理。 */
function activeRoundDelta(trace) {
  const b = lastBudget(trace);
  if (!b) return null;
  const rounds = trace.rounds || [];
  let settled = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const r = rounds[i];
    if (r.receipt || (r.decision && r.decision.allowed === false)) {
      settled = Number((r.budget_after || {}).tokens_used ?? 0);
      break;
    }
    if (i === 0) settled = Number((r.budget_before || {}).tokens_used ?? 0);
  }
  const delta = Number(b.tokens_used || 0) - settled;
  return delta > 0 ? delta : null;
}

function renderMeters(trace, opts = {}) {
  const b = lastBudget(trace);
  if (!b) return "";
  const lim = b.limits || {};
  const editable = !!opts.editable;
  const editing = editable && !!opts.editing;
  const active = opts.live ? activeRoundDelta(trace) : null;
  const meters = [
    ["calls", b.calls_used, lim.max_calls, ""],
    ["reads", b.reads_used, lim.max_reads, ""],
    ["µUSD", b.cost_used_microusd, lim.max_cost_microusd, ""],
    ["tokens", b.tokens_used, lim.max_tokens, "m-tokens"],
  ];
  return `<div class="card meters${editing ? " editing" : ""}">
    <div class="card-head">
      <span class="card-title">${ICON.lock} 预算</span>
      ${opts.queued ? `<span class="m-queued">已排队 · 下一轮生效</span>` : ""}
      <span class="grow"></span>
      ${meters.map(([label, used, max, cls]) => {
        const ratio = max ? Math.min(1, (used || 0) / max) : 0;
        const hot = ratio >= .95 ? " over" : ratio >= .7 ? " hot" : "";
        const isActive = active !== null && label === "tokens";
        return `<span class="meter${hot}${cls ? " " + cls : ""}">
          <span class="m-k">${label}</span>
          <span class="m-bar"><i style="width:${Math.round(ratio * 100)}%"></i></span>
          <span class="m-v">${num(used || 0)}/${num(max || 0)}</span>
          ${isActive ? `<span class="m-active">本轮 +${num(active)}</span>` : ""}
        </span>`;
      }).join("")}
      ${editable ? `<button class="p-edit${editing ? " active" : ""}" data-budget-edit>${editing ? "取消" : "调整"}</button>` : ""}
    </div>
    ${tokenSplitHtml(trace)}
    ${editing ? budgetForm(lim) : ""}
  </div>`;
}

function budgetForm(lim) {
  return `<div class="budget-edit">
    <label>calls <input type="number" data-budget="maxCalls" min="${lim.max_calls}" value="${lim.max_calls}" inputmode="numeric"></label>
    <label>reads <input type="number" data-budget="maxReads" min="${lim.max_reads}" value="${lim.max_reads}" inputmode="numeric"></label>
    <label>µUSD <input type="number" data-budget="maxCostMicrousd" min="${lim.max_cost_microusd}" value="${lim.max_cost_microusd}" inputmode="numeric"></label>
    <span class="hint">只允许调高 · 下一轮生效</span>
    <span class="grow"></span>
    <button class="a-btn" data-budget-cancel>取消</button>
    <button class="a-btn strong" data-budget-apply>提交调整</button>
  </div>`;
}

const TOOL_ICON = {
  list_documents: ICON.folder,
  read_document: ICON.file,
  normalize_units: '<svg class="i" viewBox="0 0 24 24"><path d="M4 8h12M4 8l3-3M4 8l3 3"/><path d="M20 16H8M20 16l-3-3M20 16l-3 3"/></svg>',
  reconcile_basis: ICON.branch,
  check_restatement: '<svg class="i" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/></svg>',
  calculate_margin: '<svg class="i" viewBox="0 0 24 24"><path d="M19 5 5 19"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/></svg>',
  report_blocked: ICON.alert,
  ls_workspace: ICON.folder,
  read_file: ICON.file,
  write_file: '<svg class="i" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 16h4"/></svg>',
  edit_file: '<svg class="i" viewBox="0 0 24 24"><path d="m4 20 4.5-1 10-10-3.5-3.5-10 10z"/><path d="M13.5 7 16 9.5"/></svg>',
  run_command: ICON.term,
  fetch_url: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5z"/></svg>',
};

function kvDetail(rows) {
  const body = rows.filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join("");
  return body ? `<div class="t-detail"><div class="kv">${body}</div></div>` : "";
}

function alertDetail(kind, title, sub) {
  return `<div class="t-detail"><div class="alert ${kind}"><div class="a-title">${esc(title)}</div>${sub ? `<div class="a-sub">${esc(sub)}</div>` : ""}</div></div>`;
}

/* 逐帧工具小人：只在正在执行的那一轮播放，完成后定格回静态图标。
   每个场景两帧（CSS steps(2)），对应喜茶式的手绘逐帧节奏。 */
const TOOL_DOODLE = {
  list_documents: `<svg class="i doodle-tool" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="7" cy="6.6" r="2.5"/><path d="M7 9.1v6.6M5 15.7h4"/>
    <path class="dm-rock" d="M13.2 8.2h5.6v9.4h-5.6z"/>
    <path class="dm-rock2" d="M14.6 6.4h5.6v9.4h-5.6z"/></svg>`,
  read_document: `<svg class="i doodle-tool" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="8" cy="6.8" r="2.6"/><path d="M8 9.4v6.4M6 15.8h4"/>
    <path class="dm-rock" d="M12.4 9.6l5.2-.8 1.2 7.6-5.2.8z"/></svg>`,
  normalize_units: `<svg class="i doodle-tool" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="7" cy="7" r="2.6"/><path d="M7 9.6v6M5 15.6h4"/>
    <path d="M13 7.4h6v4.6h-6z"/>
    <path class="dm-flip" d="M14.2 14.2h6v4.6h-6z"/></svg>`,
  reconcile_basis: `<svg class="i doodle-tool" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="6.4" cy="6.6" r="2.4"/><path d="M6.4 9v6.8M4.4 15.8h4"/>
    <path d="M10.6 16h3M15.4 16h3"/>
    <path class="dm-rock" d="M10.8 12.2h8.4"/></svg>`,
  check_restatement: `<svg class="i doodle-tool" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="7.4" cy="6.4" r="2.4"/><path d="M7.4 8.8v6.4M5.4 15.2h4"/>
    <path d="M11.6 9.2h6.4v8.2h-6.4z"/>
    <g class="dm-scan"><circle cx="16.4" cy="11.6" r="2.2"/><path d="M18 13.2l1.6 2"/></g></svg>`,
  calculate_margin: `<svg class="i doodle-tool" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="8" cy="6.6" r="2.5"/><path d="M8 9.1v6.5M6 15.6h4"/>
    <path d="M12 10.4h6v6.4h-6z"/>
    <path class="dm-crank" d="M18 12.4l2-1.3"/></svg>`,
  report_blocked: `<svg class="i doodle-tool" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="8" cy="6.6" r="2.5"/><path d="M8 9.1v6.5M6 15.6h4"/>
    <g class="dm-wave"><path d="M14 15.4V8"/><path d="M14 8h5v3.6h-5z"/></g></svg>`,
};

/* 工具渲染注册表：已知工具给专属视图，未知工具走通用兜底 */
const TOOL_RENDERERS = {
  list_documents(obs) {
    const docs = (obs.result || {}).documents || [];
    if (!docs.length) return "";
    return `<div class="t-detail">${docs.map(d => `<div class="doc-row">
      <span class="id">${esc(d.id)}</span>
      <span class="meta2">${esc(d.kind || "")} · ${esc(d.period || "")}</span>
      <span class="grow"></span>
      <span class="meta2">${esc(d.unit_label || d.unit || "")} · ${esc(d.basis || "")}</span>
    </div>`).join("")}</div>`;
  },
  read_document(obs) {
    const r = obs.result || {};
    const body = String(r.body || "");
    return `<div class="t-detail">
      <div class="doc-row"><span class="id">${esc(r.id || "")}</span><span class="meta2">${esc(r.title || "")}</span></div>
      ${body ? `<pre class="doc-body">${esc(body)}</pre>` : ""}
    </div>`;
  },
  normalize_units(obs) {
    const r = obs.result || {};
    return kvDetail([
      ["换算", `${r.source_unit} → ${r.target_unit}`],
      ["系数", `×${num(r.factor)}`],
      ["毛利（元）", num(r.gross_profit_cny)],
    ]);
  },
  reconcile_basis(obs) {
    const r = obs.result || {};
    if (r.reconciled === false) return alertDetail("warn", "无法桥接口径", r.reason || "没有公布的桥接说明");
    return kvDetail([
      ["期间", r.period],
      ["口径", `${r.from_basis} → ${r.to_basis}`],
      ["差异", `${r.delta >= 0 ? "+" : ""}${r.delta}`],
      ["说明", r.reason || ""],
    ]);
  },
  check_restatement(obs) {
    const r = obs.result || {};
    if (!r.restated) return kvDetail([["重述", "无重述记录"]]);
    return kvDetail([
      ["原值 → 重述", `${num(r.original_gross_profit)} → ${num(r.restated_gross_profit)}`],
      ["差异", `${r.delta >= 0 ? "+" : ""}${r.delta}`],
      ["说明", r.reason || ""],
    ]);
  },
  calculate_margin(obs) {
    const r = obs.result || {};
    if (!r.computed) return alertDetail("bad", "无法计算", (r.blockers || []).join("；"));
    return `<div class="t-detail"><div class="t-metrics">
      <div><div class="k">FY2024</div><div class="v">${pct(r.margin_bp_2024)}</div></div>
      <div><div class="k">FY2025</div><div class="v">${pct(r.margin_bp_2025)}</div></div>
      <div><div class="k">变化</div><div class="v ${r.change_bp >= 0 ? "up" : "down"}">${pp(r.change_bp)}</div></div>
    </div></div>`;
  },
  report_blocked(obs) {
    return alertDetail("bad", "声明受阻", (obs.result || {}).reason || "");
  },
  ls_workspace(obs) {
    const entries = (obs.result || {}).entries || [];
    if (!entries.length) return `<div class="t-detail"><div class="doc-row"><span class="id">（空工作区）</span></div></div>`;
    return `<div class="t-detail">${entries.map(entry => `<div class="doc-row">
      <span class="id">${esc(entry.path)}</span>
      <span class="grow"></span>
      <span class="meta2">${num(entry.bytes)} B</span>
    </div>`).join("")}</div>`;
  },
  read_file(obs) {
    const r = obs.result || {};
    const content = String(r.content || "");
    return `<div class="t-detail">
      <div class="doc-row"><span class="id">${esc(r.path || "")}</span><span class="grow"></span><span class="meta2">${num(r.bytes)} B · sha ${esc(shortHash(r.sha256))}…</span></div>
      ${content ? `<pre class="doc-body">${esc(content.slice(0, 4000))}</pre>` : ""}
    </div>`;
  },
  write_file(obs) {
    const r = obs.result || {};
    return kvDetail([
      ["文件", r.path],
      ["状态", r.changed ? "已写入" : "内容未变化"],
      ["大小", `${num(r.bytes)} B`],
      ["写入哈希", `${shortHash(r.sha256_after)}…`],
      ["git commit", r.commit || "—"],
    ]);
  },
  edit_file(obs) {
    const r = obs.result || {};
    return kvDetail([
      ["文件", r.path],
      ["状态", r.changed ? "唯一锚点已替换" : "内容未变化"],
      ["大小", `${num(r.bytes)} B`],
      ["写入哈希", `${shortHash(r.sha256_after)}…`],
      ["git commit", r.commit || "—"],
    ]);
  },
  run_command(obs) {
    const r = obs.result || {};
    return `${kvDetail([
      ["命令", r.command],
      ["退出码", r.exit_code],
      ["耗时", `${num(r.duration_ms)} ms`],
    ])}<div class="t-detail"><pre class="doc-body">${esc(String(r.output || "(no output)").slice(0, 4000))}</pre></div>`;
  },
  fetch_url(obs) {
    const r = obs.result || {};
    return `<div class="t-detail">
      <div class="doc-row"><span class="id">${esc(r.url || "")}</span><span class="grow"></span><span class="meta2">HTTP ${esc(r.status)} · ${num(r.bytes)} B</span></div>
      <div class="doc-row"><span class="meta2">${esc(r.title || "")} · content_truth ${esc(r.content_truth || "not-verified")}</span></div>
      ${r.text ? `<pre class="doc-body">${esc(String(r.text).slice(0, 2400))}</pre>` : ""}
    </div>`;
  },
};

/* 通用兜底：原始值铺成 KV 表，嵌套对象折叠展示——任何工具输出都至少可读 */
function genericToolDetail(obs) {
  const r = obs.result || {};
  if (!r || typeof r !== "object" || Object.keys(r).length === 0) return "";
  const flat = [];
  const nested = [];
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") nested.push([k, v]);
    else flat.push([k, String(v)]);
  }
  const kv = kvDetail(flat);
  const extra = nested.length
    ? `<details class="raw"><summary>嵌套字段</summary><pre>${esc(JSON.stringify(Object.fromEntries(nested), null, 2))}</pre></details>`
    : "";
  if (!kv && !extra) return `<div class="t-detail"><pre class="doc-body">${esc(JSON.stringify(r, null, 2))}</pre></div>`;
  return (kv || "") + extra;
}

function renderToolDetail(obs, kind = "brief") {
  if (kind === "diff") return writeDiffHtml(obs);
  if (kind === "removed") return removedResultHtml(obs);
  return (TOOL_RENDERERS[obs.tool] || genericToolDetail)(obs);
}

/* ================================================== 执行结果四块（对照官方 DisplayBlocks）
   brief   读取类：摘要行 + 展开全文（缺省回退）
   todo    计划变更：前后对照列表（round.plan → round.plan_after）
   diff    写入/追加类：目标对象 + 变更内容；语义色只用于状态点
   removed 拒绝/删除类：弱化呈现，不产生证据 */
const RESULT_BLOCK_KINDS = {
  list_documents: "brief",
  read_document: "brief",
  check_restatement: "brief",
  reconcile_basis: "brief",
  normalize_units: "brief",
  calculate_margin: "brief",
  working_paper_append: "diff",
  collect_source: "diff",
  write_document: "diff",
  report_blocked: "removed",
  ls_workspace: "brief",
  read_file: "brief",
  write_file: "diff",
  edit_file: "diff",
  run_command: "brief",
  fetch_url: "brief",
};

function resultBlockKind(round) {
  if (round.decision && round.decision.allowed === false) return "removed";
  const obs = round.observation || {};
  const step = ((round.proposal || {}).steps || [])[0] || {};
  const tool = obs.tool || (round.decision || {}).tool || step.tool || "";
  return RESULT_BLOCK_KINDS[tool] || "brief";
}

/* 写入/追加类：目标对象 + 变更内容（+/− 行语义，色只做状态点） */
function writeDiffHtml(obs) {
  const args = obs.arguments || {};
  const result = obs.result || {};
  const target = ["target", "doc_id", "document_id", "section", "path"]
    .map(k => args[k])
    .find(v => v !== undefined && v !== null && v !== "")
    || result.target || result.doc_id || "(目标未声明)";
  const added = result.content || result.appended || result.summary || result.text || "";
  const rest = Object.entries(result).filter(([k, v]) =>
    !["content", "appended", "summary", "text", "target", "doc_id"].includes(k)
    && v !== null && v !== undefined && v !== "");
  return `<div class="t-detail block-diff">
    <div class="diff-head">目标 · <code>${esc(String(target))}</code></div>
    ${added ? `<div class="diff-line add"><span class="sign">+</span><span class="body">${esc(String(added))}</span></div>` : ""}
    ${kvDetail(rest)}
  </div>`;
}

/* 拒绝/删除类：弱化呈现 */
function removedResultHtml(obs) {
  const r = obs.result || {};
  const reason = r.reason || r.message || r.blocked || "";
  return `<div class="t-detail block-removed">
    <div class="removed-line">该调用未产生可采信证据 · 结果弱化呈现</div>
    ${reason ? `<div class="removed-why">${esc(String(reason))}</div>` : ""}
  </div>`;
}

/* 计划变更：对照“上一轮的 plan_after → 本轮 plan”。steer 在轮边界前生效，
   所以变更跨轮可见（本轮 plan 的 revision 高于上一轮终态）；轮内
   plan→plan_after 是自然推进，不算变更。 */
function planTodoBlock(round, prevRound) {
  const plan = round.plan;
  if (!plan || !prevRound) return "";
  const before = prevRound.plan_after || prevRound.plan;
  if (!before) return "";
  if (Number(plan.revision || 1) <= Number(before.revision || 1)) return "";
  const beforeMap = new Map((before.todos || []).map(t => [t.id, t]));
  const glyph = { done: "✓", blocked: "✕", abandoned: "–", active: "◐", pending: "○" };
  const rows = (plan.todos || []).map(t => {
    const prev = beforeMap.get(t.id);
    const changed = !prev || prev.status !== t.status || prev.text !== t.text;
    return `<div class="todo-row ${esc(t.status)}${changed ? " changed" : ""}">
      <span class="todo-glyph">${glyph[t.status] || "○"}</span>
      <span class="todo-text">${esc(t.text || t.id)}${t.reason ? ` · ${esc(t.reason)}` : ""}</span>
      ${changed ? `<span class="todo-tag">${esc(prev ? "本轮修订" : "本轮新增")}</span>` : ""}
    </div>`;
  }).join("");
  return `<div class="block-todo">
    <div class="todo-head">计划变更 · rev ${esc(String(before.revision))} → ${esc(String(plan.revision))}</div>
    ${rows}
  </div>`;
}

function outcomeText(round, ann) {
  if (ann && ann.unknown) return "等待显式对账（未知结果不自动重发）";
  const decision = round.decision || {};
  if (decision.allowed === false) return (decision.code || "DENIED") + (decision.reason ? " · " + decision.reason : "");
  if (!round.observation) {
    const hasStep = round.proposal && round.proposal.steps && round.proposal.steps.length;
    return hasStep ? "等待工具结果…" : `已进入第 ${round.index} 轮，等待提议…`;
  }
  return describe(round.observation).map(stripTags).join(" · ");
}

function turnBudgetDelta(round) {
  const before = round.budget_before || {};
  const after = round.budget_after || {};
  const delta = (key) => Number(after[key] ?? 0) - Number(before[key] ?? 0);
  const parts = [];
  const calls = delta("calls_used");
  const reads = delta("reads_used");
  const cost = delta("cost_used_microusd");
  if (calls) parts.push(`calls +${calls}`);
  if (reads) parts.push(`reads +${reads}`);
  if (cost) parts.push(`${num(cost)} µUSD`);
  return parts.join(" · ");
}

function renderRound(round, index, ann = {}, prevRound = null) {
  const empty = !round.proposal && !round.decision && !round.observation && !round.receipt;
  if (empty && ann.terminal) {
    return `<article class="round turn terminal" data-quiet="0" data-open="false">
      <button class="turn-summary" type="button" data-toggle>
        <span class="t-ic">${ICON.term}</span>
        <span class="turn-no">第 ${round.index} 轮</span>
        <span class="turn-tool dim">未完成的轮次</span>
        <span class="turn-state pending"><i class="ev-dot info"></i>TERMINATED</span>
        <span class="turn-budget"></span>
        <span class="chev">▾</span>
      </button>
      <div class="turn-body">
        <div class="proposal-card muted">
          <div class="proposal-args">任务在此终结（${esc(ann.terminal)}）——没有提议落进签名链</div>
        </div>
      </div>
    </article>`;
  }
  if (empty && !ann.unknown) {
    return `<article class="round turn live" data-quiet="0" data-open="true">
      <button class="turn-summary" type="button" data-toggle>
        <span class="t-ic">${ICON.term}</span>
        <span class="turn-no">第 ${round.index} 轮</span>
        <span class="turn-tool dim">等待提议…</span>
        <span class="turn-state pending"><i class="ev-dot info"></i>运行中</span>
        <span class="turn-budget"></span>
        <span class="chev">▾</span>
      </button>
      <div class="turn-body">
        <div class="gate-line pending"><span class="ev-dot info"></span><span>等待模型返回</span></div>
      </div>
    </article>`;
  }
  if (empty) {
    const cause = ann.unknown || "UNKNOWN";
    return `<article class="round turn unknown" data-quiet="0" data-open="true">
      <button class="turn-summary" type="button" data-toggle>
        <span class="t-ic">${ICON.term}</span>
        <span class="turn-no">第 ${round.index} 轮</span>
        <span class="turn-tool dim">模型调用</span>
        <span class="turn-state warn"><i class="ev-dot warn"></i>${esc(cause)}</span>
        <span class="turn-budget"></span>
        <span class="chev">▾</span>
      </button>
      <div class="turn-body">
        <div class="proposal-card muted">
          <div class="proposal-args">未知不等于失败；不自动重发、不退费、不换供应商。</div>
        </div>
        <div class="gate-line pending"><span class="ev-dot warn"></span><span>等待匹配的签名收据显式对账</span></div>
      </div>
    </article>`;
  }

  const obs = round.observation || {};
  const decision = round.decision || {};
  const denied = decision.allowed === false;
  const step = (round.proposal && round.proposal.steps && round.proposal.steps[0]) || null;
  const tool = obs.tool || decision.tool || (step && step.tool) || "—";
  const argsObj = obs.arguments || (step && step.arguments) || {};
  const args = Object.keys(argsObj).length
    ? Object.entries(argsObj).map(([k, v]) => `${esc(k)}=${esc(v)}`).join("  ")
    : "";
  const icon = (!round.observation && !denied && TOOL_DOODLE[tool])
    ? TOOL_DOODLE[tool]
    : (TOOL_ICON[tool] || ICON.term);
  const gateClass = denied ? "denied" : round.observation ? "pass" : "pending";
  const sealSvg = (name, anim) => {
    const set = window.SEAL_ICONS && window.SEAL_ICONS.state;
    const svg = set && set[name];
    return svg ? svg.replace('class="s-icon"', `class="s-icon${anim ? " " + anim : ""}"`) : "";
  };
  const gateText = denied
    ? `主机门控 DENIED · ${decision.code || ""}${decision.reason ? " · " + decision.reason : ""}`
    : !round.observation
      ? "主机门控 · 等待执行"
      : `主机门控 PASS · ${decision.reason || "schema, scope and grant all agree"}`;
  const hash = obs.result_hash || "";
  const raw = { proposal: round.proposal, decision: round.decision, receipt: round.receipt, observation: round.observation };
  const receiptMeta = [
    round.receipt && round.receipt.tokens !== undefined ? `tokens ${num(round.receipt.tokens)}` : "",
    round.receipt && round.receipt.cost_microusd !== undefined ? `${num(round.receipt.cost_microusd)} µUSD` : "",
    round.receipt && round.receipt.latency_ms !== undefined ? `${round.receipt.latency_ms} ms` : "",
    ann.reconciled ? `receipt ${esc(shortHash(ann.reconciled))}…` : "",
  ].filter(Boolean).join(" · ");
  const blockKind = resultBlockKind(round);
  const removedBlock = denied ? `<div class="block-removed standalone">
      <div class="removed-line">提议被主机拒绝 · 未执行 · 不产生证据</div>
      <div class="removed-why">${esc(decision.code || "DENIED")}${decision.reason ? " · " + esc(decision.reason) : ""}</div>
    </div>` : "";

  const gateShort = denied ? "DENIED" : round.observation ? "PASS" : "等待";
  const dotClass = denied ? "bad" : round.observation ? "ok" : "info";
  // ``data-quiet`` is what the folding pass reads: a settled, passed round with
  // nothing the operator must see at rest. The pass also checks the annotation
  // and whether an interjection landed here, so this is only the round's own
  // half of the answer.
  const quiet = isQuietRound(round, ann) ? "1" : "0";
  return `<article class="round turn${!round.observation && !denied ? " live" : ""}" data-open="${denied ? "true" : "false"}" data-quiet="${quiet}">
    <button class="turn-summary" type="button" data-toggle>
      <span class="t-ic">${icon}</span>
      <span class="turn-no">第 ${round.index} 轮</span>
      <span class="turn-tool">${esc(tool)}</span>
      <span class="turn-state ${gateClass}"><i class="ev-dot ${dotClass}"></i>${gateShort}</span>
      <span class="group-size" hidden></span>
      <span class="chev">▾</span>
    </button>
    <div class="turn-body">
      <div class="turn-meta">${esc(turnBudgetDelta(round))}</div>
      ${args ? `<div class="turn-args"><code>${args}</code></div>` : ""}
      <div class="gate-line ${gateClass}">
        <span class="ev-dot ${dotClass}"></span>
        <span class="gate-ico">${sealSvg(denied ? "gate-denied" : "gate-stamp", "stamp-in")}</span><span>${esc(gateText)}</span>
      </div>

      ${round.observation ? `
      <div class="tool-result" data-block="${esc(blockKind)}">
        <div class="tool-result-head">
          <span class="tool-result-title">执行结果 · ${esc(tool)}</span>
          <span class="tool-result-summary">${esc(outcomeText(round, ann)).slice(0, 160)}</span>
        </div>
        <div class="tool-result-body">
          ${renderToolDetail(obs, blockKind)}
          <details class="raw"><summary>完整返回与收据</summary><pre>${esc(JSON.stringify(raw, null, 2))}</pre></details>
        </div>
      </div>` : removedBlock}

      ${planTodoBlock(round, prevRound)}

      <footer class="turn-receipt">
        <code>${hash ? esc(hash) : "result hash pending"}</code>
        <span class="receipt-meta">${esc(receiptMeta)}</span>
        ${hash ? `<button class="copy-mini" type="button" data-copy="${esc(hash)}">复制</button>` : ""}
      </footer>
    </div>
  </article>`;
}

function resultConclusion(result) {
  if (!result || result.change_bp === undefined) return "";
  if (result.comparable === false) return "两期数据口径不可比，不能给出变化结论。";
  const chg = result.change_bp;
  const direction = chg > 0 ? "上升" : chg < 0 ? "下降" : "持平";
  const amount = chg === 0 ? "" : ` ${(Math.abs(chg) / 100).toFixed(2)} 个百分点`;
  return `两期合并毛利率可比：FY2024 ${pct(result.margin_bp_2024)}，FY2025 ${pct(result.margin_bp_2025)}，${direction}${amount}。`;
}

function failureConclusion(failure) {
  const reason = FAILURE_REASONS[failure.code] || failure.message || "运行未能完成";
  return `未能给出结论：${reason}。`;
}

/* ----------------------- RENDER LAYER — 判断面 / 结论后的结构化块 */

function resultUnit(result) {
  if (result.unit) return result.unit;
  const periods = result.periods || [];
  if (periods.some(period => period && (period.gross_profit_cny !== undefined || period.revenue_cny !== undefined))) return "CNY";
  if ((result.citations || []).some(citation => citation && citation.value_cny !== undefined)) return "CNY";
  return "—";
}

/* 判断只属于当前打开的运行；静态 trace 没有可写入的 run id。 */
function reviewRunId() {
  const key = store.key || "";
  if (!key.startsWith("run:")) return null;
  const run = currentRun();
  if (run && run.id) return run.id;
  const s = activeSession();
  if (s && s.id && key === "run:" + s.id) return s.id;
  return null;
}

const reviewStates = new Map();
/* reviewer profile 按作用域缓存；同 module/template/outcome 的同类判断只取一次 */
const reviewProfiles = new Map();

function reviewStateFor(runId) {
  if (!reviewStates.has(runId)) {
    reviewStates.set(runId, { decision: "", reason: "", sending: false, error: "", recorded: null, appending: false });
  }
  return reviewStates.get(runId);
}

function recordedReview(trace, runId) {
  const state = reviewStates.get(runId);
  if (state && state.appending) return null;
  if (state && state.recorded) return state.recorded;
  const events = (trace && trace.events) || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.type !== "review_decided") continue;
    const detail = (event.payload && event.payload.detail) || (event.payload || {});
    return {
      decision: detail.decision || "",
      reason: detail.reason || "",
      reviewer: detail.reviewer || "reviewer",
      sequence: event.sequence !== undefined ? event.sequence : detail.sequence,
    };
  }
  return null;
}

function reviewReasonId(runId) {
  return "review-reason-" + String(runId).replace(/[^a-zA-Z0-9_-]/g, "-");
}

function reviewPanelElement(runId) {
  return [...document.querySelectorAll("[data-review-panel]")]
    .find(panel => panel.dataset.reviewRun === runId) || null;
}

/* --------------------------------------------------------- 你的历史判断
   历史只做参考，不替人拍板：显示同类运行里她以前怎么判，最多把上次的
   决定和理由放回判断面板，提交仍然要她自己点。 */

function reviewProfileParams(trace) {
  const task = (trace && trace.task) || {};
  const binding = task.binding || {};
  const terminal = (trace && trace.terminal) || {};
  return {
    module: binding.module || "",
    template: binding.scenario || "",
    outcome: terminal.status || "",
  };
}

function reviewProfileKey(params) {
  return JSON.stringify([params.module, params.template, params.outcome]);
}

function truncateReviewText(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
}

function latestRecentReview(recent) {
  let best = null;
  let bestKey = -Infinity;
  for (const item of recent) {
    if (!item) continue;
    const sequence = Number(item.sequence);
    const at = Date.parse(item.at);
    const key = Number.isFinite(sequence) ? sequence : (Number.isFinite(at) ? at : -Infinity);
    if (!best || key > bestKey) {
      best = item;
      bestKey = key;
    }
  }
  return best;
}

function reviewProfileHtml(data) {
  const counts = data.counts || {};
  const countText = REVIEW_DECISIONS
    .map(item => `${REVIEW_COUNT_LABEL[item.key]} <b>${Number(counts[item.key] || 0)}</b>`)
    .join(" · ");
  const suggested = data.suggested && REVIEW_DECISION[data.suggested.decision] ? data.suggested : null;
  const recent = Array.isArray(data.recent) ? data.recent : [];
  const latest = latestRecentReview(recent);
  let latestDecision = "";
  let latestReason = "";
  if (latest) {
    latestDecision = latest.decision || "";
    latestReason = latest.reason || "";
  } else if (suggested) {
    latestDecision = suggested.decision || "";
    latestReason = suggested.last_reason || "";
  }
  const label = REVIEW_LABEL[latestDecision] || latestDecision;
  const reasonText = truncateReviewText(latestReason, 72);
  const writable = !!reviewRunId();
  return `<div class="rp-head">
    <span class="rp-kicker">REVIEW PROFILE</span>
    <span class="rp-title">你的历史判断</span>
    <span class="rp-total">同类 <b>${Number(data.total) || 0}</b> 次</span>
  </div>
  <div class="rp-counts">${countText}</div>
  ${label ? `<div class="rp-last"><span class="rp-last-k">上次：</span>${esc(label)}${reasonText ? ` · <span class="rp-reason" title="${esc(latestReason)}">${esc(reasonText)}</span>` : ""}</div>` : ""}
  ${writable && suggested ? `<div class="rp-actions"><button type="button" class="review-apply" data-review-apply="${esc(suggested.decision)}" data-review-apply-reason="${esc(suggested.last_reason || "")}" title="只选中这个判断并填入上次理由，不会自动提交">采用上次判断</button></div>` : ""}`;
}

function paintReviewProfile(key, data) {
  const el = document.querySelector("[data-review-profile]");
  if (!el || el.dataset.reviewProfileKey !== key) return;
  if (!data || !(Number(data.total) > 0)) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.innerHTML = reviewProfileHtml(data);
  el.hidden = false;
}

function loadReviewProfile(trace, options = {}) {
  const el = document.querySelector("[data-review-profile]");
  if (!el) return;
  const params = reviewProfileParams(trace);
  if (!params.module && !params.template) {
    el.hidden = true;
    return;
  }
  const key = reviewProfileKey(params);
  el.dataset.reviewProfileKey = key;
  let entry = reviewProfiles.get(key);
  if (!entry) {
    entry = { data: null, promise: null, token: 0 };
    reviewProfiles.set(key, entry);
  }
  if (entry.data) paintReviewProfile(key, entry.data);
  if (entry.promise && !options.force) return;
  const token = ++entry.token;
  const query = new URLSearchParams();
  if (params.module) query.set("module", params.module);
  if (params.template) query.set("template", params.template);
  if (params.outcome) query.set("outcome", params.outcome);
  const promise = fetch(`/api/review-profile?${query.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  })
    .then(response => (response.ok ? response.json() : null))
    .then(data => {
      if (entry.token !== token) return;
      entry.promise = null;
      if (!data || typeof data !== "object" || !(Number(data.total) > 0)) {
        entry.data = { total: 0, counts: {}, recent: [], suggested: null };
        paintReviewProfile(key, entry.data);
        return;
      }
      entry.data = data;
      paintReviewProfile(key, data);
    })
    .catch(() => {
      if (entry.token === token) entry.promise = null;
      /* 历史判断加载失败不打扰用户：保持隐藏，不弹错误。 */
    });
  entry.promise = promise;
}

function reviewRecordedHtml(recorded) {
  const sequence = recorded.sequence === undefined || recorded.sequence === null ? "—" : recorded.sequence;
  const label = REVIEW_LABEL[recorded.decision] || recorded.decision || "判断记录";
  return `<div class="review-recorded" role="status">
    <span class="review-stamp">已记录</span>
    <span class="rr-sep">·</span>
    <span class="rr-line">${esc(label)} <span class="rr-sep">·</span> #${esc(sequence)}</span>
    <span class="rr-meta">${esc(recorded.reviewer || "reviewer")}</span>
    <button type="button" class="review-append" data-review-append title="在签名链末尾追加一次判断，不覆盖这次记录">追加判断</button>
    ${recorded.reason ? `<p class="rr-reason">${esc(recorded.reason)}</p>` : ""}
  </div>`;
}

function reviewPanelInnerHtml(trace, runId) {
  const recorded = recordedReview(trace, runId);
  if (recorded) return reviewRecordedHtml(recorded);

  const state = reviewStateFor(runId);
  const selected = REVIEW_DECISION[state.decision] || null;
  const disabled = state.sending ? " disabled" : "";
  const reason = String(state.reason || "");
  const choices = REVIEW_DECISIONS.map(item => {
    const active = item.key === state.decision;
    return `<button type="button" class="review-choice${active ? " selected" : ""}" data-review-decision="${esc(item.key)}" aria-pressed="${active ? "true" : "false"}"${disabled}>
      <span class="rc-label">${esc(item.label)}</span>
      <span class="rc-hint">${esc(item.hint)}</span>
    </button>`;
  }).join("");
  const reasonHtml = selected
    ? `<div class="review-reason">
        <div class="review-reason-head">
          <label class="review-reason-label" for="${reviewReasonId(runId)}">判断理由</label>
          <span class="${selected.requiresReason ? "review-required" : "review-optional"}">${selected.requiresReason ? "必填" : "可选"}</span>
        </div>
        <textarea class="review-textarea" id="${reviewReasonId(runId)}" data-review-reason rows="2" maxlength="1000"
          placeholder="${esc(selected.placeholder)}"${disabled}>${esc(reason)}</textarea>
        <div class="review-foot">
          <span class="review-error" data-review-error role="alert"${state.error ? "" : " hidden"}>${esc(state.error || "")}</span>
          <span class="grow"></span>
          <span class="review-count" data-review-count>${reason.length} 字</span>
          <button type="button" class="a-btn strong" data-review-submit${disabled || (selected.requiresReason && !reason.trim()) ? " disabled" : ""}>${state.sending ? "记录中…" : "记录判断"}</button>
        </div>
      </div>`
    : `<p class="review-prompt">先选择你的判断，再写理由。</p>`;
  return `<div class="review-head">
    <span class="review-kicker">REVIEW · 判断记录</span>
    <span class="review-hint">${state.appending ? "追加判断 · 写入签名链" : "reviewer · 写入签名链"}</span>
  </div>
  <div class="review-choices" role="group" aria-label="判断决定">${choices}</div>
  ${reasonHtml}`;
}

function reviewPanelHtml(trace) {
  const runId = reviewRunId();
  if (!runId) {
    return `<div class="review review-readonly">
      <div class="review-head">
        <span class="review-kicker">REVIEW · 判断记录</span>
        <span class="review-hint">只读</span>
      </div>
      <p>只读回放 · 没有可写入的运行 id，判断不会进入签名链。</p>
    </div>`;
  }
  return `<div class="review" data-review-panel data-review-run="${esc(runId)}">${reviewPanelInnerHtml(trace, runId)}</div>`;
}

function paintReviewPanel(runId) {
  const panel = reviewPanelElement(runId);
  if (!panel) return;
  const trace = shownTrace() || {};
  panel.innerHTML = reviewPanelInnerHtml(trace, runId);
}

function chooseReviewDecision(runId, decision) {
  if (!runId || !REVIEW_DECISION[decision]) return;
  const state = reviewStateFor(runId);
  if (state.sending || (state.recorded && !state.appending)) return;
  state.decision = decision;
  state.error = "";
  paintReviewPanel(runId);
  const panel = reviewPanelElement(runId);
  const textarea = panel && panel.querySelector("[data-review-reason]");
  if (textarea) textarea.focus();
}

/* 追加判断：后端追加事件，不覆盖已有记录；本地先把记录卡收回成判断面板。 */
function startAppendReview(runId) {
  if (!runId) return;
  const state = reviewStateFor(runId);
  if (state.sending) return;
  state.appending = true;
  state.recorded = null;
  state.decision = "";
  state.reason = "";
  state.error = "";
  paintReviewPanel(runId);
  const panel = reviewPanelElement(runId);
  const first = panel && panel.querySelector("[data-review-decision]");
  if (first) first.focus({ preventScroll: true });
}

/* 采用上次判断只做两件事：选中决定、填入上次理由；绝不自动提交。 */
function applyReviewSuggestion(runId, decision, reason) {
  if (!runId || !REVIEW_DECISION[decision]) return;
  const state = reviewStateFor(runId);
  if (state.sending) return;
  const trace = shownTrace() || {};
  if (!state.appending && recordedReview(trace, runId)) {
    state.appending = true;
    state.recorded = null;
  }
  state.decision = decision;
  state.reason = String(reason || "");
  state.error = "";
  paintReviewPanel(runId);
  const panel = reviewPanelElement(runId);
  const textarea = panel && panel.querySelector("[data-review-reason]");
  if (textarea) {
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }
}

function syncReviewDraft(runId, panel, input) {
  const state = reviewStateFor(runId);
  state.reason = input.value;
  state.error = "";
  const selected = REVIEW_DECISION[state.decision];
  const submit = panel.querySelector("[data-review-submit]");
  if (submit) submit.disabled = !!state.sending || !!(selected && selected.requiresReason && !input.value.trim());
  const count = panel.querySelector("[data-review-count]");
  if (count) count.textContent = `${input.value.length} 字`;
  const error = panel.querySelector("[data-review-error]");
  if (error && !error.hidden) {
    error.hidden = true;
    error.textContent = "";
  }
}

function reviewErrorText(data, status) {
  const raw = data && (data.error || data.message || data.detail);
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw) {
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  return `HTTP ${status}`;
}

/* 判断落链后后端会重建 trace；这里把新 trace 拉回来，报告才能带上刚追加的事件。 */
const reviewTraceRefreshes = new Map();

function refreshReviewedTrace(runId) {
  if (!runId) return Promise.resolve(null);
  const promise = fetch(runTraceUrl(runId), { cache: "no-store" })
    .then(response => (response.ok ? response.json() : null))
    .then(trace => {
      if (!trace || !Array.isArray(trace.events)) return null;
      cache.set("run:" + runId, trace);
      if (store.key !== "run:" + runId) return trace;
      store.trace = trace;
      const s = activeSession();
      if (s && s.id === runId) s.trace = trace;
      verifyChain(trace).then(check => {
        if (store.key !== "run:" + runId) return;
        store.check = check;
        setChainBadge(check);
      }).catch(() => { /* 链验证失败不阻断判断记录 */ });
      return trace;
    })
    .catch(() => null)
    .finally(() => {
      if (reviewTraceRefreshes.get(runId) === promise) reviewTraceRefreshes.delete(runId);
    });
  reviewTraceRefreshes.set(runId, promise);
  return promise;
}

async function submitReview(runId) {
  if (!runId) return;
  const state = reviewStateFor(runId);
  const decision = REVIEW_DECISION[state.decision];
  if (!decision || state.sending || (state.recorded && !state.appending)) return;
  const reason = String(state.reason || "").trim();
  if (decision.requiresReason && !reason) {
    state.error = "请填写判断理由：说明缺什么材料、保留什么，或为什么退回。";
    paintReviewPanel(runId);
    const panel = reviewPanelElement(runId);
    const textarea = panel && panel.querySelector("[data-review-reason]");
    if (textarea) textarea.focus();
    return;
  }
  state.sending = true;
  state.error = "";
  paintReviewPanel(runId);
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: state.decision, reason, reviewer: "reviewer" }),
    });
    let data = {};
    try { data = await response.json(); } catch { /* 非 JSON 错误也走可读提示 */ }
    if (!response.ok || (data && data.ok === false)) {
      throw new Error(reviewErrorText(data, response.status));
    }
    const event = data.event || {};
    const sequence = data.sequence !== undefined ? data.sequence : event.sequence;
    state.recorded = {
      decision: data.decision || state.decision,
      reason,
      reviewer: "reviewer",
      sequence,
    };
    state.sending = false;
    state.appending = false;
    state.decision = "";
    state.reason = "";
    state.error = "";
    paintReviewPanel(runId);
    loadReviewProfile(shownTrace() || {}, { force: true });
    refreshReviewedTrace(runId);
    const label = REVIEW_LABEL[state.recorded.decision] || state.recorded.decision;
    toast(`已记录 · ${label} · #${sequence === undefined || sequence === null ? "—" : sequence}`);
  } catch (error) {
    state.sending = false;
    state.error = `记录失败：${error && error.message ? error.message : "网络错误"}`;
    paintReviewPanel(runId);
  }
}

function judgmentFactsHtml(result) {
  const periods = result.periods || [];
  const first = periods[0] || {};
  const second = periods[1] || {};
  const sources = (result.citations || [])
    .filter(citation => citation && citation.doc_id)
    .map(citation => `${citation.period ? citation.period + " " : ""}${citation.doc_id}`);
  return `<div class="judgment-facts">
    <span class="jf"><span class="jk">${esc(first.period || "FY2024")}</span><span class="jv">${pct(result.margin_bp_2024)}</span></span>
    <span class="jf"><span class="jk">${esc(second.period || "FY2025")}</span><span class="jv">${pct(result.margin_bp_2025)}</span></span>
    <span class="jf"><span class="jk">变化</span><span class="jv">${pp(result.change_bp)}</span></span>
    ${sources.length ? `<span class="judgment-source">来源 ${esc(sources.join(" · "))}</span>` : ""}
  </div>`;
}

function judgmentRowsHtml(result) {
  const comparable = result.comparable === true ? "可比" : result.comparable === false ? "不可比" : "未标注";
  const basis = result.basis || "—";
  const restatement = result.restatement_applied ? "已应用重述" : "未应用重述";
  return `<div class="judgment-rows">
    <div class="jrow"><span class="jk">可比性</span><span class="jv"><b>${esc(comparable)}</b> · 准则 ${esc(basis)} · ${esc(restatement)}</span></div>
    <div class="jrow"><span class="jk">单位/准则</span><span class="jv"><b>已归一</b> · ${esc(resultUnit(result))} · ${esc(basis)}</span></div>
  </div>`;
}

function judgmentSurfaceHtml(trace, result) {
  const citations = (result.citations || []).length;
  return `<section class="judgment" aria-label="判断面">
    <div class="judgment-head">
      <span class="judgment-kicker">JUDGMENT · 判断面</span>
      <span class="judgment-meta">${esc(result.verification || "runtime-recomputed")}${citations ? ` · ${citations} 处引用` : ""}</span>
    </div>
    ${judgmentFactsHtml(result)}
    ${judgmentRowsHtml(result)}
    <div class="judgment-block">
      <div class="jk">解释候选</div>
      <div class="j-explanations">
        <div class="j-exp">
          <div class="j-exp-head"><span class="j-exp-title">经营变化</span><span class="j-tag pending">剩余解释</span></div>
          <div class="j-exp-note">缺分产品/销量数据，无法区分价格 vs 结构</div>
        </div>
        <div class="j-exp">
          <div class="j-exp-head"><span class="j-exp-title">口径/重述</span><span class="j-tag ok">已核对 · 已排除</span></div>
        </div>
        <div class="j-exp">
          <div class="j-exp-head"><span class="j-exp-title">单位/准则</span><span class="j-tag ok">已核对 · 已排除</span></div>
        </div>
      </div>
    </div>
    <div class="judgment-block">
      <div class="jk">待判断</div>
      <ol class="j-pending">
        <li>是否接受“经营变化”</li>
        <li>是否需要补充分产品数据</li>
      </ol>
    </div>
    <div class="judgment-impact">
      <span class="jk">会影响结论</span>
      <span>分产品毛利缺失时，应保留意见</span>
    </div>
    <div class="review-profile" data-review-profile hidden></div>
    ${reviewPanelHtml(trace)}
  </section>`;
}

function failureJudgmentHtml(trace, terminal) {
  const failure = terminal.failure || {};
  const code = failure.code || String(terminal.status || "failed").toUpperCase();
  const message = failure.message || FAILURE_REASONS[failure.code] || "";
  return `<section class="judgment judgment-fail" aria-label="判断面">
    <div class="judgment-head">
      <span class="judgment-kicker">JUDGMENT · 判断面</span>
      <span class="judgment-meta">${esc(terminal.status || "failed")} · 未产出可签字结论</span>
    </div>
    <div class="judgment-fail-note">
      <span class="jk">失败依据</span>
      <code>${esc(code)}</code>
      ${message ? `<span class="jv">${esc(message)}</span>` : ""}
    </div>
    <p class="judgment-empty">失败不补解释；只记录你对失败依据的判断。</p>
    <div class="review-profile" data-review-profile hidden></div>
    ${reviewPanelHtml(trace)}
  </section>`;
}

function generalResultHtml(trace, result, artifacts) {
  const plan = result.plan || {};
  const truth = (artifacts.find(entry => entry.content_truth) || {}).content_truth || "runtime-verified-file-state";
  return `<div class="card result">
    <div class="card-head">
      <span class="card-title">${ICON.inkTick} 产物</span>
      <span class="badge pass" style="margin-left:2px">${doodleSvg("shield-check", "draw")}<span>已验证</span></span>
      <span class="grow"></span>
      <span class="card-meta">succeeded · ${esc(result.verification || "runtime-recomputed")}</span>
    </div>
    <p class="result-answer">通用委托已完成；${artifacts.length} 个文件通过 Runtime 文件状态复核。</p>
    <div class="metrics">
      ${artifacts.map(entry => `<div class="metric"><div class="k">${esc(entry.path)}</div><div class="v">${num(entry.bytes)} B</div></div>`).join("")}
      <div class="metric"><div class="k">计划</div><div class="v">${esc(plan.done ?? "—")}/${esc(plan.total ?? "—")}</div></div>
    </div>
    <div class="proof-line">
      <span class="proof-mark">已复算</span>
      <span>${esc(result.verification || "runtime-recomputed")}</span>
      <span class="proof-sep">·</span>
      <span>${artifacts.length} 个文件</span>
      <span class="proof-sep">·</span>
      <span>${(trace.events || []).length} 个事件</span>
    </div>
    <div class="result-foot">
      <div class="chips" style="margin-top:2px">
        ${artifacts.map(entry => `<span class="mini" title="${esc(entry.sha256 || "")}">${esc(entry.path)} · ${esc(shortHash(entry.sha256))}…</span>`).join("")}
        <span class="mini">${esc(truth)}</span>
      </div>
      ${runActionsHtml(trace)}
    </div>
  </div>`;
}

function renderResult(trace) {
  const terminal = trace.terminal || {};
  const result = terminal.result || {};
  const failure = terminal.failure || {};

  if (terminal.status === "succeeded" && result.change_bp !== undefined) {
    const chg = result.change_bp;
    return `<div class="card result">
      <div class="card-head">
        <span class="card-title">${ICON.inkTick} 结论</span>
        <span class="badge pass" style="margin-left:2px">${doodleSvg("shield-check", "draw")}<span>已验证</span></span>
        <span class="grow"></span>
        <span class="card-meta">succeeded · runtime-recomputed</span>
      </div>
      <p class="result-answer">${esc(resultConclusion(result))}</p>
      <div class="metrics">
        <div class="metric"><div class="k">FY2024 毛利率</div><div class="v">${pct(result.margin_bp_2024)}</div></div>
        <div class="metric"><div class="k">FY2025 毛利率</div><div class="v">${pct(result.margin_bp_2025)}</div></div>
        <div class="metric"><div class="k">变化</div><div class="v ${chg >= 0 ? "up" : "down"}">${pp(chg)}</div></div>
      </div>
      <div class="proof-line">
        <span class="proof-mark">已复算</span>
        <span>Runtime 独立重算通过</span>
        <span class="proof-sep">·</span>
        <span>${(result.citations || []).length} 处引用</span>
        <span class="proof-sep">·</span>
        <span>${(trace.events || []).length} 个事件</span>
      </div>
      <div class="result-foot">
        <div class="chips" style="margin-top:2px">
          <span class="mini">口径 ${esc(result.basis)} · ${esc(result.consolidation)}</span>
          <span class="mini">${result.restatement_applied ? "已应用 FY2024 重述" : "无重述"}</span>
          ${(result.citations || []).map(c => `<span class="mini">${esc(c.period)} · ${esc(c.doc_id)}</span>`).join("")}
        </div>
        ${runActionsHtml(trace)}
      </div>
    </div>
    ${judgmentSurfaceHtml(trace, result)}`;
  }

  if (terminal.status === "succeeded") {
    const artifacts = Array.isArray(result.results)
      ? result.results.filter(entry => entry && entry.path)
      : (result.path ? [result] : []);
    if (artifacts.length) return generalResultHtml(trace, result, artifacts);
    return `<div class="card result">
      <div class="card-head">
        <span class="card-title">${ICON.inkTick} 结论</span>
        <span class="badge pass" style="margin-left:2px">${doodleSvg("shield-check", "draw")}<span>已验证</span></span>
        <span class="grow"></span>
        <span class="card-meta">succeeded</span>
      </div>
      <p class="result-answer">任务已完成，结果通过 Runtime 独立校验。</p>
      <div class="proof-line"><span class="proof-mark">已校验</span><span>Runtime 独立重算通过</span></div>
      <div class="result-foot">${runActionsHtml(trace)}</div>
    </div>`;
  }

  return `<div class="card result">
    <div class="card-head">
      <span class="card-title">${ICON.alert} 未能得出结论</span>
      <span class="badge ${stateClass(terminal.status)}" style="margin-left:2px"><span class="dot"></span>${esc(terminal.status || "?")}</span>
      <span class="grow"></span>
      <span class="card-meta">序列 ${esc(terminal.sequence)}</span>
    </div>
    <p class="result-answer">${esc(failureConclusion(failure))}</p>
    <div class="fail-line">
      <span class="code">${esc(failure.code || "—")}</span>
      <span class="msg">${esc(failure.message || "")}</span>
    </div>
    <div class="result-foot">${runActionsHtml(trace)}</div>
  </div>
  ${failureJudgmentHtml(trace, terminal)}`;
}

function annotateRounds(trace) {
  const rounds = trace.rounds || [];
  const events = trace.events || [];
  const unknowns = events.filter(e => e.type === "model_unknown");
  const reconciles = events.filter(e => e.type === "model_reconciled");
  const annotations = [];
  let u = 0, r = 0, pendingIndex = null;
  for (const round of rounds) {
    const empty = !round.proposal && !round.decision && !round.observation && !round.receipt;
    const ann = {};
    if (empty && u < unknowns.length) {
      const ev = unknowns[u++];
      ann.unknown = ((ev.payload || {}).detail || {}).cause || "UNKNOWN";
      pendingIndex = round.index;
    } else if (!empty && pendingIndex !== null && pendingIndex === round.index && r < reconciles.length) {
      const ev = reconciles[r++];
      ann.reconciled = ((ev.payload || {}).detail || {}).receipt_ref || "";
      pendingIndex = null;
    } else if (!empty && pendingIndex !== null && pendingIndex !== round.index) {
      pendingIndex = null;
    }
    annotations.push(ann);
  }
  const terminal = (trace.terminal || {}).status || "";
  if (terminal && rounds.length) {
    const lastIndex = rounds.length - 1;
    const round = rounds[lastIndex];
    const empty = !round.proposal && !round.decision && !round.observation && !round.receipt;
    if (empty && annotations[lastIndex] && !annotations[lastIndex].unknown) {
      annotations[lastIndex].terminal = terminal;
    }
  }
  return annotations;
}

function renderHead(trace, title) {
  const task = trace.task || {};
  const heading = title || task.id || "FCode";
  document.getElementById("tb-title").textContent = heading;
  const bridge = desktopBridge();
  if (bridge && bridge.set_title) bridge.set_title(heading);
  document.getElementById("tb-chips").innerHTML = "";
}

/* RENDER LAYER — 舞台式空状态：标识、字标与提示；composer 由 setStageMode
   以单实例 appendChild 搬进 stage-dock，模板 chips 在其下。 */
function stageEmptyHtml(note = "还没有运行记录", opts = {}) {
  const badge = opts.work ? `<span class="stage-badge">WORK</span>` : "";
  return `<section class="stage-empty" aria-label="空状态">
    <img class="stage-logo" src="brand/logo.svg" alt="FCode" width="56" height="56">
    <div class="stage-mark">FCode${badge}</div>
    <p class="stage-note">${esc(note)}</p>
    <div class="stage-dock" id="stage-dock"></div>
    <div class="stage-chips" id="stage-chips" aria-label="按模板开始委托"${opts.work ? "" : " hidden"}></div>
    ${opts.work ? `<p class="stage-foot">${esc(WORK_STAGE_FOOTNOTE)}</p>` : ""}
  </section>`;
}

/* RENDER LAYER — composer 双形态（对齐 kimi.com 的居中舞台 → 吸底节奏）。
   单实例搬运：同一个 .composer 节点在 footer 与舞台容器之间 appendChild，
   不复制第二份 DOM；事件绑定都在 composer 内部元素上，随节点走零风险。 */
function setStageMode(on) {
  const app = document.getElementById("app");
  if (!app) return;
  const composer = document.querySelector(".composer-wrap > .composer, .stage-dock > .composer");
  if (!composer) return;
  const dock = document.getElementById("stage-dock");
  const wrap = document.querySelector(".composer-wrap");
  if (on && dock && composer.parentElement !== dock) {
    dock.appendChild(composer);
    renderStageChips();
  } else if (!on && wrap && composer.parentElement !== wrap) {
    wrap.appendChild(composer);
  }
  app.classList.toggle("stage-mode", !!on);
}

/* 居中 composer 下的模板 chips：与 composer 模板选择器同源（/api/templates），
   点击 = 选中该模板 + 预填目标 + 聚焦，是真实委托入口。

   七条可靠性场景（越权工具/预算耗尽/崩溃恢复/未知结果/目标无法完成…）是这台机器
   的故障注入夹具，用来证明门控与恢复是真的——它们是演示素材，不是产品前门。
   因此真实任务模板直接露出，夹具收进折叠的「演示场景」里，仍然可达。 */
/* 只有故障注入的那几个才算演示场景——它们演示的是"这台机器出错时如实交代"，
   属于可靠的证据，不属于任务形态。「完整研究」是真任务，留在前台。 */
const DEMO_SCENARIOS = new Set([
  "tool-denied", "budget", "budget-resume", "crash", "unknown", "open-ended",
]);

function renderStageChips() {
  const slot = document.getElementById("stage-chips");
  if (!slot) return;
  const source = (templates && templates.length)
    ? templates.map(t => [t.key, (t.title || t.key).split("：")[0]])
    : SCENARIOS.map(([key, label]) => [key, label]);
  const tasks = source.filter(([key]) => !DEMO_SCENARIOS.has(key));
  const demos = source.filter(([key]) => DEMO_SCENARIOS.has(key));
  const chip = ([key, label]) =>
    `<button type="button" class="stage-chip" data-stage-chip="${esc(key)}" title="以「${esc(label)}」模板开始委托">${esc(label)}</button>`;
  slot.innerHTML = [
    tasks.map(chip).join(""),
    demos.length ? `<details class="stage-demos"><summary>演示场景 · ${demos.length}</summary>
      <div class="stage-demo-chips">${demos.map(chip).join("")}</div>
      <p class="stage-demo-note">可靠性夹具：故意触发越权、耗尽预算、杀掉进程或制造未知结果，用来看门控与恢复是否如实。</p>
    </details>` : "",
  ].join("");
}

/* RENDER LAYER — 阅读列会话头：标题下方一行 meta；证据面板按需打开。 */
function sessionHeadHtml(trace, title, note = "") {
  const task = trace.task || {};
  const binding = task.binding || {};
  const grant = task.model_grant || {};
  const moduleKey = binding.module || "";
  const moduleTitle = moduleKey
    ? ((modules.find(item => item.key === moduleKey) || {}).title || moduleKey)
    : "";
  const meta = [
    moduleTitle,
    binding.corpus,
    task.id,
    grant.grant_id ? `${grant.grant_id} · r${grant.revision ?? ""}` : "",
    note,
  ].filter(Boolean).map(item => esc(item)).join(" · ");
  const origin = (binding.spec || {}).origin_thread || null;
  const originChip = origin
    ? `<button class="meta-button origin-chip" type="button" data-origin-thread="${esc(origin.threadId || "")}" title="来自对话${origin.threadTitle ? "：" + esc(origin.threadTitle) : ""} · 点击跳回">来自对话${origin.threadTitle ? " · " + esc(origin.threadTitle.slice(0, 18)) : ""}</button>`
    : "";
  const name = (currentRun() && currentRun().name) || shortObjective(task.objective || "") || "未命名委托";
  return `<header class="session-head">
    <p class="session-kicker">${esc(title || task.id || "运行")}</p>
    <h1 class="session-title">${esc(name)}</h1>
    <div class="session-meta">
      <span>${meta}</span>
      ${originChip}
      <span class="grow"></span>
      <button class="meta-button" type="button" data-rail-open>事件 / 链验证</button>
    </div>
  </header>`;
}

function setChainBadge(check) {
  const badge = document.getElementById("chain-badge");
  badge.className = "chain-pill " + (check.ok ? "ok" : "bad");
  const shield = (check.ok && window.DOODLE_ICONS && window.DOODLE_ICONS.animated
    && window.DOODLE_ICONS.animated["shield-check"]) || "";
  badge.innerHTML = check.ok
    ? `${shield}<span>链验证通过 · ${check.events} events</span>`
    : `<span class="dot"></span><span>链断裂 · ${esc(check.reason)}</span>`;
}

/* RENDER LAYER — 纯 UI 开关：侧栏折叠与证据浮层不接触运行状态。 */
function setChromeState({ sidebar = null, rail = null } = {}) {
  const app = document.getElementById("app");
  if (!app) return;
  if (sidebar !== null) {
    app.classList.toggle("side-collapsed", sidebar);
    const sideToggle = document.getElementById("sidebar-toggle");
    if (sideToggle) {
      const label = sidebar ? "展开侧栏" : "折叠侧栏";
      sideToggle.title = label;
      sideToggle.setAttribute("aria-label", label);
    }
  }
  if (rail !== null) {
    railOpen = rail;
    app.classList.toggle("rail-open", rail);
    app.classList.toggle("rail-hidden", !rail);
  }
}

function bindToggles(root) {
  /* toggle 已改为 #main 上的事件委托（bind()），这里保留空实现以兼容旧调用 */
}

async function render(trace, title) {
  store.trace = trace;
  const check = await verifyChain(trace);
  store.check = check;
  const task = trace.task || {};
  const terminal = trace.terminal || {};
  const rounds = trace.rounds || [];
  const model = trace.model || {};
  const anns = annotateRounds(trace);

  renderHead(trace, title);
  setChainBadge(check);

  const started = (trace.events && trace.events[0] && trace.events[0].at)
    ? String(trace.events[0].at).replace("T", " ").slice(0, 19) : "";
  const events = (trace.events || []).length;
  const note = `Fcode · ${rounds.length} 轮 · ${events} 个事件 · ${check.ok ? "全链验证通过" : "链验证失败"}${started ? " · " + started + "Z" : ""}`;

  renderMain(`
    ${sessionHeadHtml(trace, title, note)}
    ${objectiveMsgHtml(trace)}
    <details class="process-details" id="thought">
      <summary class="process-head">
        <span>计划与预算</span>
        <span class="thought-meta">${thoughtMeta(trace)}</span>
        <span class="grow"></span>
        <span class="chev">▾</span>
      </summary>
      <div class="process-body">
        <div id="plan-slot">${renderPlan(lastPlan(trace))}</div>
        <div id="budget-slot">${renderMeters(trace)}</div>
      </div>
    </details>
    <section class="turns" id="turns" aria-label="运行时间轴">
      <div id="rounds-slot">${rounds.map((r, i) => roundWrapHtml(messagesByRound(trace), r, anns[i], i > 0 ? rounds[i - 1] : null)).join("")}</div>
      <div id="approval-slot"></div>
      <div id="queued-slot"></div>
    </section>
    <div id="result-slot">${terminal && terminal.status ? renderResult(trace) : ""}</div>
  `, { mode: "run" });
  applyRoundFolding();

  if (terminal && terminal.status) loadReviewProfile(trace);
  setFoot(
    `${model.provider || "—"} · ${store.key && store.key.startsWith("run:") ? "运行记录" : "只读回放"}`,
    ""
  );
  renderRail(trace, check);
  updateStatusline();
}

/* -- LOGIC LAYER + RENDER SLOT — SSE/差异渲染状态机不可改；仅模板字符串可改 */

function nearMainBottom() {
  const el = document.querySelector(".main");
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90;
}
function scrollMainBottom() {
  const el = document.querySelector(".main");
  el.scrollTop = el.scrollHeight;
}

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 132) + "px";
}

function liveShell(trace) {
  const task = trace.task || {};
  renderMain(`
    ${sessionHeadHtml(trace, "运行 · " + tplTitle(trace.task && trace.task.binding ? trace.task.binding.scenario : ""), "已提交，等待 Runtime 启动…")}
    ${objectiveMsgHtml(trace)}
    <p class="live-note" id="live-note" aria-live="polite">已提交，等待 Runtime 启动…</p>
    <details class="process-details" id="thought" open>
      <summary class="process-head">
        <span>计划与预算</span>
        <span class="thought-meta" id="thought-meta">启动中</span>
        <span class="grow"></span>
        <span class="chev">▾</span>
      </summary>
      <div class="process-body">
        <div id="plan-slot"></div>
        <div id="budget-slot"></div>
      </div>
    </details>
    <section class="turns" id="turns" aria-label="运行时间轴">
      <div id="rounds-slot"></div>
      <div id="approval-slot"></div>
      <div id="queued-slot"></div>
    </section>
    <div id="result-slot"></div>`, { mode: "run" });
  const summary = document.querySelector("#thought > summary");
  if (summary) summary.addEventListener("click", () => { const s = activeSession(); if (s) s.thoughtPinned = true; });
  applyRoundFolding();
}

function liveNote(trace) {
  const events = trace.events || [];
  const rounds = trace.rounds || [];
  const terminal = trace.terminal || {};
  const s = activeSession();
  if (s && s.pending) return `<span class="yel">等待你的决定 · ${esc(s.pending.tool)}</span>`;
  if (terminal.status) {
    const code = (terminal.failure || {}).code;
    const label = terminal.status === "succeeded" ? "已完成" : "已结束";
    return `${label} · ${rounds.length} 轮 · ${events.length} 个事件${code ? " · " + esc(code) : ""} · 过程见思考链`;
  }
  return `Fcode 正在处理${rounds.length ? ` · 第 ${rounds.length} 轮` : ""} · ${events.length} 个事件 · 过程见思考链`;
}

function thoughtMeta(trace) {
  const rounds = (trace.rounds || []).length;
  const events = (trace.events || []).length;
  const plan = lastPlan(trace);
  const total = plan && plan.todos ? plan.todos.length : 0;
  const done = plan && plan.todos ? plan.todos.filter(t => t.status === "done").length : 0;
  return `${rounds} 轮 · ${events} 事件${total ? ` · ${done}/${total} 步` : ""}`;
}

function liveApply(s, data) {
  const trace = data.snapshot;
  if (!trace) return;
  const stick = nearMainBottom();
  const first = !s.trace;
  const running = !data.finished && !s.finished;
  s.trace = trace;
  s.lastData = data;
  store.trace = trace;
  store.key = "run:" + s.id;
  store.check = { ok: true, live: true, events: (trace.events || []).length };

  const scenario = trace.task && trace.task.binding ? trace.task.binding.scenario : s.template;
  renderHead(trace, "运行 · " + tplTitle(scenario));

  if (first) {
    liveShell(trace);
    s.planHtml = "";
    s.budgetHtml = "";
    s.resultHtml = "";
    s.roundHtml = [];
    s.eventCount = 0;
  }

  const eventList = trace.events || [];
  const events = eventList.length;

  const pending = data.pending || null;
  if (pending && (!s.pending || s.pending.id !== pending.id)) {
    s.pendingDeadline = Date.now() + (Number(pending.expiresIn) || 0) * 1000;
    s.deciding = null;
  }
  if (!pending) s.deciding = null;
  s.pending = pending;

  const thoughtMetaEl = document.getElementById("thought-meta");
  if (thoughtMetaEl) thoughtMetaEl.textContent = thoughtMeta(trace);

  // 消息入链回执：排队中的消息一旦以 operator_message 事件落进快照，就移出排队区
  if (s.queuedMsgs && s.queuedMsgs.length) {
    const deliveredIds = new Set();
    const deliveredTexts = new Set();
    for (const e of eventList) {
      if (e.type !== "operator_message") continue;
      const d = (e.payload || {}).detail || {};
      if (d.message_id) deliveredIds.add(String(d.message_id));
      deliveredTexts.add(String(d.text || ""));
    }
    const before = s.queuedMsgs.length;
    s.queuedMsgs = s.queuedMsgs.filter(m => {
      const hit = (m.serverId && deliveredIds.has(m.serverId))
        || (!m.serverId && deliveredTexts.has(m.text));
      if (hit) m.state = "delivered";
      return !hit;
    });
    if (s.queuedMsgs.length !== before) toast("消息已入链 · 下轮生效");
  }

  // 队列权威同步：server 队列是事实源（SSE 帧携带）；在出链回执之后执行，
  // 消费竞态下最多闪现一帧，不吞掉回执提示
  if (Array.isArray(data.queue)) reconcileQueue(s, data.queue);

  if (s.planQueued && events > s.planQueued.events) {
    const added = eventList.slice(s.planQueued.events);
    if (added.some(e => e.type === "plan_steered")) {
      s.planQueued = null;
      toast("计划已修订");
    } else if (added.some(e => e.type === "control_rejected" && ((e.payload || {}).detail || {}).kind === "plan")) {
      s.planQueued = null;
      toast("计划指令被拒绝");
    }
  }
  if (s.budgetQueued && events > s.budgetQueued.events) {
    const added = eventList.slice(s.budgetQueued.events);
    if (added.some(e => e.type === "budget_adjusted")) {
      s.budgetQueued = null;
      toast("预算已生效");
    } else if (added.some(e => e.type === "control_rejected" && ((e.payload || {}).detail || {}).kind === "budget")) {
      s.budgetQueued = null;
      toast("预算调整被拒绝");
    }
  }

  const planHtml = renderPlan(lastPlan(trace), {
    editable: running,
    editing: s.planEditing,
    confirmId: s.planConfirm,
    queued: s.planQueued ? s.planQueued.label : "",
  });
  if (planHtml !== s.planHtml) {
    const slot = document.getElementById("plan-slot");
    if (slot) slot.innerHTML = planHtml;
    s.planHtml = planHtml;
  }

  const budgetHtml = renderMeters(trace, {
    editable: running,
    editing: s.budgetEditing,
    queued: !!s.budgetQueued,
    live: running,
  });
  if (budgetHtml !== s.budgetHtml) {
    const slot = document.getElementById("budget-slot");
    if (slot) slot.innerHTML = budgetHtml;
    s.budgetHtml = budgetHtml;
  }

  syncLiveRounds(s, trace);

  const approvalKey = pending
    ? `${pending.id}:${s.deciding ? (s.deciding.allow ? "allow" : "deny") : ""}`
    : "";
  if (approvalKey !== s.approvalKey) {
    s.approvalKey = approvalKey;
    paintApproval();
  }

  const resultHtml = trace.terminal && trace.terminal.status ? renderResult(trace) : "";
  if (resultHtml !== s.resultHtml) {
    const slot = document.getElementById("result-slot");
    if (slot) slot.innerHTML = resultHtml;
    s.resultHtml = resultHtml;
  }
  if (resultHtml) loadReviewProfile(trace);

  const thought = document.getElementById("thought");
  if (thought && !s.thoughtPinned) {
    const open = running || !!pending;
    if (thought.open !== open) thought.open = open;
  }

  const note = document.getElementById("live-note");
  if (note) note.innerHTML = liveNote(trace);

  if (events !== s.eventCount) {
    s.eventCount = events;
    const railBody = document.getElementById("rail-body");
    const railStick = railBody.scrollHeight - railBody.scrollTop - railBody.clientHeight < 60;
    renderRail(trace, store.check);
    if (railStick) railBody.scrollTop = railBody.scrollHeight;
  }

  if (trace.terminal && trace.terminal.status) {
    const runId = s.id;
    verifyChain(trace).then(check => {
      if (!sessions.has(runId) || store.key !== "run:" + runId) return;
      store.check = check;
      setChainBadge(check);
      renderRail(trace, check);
    });
  } else {
    const badge = document.getElementById("chain-badge");
    badge.className = "chain-pill";
    badge.innerHTML = `<span class="dot" style="background:var(--accent)"></span><span>签名中 · ${events} events</span>`;
  }

  const chip = document.getElementById("run-chip-text");
  if (chip) {
    const rounds = (trace.rounds || []).length;
    chip.textContent = pending
      ? `等待授权${rounds ? " · 第 " + rounds + " 轮" : ""}`
      : (rounds ? `运行中 · 第 ${rounds} 轮` : "运行中");
  }

  if (stick) scrollMainBottom();
  updateStatusline();
}

/* 已入链的运行中消息，按其生效轮次分组（detail.round = 该轮开始前）；
   steer 过的消息带 steered 标注，在时间线上可见。 */
function messagesByRound(trace) {
  const map = new Map();
  for (const e of (trace.events || [])) {
    if (e.type !== "operator_message") continue;
    const d = (e.payload || {}).detail || {};
    const round = Number(d.round) || 0;
    if (!map.has(round)) map.set(round, []);
    map.get(round).push({ text: String(d.text || ""), steered: !!d.steered });
  }
  return map;
}

/* 线程的开头是任务本身：Kimi 里它是用户那条消息，我们此前把它当文档标题。 */
function objectiveMsgHtml(trace) {
  const task = trace.task || {};
  const objective = String(task.objective || "").trim();
  if (!objective) return "";
  const binding = task.binding || {};
  const spec = binding.spec || {};
  const chips = [
    spec.mode ? `<span class="msg-chip">${esc(spec.mode === "script" ? "脚本" : "研究")}</span>` : "",
    spec.sources && spec.sources.length ? `<span class="msg-chip">${spec.sources.length} 个来源</span>` : "",
    binding.scenario ? `<span class="msg-chip">${esc(tplTitle(binding.scenario))}</span>` : "",
  ].filter(Boolean).join("");
  return `<div class="msg objective" data-objective="1">
    <div class="msg-head"><span class="msg-who">任务</span>${chips ? `<span class="msg-chips">${chips}</span>` : ""}</div>
    <div class="msg-text">${esc(objective)}</div>
  </div>`;
}

function roundWrapHtml(msgMap, round, ann, prevRound = null) {
  const msgs = msgMap.get(round.index) || [];
  const bubbles = msgs.map(m => `<div class="msg op${m.steered ? " steered" : ""}">
    <div class="msg-head"><span class="msg-who">你</span><span class="msg-state">${m.steered ? "⚡ 已插话 · 第 " + esc(round.index) + " 轮前优先入链" : "已入链 · 第 " + esc(round.index) + " 轮前生效"}</span></div>
    <div class="msg-text">${esc(m.text)}</div>
  </div>`).join("");
  return `<div class="round-wrap">${bubbles}${renderRound(round, round.index - 1, ann, prevRound)}</div>`;
}

/* 折叠：连续"安静"的轮次收成一行摘要（Kimi 的 toolcall-rollup 形状）。
   安静 = 已执行、已通过、没有插话、不是拒绝/未知/进行中——任何需要操作员看见
   的轮次都不折。折叠只改 DOM 的可见性，不动 data-* 契约，所以增量打补丁那条
   路径（syncLiveRounds 按索引替换）完全不受影响。 */
function applyRoundFolding() {
  const slot = document.getElementById("rounds-slot");
  if (!slot) return;
  const wraps = Array.from(slot.children);
  const trace = shownTrace() || {};
  const anns = annotateRounds(trace);
  const msgMap = messagesByRound(trace);
  const rounds = trace.rounds || [];
  const quiet = wraps.map((wrap, index) => {
    const card = wrap.querySelector(".round");
    const round = rounds[index] || {};
    const hasMsg = ((msgMap.get(round.index) || []).length > 0);
    return !!card && card.dataset.quiet === "1" && isQuietRound(round, anns[index] || {}, hasMsg);
  });
  // 先全部还原，再按当前分组折叠——状态变化（例如某轮被拒绝）不会留下残留。
  wraps.forEach(wrap => {
    const card = wrap.querySelector(".round");
    if (card) card.dataset.folded = "";
    wrap.hidden = false;
    const chip = card && card.querySelector(".group-size");
    if (chip) { chip.hidden = true; chip.textContent = ""; }
  });
  foldRuns(quiet).forEach(({ start, size }) => {
    const head = wraps[start];
    const headCard = head && head.querySelector(".round");
    if (!headCard) return;
    const expanded = headCard.dataset.open === "true";
    const summary = foldSummary(rounds.slice(start, start + size), size);
    headCard.querySelector(".turn-summary").setAttribute("aria-expanded", String(expanded));
    const chip = headCard.querySelector(".group-size");
    if (chip) {
      chip.hidden = false;
      chip.textContent = `${summary.label} · ${summary.verdict} · ${summary.tools}`;
      chip.title = summary.tools;
    }
    for (let i = start; i < start + size; i++) {
      const wrap = wraps[i];
      if (!wrap) continue;
      const card = wrap.querySelector(".round");
      if (card) card.dataset.folded = "1";
      if (i > start && !expanded) wrap.hidden = true;
    }
  });
}

function syncLiveRounds(s, trace) {
  const slot = document.getElementById("rounds-slot");
  if (!slot) return;
  const anns = annotateRounds(trace);
  const rounds = trace.rounds || [];
  const msgMap = messagesByRound(trace);
  const open = new Map();
  [...slot.children].forEach((el, i) => {
    const card = el.classList.contains("round") ? el : el.querySelector(".round");
    if (card) open.set(i, { open: card.dataset.open, user: card.dataset.user });
  });
  for (let i = 0; i < rounds.length; i++) {
    const html = roundWrapHtml(msgMap, rounds[i], anns[i], i > 0 ? rounds[i - 1] : null);
    if (s.roundHtml[i] === html) continue;
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const node = holder.firstElementChild;
    const previous = slot.children[i];
    if (previous) {
      const prevCard = previous.classList.contains("round") ? previous : previous.querySelector(".round");
      if (prevCard) {
        const wasLive = prevCard.classList.contains("live");
        const userToggled = prevCard.dataset.user === "1";
        const card = node.querySelector(".round");
        if (card) {
          if (open.has(i)) {
            card.dataset.open = open.get(i).open;
            if (open.get(i).user) card.dataset.user = "1";
          }
          if (wasLive && !card.classList.contains("live") && !userToggled) card.dataset.open = "false";
        }
      }
      previous.replaceWith(node);
    } else {
      slot.append(node);
    }
    s.roundHtml[i] = html;
  }
  applyRoundFolding();
}

function setComposerRunning(running) {
  const ta = document.getElementById("composer-ta");
  const btn = document.getElementById("send");
  const chip = document.getElementById("run-chip");
  if (!btn || !ta) return;
  if (running) {
    chip.hidden = false;
    document.getElementById("run-chip-text").textContent = "运行中";
    btn.disabled = false;
    btn.title = "发送消息 · 下一轮交给 agent";
    btn.innerHTML = `<span data-doodle="arrow-up"></span>`;
    hydrateDoodles(btn);
    ta.disabled = false;
    ta.placeholder = "运行中 — 直接输入，消息将排队并在下一轮交给 agent（⌘. 停止）";
  } else {
    chip.hidden = true;
    btn.title = "发送任务";
    btn.innerHTML = `<span data-doodle="arrow-up"></span>`;
    hydrateDoodles(btn);
    const enabled = !!(health && health.live);
    btn.disabled = !enabled;
    ta.disabled = !enabled;
    // 恢复任务模式的占位符（消息模式会覆盖它）
    const template = templates.find(t => t.key === tplKey);
    ta.placeholder = template ? template.objective : "给 agent 派一个任务…";
  }
  setFoot(
    running ? "offline-mock · 运行中"
      : (health && health.live ? "offline-mock · 可运行" : "offline-mock · 只读回放"),
    running ? "live" : (health && health.live ? "ok" : "")
  );
}

/* ------------------------ MIXED — 审批状态逻辑（不改）+ 审批卡渲染 */

function fmtCountdown(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/* 审批动词映射：标题动词化（对照官方 ApprovalDialog 的 "Allow this write?"）。
   映射表集中定义；缺省回退工具名，不猜动作。 */
const APPROVAL_VERBS = {
  read_document: "读取",
  list_documents: "列出资料",
  normalize_units: "换算",
  reconcile_basis: "核对口径",
  check_restatement: "核对重述",
  calculate_margin: "计算毛利率",
  report_blocked: "宣告受阻",
  ls_workspace: "列出工作区",
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  run_command: "执行命令",
  fetch_url: "抓取网页",
};

/* 有状态变更的写入类工具：审批默认展开影响区（对照官方 diff 自动展开）。
   edit_file / run_command 同属 consequential（能力基线三大件）。 */
const WRITE_TOOLS = new Set([
  "working_paper_append", "collect_source", "write_document", "write_file",
  "edit_file", "run_command",
]);
const WRITE_VERBS = { write_file: "写入", edit_file: "编辑", run_command: "执行" };

/* MCP 导入工具默认 consequential：未经主机标注 readonly 的都按写入对待 */
function isWriteLike(tool) {
  return WRITE_TOOLS.has(tool) || String(tool).startsWith("mcp__");
}

function approvalVerb(tool) {
  if (WRITE_VERBS[tool]) return WRITE_VERBS[tool];
  if (isWriteLike(tool)) return "写入";
  return APPROVAL_VERBS[tool] || "";
}

/* 注意：审批档位菜单另有同名概念的 approvalTitle(mode)，这里是待批动作标题 */
function approvalActionTitle(tool) {
  const verb = approvalVerb(tool);
  return verb ? `允许这次${verb}？` : `允许这次 ${tool} 调用？`;
}

function renderApproval(pending, deciding) {
  if (!pending) return "";
  const argsObj = pending.arguments || {};
  const args = Object.keys(argsObj).length
    ? "(" + Object.entries(argsObj).map(([k, v]) => {
        const text = String(v);
        return `${k}=${text.length > 72 ? text.slice(0, 72) + "…" : text}`;
      }).join(", ") + ")"
    : "";
  const why = pending.policy === "every-step"
    ? "逐步审批：本次运行的每次工具调用都需要你确认。"
    : "关键步骤：这个动作会改变结论或宣告任务受阻，执行前需要你确认。";
  const busy = deciding
    ? `<span class="apv-count">${deciding.allow ? "已允许 · 等待 Runtime 继续…" : "已拒绝 · 运行将终止…"}</span>`
    : `<span class="apv-count" data-countdown>${fmtCountdown(pending.expiresIn)}</span>`;
  const write = isWriteLike(pending.tool);
  const model = (activeSession()?.trace?.model) || {};
  const sender = `${model.provider || "provider"} · ${model.model || "model"} · 第 ${esc(pending.round)} 轮发起`;
  const impact = write
    ? (pending.preview && pending.preview.command !== undefined
        ? approvalCommandHtml(pending.preview)
        : pending.preview && (pending.preview.diff !== undefined || pending.preview.error)
        ? approvalDiffHtml(pending.preview)
        : approvalImpactHtml(argsObj))
    : "";
  return `<div class="card approval${write ? " approval-write" : ""}" data-approval="${esc(pending.id)}">
    <div class="card-head">
      <span class="card-title">${doodleSvg("key", true)} ${esc(approvalActionTitle(pending.tool))}</span>
      <span class="grow"></span>
      <span class="badge warn"><span class="dot"></span>${deciding ? "已提交" : "等待授权"}</span>
    </div>
    <div class="approval-body">
      <div class="apv-line">
        <span class="rno">#${esc(pending.round)}</span>
        <span class="tool">${esc(pending.tool)}</span>
        ${args ? `<span class="args">${esc(args)}</span>` : ""}
      </div>
      ${impact}
      <div class="apv-why">${esc(why)}</div>
      <div class="apv-choices" role="group" aria-label="审批选项">
        <button class="apv-choice" data-decision="allow"${deciding ? " disabled" : ""}>
          <span class="no">1</span><span class="label">本次允许</span>
        </button>
        <button class="apv-choice" data-decision="allow-remember"${deciding ? " disabled" : ""}>
          <span class="no">2</span><span class="label">本会话允许<small>本次运行内不再询问该工具</small></span>
        </button>
        <button class="apv-choice danger" data-decision="deny"${deciding ? " disabled" : ""}>
          <span class="no">3</span><span class="label">拒绝</span>
        </button>
      </div>
      <div class="apv-foot">
        ${busy}
        <span class="grow"></span>
        <span class="apv-keys">1 本次允许 · 2 本会话允许 · 3 拒绝</span>
      </div>
      <div class="apv-sender">${esc(sender)}</div>
    </div>
  </div>`;
}

/* run_command 审批：完整命令行与治理要点（能力基线三大件） */
function approvalCommandHtml(preview) {
  return `<div class="apv-impact">
    <div class="apv-impact-head">命令执行 · 白名单受限终端</div>
    <div class="apv-cmdline"><code>${esc(preview.command || "")}</code></div>
    <div class="kv">
      <span class="k">截止</span><span class="v">${esc(preview.timeout || 30)} 秒 · 超时记 unknown，不自动重跑</span>
      <span class="k">环境</span><span class="v">无 shell · 参数逐个校验 · provider 凭据不进入子进程</span>
      <span class="k">范围</span><span class="v">工作区沙箱内；文件变化全部进入 git 快照</span>
    </div>
  </div>`;
}

/* write_file / edit_file 审批：主机在执行前算好的真实 git diff，默认展开 */
function approvalDiffHtml(preview) {
  if (preview.error) {
    return `<div class="apv-impact">
      <div class="apv-impact-head">写入影响 · 预览被沙箱拒绝</div>
      <div class="apv-diff"><div class="diff-line err">${esc(preview.error)}</div></div>
    </div>`;
  }
  const lines = String(preview.diff || "").split("\n").map(line => {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "ctx";
    return `<div class="diff-line ${cls}">${esc(line) || "&nbsp;"}</div>`;
  }).join("");
  const stat = `${preview.created ? "新建文件" : "修改文件"} · +${preview.additions} / −${preview.removals}${preview.truncated ? " · 已截断（完整 diff 在收据链上）" : ""}`;
  return `<div class="apv-impact">
    <div class="apv-impact-head">写入影响 · 真实 diff（${esc(stat)}）</div>
    <div class="apv-diff">${lines || '<div class="diff-line ctx">（无内容变化）</div>'}</div>
  </div>`;
}

/* 写入类审批的影响区：列出参数与影响对象，默认展开（对照官方 diff 自动展开） */
function approvalImpactHtml(argsObj) {
  const rows = Object.entries(argsObj).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const target = rows.find(([k]) => ["target", "doc_id", "document_id", "section", "path"].includes(k));
  const affected = target ? `${target[0]}=${target[1]}` : "本次调用声明的目标对象";
  return `<div class="apv-impact">
    <div class="apv-impact-head">写入影响 · 默认展开</div>
    <div class="kv">
      <span class="k">影响对象</span><span class="v">${esc(affected)}</span>
      ${rows.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(String(v))}</span>`).join("")}
    </div>
  </div>`;
}

function paintApproval() {
  const slot = document.getElementById("approval-slot");
  if (!slot) return;
  const s = activeSession();
  slot.innerHTML = s && s.pending ? renderApproval(s.pending, s.deciding) : "";
}

async function decideApproval(allow, remember = false) {
  const s = activeSession();
  if (!s || !s.pending || s.deciding) return;
  const pending = s.pending;
  s.deciding = { allow, remember };
  paintApproval();
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(s.id)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: pending.id, allow, remember }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    toast(allow ? (remember ? "本会话已授权 · 运行继续" : "已允许 · 运行继续") : "已拒绝 · 运行将终止");
  } catch (error) {
    s.deciding = null;
    paintApproval();
    toast("决定未送达：" + error.message);
  }
}

/* ------------------------------------- LOGIC LAYER — 计划/预算指令与 API */

function paintPlan() {
  const slot = document.getElementById("plan-slot");
  const s = activeSession();
  if (!slot || !s || !s.trace) return;
  const html = renderPlan(lastPlan(s.trace), {
    editable: s.running && !s.finished,
    editing: s.planEditing,
    confirmId: s.planConfirm,
    queued: s.planQueued ? s.planQueued.label : "",
  });
  slot.innerHTML = html;
  s.planHtml = html;
}

function paintBudget() {
  const slot = document.getElementById("budget-slot");
  const s = activeSession();
  if (!slot || !s || !s.trace) return;
  const html = renderMeters(s.trace, {
    editable: s.running && !s.finished,
    editing: s.budgetEditing,
    queued: !!s.budgetQueued,
    live: s.running && !s.finished,
  });
  slot.innerHTML = html;
  s.budgetHtml = html;
}

async function queuePlan(action, todoId) {
  const s = activeSession();
  if (!s || !s.running) return;
  const note = action === "skip" ? "操作员跳过" : "操作员提前";
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(s.id)}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, todoId, note }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const label = action === "skip" ? `已排队：跳过 ${todoId}` : `已排队：提前 ${todoId}`;
    s.planQueued = { label, events: (s.trace.events || []).length };
    s.planConfirm = null;
    paintPlan();
    toast(label + " · 下一轮生效");
  } catch (error) {
    toast("计划指令未送达：" + error.message);
  }
}

async function queueBudget() {
  const s = activeSession();
  if (!s || !s.running) return;
  const read = key => Number((document.querySelector(`[data-budget="${key}"]`) || {}).value || 0);
  const limits = lastBudget(s.trace) ? lastBudget(s.trace).limits : {};
  const payload = {
    maxCalls: read("maxCalls"),
    maxReads: read("maxReads"),
    maxCostMicrousd: read("maxCostMicrousd"),
  };
  if (
    !payload.maxCalls || payload.maxCalls < (limits.max_calls || 0) ||
    !payload.maxReads || payload.maxReads < (limits.max_reads || 0) ||
    !payload.maxCostMicrousd || payload.maxCostMicrousd < (limits.max_cost_microusd || 0)
  ) {
    toast("上限只能调高，且必须是整数");
    return;
  }
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(s.id)}/budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    s.budgetEditing = false;
    s.budgetQueued = { events: (s.trace.events || []).length };
    paintBudget();
    toast("预算调整已排队 · 下一轮生效");
  } catch (error) {
    toast("预算调整未送达：" + error.message);
  }
}

function createSession(id, objective, template) {
  return {
    id, objective, template, es: null, trace: null, lastData: null,
    running: true, finished: false, failed: false,
    planHtml: "", budgetHtml: "", resultHtml: "", roundHtml: [], eventCount: 0,
    pending: null, pendingDeadline: 0, deciding: null, approvalKey: "",
    planEditing: false, planConfirm: null, planQueued: null,
    budgetEditing: false, budgetQueued: null, thoughtPinned: false,
    autoReport: false, queuedMsgs: [],
  };
}

function tabTitle(s) {
  return s.objective ? shortObjective(s.objective) : tplTitle(s.template);
}

function openLive(id, objective, template) {
  leaveChat();
  ledgerOpen = false;
  const fresh = !sessions.has(id);
  if (fresh) sessions.set(id, createSession(id, objective, template));
  const s = sessions.get(id);
  store.sessionId = s.id;
  store.key = "run:" + id;
  renderNav();
  renderTabs();
  if (fresh) {
    setComposerRunning(true);
    document.getElementById("tb-title").textContent = "运行 · " + tplTitle(template);
    document.getElementById("tb-chips").innerHTML = "";
    document.getElementById("rail-body").innerHTML = "";
    renderMain(`<div class="empty">任务已提交，等待 Runtime 启动…</div>`, { mode: "loading", scroll: "top" });
    attachStream(s);
  } else {
    repaintSession(s);
  }
}

/* 增量帧：只合并变化部分，渲染复用现有 liveApply（字符串 diff 保持不变） */
function applyDelta(trace, delta) {
  if (Array.isArray(delta.events) && delta.events.length) {
    trace.events = (trace.events || []).concat(delta.events);
  }
  if (Array.isArray(delta.rounds) && delta.rounds.length) {
    const start = Math.max(0, delta.roundStart || 0);
    trace.rounds = (trace.rounds || []).slice(0, start).concat(delta.rounds);
  }
  if (delta.terminal) trace.terminal = delta.terminal;
  if (delta.chain) trace.chain = delta.chain;
  if (delta.task) trace.task = delta.task;
  if (delta.model) trace.model = delta.model;
}

function attachStream(s) {
  const es = new EventSource(`/api/runs/${encodeURIComponent(s.id)}/stream`);
  s.es = es;
  es.addEventListener("snapshot", event => {
    if (s.failed || s.finished) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (activeSession() !== s) { stashSessionUpdate(s, data); return; }
    liveApply(s, data);
    if (data.finished) finishSession(s, data);
  });
  es.addEventListener("append", event => {
    if (s.failed || s.finished || !s.trace) return;
    let delta;
    try { delta = JSON.parse(event.data); } catch { return; }
    applyDelta(s.trace, delta);
    const data = {
      snapshot: s.trace,
      pending: delta.pending || null,
      queue: delta.queue,
      finished: !!delta.finished,
      status: delta.status,
      tracePath: delta.tracePath,
      error: delta.error,
    };
    if (activeSession() !== s) { stashSessionUpdate(s, data); return; }
    liveApply(s, data);
    if (data.finished) finishSession(s, data);
  });
  es.addEventListener("done", event => {
    let data = {};
    try { data = JSON.parse(event.data); } catch { /* empty */ }
    if (activeSession() !== s) {
      stashSessionUpdate(s, Object.assign({}, s.lastData || {}, { finished: true, status: data.status, error: data.error }));
      return;
    }
    finishSession(s, data);
  });
  es.addEventListener("failed", event => {
    let data = {};
    try { data = JSON.parse(event.data); } catch { /* empty */ }
    if (s.es) { s.es.close(); s.es = null; }
    s.failed = true;
    s.running = false;
    refreshRuns();
    if (activeSession() !== s) {
      renderTabs();
      notify("Fcode · 运行失败", String(data.error || "Runtime 未返回任何快照").slice(0, 120));
      return;
    }
    renderMain(
      `<div class="empty">运行失败：${esc(data.error || "Runtime 未返回任何快照")}
        <div class="actions" style="justify-content:center"><button class="a-btn" data-act="retry">重试</button></div>
      </div>`,
      { mode: "error" }
    );
    setComposerRunning(false);
    notify("Fcode · 运行失败", String(data.error || "Runtime 未返回任何快照").slice(0, 120));
  });
}

/* 后台会话：只更新状态与标签点，不动 DOM */
function stashSessionUpdate(s, data) {
  if (data && data.snapshot) s.trace = data.snapshot;
  if (data) s.lastData = data;
  if (data && data.finished && !s.finished && !s.failed) finishSession(s, data);
  else renderTabs();
}

/* 激活一个已有会话：从缓存状态重建画面 */
function repaintSession(s) {
  if (!s.trace) {
    renderMain(`<div class="empty">任务已提交，等待 Runtime 启动…</div>`, { mode: "loading" });
    return;
  }
  if (s.finished || (s.trace.terminal && s.trace.terminal.status)) {
    setComposerRunning(false);
    store.trace = s.trace;
    render(s.trace, "运行 · " + tabTitle(s));
    return;
  }
  setComposerRunning(true);
  liveShell(s.trace);
  s.planHtml = "";
  s.budgetHtml = "";
  s.resultHtml = "";
  s.roundHtml = [];
  s.eventCount = 0;
  liveApply(s, s.lastData || { snapshot: s.trace, pending: null, finished: false });
}

function finishSession(s, data) {
  if (s.finished) { if (activeSession() !== s) renderTabs(); return; }
  s.finished = true;
  s.running = false;
  s.pending = null;
  s.deciding = null;
  s.approvalKey = "";
  if (s.es) { s.es.close(); s.es = null; }
  s.queueEditingId = null;
  let draftCount = 0;
  s.queuedMsgs.forEach(m => {
    if (m.state === "queued") { m.state = "draft"; m.steered = false; draftCount += 1; }
  });
  const trace = s.trace || (s.lastData && s.lastData.snapshot) || null;
  s.trace = trace;
  refreshRuns();
  const status = (trace && trace.terminal && trace.terminal.status) || (data && data.status) || "?";
  if (activeSession() !== s) {
    renderTabs();
    notify(
      status === "succeeded" ? "Fcode · 运行完成" : `Fcode · 运行结束（${status}）`,
      `${tabTitle(s)} · 后台完成`
    );
    return;
  }
  paintApproval();
  paintQueuedMsgs();
  const thought = document.getElementById("thought");
  if (thought && !s.thoughtPinned) thought.open = false;
  setComposerRunning(false);
  if (trace) {
    if (trace.terminal && trace.terminal.status) {
      const html = renderResult(trace);
      const slot = document.getElementById("result-slot");
      if (slot) slot.innerHTML = html;
      s.resultHtml = html;
      loadReviewProfile(trace);
    }
    cache.set("run:" + s.id, trace);
    verifyChain(trace).then(check => {
      if (activeSession() !== s) return;
      store.check = check;
      setChainBadge(check);
      renderRail(trace, check);
    });
    const rounds = (trace.rounds || []).length;
    setFoot(
      `offline-mock · 运行${status === "succeeded" ? "完成" : "结束（" + status + "）"}`,
      status === "succeeded" ? "ok" : ""
    );
    notify(
      status === "succeeded" ? "Fcode · 运行完成" : `Fcode · 运行结束（${status}）`,
      `${shortObjective(s.objective || "")} · ${rounds} 轮`
    );
  }
  renderTabs();
  if (activeSession() === s) {
    updateStatusline();
    paintQueuedMsgs();
    if (draftCount) toast(`未送达的 ${draftCount} 条已保留为草稿`);
  }
  if (s.autoReport && status === "succeeded" && activeSession() === s) {
    s.autoReport = false;
    setTimeout(() => { if (activeSession() === s && shownTrace()) openReport(); }, 300);
  }
}

function detachLive() {
  /* 切走：会话保留在后台继续流式，不再渲染 */
  store.sessionId = null;
  setComposerRunning(false);
  renderTabs();
}

function closeSessionTab(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.es) { s.es.close(); s.es = null; }
  sessions.delete(id);
  if (store.sessionId === id) {
    store.sessionId = null;
    setComposerRunning(false);
    renderMain(`<div class="empty">标签已关闭。运行仍在服务器上继续，可从左侧运行记录重新打开。</div>`, { mode: "run" });
    document.getElementById("chain-badge").className = "chain-pill";
    document.getElementById("chain-badge").innerHTML = `<span class="dot"></span><span>未加载</span>`;
  }
  const rest = [...sessions.values()];
  if (rest.length) openLive(rest[rest.length - 1].id, rest[rest.length - 1].objective, rest[rest.length - 1].template);
  else { renderNav(); renderTabs(); }
  refreshRuns();
}

function renderTabs() {
  const bar = document.getElementById("tabs");
  if (!bar) return;
  const items = [...sessions.values()];
  bar.hidden = items.length === 0;
  bar.innerHTML = items.map(s => {
    const active = activeSession() === s && store.key === "run:" + s.id;
    const status = s.failed ? "bad"
      : s.finished ? (((s.trace || {}).terminal || {}).status === "succeeded" ? "ok" : "bad")
      : "live";
    return `<div class="tab${active ? " active" : ""}" data-tab="${esc(s.id)}" title="${esc(s.objective || "")}">
      <span class="tdot ${status}"></span>
      <span class="tlabel">${esc(tabTitle(s))}</span>
      <button class="tx" data-tabclose="${esc(s.id)}" title="关闭标签">×</button>
    </div>`;
  }).join("");
}

/* --------------------------------------------------------------- 委托入口
   用户先说话，后端 clarifier 再回复并给选项。前端不预设问卷。 */

const INTAKE_KEY = "fa.intake";
const INTAKE_INTENTS = {
  compare: { label: "判断两期能不能直接比", short: "两期可比性" },
  restatement: { label: "重点看重述与口径变化", short: "重述与口径" },
  missing: { label: "资料可能不全，先看能否下结论", short: "资料不全" },
};
const INTAKE_OUTPUTS = {
  memo: { label: "一页结论 + 审计底稿", short: "结论 + 底稿" },
  trace: { label: "详细过程 + 原始 trace", short: "详细过程" },
  conclusion: { label: "只要结论", short: "只要结论" },
};

function loadIntakePrefs() {
  const raw = localStorage.getItem(INTAKE_KEY);
  try {
    const parsed = JSON.parse(raw || "{}");
    return {
      stored: !!raw,
      intent: INTAKE_INTENTS[parsed.intent] ? parsed.intent : "",
      output: INTAKE_OUTPUTS[parsed.output] ? parsed.output : "",
      approval: APPROVAL_MODES.some(([key]) => key === parsed.approval) ? parsed.approval : "",
    };
  } catch {
    return { stored: false, intent: "", output: "", approval: "" };
  }
}

const intakePrefs = loadIntakePrefs();
const intake = {
  active: false,
  messages: [],
  spec: {},
  choices: [],
  readyTask: null,
  thinking: false,
  snapshots: [],
  returnKey: null,
  returnLabel: "",
  origin: null,
};

function intakeBadge(choice) {
  if (intakePrefs.stored) {
    const preferred = intakePrefs[choice.field];
    if (preferred && preferred === choice.value) return "上次选择";
  }
  return choice.badge || "";
}

function intakeTemplateKey() {
  if (intake.readyTask && intake.readyTask.template) return intake.readyTask.template;
  // 通用委托是默认入口：在财务问卷出现之前，预算与草稿跟随当前模板。
  if (tplKey && isGeneralTemplate()) return tplKey;
  return intake.spec.intent === "missing" ? "open-ended" : "full";
}

function intakeTemplate() {
  return templates.find(t => t.key === intakeTemplateKey()) || {};
}

function intakeSavePrefs(spec) {
  const value = {
    intent: spec.intent || "",
    output: spec.output || "",
    approval: spec.approval || "",
  };
  try { localStorage.setItem(INTAKE_KEY, JSON.stringify(value)); } catch { /* quota */ }
  intakePrefs.stored = true;
  intakePrefs.intent = value.intent;
  intakePrefs.output = value.output;
  intakePrefs.approval = value.approval;
}

function intakeDraftHtml() {
  const template = intakeTemplate();
  const limits = template.limits || {};
  const intent = intake.spec.intent ? INTAKE_INTENTS[intake.spec.intent].label : "待选择";
  const output = intake.spec.output ? INTAKE_OUTPUTS[intake.spec.output].short : "待选择";
  const approval = intake.spec.approval
    ? approvalTitle(intake.spec.approval)
    : ((intake.readyTask || {}).approval ? approvalTitle(intake.readyTask.approval) : "待选择");
  const entry = (modelBudget.models || []).find(m => m.key === modelChoice.key);
  const scaled = entry && entry.budget ? entry.budget : null;
  const operatorTuned = !!attach.budget;
  const shown = operatorTuned
    ? {
        max_calls: attach.budget.maxCalls,
        max_reads: attach.budget.maxReads,
        max_cost_microusd: attach.budget.maxCostMicrousd,
      }
    : (scaled || limits);
  const rescaled = scaled && (scaled.max_cost_microusd !== limits.max_cost_microusd
    || scaled.max_tokens !== limits.max_tokens);
  const budget = limits.max_calls
    ? `${num(shown.max_calls ?? limits.max_calls)} calls · ${num(shown.max_reads ?? limits.max_reads)} reads · ${num(shown.max_cost_microusd ?? limits.max_cost_microusd)} µUSD`
    : "—";
  const scopeNote = attach.scope.size && attach.scope.size !== attach.corpus.length
    ? `<span class="intake-scale-note">读取范围限定 ${attach.scope.size} 份资料</span>`
    : "";
  const scaleNote = operatorTuned
    ? `<span class="intake-scale-note">操作者已微调治理上限</span>`
    : (rescaled && entry
      ? `<span class="intake-scale-note">已按 ${esc(entry.model)} 价格重算成本顶（上限而非目标）</span>`
      : "");
  const general = !!(template.module && template.module !== "finance-research");
  const mode = general ? (((intake.readyTask || {}).spec || {}).mode || "") : "";
  const modeText = mode === "script" ? "脚本：写 → 运行 → 修复 → 复跑"
    : mode === "research" ? "调研：抓取来源 → 写报告"
    : "按描述自动判断";
  const sourcesText = mode === "script"
    ? "工作区脚本，无需 URL"
    : `${attach.sources.length}/5 个 URL`;
  const headTag = general
    ? (template.title ? template.title.split("：")[0] : "通用委托")
    : "内置合成资料 · 恒星智算";
  const detailRows = general
    ? `<div class="intake-row"><span>模式</span><b>${esc(modeText)}</b></div>
       <div class="intake-row"><span>来源</span><b>${esc(sourcesText)}</b>${attach.sources.length ? `<span class="intake-scale-note">只有 + 面板里列出的地址可被 fetch_url 访问</span>` : ""}</div>
       <div class="intake-row"><span>审批</span><b>${esc(approval)}</b></div>`
    : `<div class="intake-row"><span>问题</span><b>${esc(intent)}</b></div>
       <div class="intake-row"><span>输出</span><b>${esc(output)}</b></div>
       <div class="intake-row"><span>审批</span><b>${esc(approval)}</b></div>
       <div class="intake-row"><span>资料</span><b>${attach.scope.size && attach.scope.size !== attach.corpus.length ? `限定 ${attach.scope.size} 份` : "全语料"}</b>${scopeNote}</div>`;
  const ready = !!intake.readyTask;
  return `<div class="intake-draft">
    <div class="intake-draft-head"><span>任务草稿</span><span class="intake-draft-tag">${esc(headTag)}</span></div>
    ${detailRows}
    <div class="intake-row"><span>预算</span><b>${esc(budget)}</b>${scaleNote}</div>
    <div class="intake-actions">
      <button class="a-btn" data-intake-cancel>取消</button>
      ${intake.snapshots.length ? `<button class="a-btn" data-intake-back>上一步</button>` : ""}
      <span class="grow"></span>
      <button class="a-btn strong" data-intake-start${ready ? "" : " disabled"}>${ready ? "开始委托" : "继续选择"}</button>
    </div>
  </div>`;
}

function intakeChoicesHtml(choices) {
  return `<div class="intake-choices">${choices.map(choice => {
    const badge = intakeBadge(choice);
    return `<button class="intake-choice" type="button"
      data-intake-choice data-intake-field="${esc(choice.field)}" data-intake-value="${esc(choice.value)}"
      data-intake-label="${esc(choice.label)}">
      <span class="t"><b>${esc(choice.label)}</b>${badge ? `<span class="intake-badge">${esc(badge)}</span>` : ""}</span>
      <small>${esc(choice.description || "")}</small>
    </button>`;
  }).join("")}</div>`;
}

function refreshModelBudget() {
  if (!health || !health.live) return;
  const key = intakeTemplateKey();
  if (modelBudget.template === key && modelBudget.models) return;
  fetch(`/api/models?template=${encodeURIComponent(key)}`, { cache: "no-store" })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !Array.isArray(data.models)) return;
      modelBudget = { template: key, models: data.models };
      if (intake.active) renderIntake();
    })
    .catch(() => { /* 预览保持模板草案数字，不影响创建 */ });
}

function renderIntake() {
  const main = document.getElementById("main");
  if (!intake.active) return;
  refreshModelBudget();
  const messages = intake.messages.map((message, index) => {
    if (message.role === "user") {
      return `<div class="intake-msg user"><span class="who">你</span><p>${esc(message.text)}</p></div>`;
    }
    const last = index === intake.messages.length - 1;
    const thought = message.thought
      ? `<div class="intake-thought"><span>理解</span>${esc(message.thought)}</div>` : "";
    const choices = last && !intake.thinking && intake.choices.length
      ? intakeChoicesHtml(intake.choices) : "";
    return `<div class="intake-msg agent"><span class="who">FCode</span>
      <p class="intake-reply">${esc(message.text)}</p>${thought}${choices}</div>`;
  }).join("");
  const thinking = intake.thinking
    ? `<div class="intake-msg agent intake-thinking"><span class="who">FCode</span><p class="intake-reply">正在理解你的任务…</p></div>`
    : "";
  renderMain(`<div class="intake">
    <div class="intake-head">
      <div>
        <div class="intake-kicker"><span data-doodle="list-checks"></span> NEW DELEGATION</div>
        <h1 class="intake-title">${isGeneralTemplate() ? "说清楚，就开始" : "先说清楚，再开始"}</h1>
        <p class="intake-sub">${isGeneralTemplate() ? "通用委托不走问卷：描述任务，来源与审批在 + 面板确认。" : "你先描述，我再给选项。最多三轮就能确认。"}</p>
      </div>
    </div>
    <div class="intake-thread">${messages}${thinking}${intakeDraftHtml()}</div>
  </div>`, { mode: "intake", scroll: "bottom" });
  hydrateDoodles(main);
}

function intakeSnapshot() {
  intake.snapshots.push({
    messages: intake.messages.map(message => ({ ...message })),
    spec: { ...intake.spec },
    choices: intake.choices.map(choice => ({ ...choice })),
    readyTask: intake.readyTask ? { ...intake.readyTask } : null,
  });
}

function startIntake(text = "", extras = null) {
  if (!health || !health.live) {
    toast("回放模式：用 python3 viewer/server.py 启动后才能创建委托");
    return;
  }
  const s = activeSession();
  if (s && s.running && !s.finished) {
    toast("当前任务还在运行：先停止，或等它结束后再开新委托");
    return;
  }
  leaveChat();
  if (settingsOpen) closeSettingsPage(false);
  attach.open = false;
  renderAttachPanel();
  intake.active = true;
  intake.messages = [];
  intake.spec = {};
  intake.origin = extras && extras.origin ? extras.origin : null;
  intake.choices = [];
  intake.readyTask = null;
  intake.thinking = false;
  intake.snapshots = [];
  intake.returnKey = store.key;
  intake.returnLabel = document.getElementById("tb-title").textContent || "当前视图";
  document.getElementById("app").classList.add("intake-mode");
  document.getElementById("tb-title").textContent = "新委托 · 需求确认";
  document.getElementById("tb-chips").innerHTML = intake.origin
    ? `<span class="chip">需求确认</span><span class="chip">含对话上下文 · ${intake.origin.messages.length} 条</span>`
    : `<span class="chip">需求确认</span>`;
  const ta = document.getElementById("composer-ta");
  ta.value = "";
  autosize(ta);
  ta.placeholder = "说说你想做什么，Enter 交给 agent…";
  const value = String(text || "").trim();
  if (!value) {
    intake.messages.push({
      role: "assistant",
      text: "先说说你想做什么。比如：调研一个主题并整理成 research.md；或者写个脚本跑通它。",
      thought: "还没有收到任务描述。",
      choices: [],
    });
    renderMode("intake");
    ta.focus();
    return;
  }
  intakeSnapshot();
  intake.messages.push({ role: "user", text: value });
  renderMode("intake");
  intakeRequest(value, null);
}

function closeIntake(restore = true) {
  if (!intake.active) return;
  intake.active = false;
  intake.origin = null;
  document.getElementById("app").classList.remove("intake-mode");
  setComposerRunning(false);
  if (restore && intake.returnKey) {
    select(intake.returnKey, intake.returnLabel);
  } else if (restore) {
    renderMain(stageEmptyHtml(), { mode: "empty" });
    document.getElementById("tb-title").textContent = "FCode";
    document.getElementById("tb-chips").innerHTML = "";
  }
}

async function intakeRequest(message, choice) {
  if (intake.thinking) return;
  intake.thinking = true;
  intake.choices = [];
  renderIntake();
  const started = performance.now();
  try {
    const response = await fetch("/api/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        choice,
        // 通用委托没有问卷，唯一决定自主度的就是输入框那个档位——随请求一起
        // 送过去，否则会产生"chip 显示自动、运行却在每步都停"的错觉。
        // 财务问卷的审批问题仍由问卷本身回答，不受这里影响。
        spec: isGeneralTemplate() ? { ...intake.spec, approval: approvalMode } : intake.spec,
        history: intake.messages.slice(-16),
        template: tplKey || "",
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const data = await response.json();
    // Keep the thinking state readable even when the local clarifier answers
    // instantly; a real model will naturally take longer.
    const elapsed = performance.now() - started;
    if (elapsed < 650) await new Promise(resolve => setTimeout(resolve, 650 - elapsed));
    intake.spec = data.spec || {};
    intake.choices = Array.isArray(data.choices) ? data.choices : [];
    intake.readyTask = data.task || null;
    intake.messages.push({
      role: "assistant",
      text: data.reply || "我在。继续说。",
      thought: data.thought || "",
      choices: intake.choices,
    });
  } catch (error) {
    intake.messages.push({
      role: "assistant",
      text: `我没接上理解服务：${error.message}。你可以重试，或直接换一种说法。`,
      thought: "请求失败，未更新任务草稿。",
      choices: [],
    });
  } finally {
    intake.thinking = false;
    renderIntake();
  }
}

function intakeChoose(field, value, label) {
  if (!intake.active || intake.thinking) return;
  intakeSnapshot();
  intake.messages.push({ role: "user", text: label });
  intake.spec = { ...intake.spec, [field]: value };
  renderIntake();
  intakeRequest("", { field, value });
}

function intakeFreeText(text) {
  if (!intake.active || intake.thinking) return;
  const value = String(text || "").trim();
  if (!value) return;
  intakeSnapshot();
  intake.messages.push({ role: "user", text: value });
  renderIntake();
  intakeRequest(value, null);
}

function intakeBack() {
  const snapshot = intake.snapshots.pop();
  if (!snapshot) return;
  intake.messages = snapshot.messages;
  intake.spec = snapshot.spec;
  intake.choices = snapshot.choices;
  intake.readyTask = snapshot.readyTask;
  intake.thinking = false;
  renderIntake();
}

async function startIntakeRun() {
  if (!intake.active || !intake.readyTask) return;
  const task = intake.readyTask;
  const scriptMode = (task.spec && task.spec.mode) === "script";
  if (String(task.template) === tplKey && isGeneralTemplate() && !scriptMode && !attach.sources.length) {
    toast("调研委托至少需要 1 个来源 URL：点 + 添加（脚本委托可留空）");
    return;
  }
  const button = document.querySelector("[data-intake-start]");
  if (button) { button.disabled = true; button.textContent = "提交中…"; }
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objective: task.objective,
        template: task.template,
        approval: task.approval,
        spec: { ...task.spec, ...delegationSpecExtras(), ...(intake.origin ? { origin_thread: intake.origin } : {}) },
        ...(modelChoice.key !== "mock"
          ? { model: modelChoice.key, effort: modelChoice.effort || "medium" }
          : {}),
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const run = await response.json();
    intakeSavePrefs(task.spec);
    attach.scope.clear();
    attach.budget = null;
    attach.sources = [];
    attach.sourcesDraft = "";
    attach.mcp = { servers: attach.mcp.servers, loaded: false };
    renderAttachPanel();
    intake.active = false;
    intake.origin = null;
    document.getElementById("app").classList.remove("intake-mode");
    setComposerRunning(false);
    toast("委托已受理 · 开始执行");
    openLive(run.id, task.objective, run.template);
    const s = activeSession();
    if (s) s.autoReport = task.spec.output === "memo";
    refreshRuns();
  } catch (error) {
    toast("委托提交失败：" + error.message);
    if (button) { button.disabled = false; button.textContent = "开始委托"; }
  }
}

/* 输入框统一入口：需求选择中 = 补充描述，运行中 = 发消息，空闲 = 开始新委托 */
function composerSubmit() {
  if (intake.active) {
    const ta = document.getElementById("composer-ta");
    const text = (ta.value || "").trim();
    if (!text) { toast("先选一个选项，或在下方描述你的需求"); return; }
    ta.value = "";
    autosize(ta);
    return intakeFreeText(text);
  }
  if (chat.active) return sendChatFromComposer();
  const s = activeSession();
  if (s && s.running && !s.finished) return sendOperatorMessage();
  return sendTask();
}

/* 运行中插话：入队渲染在排队面板，入链后由 snapshot 事件确认并移出队列 */
async function sendOperatorMessage() {
  const s = activeSession();
  if (!s || !s.running || s.finished) return;
  const ta = document.getElementById("composer-ta");
  const text = (ta.value || "").trim();
  if (!text) return;
  ta.value = "";
  autosize(ta);
  const msg = { id: queueMsgId(), text, state: "queued" };
  s.queuedMsgs.push(msg);
  paintQueuedMsgs();
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(s.id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    if (data.messageId) msg.serverId = data.messageId;
    paintQueuedMsgs();
  } catch (error) {
    msg.state = "failed";
    msg.error = error.message;
    paintQueuedMsgs();
    toast("消息未送达：" + error.message);
  }
}

let queueMsgSeq = 0;
function queueMsgId() {
  queueMsgSeq += 1;
  return `q${Date.now().toString(36)}-${queueMsgSeq}`;
}

/* 排队面板（对照官方 QueuedMessagesPanel）：两行截断摘要 + hover 操作
   （steer 闪电 / 编辑 / 上移 / 删除）；草稿条目点击回填输入框。 */
function paintQueuedMsgs() {
  const slot = document.getElementById("queued-slot");
  if (!slot) return;
  const s = activeSession();
  const msgs = s && s.queuedMsgs ? s.queuedMsgs : [];
  if (!msgs.length) { slot.innerHTML = ""; return; }
  const items = msgs.map((m, index) => {
    if (s.queueEditingId && s.queueEditingId === m.id) {
      return `<div class="q-item editing" data-mid="${esc(m.id)}">
        <input class="q-edit" data-q-edit-input value="${esc(m.text)}" spellcheck="false">
        <div class="q-acts">
          <button class="q-act" data-q-act="save" title="保存 (↵)">✓</button>
          <button class="q-act" data-q-act="cancel" title="取消 (esc)">×</button>
        </div>
      </div>`;
    }
    const first = index === 0;
    const acts = [];
    if (m.state === "queued" && s.running && !s.finished) {
      acts.push(`<button class="q-act bolt${m.steered ? " done" : ""}" data-q-act="steer" title="${m.steered ? "已插话 · 下一轮优先处理" : "立即插入（下一轮优先处理）"}">⚡</button>`);
    }
    if (m.state === "draft") {
      acts.push(`<button class="q-act" data-q-act="refill" title="回填输入框">↩</button>`);
    } else {
      acts.push(`<button class="q-act" data-q-act="edit" title="编辑">✎</button>`);
      if (!first && m.state === "queued") acts.push(`<button class="q-act" data-q-act="moveup" title="上移">↑</button>`);
      acts.push(`<button class="q-act danger" data-q-act="remove" title="删除">🗑</button>`);
    }
    const state = m.state === "failed" ? `未送达 · ${esc(m.error || "")}`
      : m.state === "draft" ? "草稿 · 未入链"
      : m.state === "delivered" ? "已入链"
      : m.steered ? "⚡ 插话 · 下一轮优先入链"
      : "排队中 · 下一轮入链";
    return `<div class="q-item ${esc(m.state)}${m.steered ? " steered" : ""}" data-mid="${esc(m.id)}">
      <div class="q-main">
        <div class="q-text">${esc(m.text)}</div>
        <div class="q-state">${state}</div>
      </div>
      <div class="q-acts">${acts.join("")}</div>
    </div>`;
  }).join("");
  slot.innerHTML = `<div class="queued-msgs">
    <div class="q-head"><span>排队插话 · ${msgs.length} 条</span><span class="grow"></span><span class="q-hint">下一轮边界入链 · 顺序即生效顺序</span></div>
    ${items}
  </div>`;
  const editing = slot.querySelector(".q-edit");
  if (editing) { editing.focus(); editing.setSelectionRange(editing.value.length, editing.value.length); }
}

/* 队列管理指令：全部走 server 端点，server 侧队列才是生效顺序的事实源 */
async function queueCommand(op, msg, newText) {
  const s = activeSession();
  if (!s || !msg) return false;
  if (op === "steer" && !msg.serverId) { toast("这条消息还在发送中，稍后再插话"); return false; }
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(s.id)}/${op === "steer" ? "steer" : "queue"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(op === "steer"
        ? { messageId: msg.serverId }
        : { op, messageId: msg.serverId, text: newText }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    return true;
  } catch (error) {
    toast("队列操作未送达：" + error.message);
    return false;
  }
}

/* 队列权威同步：server 队列是事实源。已确认条目（有 serverId）以 server 为准
   （文本 / steer 标记 / 存在性——被其他客户端删除或已消费的不再留在面板）；
   server 有而本地没有的是别的客户端（或 API）入队的项，收编进本地面板；
   本地尚无 serverId 的条目是 POST 在途，先按文本认领再乐观保留。 */
function reconcileQueue(s, serverQueue) {
  if (!s) return;
  if (!Array.isArray(s.queuedMsgs)) s.queuedMsgs = [];
  const serverIds = new Set(serverQueue.map(item => item && item.id).filter(Boolean));
  for (const item of serverQueue) {
    if (!item || !item.id) continue;
    let local = s.queuedMsgs.find(m => m.serverId === item.id);
    if (!local) {
      // POST 在途（还没有 serverId）的同文本条目直接认领，避免重复
      local = s.queuedMsgs.find(m => !m.serverId && m.state === "queued" && m.text === item.text);
    }
    if (local) {
      local.serverId = item.id;
      local.text = String(item.text || "");
      local.steered = !!item.steered;
      if (local.state !== "queued") local.state = "queued";
      local.error = "";
    } else {
      s.queuedMsgs.push({
        id: queueMsgId(),
        serverId: item.id,
        text: String(item.text || ""),
        steered: !!item.steered,
        state: "queued",
      });
    }
  }
  s.queuedMsgs = s.queuedMsgs.filter(m => !m.serverId || serverIds.has(m.serverId));
  paintQueuedMsgs();
}

function findQueuedMsg(el) {
  const item = el.closest("[data-mid]");
  const s = activeSession();
  if (!item || !s) return null;
  return (s.queuedMsgs || []).find(m => m.id === item.dataset.mid) || null;
}

function handleQueueAction(button) {
  const act = button.dataset.qAct;
  const msg = findQueuedMsg(button);
  const s = activeSession();
  if (!msg || !s) return;
  if (act === "edit") { s.queueEditingId = msg.id; paintQueuedMsgs(); return; }
  if (act === "cancel") { s.queueEditingId = null; paintQueuedMsgs(); return; }
  if (act === "save") { saveQueueEdit(s, msg); return; }
  if (act === "refill") {
    const ta = document.getElementById("composer-ta");
    ta.value = msg.text;
    autosize(ta);
    ta.focus();
    s.queuedMsgs = s.queuedMsgs.filter(m => m.id !== msg.id);
    paintQueuedMsgs();
    return;
  }
  if (act === "remove") {
    (async () => {
      if (msg.serverId && !(await queueCommand("remove", msg))) return;
      s.queuedMsgs = s.queuedMsgs.filter(m => m.id !== msg.id);
      paintQueuedMsgs();
    })();
    return;
  }
  if (act === "moveup") {
    (async () => {
      if (msg.serverId && !(await queueCommand("moveUp", msg))) return;
      const list = s.queuedMsgs;
      const i = list.indexOf(msg);
      if (i > 0) { list.splice(i, 1); list.splice(i - 1, 0, msg); }
      paintQueuedMsgs();
    })();
    return;
  }
  if (act === "steer") {
    (async () => {
      if (!(await queueCommand("steer", msg))) return;
      const list = s.queuedMsgs;
      const i = list.indexOf(msg);
      if (i > 0) { list.splice(i, 1); list.unshift(msg); }
      msg.steered = true;
      paintQueuedMsgs();
      toast("已插话 · 下一轮优先处理");
    })();
  }
}

function saveQueueEdit(s, msg) {
  const item = document.querySelector(`[data-mid="${CSS.escape(msg.id)}"]`);
  const input = item ? item.querySelector(".q-edit") : null;
  const text = (input ? input.value : "").trim();
  if (!text) { toast("内容不能为空"); return; }
  (async () => {
    if (msg.serverId && !(await queueCommand("edit", msg, text))) return;
    msg.text = text;
    s.queueEditingId = null;
    paintQueuedMsgs();
  })();
}

async function sendTask() {
  const ta = document.getElementById("composer-ta");
  const text = (ta.value || "").trim();
  if (!health || !health.live) {
    toast("回放模式：用 python3 viewer/server.py 启动后才能派任务");
    return;
  }
  ta.value = "";
  autosize(ta);
  startIntake(text);
}

async function stopRun() {
  const s = activeSession();
  if (!s || !s.running) return;
  document.getElementById("run-chip-text").textContent = "正在停止…";
  try {
    await fetch(`/api/runs/${encodeURIComponent(s.id)}/stop`, { method: "POST" });
  } catch { /* the stream will settle it */ }
}

let runSignature = "";

async function refreshRuns() {
  if (!health || !health.live) return;
  let next;
  try {
    next = await fetch("/api/runs", { cache: "no-store" }).then(r => r.json());
  } catch {
    return;
  }
  // 只在有变化时重绘：轮询 2.5s 一次，但不能打断重命名/悬停等本地状态
  const signature = next.map(run => [
    run.id, run.status, run.rounds, run.name, run.pinned ? 1 : 0,
    (run.cost && run.cost.costMicrousd) || 0,
  ].join(":")).join("|");
  if (signature === runSignature) return;
  runSignature = signature;
  runHistory = next;
  renderNav();
}

function setTemplate(key) {
  tplKey = key;
  const template = templates.find(t => t.key === key);
  const ta = document.getElementById("composer-ta");
  if (template && ta && !ta.value) ta.placeholder = template.objective;
  if (attach.open) renderAttachPanel();
  refreshAttachData();
}

function approvalTitle(mode = approvalMode) {
  const found = APPROVAL_MODES.find(([key]) => key === mode);
  return found ? found[1] : "关键审批";
}

function setApprovalMode(mode) {
  if (!APPROVAL_MODES.some(([key]) => key === mode)) return;
  approvalMode = mode;
  localStorage.setItem("fa.approval", mode);
  const label = document.getElementById("approval-label");
  if (label) label.textContent = approvalTitle();
  renderApprovalMenu();
  syncSettings();
}

function renderApprovalMenu() {
  const menu = document.getElementById("approval-menu");
  if (!menu) return;
  menu.innerHTML = APPROVAL_MODES.map(([key, title, desc]) => `<button class="tpl-item${key === approvalMode ? " active" : ""}" data-approval-mode="${esc(key)}">
    <span class="t"><span>${esc(title)}</span><span class="m">${esc(key)}</span></span>
    <span class="d">${esc(desc)}</span>
  </button>`).join("") + `<div class="tpl-note">审批只发生在轮次边界，不打断工具执行；拒绝会终止运行并写入签名链。档位对新任务生效。</div>`;
}

/* ---------- 模型与思考强度选择器（composer 徽章） ---------- */

function saveModelChoice() {
  localStorage.setItem("fa.model", JSON.stringify(modelChoice));
}

function liveRunEffortLabel(trace) {
  const rounds = (trace || {}).rounds || [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    const effort = ((rounds[i].receipt || {}).metadata || {}).reasoning_effort;
    if (effort && EFFORT_LABEL[effort]) return EFFORT_LABEL[effort];
  }
  return "";
}

function paintModelBadge() {
  const labelEl = document.getElementById("model-label");
  const btn = document.getElementById("model-btn");
  if (!labelEl || !btn) return;
  const s = activeSession();
  if (s && s.running && !s.finished) {
    const model = (s.trace && s.trace.model) || {};
    const effort = liveRunEffortLabel(s.trace);
    labelEl.textContent = `${model.model || model.provider || "运行中"}${effort ? " · " + effort : ""}`;
    btn.classList.add("readonly");
    btn.title = "当前运行实际使用的模型（只读）；选择器只对新委托生效";
    return;
  }
  btn.classList.remove("readonly");
  if (!health || !health.live) {
    labelEl.textContent = "未连接 runtime";
    btn.title = "静态回放模式：composer 已整体禁用";
    return;
  }
  if (chat.active) {
    if (chatModels.length && chatModelChoice.key !== "mock"
        && !chatModels.some(m => m.key === chatModelChoice.key && m.available)) {
      chatModelChoice.key = "mock";
      saveChatModelChoice();
    }
    const chatEntry = chatModels.find(m => m.key === chatModelChoice.key)
      || chatModels.find(m => m.key === "mock");
    labelEl.textContent = !chatEntry || chatEntry.key === "mock"
      ? "offline-mock"
      : chatEntry.model;
    btn.title = "选择对话模型；在设置页填写 API 配置";
    return;
  }
  if (modelChoice.key !== "mock" && !modelCatalog.some(m => m.key === modelChoice.key && m.available)) {
    // 记忆的选择已不可用：回到 mock（菜单里保留 reason 供查看）
    modelChoice.key = "mock";
    saveModelChoice();
  }
  const entry = modelCatalog.find(m => m.key === modelChoice.key);
  labelEl.textContent = !entry || entry.key === "mock"
    ? "offline-mock"
    : `${entry.model}${entry.supportsEffort ? " · " + (EFFORT_LABEL[modelChoice.effort] || "中") : ""}`;
  btn.title = "选择模型与思考强度";
}


/* ---------- “+”附加面板：真实委托输入，非装饰入口 ---------- */

/* 通用委托模板（general-work）：附加面板换成“来源 URL”，不显示财务语料 */
function isGeneralTemplate() {
  const tpl = templates.find(t => t.key === tplKey);
  return !!(tpl && tpl.module && tpl.module !== "finance-research");
}

function effectiveDraftBudget() {
  const template = templates.find(t => t.key === tplKey) || {};
  const entry = (modelBudget.models || []).find(m => m.key === modelChoice.key);
  return (entry && entry.budget) || template.limits || {};
}

function renderAttachPanel() {
  const panel = document.getElementById("attach-panel");
  const box = document.getElementById("composer-box");
  if (!panel) return;
  const btn = document.getElementById("composer-open");
  if (btn) {
    btn.classList.toggle("open", attach.open);
    btn.setAttribute("aria-expanded", attach.open ? "true" : "false");
    btn.title = attach.open ? "收起附加面板" : "资料 / 工具 / 预算";
  }
  box?.classList.toggle("open-attach", attach.open);
  if (attach.open) {
    clearTimeout(Number(panel.dataset.closeTimer || 0));
    panel.classList.remove("closing");
    panel.hidden = false;
  } else if (!panel.hidden) {
    // × 收起：先播 150ms 连体段收起动画，再真正 display:none
    clearTimeout(Number(panel.dataset.closeTimer || 0));
    panel.classList.add("closing");
    panel.dataset.closeTimer = String(setTimeout(() => {
      panel.hidden = true;
      panel.classList.remove("closing");
    }, 150));
    return;
  } else {
    return;
  }

  const limits = effectiveDraftBudget();
  const budget = attach.budget || {
    maxCalls: limits.max_calls || 0,
    maxReads: limits.max_reads || 0,
    maxCostMicrousd: limits.max_cost_microusd || 0,
  };
  const raised = attach.budget && (
    budget.maxCalls > (limits.max_calls || 0)
    || budget.maxReads > (limits.max_reads || 0)
    || budget.maxCostMicrousd > (limits.max_cost_microusd || 0)
  );
  const general = isGeneralTemplate();
  const sourceRows = attach.sources.map((url, index) => `
    <div class="attach-source">
      <span class="src-index">${index + 1}</span>
      <span class="src-url">${esc(url)}</span>
      <button class="src-remove" data-attach-source-remove="${index}" title="移除此来源">×</button>
    </div>`).join("");
  const sourcesGroup = `
    <section class="attach-group">
      <header><span>资料来源（URL）</span><span class="attach-note">${attach.sources.length}/5 · fetch_url 仅访问这些地址</span></header>
      ${sourceRows || '<div class="attach-empty">调研模式需要来源；脚本模式（"写脚本并运行"）可留空</div>'}
      ${attach.sources.length < 5 ? `
      <div class="attach-source-add">
        <input type="url" placeholder="https://example.com/page" data-attach-source-input value="${esc(attach.sourcesDraft)}">
        <button data-attach-source-add>添加</button>
      </div>` : ""}
      <div class="attach-rule">SSRF 防护在工具实现内强制：私网/环回地址一律拒绝，解析后校验实际连接 IP</div>
    </section>`;
  const mcpServers = attach.mcp.servers || [];
  const mcpGroup = mcpServers.length ? `
    <section class="attach-group">
      <header><span>MCP 导入</span><span class="attach-note">${mcpServers.filter(x => x.connected).length}/${mcpServers.length} 个 server 在线</span></header>
      ${mcpServers.map(server => `
        <div class="attach-tool">
          <div class="tool-line">
            <span class="name">${esc(server.server)}</span>
            <span class="effect">${server.connected ? `${server.tools.length} 工具` : "不可用"}</span>
          </div>
          <div class="summary">${server.connected
            ? esc(server.tools.join("  ·  ") || "无已导入工具")
            : esc(server.reason || "未连接")}</div>
          ${(server.refused || []).length ? `<div class="params">拒收 ${server.refused.length} 个：${esc(server.refused.map(r => r.tool).join(", "))}</div>` : ""}
        </div>`).join("")}
      <div class="attach-rule">导入即注册：门控/预算/收据同等生效；未标 readonly 的都过审批</div>
    </section>` : "";
  const docs = attach.corpus.map(doc => `
    <label class="attach-doc${attach.scope.has(doc.id) ? " checked" : ""}">
      <input type="checkbox" data-attach-doc="${esc(doc.id)}"${attach.scope.has(doc.id) ? " checked" : ""}>
      <span class="doc-name">${esc(doc.title)}</span>
      <span class="doc-kind">${esc(doc.kind)}</span>
      <span class="doc-period">${esc(doc.period)}</span>
    </label>`).join("");
  const tools = attach.tools.map(tool => {
    const required = Object.entries(tool.parameters || {})
      .filter(([, schema]) => schema && schema.required)
      .map(([name]) => name)
      .join(", ");
    return `<div class="attach-tool">
      <div class="tool-line"><span class="name">${esc(tool.name)}</span><span class="effect">${esc(tool.effect)}</span></div>
      <div class="summary">${esc(tool.summary)}</div>
      ${required ? `<div class="params">必填：${esc(required)}</div>` : '<div class="params">无必填参数</div>'}
    </div>`;
  }).join("");
  const tplItems = templateGroups().map(group =>
    group.items.map(t => `
      <button class="attach-tpl${t.key === tplKey ? " active" : ""}" data-attach-tpl="${esc(t.key)}">
        <span class="t">${esc(t.title.split("：")[0])}</span>
        <span class="d">${esc(t.story)}</span>
        ${t.key === tplKey ? '<span class="tick">✓ 当前</span>' : ""}
      </button>`).join("")
  ).join("");
  const curTpl = String((templates.find(t => t.key === tplKey) || {}).title || tplKey).split("：")[0];
  const groups = [
    { key: "tpl", label: "委托模板", note: "决定授权、预算与故障注入",
      summary: esc(curTpl),
      body: `<div class="attach-tpls">${tplItems}</div>` },
    general
      ? { key: "sources", label: "外部来源", note: "fetch_url 可访问",
          summary: attach.sources.length ? `${attach.sources.length} 个来源` : "未添加",
          body: sourcesGroup }
      : { key: "sources", label: "资料选择", note: "不选 = 全语料（默认）",
          summary: attach.scope.size ? `已限定 ${attach.scope.size} 份` : "全语料（默认）",
          body: `<div class="attach-docs">${docs || '<div class="attach-empty">正在读取语料库…</div>'}</div>`
            + (attach.scope.size ? `<div class="attach-selected">已限定 ${attach.scope.size} 份：任务创建后读取范围真实受限</div>` : "") },
    { key: "tools", label: "工具注册表", note: "全部经门控与预算",
      summary: `${attach.tools.length} 个已注册工具`,
      body: `<div class="attach-tools">${tools || '<div class="attach-empty">正在读取注册表…</div>'}</div>${general ? mcpGroup : ""}<div class="attach-rule">工具由主机注册；任何调用须经门控与预算</div>` },
    { key: "budget", label: "预算微调", note: raised ? "已上调" : "默认 = 模型价格重算的上限",
      summary: `${budget.maxCalls} calls · ${budget.maxReads} reads · ${num(budget.maxCostMicrousd)} µ`,
      body: `<div class="attach-budget">
        <label>calls <input type="number" min="1" inputmode="numeric" data-attach-budget="maxCalls" value="${Number(budget.maxCalls)}"></label>
        <label>reads <input type="number" min="1" inputmode="numeric" data-attach-budget="maxReads" value="${Number(budget.maxReads)}"></label>
        <label>µUSD <input type="number" min="1" inputmode="numeric" data-attach-budget="maxCostMicrousd" value="${Number(budget.maxCostMicrousd)}"></label>
      </div>
      <div class="attach-warning${raised ? " on" : ""}">${raised ? "上调将放宽治理上限；实际计费仍以收据为准" : "下调立即收紧；实际计费仍以收据为准"}</div>` },
  ];
  // 手风琴：四组默认收成单行摘要（当前配置一览），单开展开——对齐 kimi 的
  // 空间纪律：+ 菜单只占浮层，从不占据页面流。
  panel.innerHTML = groups.map(g => {
    const open = attach.openGroup === g.key;
    return `<section class="attach-group${open ? " open" : ""}">
      <button class="attach-sum" data-attach-sum="${g.key}" aria-expanded="${open}">
        <span class="sum-label">${esc(g.label)}</span>
        <span class="sum-value">${g.summary}</span>
        <span class="chev">${open ? "▾" : "▸"}</span>
      </button>
      ${open ? `<div class="attach-body">${g.body}</div>` : ""}
    </section>`;
  }).join("");
}

async function refreshAttachData() {
  if (!health || !health.live || !tplKey) return;
  const key = tplKey;
  const jobs = [];
  if (modelBudget.template !== key || !modelBudget.models) {
    jobs.push(fetch(`/api/models?template=${encodeURIComponent(key)}`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Array.isArray(data.models) && tplKey === key) {
          modelBudget = { template: key, models: data.models };
        }
      }).catch(() => {}));
  }
  if (attach.loadedTemplate !== key || !attach.corpus.length || !attach.tools.length) {
    jobs.push(Promise.all([
      fetch(`/api/corpus?template=${encodeURIComponent(key)}`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/api/templates/${encodeURIComponent(key)}/tools`, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([corpus, tools]) => {
      if (tplKey !== key) return;
      attach.corpus = corpus && Array.isArray(corpus.documents) ? corpus.documents : [];
      attach.tools = tools && Array.isArray(tools.tools) ? tools.tools : [];
      const ids = new Set(attach.corpus.map(doc => doc.id));
      attach.scope = new Set([...attach.scope].filter(id => ids.has(id)));
      attach.loadedTemplate = key;
    }));
  }
  const generalNow = templates.find(t => t.key === key);
  if (generalNow && generalNow.module && generalNow.module !== "finance-research" && !attach.mcp.loaded) {
    jobs.push(fetch("/api/mcp", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Array.isArray(data.servers)) attach.mcp = { servers: data.servers, loaded: true };
      }).catch(() => { attach.mcp.loaded = true; }));
  }
  await Promise.all(jobs);
  renderAttachPanel();
  if (intake.active) renderIntake();
}

function readAttachBudgetInputs() {
  const values = {};
  document.querySelectorAll("[data-attach-budget]").forEach(input => {
    values[input.dataset.attachBudget] = Number(input.value);
  });
  if (!values.maxCalls || !values.maxReads || !values.maxCostMicrousd) return;
  attach.budget = {
    maxCalls: values.maxCalls,
    maxReads: values.maxReads,
    maxCostMicrousd: values.maxCostMicrousd,
  };
  const raised = attach.budget.maxCalls > effectiveDraftBudget().max_calls
    || attach.budget.maxReads > effectiveDraftBudget().max_reads
    || attach.budget.maxCostMicrousd > effectiveDraftBudget().max_cost_microusd;
  const warning = document.querySelector(".attach-warning");
  if (warning) {
    warning.classList.toggle("on", raised);
    warning.textContent = raised
      ? "上调将放宽治理上限；实际计费仍以收据为准"
      : "下调立即收紧；实际计费仍以收据为准";
  }
}

function delegationSpecExtras() {
  const spec = {};
  if (isGeneralTemplate()) {
    if (attach.sources.length) spec.sources = [...attach.sources];
  } else {
    const allIds = new Set(attach.corpus.map(doc => doc.id));
    if (attach.scope.size && attach.scope.size !== allIds.size) {
      spec.scope = [...attach.scope];
    }
  }
  if (attach.budget) spec.budget = { ...attach.budget };
  return spec;
}

/* 浮窗默认向上展开（Kimi 的锚点规则）；但舞台态 composer 贴近页面下沿时，
   向上会顶出画布顶部——最上面几行就点不到了。量一次：放不下就向下展开。 */
function placeModelMenu() {
  const menu = document.getElementById("model-menu");
  if (!menu) return;
  menu.classList.remove("drop-down");
  const rect = menu.getBoundingClientRect();
  if (rect.top < 8) menu.classList.add("drop-down");
}

function renderModelMenu() {
  const menu = document.getElementById("model-menu");
  if (!menu) return;
  const items = modelCatalog.map(m => {
    const current = m.available && m.key === modelChoice.key;
    return `<button class="tpl-item model-item${current ? " active" : ""}${m.available ? "" : " disabled"}" data-model-pick="${esc(m.key)}"${m.available ? "" : " disabled"}>
      <span class="t"><span>${esc(m.label)}${current ? '<span class="check">✓</span>' : ""}</span><span class="m">${esc(m.model)}</span></span>
      <span class="d">${m.available ? (m.key === "mock" ? "离线确定性 mock · 演示与回归" : m.supportsEffort ? "云端模型 · 支持思考强度" : "本地推理") : esc(m.reason)}</span>
    </button>`;
  }).join("");
  // 思考强度块对"当前选中的模型"生效——菜单数据源是服务端枚举的
  // provider 清单，任何 supportsEffort 的条目（kimi 或主机声明的端点）
  // 选中时都能调档，不再写死单一 provider。
  const selected = modelCatalog.find(m => m.key === modelChoice.key);
  const effortHost = selected && selected.available && selected.supportsEffort
    ? selected : modelCatalog.find(m => m.key === "kimi" && m.available && m.supportsEffort);
  const effortBlock = effortHost ? `<div class="model-effort">
    <span class="me-head">思考强度${effortHost.key !== modelChoice.key ? ` · ${esc(effortHost.label)}` : ""}</span>
    <div class="me-opts">${EFFORT_LEVELS.map(level =>
      `<button class="me-opt${modelChoice.key === effortHost.key && modelChoice.effort === level ? " active" : ""}" data-effort-pick="${level}">${EFFORT_LABEL[level]}</button>`
    ).join("")}</div>
    <span class="me-note">不选 = 用 provider 默认档（Kimi 为低）；选了就按档位发送</span>
  </div>` : "";
  menu.innerHTML = items + effortBlock + `<div class="tpl-note">模型由操作者选择；门控 / 预算 / 审计对任何模型同等生效</div>`;
  if (!menu.hidden) placeModelMenu();
}

async function initLive() {
  setApprovalMode(approvalMode);
  try {
    health = await fetch("/api/health", { cache: "no-store" }).then(r => r.json());
  } catch {
    health = { ok: false, live: false, runtimeError: "静态托管模式：没有本地 API" };
  }
  if (health.live) {
    try {
      const data = await fetch("/api/modules", { cache: "no-store" }).then(r => r.ok ? r.json() : null);
      if (data && Array.isArray(data.modules)) modules = data.modules;
    } catch {
      modules = [];
    }
    try {
      templates = await fetch("/api/templates", { cache: "no-store" }).then(r => r.json());
    } catch {
      templates = [];
    }
    if (!templates.length) health.live = false;
    renderStageChips();
    try {
      const data = await fetch("/api/models", { cache: "no-store" }).then(r => r.ok ? r.json() : null);
      modelCatalog = data && Array.isArray(data.models) ? data.models : [];
    } catch {
      modelCatalog = [];
    }
  }
  if (!health.live) {
    const ta = document.getElementById("composer-ta");
    ta.placeholder = "静态回放模式 — 用 python3 server.py --repo … 启动控制台即可真实运行任务";
    document.getElementById("approval-btn").disabled = true;
    const modelBtn = document.getElementById("model-btn");
    if (modelBtn) modelBtn.disabled = true;
    document.getElementById("send").disabled = true;
    setFoot("offline-mock · 只读回放", "");
    paintModelBadge();
    return;
  }
  // 通用委托是产品默认入口；金融研究作为参考负载仍可显式选择。
  const preferred = ["general-research", "full"].find(key => templates.some(t => t.key === key));
  setTemplate(preferred || templates[0].key);
  setComposerRunning(false);
  paintModelBadge();
  updateStatusline();
  fetch("/api/tools", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(data => {
    if (!data || !Array.isArray(data.tools)) return;
    toolContracts = data.tools;
    const trace = shownTrace();
    if (trace) renderRail(trace, store.check || { ok: false, reason: "" });
  }).catch(() => { /* the tools tab will show 加载中 */ });
  autosize(document.getElementById("composer-ta"));
  refreshRuns();
  setInterval(refreshRuns, 2500);
}

async function selectRun(id) {
  leaveChat();
  if (intake.active) closeIntake(false);
  if (settingsOpen) closeSettingsPage(false);
  ledgerOpen = false;
  evExpanded.clear();
  const existing = sessions.get(id);
  if (existing) return openLive(id, existing.objective, existing.template);
  const run = runHistory.find(item => item.id === id);
  if (run && (run.status === "running" || !run.tracePath)) {
    return openLive(id, run.objective, run.template);
  }
  if (activeSession()) detachLive();
  store.key = "run:" + id;
  renderNav();
  const cached = cache.get("run:" + id);
  if (cached) {
    await renderMode("run", { trace: cached, title: "运行 · " + tplTitle(run ? run.template : "") });
    return;
  }
  renderMain(`<div class="empty">加载运行记录…</div>`, { mode: "loading" });
  try {
    const trace = await fetch(runTraceUrl(id), { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    cache.set("run:" + id, trace);
    await renderMode("run", { trace, title: "运行 · " + tplTitle(run ? run.template : "") });
    renderNav();
  } catch (error) {
    renderMain(`<div class="empty">无法加载运行记录：${esc(error.message)}</div>`, { mode: "error" });
  }
}

/* ------------------------------------- LOGIC LAYER — trace 加载与视图状态 */

const TRACE_CANDIDATES = key => [
  `traces/${key}.trace.json`,
  `../work/demo/${key}.trace.json`,
  `work/demo/${key}.trace.json`,
];

async function loadTrace(key) {
  if (cache.has(key)) return cache.get(key);
  for (const url of TRACE_CANDIDATES(key)) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) continue;
      const trace = await response.json();
      cache.set(key, trace);
      return trace;
    } catch { /* try next */ }
  }
  return null;
}

async function select(key, label) {
  leaveChat();
  if (intake.active) closeIntake(false);
  if (settingsOpen) closeSettingsPage(false);
  if (key.startsWith("run:")) return selectRun(key.slice(4));
  ledgerOpen = false;
  evExpanded.clear();
  if (activeSession()) detachLive();
  store.key = key;
  renderNav();
  renderMain(`<div class="empty">加载 ${esc(label)}…</div>`, { mode: "loading" });
  const trace = await loadTrace(key);
  if (!trace) {
    document.getElementById("chain-badge").className = "chain-pill";
    document.getElementById("chain-badge").innerHTML = `<span class="dot"></span><span>无数据</span>`;
    renderMain(`<div class="empty">
      ${esc(key)} 还没有 trace。先运行 <code>python demo.py ${esc(key)}</code>，或 <code>python demo.py all</code> 一次生成全部。
    </div>`, { mode: "error" });
    return;
  }
  await renderMode("run", { trace, title: label });
  renderNav();
}

/* ----------------- LOGIC LAYER — 哈希验证 / 复制 / 导出 / 指令绑定入口 */

async function reverify() {
  const trace = shownTrace();
  if (!trace) return;
  const check = await verifyChain(trace);
  const badge = document.getElementById("chain-badge");
  badge.className = "chain-pill " + (check.ok ? "ok" : "bad") + " pulse";
  badge.innerHTML = check.ok
    ? `<span class="dot"></span><span>链验证通过 · ${check.events} events</span>`
    : `<span class="dot"></span><span>链断裂 · ${esc(check.reason)}</span>`;
  setTimeout(() => badge.classList.remove("pulse"), 700);
}

function exportTrace() {
  const trace = shownTrace();
  if (!trace) return;
  const name = (store.key ? store.key.replace(/:/g, "-") : "trace") + ".trace.json";
  const blob = new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  toast("已导出 trace JSON");
}

/* -------------------------------------- LOGIC LAYER — 运行创建 / 恢复 / 重试 */

function currentRun() {
  if (store.key && store.key.startsWith("run:")) {
    return runHistory.find(item => item.id === store.key.slice(4)) || null;
  }
  return null;
}

async function togglePin(id) {
  const run = runHistory.find(item => item.id === id);
  if (!run) return;
  run.pinned = !run.pinned;
  renderRuns();
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}/meta`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: run.pinned }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    toast(run.pinned ? "已固定" : "已取消固定");
  } catch {
    run.pinned = !run.pinned;
    renderRuns();
    toast("固定失败");
  }
}

function startRename(id, labelEl) {
  const run = runHistory.find(item => item.id === id);
  if (!run || !labelEl) return;
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = run.name || shortObjective(run.objective);
  input.spellcheck = false;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async save => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== (run.name || shortObjective(run.objective))) {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(id)}/meta`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: value }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const updated = await response.json();
        run.name = updated.name || "";
        toast("已重命名");
      } catch {
        toast("重命名失败");
      }
    }
    renderRuns();
  };
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); commit(true); }
    else if (event.key === "Escape") { event.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(false));
}

function costChipsHtml(trace) {
  const b = lastBudget(trace);
  if (!b) return "";
  const lim = b.limits || {};
  return `<div class="chips">
    <span class="mini">成本 ${num(b.cost_used_microusd)} µUSD</span>
    <span class="mini">calls ${b.calls_used}/${num(lim.max_calls || 0)}</span>
    <span class="mini">reads ${b.reads_used}/${num(lim.max_reads || 0)}</span>
    <span class="mini">tokens ${num(b.tokens_used)}</span>
  </div>${tokenSplitHtml(trace)}`;
}

function runActionsHtml(trace) {
  const terminal = trace.terminal || {};
  const status = terminal.status || "";
  if (!status) return "";
  const report = `<button class="a-btn strong" data-act="report">签发报告</button>`;
  if (!(store.key && store.key.startsWith("run:"))) {
    return `<div class="chips">${costChipsHtml(trace)}</div><div class="actions">${report}</div>`;
  }
  const failure = terminal.failure || {};
  const run = currentRun();
  const session = activeSession();
  const liveId = session && session.id;
  const canResume = !run || !!run.taskId || (liveId && liveId === run.id);
  const resumable = (failure.code === "BUDGET_EXCEEDED" || failure.code === "ROUND_LIMIT")
    && !(session && session.running)
    && canResume;
  const resume = resumable ? `<button class="a-btn strong" data-act="resume">追加预算并继续</button>` : "";
  const retry = status && status !== "succeeded"
    ? `<button class="a-btn" data-act="retry">重试</button>` : "";
  return `<div class="chips">${costChipsHtml(trace)}</div><div class="actions">${resume}${retry}${report}<button class="a-btn" data-act="diag">复制诊断</button></div>`;
}

/* ---------------- MIXED — 报告构建/链验证逻辑（不改）+ 浮层 DOM 操作 */

let lastReportHtml = null;
let lastReportName = "fcode-report.html";

async function openReport() {
  const initial = shownTrace();
  if (!initial || !(initial.terminal && initial.terminal.status)) {
    toast("运行结束后才能签发报告");
    return;
  }
  const run = currentRun();
  const currentRunId = (store.key || "").startsWith("run:") ? store.key.slice(4) : (run && run.id);
  const pendingReview = currentRunId ? reviewTraceRefreshes.get(currentRunId) : null;
  if (pendingReview) await pendingReview;
  const trace = shownTrace();
  const check = await verifyChain(trace);
  const latest = shownTrace();
  const task = latest.task || {};
  const title = run ? (run.name || shortObjective(run.objective)) : shortObjective(task.objective || "工作底稿");
  lastReportHtml = FCReport.build(latest, {
    title,
    runId: run ? run.id : (store.key || "trace"),
    check,
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 19) + "Z",
  });
  lastReportName = "fcode-report-" + String(run ? run.id : (store.key || "trace")).replace(/[^a-zA-Z0-9-]+/g, "-") + ".html";
  document.getElementById("report-title").textContent = title;
  document.getElementById("report-frame").srcdoc = lastReportHtml;
  document.getElementById("report-layer").hidden = false;
}

function closeReport() {
  const layer = document.getElementById("report-layer");
  if (layer) layer.hidden = true;
  const frame = document.getElementById("report-frame");
  if (frame) frame.srcdoc = "";
  lastReportHtml = null;
}

function downloadReport() {
  if (!lastReportHtml) return;
  const bridge = desktopBridge();
  if (bridge && bridge.save_report) {
    bridge.save_report(lastReportName, lastReportHtml).then(result => {
      if (result && result.saved) toast("报告已保存 · " + result.path);
      else if (result) toast("已取消保存");
    }).catch(() => toast("保存失败"));
    return;
  }
  const blob = new Blob([lastReportHtml], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = lastReportName; a.click();
  URL.revokeObjectURL(url);
  toast("报告已下载 · 可离线打开与转发");
}

function printReport() {
  const frame = document.getElementById("report-frame");
  try {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  } catch {
    toast("此环境不支持内嵌打印，请下载后打开打印");
  }
}

function openResumeForm() {
  const trace = shownTrace() || {};
  const budget = lastBudget(trace);
  const lim = (budget && budget.limits) || {};
  const card = document.querySelector("#result-slot .result") || document.querySelector(".main .result");
  if (!card) return;
  const foot = card.querySelector(".result-foot");
  if (!foot || foot.querySelector(".resume-form")) return;
  const calls = (lim.max_calls || 0) + 6;
  const reads = (lim.max_reads || 0) + 10;
  const cost = (lim.max_cost_microusd || 0) + 20000;
  const form = document.createElement("div");
  form.className = "resume-form";
  form.innerHTML = `
    <div class="rf-title">追加预算并继续</div>
    <div class="rf-grid">
      <label>calls <input type="number" data-resume="maxCalls" min="${lim.max_calls || 0}" value="${calls}" inputmode="numeric"></label>
      <label>reads <input type="number" data-resume="maxReads" min="${lim.max_reads || 0}" value="${reads}" inputmode="numeric"></label>
      <label>µUSD <input type="number" data-resume="maxCostMicrousd" min="${lim.max_cost_microusd || 0}" value="${cost}" inputmode="numeric"></label>
    </div>
    <div class="rf-foot">
      <span class="hint">从事件日志续跑，已读资料不重发 · 轮次上限 +6</span>
      <span class="grow"></span>
      <button class="a-btn" data-resume-cancel>取消</button>
      <button class="a-btn strong" data-resume-apply>继续运行</button>
    </div>
    <div class="rf-error" hidden></div>`;
  foot.appendChild(form);
  const first = form.querySelector("input");
  if (first) first.focus();
}

async function resumeRun() {
  const form = document.querySelector(".resume-form");
  if (!form) return;
  const s = activeSession();
  const id = store.key && store.key.startsWith("run:") ? store.key.slice(4) : null;
  if (!id) { toast("没有可续跑的运行"); return; }
  const saved = runHistory.find(item => item.id === id);
  if (saved && !saved.taskId && !(s && s.id === id)) { toast("这条运行没有可续跑的持久任务"); return; }
  const read = key => Number((form.querySelector(`[data-resume="${key}"]`) || {}).value || 0);
  const payload = {
    maxCalls: read("maxCalls"),
    maxReads: read("maxReads"),
    maxCostMicrousd: read("maxCostMicrousd"),
    extraRounds: 6,
  };
  if (payload.maxCalls < 1 || payload.maxReads < 1 || payload.maxCostMicrousd < 1) {
    toast("预算上限必须是正整数");
    return;
  }
  const button = form.querySelector("[data-resume-apply]");
  if (button) button.disabled = true;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const current = activeSession();
    const run = runHistory.find(item => item.id === id) || (current && current.id === id ? current : null);
    const trace = shownTrace();
    const objective = (run && run.objective) || (trace && trace.task && trace.task.objective) || "";
    const template = (run && run.template) || ((trace && trace.task && trace.task.binding || {}).scenario) || "full";
    toast("预算已追加 · 从事件日志续跑");
    // 续跑让同一个 run 恢复运行：丢弃旧会话缓存，重新以运行态打开
    const stale = sessions.get(id);
    if (stale) { if (stale.es) stale.es.close(); sessions.delete(id); }
    if (store.sessionId === id) store.sessionId = null;
    cache.delete("run:" + id);
    openLive(id, objective, template);
    refreshRuns();
  } catch (error) {
    if (button) button.disabled = false;
    const line = form.querySelector(".rf-error");
    if (line) {
      line.hidden = false;
      line.textContent = error.message;
    }
  }
}

async function retryRun(objective, template) {
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective, template, approval: approvalMode }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const run = await response.json();
    toast("已重新提交");
    openLive(run.id, objective, run.template);
    refreshRuns();
  } catch (error) {
    toast("重试失败：" + error.message);
  }
}

function retryCurrent() {
  const run = currentRun();
  const trace = shownTrace() || {};
  const task = trace.task || {};
  const s = activeSession();
  const objective = (run && run.objective) || task.objective || (s && s.objective);
  const template = (run && run.template) || (task.binding || {}).scenario || (s && s.template);
  if (objective && template) retryRun(objective, template);
  else toast("没有可重试的运行");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to execCommand */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyDiagnostics() {
  const run = currentRun();
  const trace = shownTrace() || {};
  const terminal = trace.terminal || {};
  const failure = terminal.failure || {};
  const task = trace.task || {};
  const s = activeSession();
  const active = s && s.running ? s : null;
  const check = store.check;
  const lines = [
    "Fcode · 运行诊断",
    `run: ${(run && run.id) || (active && active.id) || store.key || "（未选择运行）"}`,
    `template: ${(run && run.template) || (task.binding || {}).scenario || (active && active.template) || "—"}`,
    `objective: ${task.objective || (run && run.objective) || (active && active.objective) || "—"}`,
    `status: ${terminal.status || (run && run.status) || (active ? "running" : "—")}` +
      (failure.code ? ` · ${failure.code}` : "") + (failure.message ? ` · ${failure.message}` : ""),
    `rounds/events: ${(trace.rounds || []).length}/${(trace.events || []).length}` +
      (check ? ` · chain: ${check.ok ? "ok" : "broken(" + check.reason + ")"}` : ""),
    run && run.error ? `error: ${run.error}` : "",
    `at: ${new Date().toISOString()}`,
  ].filter(Boolean);
  const ok = await copyText(lines.join("\n"));
  toast(ok ? "诊断信息已复制" : "复制失败");
}

/* ------------------------------------------------ LOGIC LAYER — 通知授权 */

const NOTIFY_KEY = "fa.notify";
let notifyOn = localStorage.getItem(NOTIFY_KEY) === "1";

function notifyReady() {
  return notifyOn && ("Notification" in window) && Notification.permission === "granted";
}

async function toggleNotify() {
  if (notifyOn) {
    notifyOn = false;
    localStorage.setItem(NOTIFY_KEY, "0");
    syncSettings();
    toast("完成通知已关闭");
    return;
  }
  if (!("Notification" in window)) {
    syncSettings();
    toast("此浏览器不支持系统通知");
    return;
  }
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") {
    syncSettings();
    toast("通知权限未授予");
    return;
  }
  notifyOn = true;
  localStorage.setItem(NOTIFY_KEY, "1");
  syncSettings();
  toast("完成通知已开启");
}

/* --------------- MIXED — 本机偏好状态（不改）+ 设置页 DOM 同步与渲染 */

let settingsOpen = false;
let settingsSection = "appearance";
const settingsScroll = { main: 0, rail: 0 };
let memoryStats = null;
let settingsResetArmed = false;
let settingsResetTimer = null;
let toolsLoaded = false;

function applyMotion() {
  document.body.classList.toggle("reduce-motion", !motionOn);
  const toggle = document.getElementById("settings-motion");
  if (toggle) toggle.setAttribute("aria-checked", motionOn ? "true" : "false");
}

function setMotion(on) {
  motionOn = !!on;
  localStorage.setItem(MOTION_KEY, motionOn ? "1" : "0");
  applyMotion();
  toast(motionOn ? "界面动效已开启" : "界面动效已关闭");
}

function notificationStateText() {
  if (!("Notification" in window)) return "此浏览器不支持系统通知";
  if (notifyOn && Notification.permission === "granted") return "已开启 · 浏览器已授权";
  if (notifyOn) return "已开启 · 等待浏览器授权";
  return "关闭 · 完成时只更新页面";
}

function syncSettings() {
  const modes = document.getElementById("settings-modes");
  if (modes) {
    for (const button of modes.querySelectorAll("[data-set-approval]")) {
      const active = button.dataset.setApproval === approvalMode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-checked", active ? "true" : "false");
    }
  }
  const motion = document.getElementById("settings-motion");
  if (motion) motion.setAttribute("aria-checked", motionOn ? "true" : "false");
  const notifyToggle = document.getElementById("settings-notify");
  if (notifyToggle) notifyToggle.setAttribute("aria-checked", notifyOn ? "true" : "false");
  const notifyState = document.getElementById("settings-notify-state");
  if (notifyState) notifyState.textContent = notificationStateText();

  for (const button of document.querySelectorAll("[data-set-filter]")) {
    button.classList.toggle("active", button.dataset.setFilter === railFilter);
  }

  const state = document.getElementById("settings-state");
  if (state) {
    const online = !!(health && health.live);
    state.textContent = online ? "live · local" : "offline";
    state.classList.toggle("on", online);
  }

  const cases = memoryStats && memoryStats.cases;
  const facts = memoryStats && memoryStats.facts;
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText("settings-cases", cases ? `${cases.active} / ${cases.total}` : "—");
  setText("settings-facts", facts ? `${facts.active} / ${facts.total}` : "—");
  setText("settings-artifacts", memoryStats && memoryStats.artifacts
    ? `${memoryStats.artifacts.active} / ${memoryStats.artifacts.total}`
    : "—");
  setText("settings-runs", String(runHistory.length));
  setText("settings-tools", toolContracts ? `${toolContracts.length} 个工具 · 契约已加载` : "—");
  setText("settings-chain", store.check
    ? (store.check.ok ? `链验证通过 · ${store.check.events} events` : `链断裂 · ${store.check.reason}`)
    : "当前没有加载运行");
  setText("settings-repo", health && health.repo ? `${health.repo}/flowcredit/viewer/runs` : "—");
}

function renderSettings() {
  const modes = document.getElementById("settings-modes");
  if (modes && modes.dataset.ready !== "1") {
    modes.innerHTML = APPROVAL_MODES.map(([key, title, desc]) =>
      `<button class="set-mode" type="button" role="radio" data-set-approval="${esc(key)}" aria-checked="false">
        <span class="set-dot"></span>
        <b>${esc(title)}</b>
        <small>${esc(desc)}</small>
      </button>`).join("");
    modes.dataset.ready = "1";
  }
  syncSettings();
}

async function refreshSettingsStats() {
  if (health && health.live) {
    try {
      const response = await fetch("/api/memory", { cache: "no-store" });
      if (response.ok) memoryStats = await response.json();
    } catch { /* the page shows — offline */ }
    if (!toolContracts && !toolsLoaded) {
      toolsLoaded = true;
      try {
        const response = await fetch("/api/tools", { cache: "no-store" });
        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data.tools)) toolContracts = data.tools;
        }
      } catch { toolsLoaded = false; }
    }
  }
  syncSettings();
}

function activateSettingsSection(name, behavior = motionOn ? "smooth" : "auto") {
  settingsSection = name;
  for (const button of document.querySelectorAll("#settings-nav [data-set-section]")) {
    button.classList.toggle("active", button.dataset.setSection === name);
  }
  const section = document.getElementById(`set-${name}`);
  if (section) section.scrollIntoView({ block: "start", behavior });
}

function openSettingsPage() {
  if (settingsOpen) return;
  leaveChat();
  if (intake.active) closeIntake(false);
  settingsOpen = true;
  settingsScroll.main = document.querySelector(".main")?.scrollTop || 0;
  settingsScroll.rail = document.getElementById("rail-body").scrollTop;
  document.getElementById("workspace").classList.add("settings-open");
  document.getElementById("app").classList.add("settings-open");
  document.getElementById("settings-page").hidden = false;
  document.getElementById("settings-back").textContent = "×";
  document.getElementById("settings-back").title = "关闭设置 (Esc)";
  const anchor = document.getElementById("settings-mobile") || document.getElementById("settings-btn");
  anchor?.setAttribute("aria-current", "page");
  renderSettings();
  syncChatConfig();
  document.getElementById("settings-content").scrollTop = 0;

  activateSettingsSection(settingsSection, "auto");
  refreshSettingsStats();
  document.getElementById("settings-back").focus({ preventScroll: true });
}

function closeSettingsPage(returnFocus = true) {
  if (!settingsOpen) return;
  settingsOpen = false;
  store.mode = document.getElementById("main")?.dataset.view || "run";
  document.getElementById("workspace").classList.remove("settings-open");
  document.getElementById("app").classList.remove("settings-open");
  document.getElementById("settings-page").hidden = true;
  (document.getElementById("settings-mobile") || document.getElementById("settings-btn"))?.removeAttribute("aria-current");
  requestAnimationFrame(() => {
    const scroller = document.querySelector(".main");
    if (scroller) scroller.scrollTop = settingsScroll.main;
    document.getElementById("rail-body").scrollTop = settingsScroll.rail;
  });
  if (returnFocus) (document.getElementById("settings-mobile") || document.getElementById("settings-btn"))?.focus({ preventScroll: true });
}

function toggleSettingsPage() {
  if (settingsOpen) closeSettingsPage(true);
  else renderMode("settings");
}

function disarmSettingsReset() {
  settingsResetArmed = false;
  clearTimeout(settingsResetTimer);
  const button = document.getElementById("settings-reset");
  if (button) {
    button.textContent = "恢复本机默认";
    button.classList.remove("confirm");
  }
}

function resetSettingsPreferences() {
  disarmSettingsReset();
  setApprovalMode("consequential");
  motionOn = true;
  localStorage.setItem(MOTION_KEY, "1");
  applyMotion();
  notifyOn = false;
  localStorage.setItem(NOTIFY_KEY, "0");
  railFilter = "key";
  localStorage.setItem("fa.railFilter", railFilter);
  const trace = shownTrace();
  if (trace) renderRail(trace, store.check);
  syncSettings();
  toast("本机偏好已恢复默认");
}

function bindSettings() {
  document.getElementById("settings-page").addEventListener("click", async event => {
    const target = event.target;
    if (target.closest("#settings-back") || target.closest("#settings-done")) { closeSettingsPage(true); return; }
    if (target.closest("#settings-motion")) { setMotion(!motionOn); return; }
    if (target.closest("#settings-notify")) { await toggleNotify(); syncSettings(); return; }
    const section = target.closest("[data-set-section]");
    if (section) { activateSettingsSection(section.dataset.setSection); return; }
    const filter = target.closest("[data-set-filter]");
    if (filter) {
      railFilter = filter.dataset.setFilter;
      localStorage.setItem("fa.railFilter", railFilter);
      const trace = shownTrace();
      if (trace) renderRail(trace, store.check);
      syncSettings();
      return;
    }
    if (target.closest("#settings-clear")) {
      promptHistory.length = 0;
      historyIndex = -1;
      try { localStorage.removeItem("fa.history"); } catch { /* quota */ }
      syncSettings();
      toast("输入历史已清空");
      return;
    }
    if (target.closest("#settings-refresh-memory")) {
      refreshSettingsStats().then(() => toast("记忆统计已刷新"));
      return;
    }
    if (target.closest("#settings-reset")) {
      if (!settingsResetArmed) {
        settingsResetArmed = true;
        const button = document.getElementById("settings-reset");
        button.textContent = "再次点击确认";
        button.classList.add("confirm");
        clearTimeout(settingsResetTimer);
        settingsResetTimer = setTimeout(disarmSettingsReset, 3000);
        return;
      }
      resetSettingsPreferences();
      return;
    }
    if (target.closest("#settings-diag")) {
      if (!shownTrace()) { toast("先打开一条运行再复制诊断"); return; }
      copyDiagnostics();
      return;
    }
    if (target.closest("#settings-reverify")) {
      if (!shownTrace()) { toast("当前没有加载运行"); return; }
      reverify();
      setTimeout(refreshSettingsStats, 600);
      return;
    }
    const approval = target.closest("[data-set-approval]");
    if (approval) {
      setApprovalMode(approval.dataset.setApproval);
      syncSettings();
      return;
    }
    const save = target.closest("[data-chatcfg-save]");
    if (save) { saveChatConfig(save.dataset.chatcfgSave); return; }
    const clearKey = target.closest("[data-chatcfg-clearkey]");
    if (clearKey) { clearChatConfigKey(clearKey.dataset.chatcfgClearkey); return; }
    const defaultPick = target.closest("[data-chatcfg-default]");
    if (defaultPick && !defaultPick.disabled) { setDefaultChatModel(defaultPick.dataset.chatcfgDefault); return; }
  });
}

function notify(title, body) {
  const bridge = desktopBridge();
  if (bridge && bridge.notify) {
    bridge.notify(title, body);
    return;
  }
  if (!notifyReady() || !document.hidden) return;
  try {
    const note = new Notification(title, { body, silent: true });
    note.onclick = () => { window.focus(); note.close(); };
  } catch { /* 通知失败不影响运行 */ }
}

/* --------------------------------------------------- RENDER LAYER — toast */

let toastTimer = null;
function toast(message) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("on"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("on");
    setTimeout(() => { if (!el.classList.contains("on")) el.hidden = true; }, 220);
  }, 1700);
}

/* ------------------- MIXED — 命令动作闭包（不改）+ 命令面板渲染 */

let palItems = [];
let palActive = 0;

function setAllRounds(open) {
  for (const el of document.querySelectorAll(".round")) {
    el.dataset.open = open ? "true" : "false";
    el.dataset.user = "1";
  }
  toast(open ? "已展开全部轮次" : "已折叠全部轮次");
}

function focusComposer() {
  const ta = document.getElementById("composer-ta");
  if (!ta) return;
  if (ta.disabled) { toast("有运行中的任务，先停止再派新任务"); return; }
  ta.focus();
}

function paletteActions() {
  const s = activeSession();
  const actions = [
    { ic: "＋", label: "新委托 · 需求选择", run: () => startIntake("") },
    { ic: "✎", label: "新任务 · 聚焦输入框", run: focusComposer },
  ];
  if (s && s.running) actions.push({ ic: "■", label: "停止当前运行", run: stopRun });
  if (currentRun() && !(s && s.running)) actions.push({ ic: "↻", label: "重试当前运行", run: retryCurrent });
  const trace = shownTrace();
  if (trace) {
    actions.push({ ic: "⧉", label: "复制运行诊断", run: copyDiagnostics });
    actions.push({ ic: "↓", label: "导出 trace JSON", run: exportTrace });
    if (!(store.key || "").startsWith("run:")) {
      actions.push({ ic: "⟲", label: "重放当前场景", run: replay });
    }
    if (trace.terminal && trace.terminal.status) {
      actions.push({ ic: "⎘", label: "签发审计报告", run: openReport });
    }
    actions.push({ ic: "✓", label: "重新验证签名链", run: reverify });
    actions.push({ ic: "▾", label: "展开全部轮次", run: () => setAllRounds(true) });
    actions.push({ ic: "▸", label: "折叠全部轮次", run: () => setAllRounds(false) });
  }
  actions.push({ ic: "＋", label: "打开 trace JSON 文件…", run: () => document.getElementById("pick").click() });
  actions.push({ ic: "◔", label: notifyOn ? "关闭完成通知" : "开启完成通知", run: toggleNotify });
  return actions;
}

function paletteMatches() {
  const query = (document.getElementById("palette-input").value || "").trim().toLowerCase();
  const out = [];
  const push = (group, item) => out.push({ group, ...item });
  for (const item of paletteActions()) {
    if (!query || item.label.toLowerCase().includes(query)) push("动作", item);
  }
  const runs = runHistory
    .slice()
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .filter(run => !query || `${runLabel(run)} ${run.objective}`.toLowerCase().includes(query))
    .slice(0, 6);
  for (const run of runs) push("运行", {
    label: runLabel(run),
    hint: run.status === "running" ? "运行中" : (run.rounds ? run.rounds + " 轮" : ""),
    run: () => selectRun(run.id),
  });
  return out;
}

function renderPalette() {
  palItems = paletteMatches();
  if (palActive >= palItems.length) palActive = Math.max(0, palItems.length - 1);
  const list = document.getElementById("palette-list");
  let html = "";
  let lastGroup = "";
  palItems.forEach((item, index) => {
    if (item.group !== lastGroup) {
      html += `<div class="pal-group">${esc(item.group)}</div>`;
      lastGroup = item.group;
    }
    html += `<button class="pal-item${index === palActive ? " active" : ""}" data-idx="${index}">
      <span class="pal-ic">${esc(item.ic || "")}</span>
      <span class="pal-label">${esc(item.label)}</span>
      ${item.hint ? `<span class="pal-hint">${esc(item.hint)}</span>` : ""}
    </button>`;
  });
  list.innerHTML = html || `<div class="pal-empty">没有匹配项</div>`;
  highlightPalette();
}

function highlightPalette() {
  const list = document.getElementById("palette-list");
  for (const button of list.querySelectorAll(".pal-item")) {
    button.classList.toggle("active", Number(button.dataset.idx) === palActive);
  }
  const active = list.querySelector(".pal-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  const overlay = document.getElementById("palette");
  if (!overlay) return;
  overlay.hidden = false;
  const input = document.getElementById("palette-input");
  input.value = "";
  palActive = 0;
  renderPalette();
  input.focus();
}

function closePalette() {
  const overlay = document.getElementById("palette");
  if (overlay) overlay.hidden = true;
}

function togglePalette() {
  const overlay = document.getElementById("palette");
  if (!overlay) return;
  if (overlay.hidden) openPalette();
  else closePalette();
}

function runPaletteItem(index) {
  const item = palItems[index];
  if (!item) return;
  closePalette();
  setTimeout(() => {
    try { item.run(); } catch (error) { toast("执行失败：" + error.message); }
  }, 0);
}

/* -------------------- MIXED — 命令匹配/执行（不改）+ 菜单渲染 */
/* Codex 式入口：输入框以 / 开头弹出命令面板，↑↓ 选择，Tab 补全，Enter 执行。 */
const SLASH_COMMANDS = [
  { cmd: "/new", desc: "新建委托 · 需求确认", run: () => startIntake("") },
  { cmd: "/ledger", desc: "打开工作台账本", run: () => renderMode("ledger") },
  { cmd: "/report", desc: "签发当前运行的审计报告", run: () => openReport() },
  { cmd: "/stop", desc: "在轮次边界停止当前运行", run: () => stopRun() },
  { cmd: "/allow", desc: "批准挂起的审批请求", run: () => decideApproval(true) },
  { cmd: "/deny", desc: "拒绝挂起的审批请求", run: () => decideApproval(false) },
  { cmd: "/help", desc: "快捷键与命令说明", run: () => toast("⌘K 面板 · ⌘N 新建对话 · ⌘, 设置 · ⌘. 停止 · ⌘↵ 允许 · ⌘⌫ 拒绝 · ↑↓ 历史") },
  { cmd: "/clear", desc: "清空输入框", run: () => { const ta = document.getElementById("composer-ta"); ta.value = ""; autosize(ta); } },
];
let slashIndex = 0;
let slashItems = [];
const promptHistory = (() => {
  try { return JSON.parse(localStorage.getItem("fa.history") || "[]"); } catch { return []; }
})();
let historyIndex = -1;
let draftBeforeHistory = "";

function slashMenuEl() {
  let el = document.getElementById("slash-menu");
  if (!el) {
    el = document.createElement("div");
    el.id = "slash-menu";
    el.className = "slash-menu";
    el.hidden = true;
    document.getElementById("composer-box").appendChild(el);
    el.addEventListener("mousedown", event => {
      const item = event.target.closest("[data-slash]");
      if (item) { event.preventDefault(); runSlash(item.dataset.slash); }
    });
  }
  return el;
}

function updateSlashMenu() {
  const ta = document.getElementById("composer-ta");
  const menu = slashMenuEl();
  const value = ta.value;
  if (!value.startsWith("/")) { menu.hidden = true; slashItems = []; return; }
  const query = value.slice(1).trim().toLowerCase();
  slashItems = SLASH_COMMANDS.filter(c =>
    c.cmd.slice(1).startsWith(query) || c.desc.toLowerCase().includes(query));
  if (!slashItems.length) { menu.hidden = true; return; }
  slashIndex = Math.min(slashIndex, slashItems.length - 1);
  menu.innerHTML = slashItems.map((c, i) => `<div class="slash-item${i === slashIndex ? " active" : ""}" data-slash="${esc(c.cmd.slice(1))}">
    <span class="cmd">${esc(c.cmd)}</span><span class="desc">${esc(c.desc)}</span></div>`).join("");
  menu.hidden = false;
}

function runSlash(name) {
  const command = SLASH_COMMANDS.find(c => c.cmd === "/" + name);
  const ta = document.getElementById("composer-ta");
  ta.value = "";
  autosize(ta);
  slashMenuEl().hidden = true;
  slashItems = [];
  if (command) command.run();
}

function pushHistory(text) {
  if (!text) return;
  promptHistory.push(text);
  while (promptHistory.length > 50) promptHistory.shift();
  try { localStorage.setItem("fa.history", JSON.stringify(promptHistory)); } catch { /* quota */ }
  historyIndex = -1;
}

/* 取手绘图标：mode=false 静止 / true 动画 / "draw" 只描边一次（不沸腾） */
function doodleSvg(name, mode = false) {
  if (!name) return "";
  /* 印章线稿优先：家族语言统一（见 brand/seal-icons.js） */
  const seal = window.SEAL_ICONS && window.SEAL_ICONS.still && window.SEAL_ICONS.still[name];
  if (seal) return seal;
  const set = window.DOODLE_ICONS || {};
  const animated = set.animated && set.animated[name];
  if (mode === "draw" && animated) {
    return animated.replace('class="d-icon d-icon-anim ', 'class="d-icon d-icon-anim draw-only ');
  }
  if (mode && animated) return animated;
  return (set.still && set.still[name]) || "";
}

/* 内联手绘图标：data-doodle 槽位在启动/重绘后填充 */
function hydrateDoodles(root = document) {
  const set = window.DOODLE_ICONS || {};
  const seal = window.SEAL_ICONS && window.SEAL_ICONS.still || {};
  for (const slot of root.querySelectorAll("[data-doodle]")) {
    if (slot.dataset.hydrated === "1") continue;
    const name = slot.dataset.doodle;
    /* 印章线稿优先：同名接管，家族语言统一 */
    if (seal[name]) { slot.innerHTML = seal[name]; slot.dataset.hydrated = "1"; continue; }
    const useAnimated = slot.dataset.doodleAnim === "1";
    const svg = (useAnimated && set.animated && set.animated[name])
      || (set.still && set.still[name]) || "";
    if (!svg) continue;
    slot.innerHTML = svg;
    slot.dataset.hydrated = "1";
  }
}

/* ================================================================ Chat
   对话是“回答”，不是“运行”：每次回答仍是一笔受预算约束、进事件链的
   模型调用，但不执行工具。需要执行时，用户点「转为委托」。 */

async function loadChatThreads(reset = true) {
  if (!health || !health.live) return;
  const offset = reset ? 0 : chatThreads.length;
  try {
    const data = await fetch(
      `/api/chat/threads?limit=${chat.limit}&offset=${offset}`,
      { cache: "no-store" },
    ).then(r => r.ok ? r.json() : null);
    const list = data && Array.isArray(data.threads) ? data.threads : [];
    if (data && Number.isFinite(Number(data.total))) chat.total = Number(data.total);
    chatThreads = reset
      ? list
      : chatThreads.concat(list.filter(thread => !chatThreads.some(item => item.id === thread.id)));
    chat.threads = chatThreads;
    renderChats();
  } catch { /* 侧栏列表失败不阻塞对话 */ }
}

function renderChats() {
  const nav = document.getElementById("chat-nav");
  if (!nav) return;
  const count = document.getElementById("chat-count");
  if (count) count.textContent = String(chatThreads.length);
  if (!chatThreads.length) {
    nav.innerHTML = `<div class="side-empty-inline">还没有对话</div>`;
    return;
  }
  const items = chatThreads.map(thread => {
    const active = chat.current && chat.current.id === thread.id;
    return `<button class="session chat-row${active ? " active" : ""}" data-chat-id="${esc(thread.id)}" title="${esc(thread.title)}">
      <span class="slabel">${esc(thread.title)}</span>
      <span class="chat-del" data-chat-delete="${esc(thread.id)}" role="button" title="从列表移除（事件链保留）">×</span>
    </button>`;
  }).join("");
  const more = chatThreads.length < chat.total
    ? `<button class="chat-more" type="button" data-chat-more>加载更多 · 还有 ${chat.total - chatThreads.length} 条</button>`
    : "";
  nav.innerHTML = items + more;
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
      chatThreads = chatThreads.filter(thread => thread.id !== threadId);
      chat.threads = chatThreads;
      chat.total = Math.max(0, chat.total - 1);
      if (chat.current && chat.current.id === threadId) newChat();
      renderChats();
      toast("对话已从列表移除（事件链保留）");
    } catch (error) {
      toast("删除失败：" + error.message);
    }
  })();
}

function adoptDefaultChatModel(defaultKey) {
  if (chatModelTouched || !defaultKey) return;
  const entry = chatModels.find(m => m.key === defaultKey && m.available);
  if (entry && chatModelChoice.key !== entry.key) {
    chatModelChoice.key = entry.key;
    saveChatModelChoice();
    paintModelBadge();
  }
}

async function loadChatModels() {
  if (!health || !health.live) return;
  try {
    const data = await fetch("/api/chat/models", { cache: "no-store" }).then(r => r.ok ? r.json() : null);
    if (data && Array.isArray(data.models)) {
      chatModels = data.models;
      adoptDefaultChatModel(data.default);
      if (chat.active) paintModelBadge();
    }
  } catch { /* 菜单打开时会重试 */ }
}

function renderChatModelMenu() {
  const menu = document.getElementById("model-menu");
  if (!menu) return;
  const items = chatModels.map(m => {
    const current = m.available && m.key === chatModelChoice.key;
    return `<button class="tpl-item model-item${current ? " active" : ""}${m.available ? "" : " disabled"}" data-chatmodel-pick="${esc(m.key)}"${m.available ? "" : " disabled"}>
      <span class="t"><span>${esc(m.label)}${current ? '<span class="check">✓</span>' : ""}</span><span class="m">${esc(m.model)}</span></span>
      <span class="d">${m.available ? (m.remote && m.price ? `${num(m.price.inputMicrousdPerMtok)} / ${num(m.price.outputMicrousdPerMtok)} µUSD·MTok⁻¹` : "离线 · 不产生外部计费") : esc(m.reason)}</span>
    </button>`;
  }).join("");
  menu.innerHTML = items + `<div class="tpl-note">对话模型；委托运行的模型仍由环境变量配置</div>
    <button class="tpl-item" type="button" data-chatmodel-settings><span class="t"><span>管理模型配置…</span></span><span class="d">设置 → 模型与工具：填写 API Key 与价格</span></button>`;
}

async function syncChatConfig() {
  if (!health || !health.live) return;
  try {
    const data = await fetch("/api/settings/chat-config", { cache: "no-store" }).then(r => r.ok ? r.json() : null);
    if (!data) return;
    chatConfig = data.config || { providers: {}, default_model: "mock" };
    chatConfigSource = data.source || null;
    chatModels = Array.isArray(data.models) ? data.models : chatModels;
    renderChatConfig(true);
  } catch { /* 设置页会显示加载失败 */ }
}

/* 一组设置同时喂两个面：对话与委托运行。价格与日期是必填项——预算顶不能
   建立在猜来的价格上，这条规则委托侧一直有，现在对话侧也一致。 */
const CHATCFG_FIELDS = {
  kimi: [
    ["model", "模型", "kimi-k2.6"],
    ["api_key", "API Key", ""],
    ["input_price_microusd_per_mtok", "输入价 µUSD/MTok", "950000"],
    ["output_price_microusd_per_mtok", "输出价 µUSD/MTok", "4000000"],
    ["price_as_of", "价格日期（YYYY-MM-DD）", "2026-10-25"],
    ["price_source", "价格来源", "moonshot-cn-published"],
    ["min_interval_seconds", "最小间隔（秒）", "22"],
    ["max_completion_tokens", "最大补全 tokens", "2048"],
  ],
  deepseek: [
    ["model", "模型", "deepseek-chat"],
    ["api_key", "API Key", ""],
    ["input_price_microusd_per_mtok", "输入价 µUSD/MTok", ""],
    ["output_price_microusd_per_mtok", "输出价 µUSD/MTok", ""],
    ["price_as_of", "价格日期（YYYY-MM-DD）", ""],
    ["price_source", "价格来源", ""],
    ["min_interval_seconds", "最小间隔（秒）", "0"],
    ["max_completion_tokens", "最大补全 tokens", "2048"],
  ],
  local: [
    ["base_url", "端点（OpenAI 兼容）", "http://127.0.0.1:11434/v1"],
    ["model", "模型", "fcode-qwen3-4b"],
    ["api_key", "API Key（可选）", ""],
    ["max_completion_tokens", "最大补全 tokens", "2048"],
  ],
};

function renderChatConfig(preserveInputs = false) {
  const defaultSlot = document.getElementById("chatcfg-default");
  const cardsSlot = document.getElementById("chatcfg-cards");
  if (!defaultSlot || !cardsSlot) return;
  const before = {};
  if (preserveInputs) {
    document.querySelectorAll("#chatcfg input").forEach(input => {
      // Passwords are intentionally not restored: a saved key clears the field.
      if (input.type !== "password") before[input.id] = input.value;
    });
  }
  const providers = (chatConfig && chatConfig.providers) || {};
  const fallbacks = { kimi: "Kimi 云端", deepseek: "DeepSeek 云端", local: "本地模型", mock: "离线 Mock" };
  const currentDefault = (chatConfig && chatConfig.default_model) || "mock";
  defaultSlot.innerHTML = `<span class="chatcfg-label">默认对话模型</span>` + ["mock", "kimi", "deepseek", "local"].map(key => {
    const entry = chatModels.find(m => m.key === key);
    const usable = key === "mock" || (entry && entry.available);
    return `<button type="button" class="chatcfg-radio${currentDefault === key ? " active" : ""}" data-chatcfg-default="${esc(key)}"${usable ? "" : " disabled"} title="${usable ? "" : esc(entry ? entry.reason : "未配置")}">
      <span class="dot${usable ? " ok" : ""}"></span>${esc(fallbacks[key])}
    </button>`;
  }).join("");
  const sourceLine = (() => {
    if (!chatConfigSource || !chatConfigSource.path) return "";
    const fmt = seconds => seconds ? new Date(seconds * 1000).toLocaleString() : "—";
    const stale = chatConfigSource.stale
      ? `<b class="bad">配置文件比本进程新（本进程加载于 ${esc(fmt(chatConfigSource.loadedAt))}）——重启后生效</b>`
      : `<span class="dim">本进程已加载最新配置</span>`;
    return `<p class="chatcfg-source">配置文件：<code>${esc(chatConfigSource.path)}</code> · 最后修改 ${esc(fmt(chatConfigSource.fileMtime))} · ${stale}</p>`;
  })();
  cardsSlot.innerHTML = sourceLine + Object.entries(CHATCFG_FIELDS).map(([provider, fields]) => {
    const stored = providers[provider] || {};
    const entry = chatModels.find(m => m.key === provider);
    let status;
    if (entry && entry.available) {
      status = `<span class="chatcfg-status ok">可用 · ${esc(entry.model)}</span>`;
    } else {
      const reason = entry ? entry.reason : "未配置";
      const missing = reason.includes("缺少")
        ? (reason.split("缺少")[1].match(/、/g) || []).length + 1
        : 1;
      status = `<span class="chatcfg-status bad" title="${esc(reason)}">未配置 · 缺 ${missing} 项</span>`;
    }
    const inputs = fields.map(([name, label, placeholder]) => {
      const value = name === "api_key" ? "" : String(stored[name] ?? "");
      const hint = name === "api_key"
        ? (stored.api_key_set ? `已保存 ${esc(stored.api_key_masked || "")} · 留空保持不变` : "未设置")
        : "";
      return `<label class="chatcfg-field">
        <span>${esc(label)}${hint ? `<i>${hint}</i>` : ""}</span>
        <input id="chatcfg-${provider}-${name}" type="${name === "api_key" ? "password" : "text"}"
          value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">
      </label>`;
    }).join("");
    return `<div class="chatcfg-card" data-chatcfg-card="${provider}">
      <div class="chatcfg-card-head"><b>${esc(fallbacks[provider])}</b>${status}</div>
      <p class="chatcfg-scope">同时用于对话与委托运行（设置 &gt; 环境 &gt; 默认）。云端端点固定为官方地址，不能在这里改。</p>
      <div class="chatcfg-grid">${inputs}</div>
      <div class="chatcfg-actions">
        <button type="button" class="chat-act strong" data-chatcfg-save="${provider}">保存</button>
        ${stored.api_key_set ? `<button type="button" class="chat-act" data-chatcfg-clearkey="${provider}">清除密钥</button>` : ""}
        <span class="chatcfg-note">留空保存 = 清除该项（回落到环境变量/默认）</span>
      </div>
    </div>`;
  }).join("");
  if (preserveInputs) {
    for (const [id, value] of Object.entries(before)) {
      const input = document.getElementById(id);
      if (input) input.value = value;
    }
  }
}

async function saveChatConfig(provider) {
  if (!provider || !CHATCFG_FIELDS[provider]) return;
  const values = {};
  for (const [name] of CHATCFG_FIELDS[provider]) {
    const input = document.getElementById(`chatcfg-${provider}-${name}`);
    if (!input) continue;
    const value = String(input.value || "").trim();
    if (name === "api_key" && !value) continue; // 留空 = 保持不变
    values[name] = value;
  }
  try {
    const response = await fetch("/api/settings/chat-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, values }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    chatConfig = data.config;
    chatConfigSource = data.source || chatConfigSource;
    chatModels = Array.isArray(data.models) ? data.models : chatModels;
    renderChatConfig(true);
    paintModelBadge();
    toast("已保存（本机）");
  } catch (error) {
    toast("保存失败：" + error.message);
  }
}

async function clearChatConfigKey(provider) {
  try {
    const response = await fetch("/api/settings/chat-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, values: { api_key: "" } }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    chatConfig = data.config;
    chatConfigSource = data.source || chatConfigSource;
    chatModels = Array.isArray(data.models) ? data.models : chatModels;
    renderChatConfig(true);
    paintModelBadge();
    toast("密钥已清除（回落到环境变量）");
  } catch (error) {
    toast("清除失败：" + error.message);
  }
}

async function setDefaultChatModel(key) {
  try {
    const response = await fetch("/api/settings/chat-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_model: key }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    chatConfig = data.config;
    chatConfigSource = data.source || chatConfigSource;
    chatModels = Array.isArray(data.models) ? data.models : chatModels;
    if (!chatModelTouched) {
      const entry = chatModels.find(m => m.key === key && m.available);
      if (entry) { chatModelChoice.key = key; saveChatModelChoice(); }
    }
    renderChatConfig(true);
    paintModelBadge();
    toast(`默认对话模型：${key}`);
  } catch (error) {
    toast("设置失败：" + error.message);
  }
}

function leaveChat() {
  if (chat.abort) {
    try { chat.abort.abort(); } catch { /* already settled */ }
  }
  if (chat.paintTimer) { clearTimeout(chat.paintTimer); chat.paintTimer = null; }
  const wasActive = chat.active;
  const wasStreaming = chat.streaming;
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
  if (attach) {
    attach.hidden = !on;
    attach.style.display = on ? "" : "none";
  }
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

const WORK_STAGE_NOTE = "把任务交给 FCode：自己规划、动手执行、完成后给你产物。";
const WORK_STAGE_FOOTNOTE = "每次工具调用都过权限门控与预算，全程写入签名链——需要你确认的动作会停下来问。";
const WORK_PLACEHOLDER = "给 FCode 派一个任务…";
let uiMode = (() => {
  try { return localStorage.getItem("fa.uiMode") === "work" ? "work" : "chat"; }
  catch { return "chat"; }
})();

function detachChatChrome() {
  /* 模式切换用：拆掉对话的界面件，但保留 chat.current，
     让「对话 ↔ 工作」往返后线程可以从内存恢复。 */
  if (chat.abort) {
    try { chat.abort.abort(); } catch { /* already settled */ }
  }
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
  if (intake.active) closeIntake(false);
  if (settingsOpen) closeSettingsPage(false);
  ledgerOpen = false;
  if (activeSession()) detachLive();
  setChromeState({ rail: false });
  store.key = null;
  store.trace = null;
  chat.active = false;          /* chat.current 保留：切回对话可恢复线程 */
  chat.streaming = false;
  chat.editing = null;
  renderNav();
  renderMain(stageEmptyHtml(WORK_STAGE_NOTE, { work: true }), { mode: "empty" });
  paintChatChrome(false);
  document.getElementById("tb-title").textContent = "FCode";
  document.getElementById("tb-chips").innerHTML = "";
  const ta = document.getElementById("composer-ta");
  if (ta) {
    ta.value = "";
    autosize(ta);
    ta.placeholder = WORK_PLACEHOLDER;
    ta.focus();
  }
  renderChatAttachChips();
  paintSendState();
}

function switchToChat() {
  if (chat.current && (chat.current.messages || []).length) {
    chat.active = true;
    chat.streaming = false;
    chat.editing = null;
    renderNav();
    renderChat({ forceBottom: true });
    paintChatChrome(true);
    const ta = document.getElementById("composer-ta");
    if (ta) { ta.value = ""; autosize(ta); ta.placeholder = "给 FCode 发消息…"; }
    paintSendState();
  } else {
    newChat();
  }
}

function setUiMode(mode) {
  if (uiMode !== mode) {
    uiMode = mode;
    try { localStorage.setItem("fa.uiMode", mode); } catch { /* quota */ }
  }
  const app = document.getElementById("app");
  app.classList.toggle("mode-chat", mode === "chat");
  app.classList.toggle("mode-work", mode === "work");
  const chatTab = document.getElementById("mode-chat");
  const workTab = document.getElementById("mode-work");
  if (chatTab) {
    chatTab.classList.toggle("active", mode === "chat");
    chatTab.setAttribute("aria-selected", mode === "chat" ? "true" : "false");
  }
  if (workTab) {
    workTab.classList.toggle("active", mode === "work");
    workTab.setAttribute("aria-selected", mode === "work" ? "true" : "false");
  }
  const paneChat = document.getElementById("pane-chat");
  const paneWork = document.getElementById("pane-work");
  if (paneChat) paneChat.hidden = mode !== "chat";
  if (paneWork) paneWork.hidden = mode !== "work";
  const newLabel = document.getElementById("new-label");
  if (newLabel) newLabel.textContent = mode === "work" ? "新建工作" : "新对话";
  const newBtn = document.getElementById("new-run");
  if (newBtn) newBtn.title = mode === "work" ? "新建工作：受门控的委托运行" : "新对话";
  if (mode === "chat") {
    if (chat.active && document.getElementById("main")?.dataset.view === "empty") return;
    if (chat.current && (chat.current.messages || []).length) switchToChat();
    else if (!chat.active) newChat();
  } else {
    const view = document.getElementById("main")?.dataset.view;
    if (view === "empty" && !chat.active) {
      renderMain(stageEmptyHtml(WORK_STAGE_NOTE, { work: true }), { mode: "empty" });
      const ta = document.getElementById("composer-ta");
      if (ta) ta.placeholder = WORK_PLACEHOLDER;
      return;
    }
    if (activeSession()) selectRun(activeSession().id);
    else openWorkHome();
  }
}

function newChat() {
  leaveChat();
  if (intake.active) closeIntake(false);
  if (settingsOpen) closeSettingsPage(false);
  ledgerOpen = false;
  if (activeSession()) detachLive();
  setChromeState({ rail: false });
  store.key = null;
  store.trace = null;
  chat.active = true;
  chat.current = null;
  chat.streaming = false;
  chat.editing = null;
  chat.attachments = [];
  renderNav();
  renderMain(stageEmptyHtml("向 FCode 提问，或让 FCode 帮你整理思路", { chat: true }), { mode: "empty" });
  paintChatChrome(true);
  document.getElementById("tb-title").textContent = "FCode";
  document.getElementById("tb-chips").innerHTML = "";
  const ta = document.getElementById("composer-ta");
  if (ta) {
    ta.value = "";
    autosize(ta);
    ta.placeholder = "给 FCode 发消息…";
    ta.focus();
  }
  renderChatAttachChips();
  paintSendState();
  adoptDefaultChatModel(chatConfig && chatConfig.default_model);
  loadChatModels();
}

async function openChat(threadId) {
  leaveChat();
  if (intake.active) closeIntake(false);
  if (settingsOpen) closeSettingsPage(false);
  ledgerOpen = false;
  if (activeSession()) detachLive();
  setChromeState({ rail: false });
  store.key = null;
  store.trace = null;
  chat.active = true;
  chat.current = null;
  chat.streaming = false;
  chat.editing = null;
  chat.attachments = [];
  renderNav();
  renderMain(`<div class="empty">加载对话…</div>`, { mode: "loading" });
  try {
    const response = await fetch(`/api/chat/threads/${encodeURIComponent(threadId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    chat.current = await response.json();
    await prepareCardRuns(chat.current);
  } catch (error) {
    toast("对话加载失败：" + error.message);
    newChat();
    return;
  }
  paintChatChrome(true);
  renderChatHead();
  renderChat({ forceBottom: true });
  renderNav();
  const ta = document.getElementById("composer-ta");
  if (ta) {
    ta.value = "";
    autosize(ta);
    ta.placeholder = "给 FCode 发消息…";
    ta.focus();
  }
  paintSendState();
}

function renderChat({ forceBottom = false } = {}) {
  const thread = chat.current;
  if (!thread || !(thread.messages || []).length) {
    renderMain(`<div class="chat-empty">
      <div class="chat-empty-mark">FCode</div>
      <p>开始一段对话。对话只回答，不执行工具；需要读写文件或运行命令时，用「委托运行」。</p>
    </div>`, { mode: "chat" });
    return;
  }
  const stick = forceBottom || nearMainBottom();
  renderMain(
    `<div class="chat-thread" aria-live="polite">${thread.messages
      .map(message => chatMessageHtml(message, chat.editing, chatCardHtml(message)))
      .join("")}</div>`,
    { mode: "chat" },
  );
  if (stick) requestAnimationFrame(scrollMainBottom);
}

/* 轻量 Markdown：标题 / 列表 / 引用 / 代码围栏 / 行内代码 / 粗斜体 / 链接。
   先转义再应用行内规则；未知语法按纯文本处理。 */
function renderChatAttachChips() {
  const slot = document.getElementById("chat-attach-chips");
  if (!slot) return;
  slot.hidden = !chat.attachments.length;
  slot.innerHTML = chat.attachments.map((file, index) =>
    `<span class="chat-file">${esc(file.name)}<button class="chat-file-x" type="button" data-chat-attach-remove="${index}" title="移除">×</button></span>`
  ).join("");
}

async function handleChatFiles(event) {
  const files = [...(event.target.files || [])];
  for (const file of files) {
    if (chat.attachments.length >= 3) { toast("最多 3 个附件"); break; }
    if (file.size > 64 * 1024) { toast(`${file.name} 超过 64 KiB`); continue; }
    let text;
    try { text = await file.text(); } catch { toast(`${file.name} 读取失败`); continue; }
    if (text.includes("\u0000")) { toast(`${file.name} 不是纯文本文件`); continue; }
    chat.attachments.push({ name: file.name, text });
  }
  event.target.value = "";
  renderChatAttachChips();
  paintSendState();
}

function paintSendState() {
  const btn = document.getElementById("send");
  if (!btn) return;
  if (!chat.active) return; // 运行/委托态由各自的函数管理
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
  hydrateDoodles(btn);
  const ta = document.getElementById("composer-ta");
  const hasText = !!(ta && ta.value.trim());
  btn.disabled = !(health && health.live) || (!hasText && !chat.attachments.length);
}

function restoreSendButton() {
  const btn = document.getElementById("send");
  if (!btn) return;
  btn.classList.remove("stop");
  btn.title = "发送任务";
  btn.innerHTML = `<span data-doodle="arrow-up"></span>`;
  hydrateDoodles(btn);
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
  try { chat.abort.abort(); } catch { /* already settled */ }
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
  const stick = nearMainBottom();
  const body = node.querySelector(".chat-md");
  if (body) body.innerHTML = renderMarkdown(assistant.text);
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
  } else if (wait) {
    wait.remove();
  }
  if (stick) scrollMainBottom();
}

async function sendChatFromComposer() {
  if (chat.streaming) return;
  if (!health || !health.live) { toast("回放模式：启动 server.py 后才能对话"); return; }
  const ta = document.getElementById("composer-ta");
  const text = (ta.value || "").trim();
  const attachments = chat.attachments.map(file => ({ name: file.name, text: file.text }));
  if (!text && !attachments.length) return;
  ta.value = "";
  autosize(ta);
  chat.attachments = [];
  renderChatAttachChips();
  const threadId = chat.current && chat.current.id ? chat.current.id : null;
  const model = chatModelChoice.key || "mock";
  if (!chat.current) {
    chat.current = { id: null, title: (text || attachments[0].name || "新对话").slice(0, 30), messages: [] };
  }
  if (!chat.current.messages) chat.current.messages = [];
  chat.current.messages.push({
    id: "pending-user-" + Date.now(),
    role: "user",
    text,
    attachments: attachments.map(file => ({ name: file.name, bytes: file.text.length })),
    status: "ok",
  });
  chat.current.messages.push({
    id: "pending-assistant",
    role: "assistant",
    text: "",
    reasoning: "",
    status: "streaming",
    usage: {},
    error: {},
  });
  renderChatHead();
  renderChat({ forceBottom: true });
  setChatStreaming(true);
  await streamChat("/api/chat/send", { threadId, text, attachments, model });
}

async function streamChat(url, payload) {
  const threadRef = chat.current;
  const assistant = threadRef && threadRef.messages
    ? threadRef.messages[threadRef.messages.length - 1]
    : null;
  if (!assistant || assistant.role !== "assistant") { setChatStreaming(false); return; }
  const controller = new AbortController();
  chat.abort = controller;
  let aborted = false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("浏览器没有拿到流式响应");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
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
      toast("对话失败：" + error.message);
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
        } catch { /* keep the optimistic view */ }
      }
      renderChat();
      renderChatHead();
    } else if (chat.abort === controller) {
      chat.abort = null;
    }
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
          const pending = [...threadRef.messages].reverse()
            .find(message => message.role === "user" && String(message.id).startsWith("pending-user-"));
          if (pending) Object.assign(pending, event.user);
        }
        if (event.assistant_id) assistant.id = event.assistant_id;
        renderChatHead();
        renderChat();
      }
      break;
    case "wait":
      assistant.waiting = Number(event.seconds) || 0;
      scheduleChatPaint(assistant);
      break;
    case "reasoning":
      assistant.reasoning = (assistant.reasoning || "") + String(event.text || "");
      scheduleChatPaint(assistant);
      break;
    case "delta":
      assistant.text = (assistant.text || "") + String(event.text || "");
      scheduleChatPaint(assistant);
      break;
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
    case "stopped":
      assistant.status = "cancelled";
      renderChat();
      break;
    default:
      break;
  }
}

function beginChatEdit(messageId) {
  chat.editing = messageId;
  renderChat();
  requestAnimationFrame(() => document.getElementById("chat-edit-input")?.focus());
}

function cancelChatEdit() {
  chat.editing = null;
  renderChat();
}

function saveChatEdit(messageId) {
  if (!chat.current || !chat.current.id) return;
  const input = document.getElementById("chat-edit-input");
  const text = (input && input.value || "").trim();
  if (!text) { toast("消息不能为空"); return; }
  const index = chat.current.messages.findIndex(message => message.id === messageId);
  if (index < 0) return;
  chat.editing = null;
  chat.current.messages = chat.current.messages.slice(0, index);
  chat.current.messages.push({
    id: "pending-user-" + Date.now(),
    role: "user",
    text,
    attachments: [],
    status: "ok",
  });
  chat.current.messages.push({
    id: "pending-assistant",
    role: "assistant",
    text: "",
    reasoning: "",
    status: "streaming",
    usage: {},
    error: {},
  });
  renderChat({ forceBottom: true });
  setChatStreaming(true);
  streamChat(`/api/chat/threads/${encodeURIComponent(chat.current.id)}/edit`, {
    messageId, text, model: chatModelChoice.key || "mock",
  });
}

function regenerateChat(messageId) {
  if (!chat.current || !chat.current.id) return;
  const index = chat.current.messages.findIndex(message => message.id === messageId);
  if (index < 0) return;
  chat.current.messages = chat.current.messages.slice(0, index);
  chat.current.messages.push({
    id: "pending-assistant",
    role: "assistant",
    text: "",
    reasoning: "",
    status: "streaming",
    usage: {},
    error: {},
  });
  renderChat({ forceBottom: true });
  setChatStreaming(true);
  streamChat(`/api/chat/threads/${encodeURIComponent(chat.current.id)}/regenerate`, {
    messageId, model: chatModelChoice.key || "mock",
  });
}

function copyChatMessage(messageId) {
  if (!chat.current) return;
  const message = chat.current.messages.find(item => item.id === messageId);
  if (!message) return;
  copyText(message.text).then(ok => toast(ok ? "已复制回答" : "复制失败"));
}

function delegateChatMessage(messageId) {
  if (!chat.current) return;
  const message = chat.current.messages.find(item => item.id === messageId);
  if (!message || message.role !== "user") return;
  startIntake(message.text, { origin: threadOrigin(chat.current) });
}

/* 对话上下文随委托一起走：本轮目标是 message.text，但“周三/当天/到了后”
   指代的是本线程前文。取尾部 24 条（越近越相关），每条截断 600 字，
   与后端 validate_delegation_spec 的上限一致。 */
const ORIGIN_MESSAGES = 24;
const ORIGIN_CHARS = 600;

function threadOrigin(thread) {
  if (!thread) return null;
  const messages = (thread.messages || [])
    .filter(item => item.status !== "error" && (item.role === "user" || item.role === "assistant"))
    .map(item => ({ role: item.role, text: String(item.text || "").slice(0, ORIGIN_CHARS) }))
    .filter(item => item.text)
    .slice(-ORIGIN_MESSAGES);
  return { threadId: thread.id || null, threadTitle: thread.title || "", messages };
}

/* ------------------------------------------- 对话内执行卡（chat v2 · P1）
   对话本身绝不执行工具：模型只能在回答里提出一个提案块，前端把它渲染成一张
   卡片；只有用户点「开始执行」，卡片才把提案（含用户的编辑）交给确认端点，
   由运行流水线创建一次受治理的运行。卡片之后的进度不是前端猜的——它订阅运行
   自己的 SSE，与 Work 视图读同一份签名轨迹。 */

const cssEscape = value => (window.CSS && window.CSS.escape
  ? window.CSS.escape(String(value))
  : String(value).replace(/["\\]/g, "\\$&"));

function chatCardHtml(message) {
  if (!message.action) return "";
  const state = chat.cards.get(message.id) || {};
  if (message.run) {
    return runMirrorHtml(message, mirrorView(message), { run: message.run });
  }
  if (state.dismissed) {
    return `<div class="run-card dismissed" data-card="${esc(message.id)}" data-run-card="${esc(message.id)}">
      <span class="run-card-hint">已忽略这个提案</span>
      <span class="grow"></span>
      <button type="button" class="run-act" data-run-reconsider="${esc(message.id)}">重新考虑</button>
    </div>`;
  }
  return actionCardHtml(message, {
    draft: state.draft,
    mode: state.mode,
    sources: state.sources,
    busy: state.busy,
    error: state.error,
    approval: approvalMode,
  });
}

function cardState(messageId) {
  if (!chat.cards.has(messageId)) chat.cards.set(messageId, {});
  return chat.cards.get(messageId);
}

/* 输入框不触发重绘，光标就不会丢；结构性变化（切方式/提交中）之前先把
   用户已经敲进 DOM 的内容读回状态。 */
function readCardDraft(messageId) {
  const node = document.querySelector(`[data-run-card="${cssEscape(messageId)}"]`);
  if (!node) return;
  const state = cardState(messageId);
  const goal = node.querySelector("[data-run-goal]");
  const sources = node.querySelector("[data-run-sources]");
  if (goal) state.draft = goal.value;
  if (sources) state.sources = sources.value;
}

function paintCard(messageId) {
  const message = chatMessageById(messageId);
  if (!message) return;
  const node = document.querySelector(`[data-run-card="${cssEscape(messageId)}"]`);
  if (!node) { renderChat(); return; }
  const holder = document.createElement("div");
  holder.innerHTML = chatCardHtml(message);
  const next = holder.firstElementChild;
  if (next) node.replaceWith(next);
}

function chatMessageById(messageId) {
  const thread = chat.current;
  if (!thread || !thread.messages) return null;
  return thread.messages.find(item => item.id === messageId) || null;
}

function parseSourceLines(text) {
  return String(text || "")
    .split(/[\n,，\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

async function startCardRun(messageId) {
  const message = chatMessageById(messageId);
  if (!message || !message.action || message.run) return;
  readCardDraft(messageId);
  const state = cardState(messageId);
  if (state.busy) return;
  const goal = String(state.draft !== undefined ? state.draft : message.action.goal || "").trim();
  const mode = state.mode || message.action.mode || "script";
  const sources = mode === "research"
    ? parseSourceLines(state.sources !== undefined ? state.sources : (message.action.sources || []).join("\n"))
    : [];
  /* 本地先按同一套规则拦一遍，错误直接落在卡片上；服务端仍会独立复核。 */
  if (goal.length < 5 || goal.length > 600) {
    state.error = "目标需要 5 到 600 个字";
    paintCard(messageId);
    return;
  }
  if (mode === "research" && (sources.length < 1 || sources.length > 5)) {
    state.error = "研究方式需要 1 到 5 个 http(s) 来源";
    paintCard(messageId);
    return;
  }
  state.busy = true;
  state.error = "";
  paintCard(messageId);
  try {
    const response = await fetch(
      `/api/chat/threads/${encodeURIComponent(chat.current.id)}/confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId, goal, mode, sources,
          approval: approvalMode,
          // 这次调用创建的是**委托运行**，模型必须来自 Work 侧的目录。
          // 以前送的是对话侧的 key：委托目录里没有它，确认必然 400。
          model: modelChoice.key || "mock",
          effort: modelChoice.effort || "",
        }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    const run = payload.run || {};
    message.run = { id: run.id, goal, mode, at: new Date().toISOString() };
    chat.cards.delete(messageId);
    seedMirror(messageId, run);
    paintCard(messageId);
    loadChatThreads();
    toast(`已开始运行 ${run.id}`);
  } catch (error) {
    state.busy = false;
    state.error = error.message;
    paintCard(messageId);
  }
}

function dismissCard(messageId) {
  const state = cardState(messageId);
  state.dismissed = true;
  paintCard(messageId);
}

function reconsiderCard(messageId) {
  const state = cardState(messageId);
  state.dismissed = false;
  paintCard(messageId);
}

/* ------------------------------------------------------------- 运行镜像 */

function mirrorView(message) {
  const state = chat.mirrors.get(message.id);
  const run = message.run || {};
  const live = Object.assign(
    { finished: ["succeeded", "failed", "stopped"].includes(run.status) },
    state ? state.live : {},
  );
  return mirrorFrom(state ? state.trace : null, live, rowDescription);
}

const rowDescription = observation => stripTags((describe(observation) || [])[0] || "");
const TERMINAL_STATUS = ["succeeded", "failed", "stopped"];

/* 进入一段对话时，先把锚定的运行读一遍：卡片第一次出现就是事实，
   不是「等待中」的占位。随后 SSE 接管。 */
async function prepareCardRuns(thread) {
  const anchored = (thread.messages || []).filter(message => message.run && message.run.id);
  await Promise.all(anchored.map(async message => {
    if (chat.mirrors.has(message.id)) return;
    let run = null;
    try {
      const response = await fetch(`/api/runs/${encodeURIComponent(message.run.id)}`, { cache: "no-store" });
      if (response.ok) run = await response.json();
    } catch { /* the card falls back to whatever the anchor recorded */ }
    if (chat.current !== thread) return;
    seedMirror(message.id, run || { id: message.run.id });
  }));
}

function seedMirror(messageId, run) {
  const entry = chat.mirrors.get(messageId) || { runId: run.id, trace: null, live: {}, es: null };
  entry.runId = run.id;
  entry.live = Object.assign({}, entry.live, {
    status: run.status || entry.live.status || "",
    error: run.error || entry.live.error || "",
    cost: run.cost || entry.live.cost || null,
    finished: TERMINAL_STATUS.includes(run.status) || entry.live.finished,
  });
  chat.mirrors.set(messageId, entry);
  attachMirror(messageId, entry);
  return entry;
}

function attachMirror(messageId, entry) {
  if (!entry || entry.es || !entry.runId) return;
  const es = new EventSource(`/api/runs/${encodeURIComponent(entry.runId)}/stream`);
  entry.es = es;
  const absorb = payload => {
    if (payload.snapshot) entry.trace = payload.snapshot;
    entry.live = Object.assign({}, entry.live, {
      status: payload.status || entry.live.status,
      error: payload.error || "",
      pending: payload.pending || null,
      cost: payload.cost || entry.live.cost || null,
      finished: !!payload.finished,
    });
    /* The server is the authority on what is still pending: once the gate we
       submitted for is gone, the submitted state is gone with it. */
    const deciding = entry.live.deciding;
    if (deciding && (!entry.live.pending || entry.live.pending.id !== deciding.pendingId)) {
      entry.live.deciding = null;
    }
    paintCard(messageId);
  };
  es.addEventListener("snapshot", event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    absorb(data);
    if (data.finished) closeMirror(entry, data);
  });
  es.addEventListener("append", event => {
    let delta;
    try { delta = JSON.parse(event.data); } catch { return; }
    if (entry.trace) applyDelta(entry.trace, delta);
    absorb({
      status: delta.status,
      error: delta.error,
      pending: delta.pending,
      finished: !!delta.finished,
    });
    if (delta.finished) closeMirror(entry, delta);
  });
  es.addEventListener("done", event => {
    let data = {};
    try { data = JSON.parse(event.data); } catch { /* empty */ }
    absorb(Object.assign({}, entry.live, { status: data.status, error: data.error, finished: true }));
    closeMirror(entry, data);
  });
  es.addEventListener("failed", event => {
    let data = {};
    try { data = JSON.parse(event.data); } catch { /* empty */ }
    if (!TERMINAL_STATUS.includes(entry.live.status)) {
      entry.live.error = data.error || "运行未留下可读快照";
    }
    entry.live.finished = true;
    closeMirror(entry, data);
  });
}

function closeMirror(entry, data) {
  if (entry.es) {
    entry.es.close();
    entry.es = null;
  }
  entry.live.finished = true;
  if (data && data.status) entry.live.status = data.status;
  paintCardFor(entry);
}

/* 卡片可能已经被重绘或换到别处；按 run id 找到它当前的主人。 */
function paintCardFor(entry) {
  for (const [messageId, candidate] of chat.mirrors) {
    if (candidate === entry) paintCard(messageId);
  }
}

async function decideFromCard(messageId, pendingId, allow) {
  const message = chatMessageById(messageId);
  const entry = chat.mirrors.get(messageId);
  if (!message || !message.run || !entry || entry.live.deciding) return;
  entry.live.deciding = { allow, pendingId };
  paintCard(messageId);
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(message.run.id)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: pendingId, allow, remember: false }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    toast(allow ? "已允许 · 运行继续" : "已拒绝 · 运行将终止");
  } catch (error) {
    entry.live.deciding = null;
    entry.live.error = error.message;
    paintCard(messageId);
    toast("决定未送达：" + error.message);
  }
}

async function stopFromCard(runId) {
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    toast("已在轮次边界请求停止");
  } catch (error) {
    toast("停止请求未送达：" + error.message);
  }
}

async function openRunFromCard(runId) {
  /* 先切到工作模式：侧栏、顶栏与输入框都跟着换，然后是这次运行的证据视图。
     顺序不能反——工作模式的切换在会话未激活时会打开工作首页。 */
  const known = runHistory.find(run => run.id === runId);
  if (known) {
    setUiMode("work");
    openLive(known.id, known.objective, known.template);
    return;
  }
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const run = await response.json();
    setUiMode("work");
    openLive(run.id, run.objective, run.template);
  } catch (error) {
    toast("打开运行失败：" + error.message);
  }
}

function bindChatAttachments() {
  const attach = document.getElementById("chat-attach");
  const files = document.getElementById("chat-files");
  if (attach && files) {
    attach.addEventListener("click", () => files.click());
    files.addEventListener("change", handleChatFiles);
  }
}

function bind() {
  hydrateDoodles();
  applyMotion();
  bindSettings();
  bindChatAttachments();
  document.getElementById("pick").addEventListener("change", event => {
    if (event.target.files[0]) fromFile(event.target.files[0]);
  });
  const ta = document.getElementById("composer-ta");
  ta.addEventListener("input", () => {
    autosize(ta);
    updateSlashMenu();
    if (chat.active) { paintSendState(); return; }
    const s = activeSession();
    if (!(s && s.running && !s.finished)) {
      document.getElementById("send").disabled = !(health && health.live);
    }
  });
  ta.addEventListener("keydown", event => {
    const menu = document.getElementById("slash-menu");
    if (menu && !menu.hidden) {
      if (event.key === "ArrowDown") { event.preventDefault(); slashIndex = Math.min(slashItems.length - 1, slashIndex + 1); updateSlashMenu(); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); slashIndex = Math.max(0, slashIndex - 1); updateSlashMenu(); return; }
      if (event.key === "Tab") {
        event.preventDefault();
        const command = slashItems[slashIndex];
        if (command) { ta.value = command.cmd + " "; autosize(ta); updateSlashMenu(); }
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const command = slashItems[slashIndex];
        if (command) runSlash(command.cmd.slice(1));
        return;
      }
      if (event.key === "Escape") { event.preventDefault(); menu.hidden = true; return; }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      pushHistory(ta.value.trim());
      composerSubmit();
      return;
    }
    if (event.key === "ArrowUp" && ta.selectionStart === 0 && promptHistory.length) {
      event.preventDefault();
      if (historyIndex === -1) {
        draftBeforeHistory = ta.value;
        historyIndex = promptHistory.length - 1;
      } else {
        historyIndex = Math.max(0, historyIndex - 1);
      }
      ta.value = promptHistory[historyIndex];
      autosize(ta);
      return;
    }
    if (event.key === "ArrowDown" && historyIndex !== -1) {
      event.preventDefault();
      if (historyIndex < promptHistory.length - 1) {
        historyIndex += 1;
        ta.value = promptHistory[historyIndex];
      } else {
        historyIndex = -1;
        ta.value = draftBeforeHistory;
      }
      autosize(ta);
    }
  });
  const apvBtn = document.getElementById("approval-btn");
  const apvMenu = document.getElementById("approval-menu");
  const modelBtn = document.getElementById("model-btn");
  const modelMenu = document.getElementById("model-menu");
  apvBtn.addEventListener("click", event => {
    event.stopPropagation();
    modelMenu.hidden = true;
    apvMenu.hidden = !apvMenu.hidden;
  });
  const plusBtn = document.getElementById("composer-open");
  const attachPanel = document.getElementById("attach-panel");
  plusBtn.addEventListener("click", event => {
    event.stopPropagation();
    apvMenu.hidden = true;
    modelMenu.hidden = true;
    attach.open = !attach.open;
    renderAttachPanel();
    if (attach.open) refreshAttachData();
  });
  attachPanel.addEventListener("click", event => {
    const sum = event.target.closest("[data-attach-sum]");
    if (sum) {
      event.stopPropagation();
      const key = sum.dataset.attachSum;
      attach.openGroup = attach.openGroup === key ? null : key;
      renderAttachPanel();
      return;
    }
    const tplSel = event.target.closest("[data-attach-tpl]");
    if (tplSel) {
      event.stopPropagation();
      setTemplate(tplSel.dataset.attachTpl);
      return;
    }
    const doc = event.target.closest("[data-attach-doc]");
    if (doc) {
      event.stopPropagation(); // 重渲会移走原节点；先止泡，避免 document 误判为外部点击
      if (doc.checked) attach.scope.add(doc.dataset.attachDoc);
      else attach.scope.delete(doc.dataset.attachDoc);
      renderAttachPanel();
      if (intake.active) renderIntake();
      return;
    }
    const addBtn = event.target.closest("[data-attach-source-add]");
    if (addBtn) {
      event.stopPropagation();
      const input = attachPanel.querySelector("[data-attach-source-input]");
      const url = String(input ? input.value : "").trim();
      if (!/^https?:\/\/.+\./.test(url)) { toast("来源必须是合法的 http(s) URL"); return; }
      if (attach.sources.includes(url)) { toast("该来源已添加"); return; }
      if (attach.sources.length >= 5) { toast("最多 5 个来源"); return; }
      attach.sources.push(url);
      attach.sourcesDraft = "";
      renderAttachPanel();
      return;
    }
    const removeBtn = event.target.closest("[data-attach-source-remove]");
    if (removeBtn) {
      event.stopPropagation();
      attach.sources.splice(Number(removeBtn.dataset.attachSourceRemove), 1);
      renderAttachPanel();
      return;
    }
    event.stopPropagation(); // 面板内部点击不关闭
  });
  attachPanel.addEventListener("input", event => {
    if (event.target.closest("[data-attach-budget]")) readAttachBudgetInputs();
    const sourceInput = event.target.closest("[data-attach-source-input]");
    if (sourceInput) attach.sourcesDraft = sourceInput.value;
  });
  attachPanel.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    const sourceInput = event.target.closest("[data-attach-source-input]");
    if (!sourceInput) return;
    event.preventDefault();
    const url = String(sourceInput.value || "").trim();
    if (!url) return;
    if (!/^https?:\/\/.+\./.test(url)) { toast("来源必须是合法的 http(s) URL"); return; }
    if (attach.sources.includes(url)) { toast("该来源已添加"); return; }
    if (attach.sources.length >= 5) { toast("最多 5 个来源"); return; }
    attach.sources.push(url);
    attach.sourcesDraft = "";
    renderAttachPanel();
  });
  modelBtn.addEventListener("click", event => {
    event.stopPropagation();
    if (modelBtn.classList.contains("readonly")) {
      toast("运行中使用当前模型；选择器只对新委托生效");
      return;
    }
    apvMenu.hidden = true;
    if (modelMenu.hidden) {
      if (chat.active) {
        renderChatModelMenu();
        loadChatModels().then(() => { if (!modelMenu.hidden) renderChatModelMenu(); });
      } else {
        renderModelMenu();
      }
    }
    modelMenu.hidden = !modelMenu.hidden;
    if (!modelMenu.hidden) placeModelMenu();
  });
  modelMenu.addEventListener("click", event => {
    const chatSettings = event.target.closest("[data-chatmodel-settings]");
    if (chatSettings) {
      modelMenu.hidden = true;
      renderMode("settings");
      activateSettingsSection("model");
      return;
    }
    const chatPick = event.target.closest("[data-chatmodel-pick]");
    if (chatPick && !chatPick.disabled) {
      chatModelChoice.key = chatPick.dataset.chatmodelPick;
      chatModelTouched = true;
      saveChatModelChoice();
      renderChatModelMenu();
      paintModelBadge();
      modelMenu.hidden = true;
      return;
    }
    const pick = event.target.closest("[data-model-pick]");
    if (pick && !pick.disabled) {
      modelChoice.key = pick.dataset.modelPick;
      saveModelChoice();
      modelBudget.models = null;
      attach.budget = null;
      renderModelMenu();
      paintModelBadge();
      modelMenu.hidden = true;
      return;
    }
    const effort = event.target.closest("[data-effort-pick]");
    if (effort) {
      modelChoice.key = "kimi";
      modelChoice.effort = effort.dataset.effortPick;
      saveModelChoice();
      modelBudget.models = null;
      attach.budget = null;
      renderModelMenu();
      paintModelBadge();
    }
  });
  document.addEventListener("click", event => {
    if (!apvMenu.hidden && !apvBtn.contains(event.target) && !apvMenu.contains(event.target)) apvMenu.hidden = true;
    if (!modelMenu.hidden && !modelBtn.contains(event.target) && !modelMenu.contains(event.target)) modelMenu.hidden = true;
    if (attach.open && !plusBtn.contains(event.target) && !attachPanel.contains(event.target)) {
      attach.open = false;
      renderAttachPanel();
    }
    const slashMenu = document.getElementById("slash-menu");
    const composerBox = document.getElementById("composer-box");
    if (slashMenu && !slashMenu.hidden && composerBox && !composerBox.contains(event.target)) slashMenu.hidden = true;
    if (!event.target.closest(".run-row")) closeRowMenus();

    if (event.target.closest("#proj-add")) {
      event.stopPropagation();
      const addBtn = event.target.closest("#proj-add");
      const input = document.createElement("input");
      input.className = "proj-new-input";
      input.placeholder = "项目名称，回车保存";
      addBtn.replaceWith(input);
      input.focus();
      const commit = () => {
        const name = (input.value || "").trim();
        if (name) { projects.push({ id: "prj-" + Date.now().toString(36), name }); saveProjects(); }
        renderProjects();
      };
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") renderProjects();
      });
      input.addEventListener("blur", commit);
      return;
    }
    const projAssign = event.target.closest("[data-proj-assign]");
    if (projAssign) {
      event.stopPropagation();
      const runRow = projAssign.closest("[data-run]");
      let pid = projAssign.dataset.projAssign;
      if (pid === "new") {
        const name = (prompt("项目名称") || "").trim();
        if (!name) return;
        pid = "prj-" + Date.now().toString(36);
        projects.push({ id: pid, name });
      }
      if (runRow) runProjects[runRow.dataset.run] = pid;
      saveProjects();
      closeRowMenus();
      renderProjects();
      renderRuns();
      return;
    }
    if (!document.getElementById("foot-menu").hidden
        && !event.target.closest("#user-btn") && !event.target.closest("#foot-menu")) {
      document.getElementById("foot-menu").hidden = true;
      document.getElementById("user-btn")?.setAttribute("aria-expanded", "false");
    }
    if (event.target.closest("#nav-reviews")) { renderMode("reviews"); return; }
    if (event.target.closest("#nav-scheduled")) { renderMode("scheduled"); return; }
    if (event.target.closest("#nav-more")) { setMoreNav(!moreOpen()); return; }
    const chatDelete = event.target.closest("[data-chat-delete]");
    if (chatDelete) { handleChatDelete(chatDelete.dataset.chatDelete, chatDelete); return; }
    if (event.target.closest("[data-chat-more]")) { loadChatThreads(false); return; }
    const chatRow = event.target.closest("#chat-nav [data-chat-id]");
    if (chatRow) { openChat(chatRow.dataset.chatId); return; }
    const chatEdit = event.target.closest("[data-chat-edit]");
    if (chatEdit) { beginChatEdit(chatEdit.dataset.chatEdit); return; }
    const chatSave = event.target.closest("[data-chat-save]");
    if (chatSave) { saveChatEdit(chatSave.dataset.chatSave); return; }
    if (event.target.closest("[data-chat-cancel]")) { cancelChatEdit(); return; }
    const chatRegen = event.target.closest("[data-chat-regen]");
    if (chatRegen) { regenerateChat(chatRegen.dataset.chatRegen); return; }
    const chatCopy = event.target.closest("[data-chat-copy]");
    if (chatCopy) { copyChatMessage(chatCopy.dataset.chatCopy); return; }
    const chatDelegate = event.target.closest("[data-chat-delegate]");
    if (chatDelegate) { delegateChatMessage(chatDelegate.dataset.chatDelegate); return; }
    const cardStart = event.target.closest("[data-run-start]");
    if (cardStart) { startCardRun(cardStart.dataset.runStart); return; }
    const cardCancel = event.target.closest("[data-run-cancel]");
    if (cardCancel) { dismissCard(cardCancel.dataset.runCancel); return; }
    const cardAgain = event.target.closest("[data-run-reconsider]");
    if (cardAgain) { reconsiderCard(cardAgain.dataset.runReconsider); return; }
    const cardMode = event.target.closest("[data-run-mode]");
    if (cardMode) {
      const holder = cardMode.closest("[data-run-card]");
      if (holder) {
        readCardDraft(holder.dataset.runCard);
        cardState(holder.dataset.runCard).mode = cardMode.dataset.runMode;
        paintCard(holder.dataset.runCard);
      }
      return;
    }
    const cardAllow = event.target.closest("[data-run-allow]");
    if (cardAllow) {
      const holder = cardAllow.closest("[data-run-card]");
      if (holder) decideFromCard(holder.dataset.runCard, cardAllow.dataset.runAllow, true);
      return;
    }
    const cardDeny = event.target.closest("[data-run-deny]");
    if (cardDeny) {
      const holder = cardDeny.closest("[data-run-card]");
      if (holder) decideFromCard(holder.dataset.runCard, cardDeny.dataset.runDeny, false);
      return;
    }
    const cardStop = event.target.closest("[data-run-stop]");
    if (cardStop) { stopFromCard(cardStop.dataset.runStop); return; }
    const cardOpen = event.target.closest("[data-run-open]");
    if (cardOpen) { openRunFromCard(cardOpen.dataset.runOpen); return; }
    const chatRemove = event.target.closest("[data-chat-attach-remove]");
    if (chatRemove) {
      const index = Number(chatRemove.dataset.chatAttachRemove);
      if (Number.isInteger(index)) chat.attachments.splice(index, 1);
      renderChatAttachChips();
      paintSendState();
      return;
    }
    if (event.target.closest("#new-run")) { if (uiMode === "work") openWorkHome(); else newChat(); return; }
    if (event.target.closest("#mode-chat")) { setUiMode("chat"); return; }
    if (event.target.closest("#mode-work")) { setUiMode("work"); return; }
    if (event.target.closest("#send")) {
      if (chat.active && chat.streaming) { stopChat(); return; }
      composerSubmit();
      return;
    }
    if (event.target.closest("#run-chip")) { stopRun(); return; }
    if (event.target.closest("#desk-btn")) { renderMode("ledger"); return; }
    if (event.target.closest("#chain-badge")) { reverify(); return; }
    if (event.target.closest("[data-rail-close]")) { setChromeState({ rail: false }); return; }
    if (event.target.closest("#report-close") || event.target.closest("[data-report-close]")) { closeReport(); return; }
    if (event.target.closest("#report-print")) { printReport(); return; }
    if (event.target.closest("#report-download")) { downloadReport(); return; }
    if (event.target.closest("#palette-btn")) { openPalette(); return; }
    if (event.target.closest("#settings-btn") || event.target.closest("#foot-settings")) { toggleSettingsPage(); return; }
    if (event.target.closest("#settings-mobile")) { renderMode("settings"); return; }
  });
  document.addEventListener("input", event => {
    const field = event.target.closest("[data-run-goal], [data-run-sources]");
    if (!field) return;
    const holder = field.closest("[data-run-card]");
    if (!holder) return;
    readCardDraft(holder.dataset.runCard);
  });
  document.getElementById("run-search").addEventListener("input", event => {
    runFilter = event.target.value;
    renderRuns();
  });
  const palInput = document.getElementById("palette-input");
  palInput.addEventListener("input", () => { palActive = 0; renderPalette(); });
  palInput.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") { event.preventDefault(); palActive = Math.min(palItems.length - 1, palActive + 1); highlightPalette(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); palActive = Math.max(0, palActive - 1); highlightPalette(); }
    else if (event.key === "Enter") { event.preventDefault(); runPaletteItem(palActive); }
    else if (event.key === "Escape") { event.preventDefault(); closePalette(); }
  });
  document.getElementById("palette").addEventListener("click", event => {
    if (event.target.closest("[data-palette-close]")) { closePalette(); return; }
    const item = event.target.closest("[data-idx]");
    if (item) runPaletteItem(Number(item.dataset.idx));
  });
  document.getElementById("palette").addEventListener("mousemove", event => {
    const item = event.target.closest("[data-idx]");
    if (!item) return;
    const index = Number(item.dataset.idx);
    if (palActive !== index) { palActive = index; highlightPalette(); }
  });
  document.getElementById("approval-menu").addEventListener("click", event => {
    const button = event.target.closest("[data-approval-mode]");
    if (!button) return;
    const changed = button.dataset.approvalMode !== approvalMode;
    setApprovalMode(button.dataset.approvalMode);
    document.getElementById("approval-menu").hidden = true;
    const s = activeSession();
    if (changed && s && s.running) toast("已切换 · 下一个任务生效");
  });
  document.getElementById("run-nav").addEventListener("click", event => {
    const moreBtn = event.target.closest("[data-more]");
    if (moreBtn) {
      event.stopPropagation();
      const row = moreBtn.closest("[data-run]");
      const menu = row && row.querySelector(".row-menu");
      if (!menu) return;
      const wasHidden = menu.hidden;
      closeRowMenus();
      menu.hidden = !wasHidden;
      if (!menu.hidden) {
        const del = menu.querySelector('[data-row-act="delete"]');
        if (del) { del.textContent = "删除"; delete del.dataset.confirm; }
      }
      return;
    }
    const rowAct = event.target.closest("[data-row-act]");
    if (rowAct) {
      event.stopPropagation();
      const row = rowAct.closest("[data-run]");
      if (!row) return;
      const label = row.querySelector("[data-name]");
      const act = rowAct.dataset.rowAct;
      if (act === "pin") { closeRowMenus(); togglePin(row.dataset.run); }
      else if (act === "rename") { closeRowMenus(); startRename(row.dataset.run, label); }
      else if (act === "delete") {
        if (rowAct.dataset.confirm === "1") { closeRowMenus(); deleteRun(row.dataset.run); }
        else { rowAct.dataset.confirm = "1"; rowAct.textContent = "确认删除？"; }
      }
      else if (act === "project") {
        const pid = runProjects[row.dataset.run];
        menu.innerHTML = '<div class="row-menu-title">移动到项目</div>'
          + (projects.length
            ? projects.map(prj => '<button data-proj-assign="' + esc(prj.id) + '">' + esc(prj.name)
              + (pid === prj.id ? ' ✓' : '') + '</button>').join("")
            : '<div class="dim" style="padding:4px 10px">还没有项目</div>')
          + '<button data-proj-assign="new">＋ 新建项目…</button>';
        return;
      }
      return;
    }
    if (event.target.closest("[data-more-older]")) { olderOpen = true; renderRuns(); return; }
    if (event.target.closest("[data-collapse-older]")) { olderOpen = false; renderRuns(); return; }
    const row = event.target.closest("[data-run]");
    if (!row) return;
    if (event.target.closest(".row-menu") || event.target.closest(".rename-input")) return;
    selectRun(row.dataset.run);
  });
  document.getElementById("project-nav").addEventListener("click", event => {
    const row = event.target.closest("[data-proj]");
    if (!row) return;
    projectFilter = projectFilter === row.dataset.proj ? null : row.dataset.proj;
    renderProjects();
    renderRuns();
  });
  document.getElementById("run-nav").addEventListener("keydown", event => {
    const row = event.target.closest("[data-run]");
    if (!row || event.target !== row) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectRun(row.dataset.run);
    }
  });
  document.getElementById("run-nav").addEventListener("dblclick", event => {
    const label = event.target.closest("[data-name]");
    if (!label) return;
    const row = label.closest("[data-run]");
    if (!row) return;
    event.stopPropagation();
    startRename(row.dataset.run, label);
  });
  document.getElementById("tabs").addEventListener("click", event => {
    const close = event.target.closest("[data-tabclose]");
    if (close) { event.stopPropagation(); closeSessionTab(close.dataset.tabclose); return; }
    const tab = event.target.closest("[data-tab]");
    if (!tab) return;
    const id = tab.dataset.tab;
    if (store.key === "run:" + id && activeSession() === sessions.get(id)) return;
    const s = sessions.get(id);
    if (s) openLive(id, s.objective, s.template);
  });
  document.getElementById("rail-tabs").addEventListener("click", event => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    railTab = button.dataset.tab;
    const trace = shownTrace();
    if (trace) renderRail(trace, store.check || { ok: false, reason: "" });
  });
  document.getElementById("rail-body").addEventListener("click", async event => {
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const ok = await copyText(copy.dataset.copy);
      toast(ok ? "哈希已复制" : "复制失败");
      return;
    }
    if (event.target.closest("[data-copy-raw]")) {
      const trace = shownTrace();
      if (!trace) return;
      const ok = await copyText(JSON.stringify(trace, null, 2));
      toast(ok ? "原文已复制" : "复制失败");
      return;
    }
    if (event.target.closest("[data-download-raw]")) {
      const trace = shownTrace();
      if (!trace) return;
      const blob = new Blob([JSON.stringify(trace, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = "trace.json"; link.click();
      URL.revokeObjectURL(url);
      return;
    }
    const chip = event.target.closest("[data-rail-filter]");
    if (chip) {
      railFilter = chip.dataset.railFilter;
      localStorage.setItem("fa.railFilter", railFilter);
      const trace = shownTrace();
      if (trace) renderRail(trace, store.check || { ok: false, reason: "" });
      return;
    }
    const toggle = event.target.closest("[data-ev-group]");
    if (toggle) {
      const round = Number(toggle.dataset.evGroup);
      if (evExpanded.has(round)) evExpanded.delete(round); else evExpanded.add(round);
      const trace = shownTrace();
      if (trace) renderRail(trace, store.check || { ok: false, reason: "" });
    }
  });
  document.getElementById("main").addEventListener("click", async event => {
    const railOpenButton = event.target.closest("[data-rail-open]");
    if (railOpenButton) { setChromeState({ rail: true }); return; }
    const railCloseButton = event.target.closest("[data-rail-close]");
    if (railCloseButton) { setChromeState({ rail: false }); return; }
    const copy = event.target.closest("[data-copy]");
    if (copy) {
      const ok = await copyText(copy.dataset.copy);
      toast(ok ? "哈希已复制" : "复制失败");
      return;
    }
    const qAct = event.target.closest("[data-q-act]");
    if (qAct) { handleQueueAction(qAct); return; }
    const stageChip = event.target.closest("[data-stage-chip]");
    if (stageChip) {
      const key = stageChip.dataset.stageChip;
      setTemplate(key);
      const template = (templates || []).find(t => t.key === key);
      startIntake((template && template.objective) || "");
      return;
    }
    const intakeChoice = event.target.closest("[data-intake-choice]");
    if (intakeChoice) {
      intakeChoose(intakeChoice.dataset.intakeField, intakeChoice.dataset.intakeValue, intakeChoice.dataset.intakeLabel || "");
      return;
    }
    if (event.target.closest("[data-intake-start]")) { startIntakeRun(); return; }
    if (event.target.closest("[data-intake-back]")) { intakeBack(); return; }
    if (event.target.closest("[data-intake-cancel]")) { closeIntake(true); return; }
    if (event.target.closest("[data-intake-open]")) { startIntake(""); return; }
    const reviewChoice = event.target.closest("[data-review-decision]");
    if (reviewChoice) {
      const panel = reviewChoice.closest("[data-review-panel]");
      if (panel) chooseReviewDecision(panel.dataset.reviewRun, reviewChoice.dataset.reviewDecision);
      return;
    }
    if (event.target.closest("[data-review-submit]")) {
      const panel = event.target.closest("[data-review-panel]");
      if (panel) submitReview(panel.dataset.reviewRun);
      return;
    }
    const reviewAppend = event.target.closest("[data-review-append]");
    if (reviewAppend) {
      const panel = reviewAppend.closest("[data-review-panel]");
      if (panel) startAppendReview(panel.dataset.reviewRun);
      return;
    }
    const reviewApply = event.target.closest("[data-review-apply]");
    if (reviewApply) {
      const runId = reviewRunId();
      if (runId) applyReviewSuggestion(runId, reviewApply.dataset.reviewApply, reviewApply.dataset.reviewApplyReason || "");
      return;
    }
    const ledDel = event.target.closest("[data-led-del]");
    if (ledDel) {
      const id = ledDel.dataset.ledDel;
      if (ledgerConfirmId !== id) { ledgerConfirmId = id; renderLedger(); }
      else { ledgerConfirmId = null; deleteRun(id); }
      return;
    }
    const ledRow = event.target.closest("[data-led-row]");
    if (ledRow && !event.target.closest("[data-led-del]")) { selectRun(ledRow.dataset.ledRow); return; }
    const originChip = event.target.closest("[data-origin-thread]");
    if (originChip) {
      const threadId = originChip.dataset.originThread;
      if (threadId) { setUiMode("chat"); openChat(threadId); }
      return;
    }
    const toggleHead = event.target.closest("[data-toggle]");
    if (toggleHead) {
      const round = toggleHead.closest(".round");
      if (round) {
        round.dataset.open = round.dataset.open === "true" ? "false" : "true";
        round.dataset.user = "1";
        // A folded run opens with its head: the summary line and its parts are
        // one disclosure, so toggling the head re-runs the fold.
        if (round.dataset.folded === "1") applyRoundFolding();
        return;
      }
    }
    const decision = event.target.closest("[data-decision]");
    if (decision) {
      const choice = decision.dataset.decision;
      decideApproval(choice !== "deny", choice === "allow-remember");
      return;
    }
    const planEdit = event.target.closest("[data-plan-edit]");
    if (planEdit) {
      const s = activeSession();
      if (!s) return;
      s.planEditing = !s.planEditing;
      s.planConfirm = null;
      paintPlan();
      return;
    }
    const planAction = event.target.closest("[data-plan-action]");
    const planSession = activeSession();
    if (planAction && planSession) {
      const action = planAction.dataset.planAction;
      if (action === "cancel") {
        planSession.planConfirm = null;
        paintPlan();
      } else if (action === "skip") {
        planSession.planConfirm = planAction.dataset.todo;
        planSession.planEditing = true;
        paintPlan();
      } else if (action === "skip-confirm") {
        queuePlan("skip", planAction.dataset.todo);
      } else if (action === "promote") {
        queuePlan("promote", planAction.dataset.todo);
      }
      return;
    }
    const budgetEdit = event.target.closest("[data-budget-edit]");
    if (budgetEdit) {
      const s = activeSession();
      if (!s) return;
      s.budgetEditing = !s.budgetEditing;
      paintBudget();
      return;
    }
    const budgetCancel = event.target.closest("[data-budget-cancel]");
    if (budgetCancel) {
      const s = activeSession();
      if (!s) return;
      s.budgetEditing = false;
      paintBudget();
      return;
    }
    if (event.target.closest("[data-budget-apply]")) { queueBudget(); return; }
    if (event.target.closest("[data-resume-apply]")) { resumeRun(); return; }
    const resumeCancel = event.target.closest("[data-resume-cancel]");
    if (resumeCancel) {
      const form = resumeCancel.closest(".resume-form");
      if (form) form.remove();
      return;
    }
    const button = event.target.closest("[data-act]");
    if (!button) return;
    if (button.dataset.act === "retry") retryCurrent();
    else if (button.dataset.act === "diag") copyDiagnostics();
    else if (button.dataset.act === "report") openReport();
    else if (button.dataset.act === "resume") openResumeForm();
  });
  document.getElementById("main").addEventListener("input", event => {
    const input = event.target.closest("[data-review-reason]");
    if (!input) return;
    const panel = input.closest("[data-review-panel]");
    if (panel) syncReviewDraft(panel.dataset.reviewRun, panel, input);
  });
  document.getElementById("main").addEventListener("keydown", event => {
    const input = event.target.closest(".q-edit");
    if (!input) return;
    const item = input.closest("[data-mid]");
    const s = activeSession();
    if (!s || !item) return;
    const msg = (s.queuedMsgs || []).find(m => m.id === item.dataset.mid);
    if (!msg) return;
    if (event.key === "Enter") { event.preventDefault(); saveQueueEdit(s, msg); }
    else if (event.key === "Escape") { event.preventDefault(); s.queueEditingId = null; paintQueuedMsgs(); }
  });
  const app = document.getElementById("app");
  setChromeState({ rail: railOpen });
  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    setChromeState({ sidebar: !app.classList.contains("side-collapsed") });
  });
  const userBtn = document.getElementById("user-btn");
  const footMenu = document.getElementById("foot-menu");
  userBtn.addEventListener("click", event => {
    event.stopPropagation();
    const open = footMenu.hidden;
    footMenu.hidden = !open;
    userBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  footMenu.addEventListener("click", event => event.stopPropagation());
  document.getElementById("foot-settings").addEventListener("click", () => {
    footMenu.hidden = true;
    userBtn.setAttribute("aria-expanded", "false");
    toggleSettingsPage();
  });
  document.getElementById("foot-github").addEventListener("click", () => {
    window.open("https://github.com/Anhao1314/FCode", "_blank", "noopener");
    footMenu.hidden = true;
  });
  document.getElementById("rail-toggle").addEventListener("click", () => {
    setChromeState({ rail: !railOpen });
  });
  document.querySelectorAll("[data-rail-open]").forEach(button => {
    button.addEventListener("click", () => setChromeState({ rail: true }));
  });
  document.querySelectorAll("[data-rail-close]").forEach(button => {
    button.addEventListener("click", () => setChromeState({ rail: false }));
  });

  document.addEventListener("dragenter", e => e.preventDefault());
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", e => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) fromFile(file);
  });

  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    const s = activeSession();
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); togglePalette(); return; }
    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (e.shiftKey) { setUiMode("work"); openWorkHome(); }
      else { setUiMode("chat"); newChat(); }
      return;
    }
    if (mod && e.key === ",") { e.preventDefault(); toggleSettingsPage(); return; }
    if (mod && e.key === ".") { e.preventDefault(); if (chat.active && chat.streaming) { stopChat(); return; } if (s && s.running) stopRun(); return; }
    if (mod && s && s.pending && !s.deciding && (e.key === "Enter" || e.key === "Backspace" || e.key === "Delete")) {
      const palette = document.getElementById("palette");
      if (palette && !palette.hidden) return;
      e.preventDefault();
      decideApproval(e.key === "Enter");
      return;
    }
    const typing = e.target && /INPUT|TEXTAREA/.test(e.target.tagName);
    if (!typing && !mod && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const rows = [...document.querySelectorAll(".run-row")];
      if (rows.length) {
        e.preventDefault();
        const index = rows.indexOf(document.activeElement);
        const step = e.key === "ArrowDown" ? 1 : -1;
        const next = index === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, index + step));
        rows[next].focus();
        return;
      }
    }
    if (!typing && !mod && e.key === "/") {
      e.preventDefault();
      document.getElementById("run-search").focus();
      return;
    }
    if (!typing && s && s.pending && !s.deciding && (e.key === "1" || e.key === "2" || e.key === "3")) {
      const overlay = ["palette", "report-layer"].some(id => {
        const el = document.getElementById(id);
        return el && !el.hidden;
      });
      if (!overlay) {
        e.preventDefault();
        // 数字键直选：等于点击对应档位按钮；先给焦点环，再提交决定
        const button = document.querySelector(`.apv-choice[data-decision="${e.key === "1" ? "allow" : e.key === "2" ? "allow-remember" : "deny"}"]`);
        if (button) {
          button.classList.add("kb-selected");
          button.focus();
          decideApproval(e.key !== "3", e.key === "2");
        }
        return;
      }
    }
    if (e.key === "Escape") {
      const reportLayer = document.getElementById("report-layer");
      if (reportLayer && !reportLayer.hidden) { closeReport(); return; }
      const palette = document.getElementById("palette");
      if (palette && !palette.hidden) { closePalette(); return; }
      const menu = document.getElementById("tpl-menu");
      if (menu && !menu.hidden) { menu.hidden = true; return; }
      const approval = document.getElementById("approval-menu");
      if (approval && !approval.hidden) { approval.hidden = true; return; }
      const modelMenu = document.getElementById("model-menu");
      if (modelMenu && !modelMenu.hidden) { modelMenu.hidden = true; return; }
      if (attach.open) { attach.open = false; renderAttachPanel(); return; }
      if (settingsOpen) { closeSettingsPage(true); return; }
      if (!typing && innerWidth <= 1100 && railOpen) {
        railOpen = false;
        const app = document.getElementById("app");
        app.classList.add("rail-hidden");
        app.classList.remove("rail-open");
      }
      return;
    }
    if (typing || mod) return;
    if (e.key === "r") replay();
  });

  setInterval(() => {
    const el = document.querySelector("[data-countdown]");
    const s = activeSession();
    if (!el || !s || !s.pendingDeadline) return;
    const left = (s.pendingDeadline - Date.now()) / 1000;
    el.textContent = left > 0 ? fmtCountdown(left) : "已到时限 · 等待 Runtime 拒绝";
  }, 500);
}

function replay() {
  if (intake.active) closeIntake(false);
  if (settingsOpen) closeSettingsPage(false);
  const key = store.key;
  if (key && key.startsWith("run:")) return; // run records are immutable
  if (key) { cache.delete(key); select(key, labelOf(key)); }
  else {
    const trace = shownTrace();
    if (trace) render(trace, "trace");
  }
}

async function fromFile(file) {
  try {
    if (intake.active) closeIntake(false);
    if (settingsOpen) closeSettingsPage(false);
    ledgerOpen = false;
    const trace = JSON.parse(await file.text());
    if (activeSession()) detachLive();
    store.key = null;
    renderNav();
    await render(trace, file.name);
  } catch (error) {
    renderMain(`<div class="empty">无法解析 ${esc(file.name)}：${esc(error.message)}</div>`, { mode: "error" });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  bind();
  renderNav();
  // await：?run= 直链要在 health/runHistory 就绪后才能判定运行状态
  await initLive();
  await loadChatThreads();
  loadChatModels();
  const params = new URLSearchParams(location.search);
  const runParam = params.get("run");
  const param = params.get("trace");
  if (runParam) {
    // 运行直链：运行中 → 接入 SSE；已结束 → 拉 trace 回放。
    // selectRun 需要 runHistory 判定状态，先等一次运行列表。
    renderMain(`<div class="empty">加载运行 ${esc(runParam)}…</div>`, { mode: "loading" });
    refreshRuns().then(() => selectRun(runParam)).catch(() => {
      renderMain(`<div class="empty">无法加载运行 ${esc(runParam)}：运行不存在或已删除</div>`, { mode: "error" });
    });
  } else if (param) {
    fetch(param, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(trace => render(trace, param.split("/").pop()))
      .catch(error => {
        renderMain(`<div class="empty">无法加载 ${esc(param)}：${esc(error.message)}</div>`, { mode: "error" });
      });
  } else {
    newChat();
    setUiMode(uiMode);
  }
});
