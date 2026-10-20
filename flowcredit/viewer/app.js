"use strict";

/* ------------------------------------------------------------------- data */

const SCENARIOS = [
  ["full",          "完整研究"],
  ["tool-denied",   "越权工具"],
  ["budget",        "预算耗尽"],
  ["budget-resume", "预算追加"],
  ["crash",         "崩溃恢复"],
  ["unknown",       "未知对账"],
  ["open-ended",    "开放问题"],
];

const EVENT_DOT = {
  task_created: "", model_started: "info", model_unknown: "warn", model_reconciled: "ok",
  plan_validated: "", plan_updated: "", execution_started: "", tool_started: "info",
  tool_denied: "bad", tool_succeeded: "ok", verification_started: "info",
  task_succeeded: "ok", task_failed: "bad", task_stopped: "warn",
  approval_requested: "warn", approval_granted: "ok", approval_denied: "bad", approval_aborted: "warn",
  plan_steered: "info", budget_adjusted: "info", control_rejected: "bad", task_resumed: "info",
  operator_message: "you",
};

/* 人的决定：审批、计划修订、预算调整、续跑、运行中消息 */
const HUMAN_EVENTS = new Set([
  "approval_requested", "approval_granted", "approval_denied", "approval_aborted",
  "plan_steered", "budget_adjusted", "control_rejected", "task_resumed", "operator_message",
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
const dot = cls => `<span class="ev-dot ${cls || ""}"></span>`;

/* 桌面壳桥：浏览器里返回 null，桌面端返回 pywebview 原生 API */
function desktopBridge() {
  return (window.pywebview && window.pywebview.api) ? window.pywebview.api : null;
}
window.addEventListener("pywebviewready", () => {
  window.__fcodeDesktop = true;
  document.body.classList.add("desktop");
});

/* ------------------------------------------------------------- 状态行 */
/* Codex TUI 的底栏：当前模型、轮次、预算用量与快捷键，常驻不占正文。 */
function setStatusline(leftHtml, rightText) {
  const el = document.getElementById("statusline");
  if (!el) return;
  el.innerHTML = `<span class="sl-left">${leftHtml}</span><span class="sl-right">${esc(rightText || "")}</span>`;
}

function updateStatusline() {
  if (ledgerOpen) {
    const finished = runHistory.filter(r => r.status !== "running");
    const succeeded = finished.filter(r => r.status === "succeeded").length;
    const totalCost = finished.reduce((sum, r) => sum + ((r.cost && r.cost.costMicrousd) || 0), 0);
    const rate = finished.length ? Math.round((succeeded / finished.length) * 100) : 0;
    setStatusline(`<b>工作台</b><span class="sl-sep">·</span>委托 ${runHistory.length} 项`,
      `成功率 ${rate}% · 总成本 ${num(totalCost)} µUSD · ⌘N 新建`);
    return;
  }
  const trace = (live && live.trace) || currentTrace;
  if (!trace) {
    setStatusline("<b>FCode</b>", "⌘K 命令 · ⌘N 新建委托 · ⌘. 停止 · ↑↓ 历史");
    return;
  }
  const budget = lastBudget(trace);
  const lim = (budget && budget.limits) || {};
  const model = trace.model || {};
  const rounds = (trace.rounds || []).length;
  const statusMap = { succeeded: "成功", failed: "失败", denied: "拒绝", stopped: "已停止" };
  const state = live ? (live.finished ? "已结束" : `第 ${rounds} 轮`)
    : (statusMap[(trace.terminal && trace.terminal.status) || ""] || (trace.terminal && trace.terminal.status) || "");
  const left = `<b>${esc(model.provider || "offline-mock")}</b> <span class="sl-sep">·</span> ${state ? esc(state) : "—"}`;
  const right = budget
    ? `calls ${budget.calls_used}/${lim.max_calls ?? "?"} · reads ${budget.reads_used}/${lim.max_reads ?? "?"} · ${num(budget.cost_used_microusd)} µUSD · tokens ${num(budget.tokens_used)}`
    : "⌘K 命令 · ⌘N 新建委托";
  setStatusline(left, right);
}

const cache = new Map();
let currentKey = null;
let currentTrace = null;
let currentCheck = null;
let railTab = "events";
let railOpen = window.innerWidth > 1100;
let railHumanOnly = false;
let approvalMode = localStorage.getItem("fa.approval") || "consequential";
if (!APPROVAL_MODES.some(([key]) => key === approvalMode)) approvalMode = "consequential";

/* live console state */
const TPL_FALLBACK = { full: "完整研究", "tool-denied": "越权工具", budget: "预算耗尽", "budget-resume": "预算追加", crash: "崩溃恢复", unknown: "未知对账", "open-ended": "开放问题" };
let health = null;      // /api/health payload
let templates = [];     // /api/templates
let tplKey = "full";    // selected template
let runHistory = [];    // /api/runs
let live = null;        // 当前激活的会话（指向 sessions 中的一项）
let runFilter = "";     // 运行记录搜索词
let toolContracts = null; // /api/tools，工具契约（含版本与 effect）
let modules = [];         // /api/modules，域模块（金融研究 / 审计 / 量化…）
let olderOpen = false;  // 「更早」分组是否展开
let scenesOpen = localStorage.getItem("fa.scenesOpen"); // null | "1" | "0"

/* 多会话：每个 run 一个会话对象；后台会话保持 SSE 流，只是不渲染 */
const sessions = new Map();

/* --------------------------------------------------------- canonical json */

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyChain(trace) {
  const events = trace.events || [];
  if (!events.length) return { ok: false, reason: "trace 里没有事件" };
  let previous = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.sequence !== i + 1) return { ok: false, reason: `第 ${i + 1} 个事件序号不连续` };
    if (e.prev_hash !== previous) return { ok: false, reason: `第 ${i + 1} 个事件没有链接到前一个` };
    const expected = await sha256Hex(canonical({
      sequence: e.sequence, type: e.type, payload: e.payload, prev_hash: e.prev_hash, at: e.at
    }));
    if (expected !== e.hash) return { ok: false, reason: `第 ${i + 1} 个事件（${e.type}）哈希不匹配` };
    previous = e.hash;
  }
  const chain = trace.chain || {};
  if (chain.head_hash !== previous) return { ok: false, reason: "链头与最后一个事件不一致" };
  if (chain.event_count !== events.length) return { ok: false, reason: "事件计数与实际不符" };
  return { ok: true, events: events.length, head: previous };
}

/* ---------------------------------------------------------------- helpers */

const esc = value => String(value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = bp => (bp / 100).toFixed(2) + "%";
const pp = bp => (bp >= 0 ? "+" : "") + (bp / 100).toFixed(2) + " pp";
const num = n => Number(n).toLocaleString("en-US");
const shortHash = h => String(h || "").slice(0, 12);
const stripTags = html => String(html).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const runLabel = run => run.name || shortObjective(run.objective);

const stateClass = status =>
  status === "succeeded" ? "ok" : (status === "denied" || status === "failed") ? "bad" : "warn";
const stateText = status =>
  ({ succeeded: "成功", failed: "失败", denied: "拒绝" }[status] || (status || "?"));

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

/* --------------------------------------------------------------- describe */

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
    default:
      return [esc(JSON.stringify(r))];
  }
}

/* ---------------------------------------------------------------- sidebar */

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
  renderScenarios();
  renderRuns();
}

/* ------------------------------------------------------------- 工作台账本 */

function openLedger() {
  ledgerOpen = true;
  if (live) detachLive();
  currentKey = null;
  currentTrace = null;
  renderNav();
  renderTabs();
  document.getElementById("tb-title").textContent = "工作台";
  document.getElementById("tb-chips").innerHTML = "";
  const badge = document.getElementById("chain-badge");
  if (badge) {
    badge.className = "chain-pill";
    badge.innerHTML = `<span class="dot"></span><span>未加载</span>`;
  }
  const main = document.getElementById("main");
  main.scrollTop = 0;
  renderLedger();
}

async function renderLedger() {
  const main = document.getElementById("main");
  if (!main || !ledgerOpen) return;
  main.innerHTML = `<div class="empty">统计账本…</div>`;
  // 旧运行 meta 里没有成本摘要：按需拉 trace 补齐（有缓存）
  const missing = runHistory.filter(run => !run.cost && run.tracePath);
  await Promise.all(missing.map(async run => {
    try {
      const response = await fetch(run.tracePath, { cache: "no-store" });
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

  main.innerHTML = `
    <section class="prompt">
      <div class="prompt-kicker">工作台</div>
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
    </div>`;
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
  if (live === s) live = null;
  cache.delete("run:" + id);
  if (currentKey === "run:" + id) {
    currentKey = null;
    currentTrace = null;
    openLedger();
  } else if (ledgerOpen) {
    renderLedger();
  }
  renderTabs();
  refreshRuns();
  toast("委托已删除");
}

function applyScenesOpen(open) {
  const section = document.getElementById("scene-section");
  const toggle = document.getElementById("scene-toggle");
  if (!section || !toggle) return;
  section.classList.toggle("open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function scenesDefaultOpen() {
  if (scenesOpen === "1") return true;
  if (scenesOpen === "0") return false;
  return runHistory.length === 0;
}

function setScenesOpen(open, persist = true) {
  applyScenesOpen(open);
  if (!persist) return;
  scenesOpen = open ? "1" : "0";
  localStorage.setItem("fa.scenesOpen", scenesOpen);
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

function renderScenarios() {
  const nav = document.getElementById("nav");
  if (!nav) return;
  nav.innerHTML = SCENARIOS.map(([key, label]) => {
    const trace = cache.get(key);
    const meta = trace ? `${(trace.rounds || []).length} 轮` : "";
    return `<button class="session scene-row${key === currentKey ? " active" : ""}" data-key="${key}">
      <span class="slabel">${esc(label)}</span>
      <span class="smeta">${meta}</span>
    </button>`;
  }).join("");
  for (const button of nav.querySelectorAll("button")) {
    button.addEventListener("click", () => {
      setScenesOpen(true);
      select(button.dataset.key, labelOf(button.dataset.key));
    });
  }
  const count = document.getElementById("scene-count");
  if (count) count.textContent = String(SCENARIOS.length);
  applyScenesOpen(scenesDefaultOpen());
}

function runRowHtml(run) {
  const active = currentKey === "run:" + run.id;
  const running = run.status === "running";
  const cls = running ? "live" : stateClass(run.status);
  const meta = running ? "运行中" : runTimeText(run.created);
  return `<div class="session run-row${active ? " active" : ""}${run.pinned ? " pinned" : ""}" data-run="${esc(run.id)}" title="${esc(run.objective)}${run.rounds ? " · " + run.rounds + " 轮" : ""}">
    <span class="sdot ${cls}"></span>
    <span class="slabel" data-name>${esc(runLabel(run))}</span>
    <span class="smeta">${meta}</span>
    <button class="pin" data-pin="${esc(run.id)}" title="${run.pinned ? "取消固定" : "固定"}">${run.pinned ? "★" : "☆"}</button>
    <button class="rename-act" data-rename="${esc(run.id)}" title="重命名">✎</button>
  </div>`;
}

function renderRuns() {
  const runNav = document.getElementById("run-nav");
  if (!runNav) return;
  const query = runFilter.trim().toLowerCase();
  const runs = runHistory
    .filter(run => !query || `${run.name || ""} ${run.objective} ${run.id}`.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  if (!runs.length) {
    runNav.innerHTML = query
      ? `<div class="side-empty">没有匹配的运行</div>`
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
      html += `<div class="side-head-label">已固定</div>`;
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
      html += `<div class="side-head-label">${group.label}</div>`;
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

  for (const row of runNav.querySelectorAll(".run-row")) {
    row.addEventListener("click", event => {
      if (event.target.closest("[data-pin]") || event.target.closest("[data-rename]") || event.target.closest(".rename-input")) return;
      selectRun(row.dataset.run);
    });
    const label = row.querySelector("[data-name]");
    label.addEventListener("dblclick", event => { event.stopPropagation(); startRename(row.dataset.run, label); });
    const pin = row.querySelector("[data-pin]");
    pin.addEventListener("click", event => { event.stopPropagation(); togglePin(row.dataset.run); });
    const rename = row.querySelector("[data-rename]");
    rename.addEventListener("click", event => { event.stopPropagation(); startRename(row.dataset.run, label); });
  }
  const more = runNav.querySelector("[data-more-older]");
  if (more) more.addEventListener("click", () => { olderOpen = true; renderRuns(); });
  const collapse = runNav.querySelector("[data-collapse-older]");
  if (collapse) collapse.addEventListener("click", () => { olderOpen = false; renderRuns(); });
}

/* ------------------------------------------------------------------ rail */

function renderRail(trace, check) {
  const body = document.getElementById("rail-body");
  if (!trace) { body.innerHTML = ""; return; }
  for (const button of document.querySelectorAll("#rail-tabs button")) {
    button.classList.toggle("active", button.dataset.tab === railTab);
  }

  if (railTab === "events") {
    const all = trace.events || [];
    const humans = all.filter(e => HUMAN_EVENTS.has(e.type));
    const events = railHumanOnly ? humans : all;
    body.innerHTML = `<div class="rail-tools">
      <button class="rf${railHumanOnly ? " active" : ""}" data-rail-human>${railHumanOnly ? "只看人工" : "人工"} · ${humans.length}</button>
      <span class="rf-hint">审批 / 修订 / 预算 / 续跑</span>
    </div>` + (events.length ? events.map(e => `<div class="ev-item">
      <div class="ev-line">
        <span class="ev-seq">#${e.sequence}</span>
        ${dot(EVENT_DOT[e.type] || "")}
        <span class="ev-type">${esc(e.type)}</span>
        <span class="ev-hash">${esc(shortHash(e.hash))}</span>
      </div>
      ${summariseEvent(e) ? `<div class="ev-detail">${summariseEvent(e)}</div>` : ""}
    </div>`).join("") : `<div class="rail-empty">这条轨迹里还没有人工决定</div>`);
    const toggle = body.querySelector("[data-rail-human]");
    if (toggle) {
      toggle.addEventListener("click", () => {
        railHumanOnly = !railHumanOnly;
        renderRail(trace, check || { ok: false, reason: "" });
      });
    }
    return;
  }

  if (railTab === "tools") {
    body.innerHTML = renderTools(trace, check);
    return;
  }

  if (railTab === "chain") {
    const events = trace.events || [];
    const chain = trace.chain || {};
    body.innerHTML = `
      <div class="rail-sec">
        <div class="rs-row"><span class="k">算法</span><span class="v">${esc(chain.algorithm || "sha256 · canonical json")}</span></div>
        <div class="rs-row"><span class="k">事件数</span><span class="v">${events.length}</span></div>
        <div class="rs-row"><span class="k">链头</span><span class="v">${esc(chain.head_hash || "")}</span></div>
        <div class="rs-row"><span class="k">浏览器重算</span><span class="v ${check.live ? "" : (check.ok ? "ok" : "bad")}">${check.live ? "运行中…" : (check.ok ? "✔ 通过" : "✕ " + esc(check.reason))}</span></div>
      </div>
      <div class="rail-sec">
        ${events.map(e => `<div class="link-row">
          <span class="n">#${e.sequence}</span>
          <span class="h">${esc(shortHash(e.hash))}</span>
          <span class="arrow">←</span>
          <span>${esc(shortHash(e.prev_hash))}${e.prev_hash ? "" : " (genesis)"}</span>
        </div>`).join("")}
      </div>`;
    return;
  }

  body.innerHTML = `<pre>${esc(JSON.stringify(trace, null, 2))}</pre>`;
}

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
      return `<div class="tool-row${inScope ? "" : " out-of-scope"}">
        <div class="tr-head">
          <span class="tr-name">${esc(contract.name)}</span>
          <span class="eff eff-${esc(effect)}">${esc(effect)}</span>
          <span class="tr-ver">v${esc(contract.version || "?")}</span>
          <span class="grow"></span>
          <span class="tr-scope">${inScope ? (inGrant ? "允许 · 已授权" : "允许 · 未授权") : "不在任务范围"}</span>
        </div>
        <div class="tr-summary">${esc(contract.summary || "")}</div>
        <div class="tr-usage">${esc(usageText)}</div>
      </div>`;
    }).join("");
  return `<div class="rail-tools">
      <span class="rf-hint">${allowed.size} 个允许 · ${granted.size} 个授权 · 契约来自注册表</span>
    </div>${rows}`;
}

function summariseEvent(e) {
  const d = e.payload && e.payload.detail;
  if (!d || Object.keys(d).length === 0) return "";
  if (e.type === "tool_started" || e.type === "tool_succeeded") return `${esc(d.tool || "")} ${d.arguments && Object.keys(d.arguments).length ? "(" + Object.entries(d.arguments).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(", ") + ")" : "()"}`;
  if (e.type === "model_started") return `round ${esc(d.round)}`;
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

/* ------------------------------------------------------------ main render */

function renderPlan(plan, opts = {}) {
  if (!plan || !plan.todos || !plan.todos.length) return "";
  const done = plan.todos.filter(t => t.status === "done").length;
  const glyph = { done: "✓", blocked: "✕", abandoned: "–", active: "◐", pending: "○" };
  const editable = !!opts.editable;
  const editing = editable && !!opts.editing;
  return `<div class="card plan${editing ? " editing" : ""}">
    <div class="card-head">
      <span class="card-title">${ICON.file} Plan</span>
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

function renderMeters(trace, opts = {}) {
  const b = lastBudget(trace);
  if (!b) return "";
  const lim = b.limits || {};
  const editable = !!opts.editable;
  const editing = editable && !!opts.editing;
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
        return `<span class="meter${hot}${cls ? " " + cls : ""}">
          <span class="m-k">${label}</span>
          <span class="m-bar"><i style="width:${Math.round(ratio * 100)}%"></i></span>
          <span class="m-v">${num(used || 0)}/${num(max || 0)}</span>
        </span>`;
      }).join("")}
      ${editable ? `<button class="p-edit${editing ? " active" : ""}" data-budget-edit>${editing ? "取消" : "调整"}</button>` : ""}
    </div>
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

function renderToolDetail(obs) {
  return (TOOL_RENDERERS[obs.tool] || genericToolDetail)(obs);
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

function renderRound(round, index, ann = {}) {
  const empty = !round.proposal && !round.decision && !round.observation && !round.receipt;
  if (empty && ann.terminal) {
    return `<div class="card round" data-open="false">
      <div class="card-head click" data-toggle>
        <span class="rno">#${round.index}</span>
        ${ICON.circle}
        <span class="tool">未完成的轮次</span>
        <span class="grow"></span>
        <span class="badge warn"><span class="dot"></span>TERMINATED</span>
        <span class="chev">▾</span>
      </div>
      <div class="preview">任务在此终结（${esc(ann.terminal)}）——没有提议落进签名链</div>
      <div class="card-body"></div>
    </div>`;
  }
  if (empty && !ann.unknown) {
    return `<div class="card round live" data-open="true">
      <div class="card-head click" data-toggle>
        <span class="rno">#${round.index}</span>
        ${ICON.circle}
        <span class="tool">模型思考中</span>
        <span class="grow"></span>
        <span class="badge run"><span class="dot"></span>RUNNING</span>
        <span class="chev">▾</span>
      </div>
      <div class="preview">已进入第 ${round.index} 轮，等待提议…</div>
      <div class="card-body"></div>
    </div>`;
  }
  if (empty) {
    const cause = ann.unknown || "UNKNOWN";
    return `<div class="card round" data-open="true">
      <div class="card-head click" data-toggle>
        <span class="rno">#${round.index}</span>
        ${ICON.alert}
        <span class="tool">模型调用未知</span>
        <span class="grow"></span>
        <span class="badge warn"><span class="dot"></span>UNKNOWN</span>
        <span class="chev">▾</span>
      </div>
      <div class="preview">${esc(cause)}</div>
      <div class="card-body">
        <div class="alert warn">
          <div class="a-title">未知不等于失败</div>
          <div class="a-sub">不自动重发、不自动退费、不换供应商；预算与租约保留，只接受匹配的签名收据显式对账。</div>
        </div>
      </div>
    </div>`;
  }

  const obs = round.observation || {};
  const decision = round.decision || {};
  const denied = decision.allowed === false;
  const step = (round.proposal && round.proposal.steps && round.proposal.steps[0]) || null;
  const tool = obs.tool || decision.tool || (step && step.tool) || "—";
  const argsObj = obs.arguments || (step && step.arguments) || {};
  const args = Object.keys(argsObj).length
    ? "(" + Object.entries(argsObj).map(([k, v]) => `${k}=${v}`).join(", ") + ")"
    : "";

  const verdict = denied
    ? `<span class="badge deny"><span class="dot"></span>DENIED</span>`
    : !round.observation
      ? `<span class="badge run"><span class="dot"></span>RUNNING</span>`
      : `<span class="badge pass"><span class="dot"></span>PASS</span>`;

  const chips = [];
  if (ann.reconciled) chips.push(`<span class="mini hi">已对账 · receipt ${esc(shortHash(ann.reconciled))}…</span>`);
  const r = round.receipt;
  if (r) {
    if (r.todo_id) chips.push(`todo ${esc(r.todo_id)}`);
    if (r.tokens !== undefined) chips.push(`tokens ${num(r.tokens)}`);
    if (r.cost_microusd !== undefined) chips.push(`${num(r.cost_microusd)} µUSD`);
    if (r.latency_ms !== undefined) chips.push(`${r.latency_ms} ms`);
    if (r.external_billing) chips.push(`账单 ${esc(r.external_billing)}`);
  }
  const b = round.budget_after || {};
  if (b.calls_used !== undefined) chips.push(`calls ${b.calls_used}/${b.limits ? b.limits.max_calls : "?"}`);
  if (b.reads_used !== undefined) chips.push(`reads ${b.reads_used}/${b.limits ? b.limits.max_reads : "?"}`);

  const raw = { proposal: round.proposal, decision: round.decision, receipt: round.receipt, observation: round.observation };
  const lines = obs.result ? describe(obs).map(line => `<span class="grn">⎿</span>  ${line}`) : [];
  const icon = (!round.observation && !denied && TOOL_DOODLE[tool])
    ? TOOL_DOODLE[tool]
    : (TOOL_ICON[tool] || ICON.term);

  return `<div class="card round${!round.observation && !denied ? " live" : ""}" data-open="${denied ? "true" : "false"}">
    <div class="card-head click" data-toggle>
      <span class="rno">#${round.index}</span>
      <span class="t-ic">${icon}</span>
      <span class="tool">${esc(tool)}</span>
      ${args ? `<span class="args">${esc(args)}</span>` : ""}
      ${round.receipt && (round.receipt.latency_ms !== undefined || round.receipt.cost_microusd !== undefined)
        ? `<span class="rstat">${round.receipt.latency_ms !== undefined ? round.receipt.latency_ms + " ms" : ""}${round.receipt.latency_ms !== undefined && round.receipt.cost_microusd !== undefined ? " · " : ""}${round.receipt.cost_microusd !== undefined ? num(round.receipt.cost_microusd) + " µ" : ""}</span>`
        : ""}
      <span class="grow"></span>
      ${verdict}
      <span class="chev">▾</span>
    </div>
    <div class="preview">${esc(outcomeText(round, ann)).slice(0, 150)}</div>
    <div class="card-body">
      ${lines.length ? `<div class="out">${lines.join("\n")}</div>` : ""}
      ${renderToolDetail(obs)}
      ${denied ? `<div class="alert bad" style="margin-top:10px"><div class="a-title">${esc(decision.code || "DENIED")}</div><div class="a-sub">${esc(decision.reason || "")}</div></div>` : ""}
      ${chips.length ? `<div class="chips">${chips.map(c => `<span class="mini">${c}</span>`).join("")}</div>` : ""}
      <details class="raw"><summary>原始数据</summary><pre>${esc(JSON.stringify(raw, null, 2))}</pre></details>
    </div>
  </div>`;
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

function renderResult(trace) {
  const terminal = trace.terminal || {};
  const result = terminal.result || {};
  const failure = terminal.failure || {};

  if (terminal.status === "succeeded" && result.change_bp !== undefined) {
    const chg = result.change_bp;
    return `<div class="card result">
      <div class="card-head">
        <span class="card-title">${ICON.inkTick} 结论</span>
        <span class="badge pass" style="margin-left:2px"><span class="dot"></span>已验证</span>
        <span class="grow"></span>
        <span class="card-meta">succeeded · runtime-recomputed</span>
      </div>
      <p class="result-answer">${esc(resultConclusion(result))}</p>
      <div class="metrics">
        <div class="metric"><div class="k">FY2024 毛利率</div><div class="v">${pct(result.margin_bp_2024)}</div></div>
        <div class="metric"><div class="k">FY2025 毛利率</div><div class="v">${pct(result.margin_bp_2025)}</div></div>
        <div class="metric"><div class="k">变化</div><div class="v ${chg >= 0 ? "up" : "down"}">${pp(chg)}</div></div>
      </div>
      <div class="result-foot">
        <div class="chips" style="margin-top:2px">
          <span class="mini">口径 ${esc(result.basis)} · ${esc(result.consolidation)}</span>
          <span class="mini">${result.restatement_applied ? "已应用 FY2024 重述" : "无重述"}</span>
          ${(result.citations || []).map(c => `<span class="mini">${esc(c.period)} · ${esc(c.doc_id)}</span>`).join("")}
        </div>
        ${runActionsHtml(trace)}
      </div>
    </div>`;
  }

  if (terminal.status === "succeeded") {
    return `<div class="card result">
      <div class="card-head">
        <span class="card-title">${ICON.inkTick} 结论</span>
        <span class="badge pass" style="margin-left:2px"><span class="dot"></span>已验证</span>
        <span class="grow"></span>
        <span class="card-meta">succeeded</span>
      </div>
      <p class="result-answer">任务已完成，结果通过 Runtime 独立校验。</p>
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
  </div>`;
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
  const binding = task.binding || {};
  document.getElementById("tb-title").textContent = title || task.id || "—";
  const bridge = desktopBridge();
  if (bridge && bridge.set_title) bridge.set_title(title || task.id || "FCode");
  const moduleKey = binding.module || "";
  const moduleTitle = moduleKey
    ? ((modules.find(item => item.key === moduleKey) || {}).title || moduleKey)
    : "";
  document.getElementById("tb-chips").innerHTML = `
    ${moduleTitle ? `<span class="chip">${ICON.thought}${esc(moduleTitle)}</span>` : ""}
    <span class="chip">${ICON.folder}${esc(binding.corpus || "—")}</span>
    <span class="chip">${ICON.branch}${esc(task.id || "—")}</span>
    <span class="chip chip-grant">${ICON.key}${esc((task.model_grant || {}).grant_id || "—")} · r${esc((task.model_grant || {}).revision || "")}</span>
  `;
}

function setChainBadge(check) {
  const badge = document.getElementById("chain-badge");
  badge.className = "chain-pill " + (check.ok ? "ok" : "bad");
  badge.innerHTML = check.ok
    ? `<span class="dot"></span><span>链验证通过 · ${check.events} events</span>`
    : `<span class="dot"></span><span>链断裂 · ${esc(check.reason)}</span>`;
}

function bindToggles(root) {
  /* toggle 已改为 #main 上的事件委托（bind()），这里保留空实现以兼容旧调用 */
}

async function render(trace, title) {
  currentTrace = trace;
  const check = await verifyChain(trace);
  currentCheck = check;
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

  document.getElementById("main").innerHTML = `
    <section class="prompt">
      <div class="prompt-kicker">任务 · ${esc(task.principal || "")}</div>
      <p class="prompt-text">${esc(task.objective || "")}</p>
      <p class="prompt-note">${esc(note)}</p>
    </section>
    <div id="approval-slot"></div>
    <details class="thought" id="thought">
      <summary class="thought-head">
        <span class="thought-title">${ICON.thought} 思考链</span>
        <span class="thought-meta">${thoughtMeta(trace)}</span>
        <span class="grow"></span>
        <span class="thought-hint">计划、工具调用与证据</span>
        <span class="chev">▾</span>
      </summary>
      <div class="thought-body">
        <div id="plan-slot">${renderPlan(lastPlan(trace))}</div>
        <div id="budget-slot">${renderMeters(trace)}</div>
        <div id="rounds-slot">${rounds.map((r, i) => roundWrapHtml(messagesByRound(trace), r, anns[i])).join("")}</div>
      </div>
    </details>
    <div id="result-slot">${terminal && terminal.status ? renderResult(trace) : ""}</div>
  `;

  setFoot(
    `${model.provider || "—"} · ${currentKey && currentKey.startsWith("run:") ? "运行记录" : "只读回放"}`,
    ""
  );
  renderRail(trace, check);
  updateStatusline();
}

/* ------------------------------------------------------------------- live */

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
  document.getElementById("main").innerHTML = `
    <section class="prompt">
      <div class="prompt-kicker">任务 · ${esc(task.principal || "console-operator")}</div>
      <p class="prompt-text">${esc(task.objective || "")}</p>
      <p class="prompt-note" id="live-note" aria-live="polite">已提交，等待 Runtime 启动…</p>
    </section>
    <div id="approval-slot"></div>
    <div id="queued-slot"></div>
    <details class="thought" id="thought" open>
      <summary class="thought-head">
        <span class="thought-title">${ICON.thought} 思考链</span>
        <span class="thought-meta" id="thought-meta">启动中</span>
        <span class="grow"></span>
        <span class="thought-hint">计划、工具调用与证据</span>
        <span class="chev">▾</span>
      </summary>
      <div class="thought-body">
        <div id="plan-slot"></div>
        <div id="budget-slot"></div>
        <div id="rounds-slot"></div>
      </div>
    </details>
    <div id="result-slot"></div>`;
  const summary = document.querySelector("#thought > summary");
  if (summary) summary.addEventListener("click", () => { if (live) live.thoughtPinned = true; });
}

function liveNote(trace) {
  const events = trace.events || [];
  const rounds = trace.rounds || [];
  const terminal = trace.terminal || {};
  if (live && live.pending) return `<span class="yel">等待你的决定 · ${esc(live.pending.tool)}</span>`;
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
  currentTrace = trace;
  currentKey = "run:" + s.id;
  currentCheck = { ok: true, live: true, events: (trace.events || []).length };

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
    const delivered = new Set(
      eventList.filter(e => e.type === "operator_message").map(e => ((e.payload || {}).detail || {}).text)
    );
    const before = s.queuedMsgs.length;
    s.queuedMsgs = s.queuedMsgs.filter(m => !delivered.has(m.text));
    if (s.queuedMsgs.length !== before) toast("消息已入链 · 下轮生效");
    paintQueuedMsgs();
  }

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
    renderRail(trace, currentCheck);
    if (railStick) railBody.scrollTop = railBody.scrollHeight;
  }

  if (trace.terminal && trace.terminal.status) {
    const runId = s.id;
    verifyChain(trace).then(check => {
      if (!sessions.has(runId) || currentKey !== "run:" + runId) return;
      currentCheck = check;
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

/* 已入链的运行中消息，按其生效轮次分组（detail.round = 该轮开始前） */
function messagesByRound(trace) {
  const map = new Map();
  for (const e of (trace.events || [])) {
    if (e.type !== "operator_message") continue;
    const d = (e.payload || {}).detail || {};
    const round = Number(d.round) || 0;
    if (!map.has(round)) map.set(round, []);
    map.get(round).push(String(d.text || ""));
  }
  return map;
}

function roundWrapHtml(msgMap, round, ann) {
  const msgs = msgMap.get(round.index) || [];
  const bubbles = msgs.map(text => `<div class="msg op">
    <div class="msg-head"><span class="msg-who">你</span><span class="msg-state">已入链 · 第 ${esc(round.index)} 轮前生效</span></div>
    <div class="msg-text">${esc(text)}</div>
  </div>`).join("");
  return `<div class="round-wrap">${bubbles}${renderRound(round, round.index - 1, ann)}</div>`;
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
    const html = roundWrapHtml(msgMap, rounds[i], anns[i]);
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
    btn.innerHTML = `<svg class="i" viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
    ta.disabled = false;
    ta.placeholder = "运行中 — 直接输入，消息将排队并在下一轮交给 agent（⌘. 停止）";
  } else {
    chip.hidden = true;
    btn.title = "发送任务";
    btn.innerHTML = `<svg class="i" viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
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

/* ------------------------------------------------------------- 审批 */

function fmtCountdown(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function renderApproval(pending, deciding) {
  if (!pending) return "";
  const argsObj = pending.arguments || {};
  const args = Object.keys(argsObj).length
    ? "(" + Object.entries(argsObj).map(([k, v]) => `${k}=${v}`).join(", ") + ")"
    : "";
  const why = pending.policy === "every-step"
    ? "逐步审批：本次运行的每次工具调用都需要你确认。"
    : "关键步骤：这个动作会改变结论或宣告任务受阻，执行前需要你确认。";
  const busy = deciding
    ? `<span class="apv-count">${deciding.allow ? "已允许 · 等待 Runtime 继续…" : "已拒绝 · 运行将终止…"}</span>`
    : `<span class="apv-count" data-countdown>${fmtCountdown(pending.expiresIn)}</span>`;
  return `<div class="card approval" data-approval="${esc(pending.id)}">
    <div class="card-head">
      <span class="card-title">${ICON.lock} 需要你的决定</span>
      <span class="grow"></span>
      <span class="badge warn"><span class="dot"></span>${deciding ? "已提交" : "等待授权"}</span>
    </div>
    <div class="approval-body">
      <div class="apv-line">
        <span class="rno">#${esc(pending.round)}</span>
        <span class="tool">${esc(pending.tool)}</span>
        ${args ? `<span class="args">${esc(args)}</span>` : ""}
      </div>
      <div class="apv-why">${esc(why)}</div>
      <div class="apv-foot">
        ${busy}
        <label class="apv-remember"><input type="checkbox" data-remember${deciding ? " disabled" : ""}> 本次运行内不再询问该工具</label>
        <span class="grow"></span>
        <span class="apv-keys">1 允许 · 2 拒绝</span>
        <button class="a-btn" data-decision="deny"${deciding ? " disabled" : ""}>拒绝</button>
        <button class="a-btn strong" data-decision="allow"${deciding ? " disabled" : ""}>允许</button>
      </div>
    </div>
  </div>`;
}

function paintApproval() {
  const slot = document.getElementById("approval-slot");
  if (!slot) return;
  slot.innerHTML = live && live.pending ? renderApproval(live.pending, live.deciding) : "";
}

async function decideApproval(allow) {
  if (!live || !live.pending || live.deciding) return;
  const pending = live.pending;
  const rememberEl = document.querySelector("[data-remember]");
  const remember = !!(rememberEl && rememberEl.checked && allow);
  live.deciding = { allow };
  paintApproval();
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(live.id)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: pending.id, allow, remember }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    toast(allow ? "已允许 · 运行继续" : "已拒绝 · 运行将终止");
  } catch (error) {
    live.deciding = null;
    paintApproval();
    toast("决定未送达：" + error.message);
  }
}

/* ------------------------------------------------------- 计划与预算指令 */

function paintPlan() {
  const slot = document.getElementById("plan-slot");
  if (!slot || !live || !live.trace) return;
  const html = renderPlan(lastPlan(live.trace), {
    editable: live.running && !live.finished,
    editing: live.planEditing,
    confirmId: live.planConfirm,
    queued: live.planQueued ? live.planQueued.label : "",
  });
  slot.innerHTML = html;
  live.planHtml = html;
}

function paintBudget() {
  const slot = document.getElementById("budget-slot");
  if (!slot || !live || !live.trace) return;
  const html = renderMeters(live.trace, {
    editable: live.running && !live.finished,
    editing: live.budgetEditing,
    queued: !!live.budgetQueued,
  });
  slot.innerHTML = html;
  live.budgetHtml = html;
}

async function queuePlan(action, todoId) {
  if (!live || !live.running) return;
  const note = action === "skip" ? "操作员跳过" : "操作员提前";
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(live.id)}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, todoId, note }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const label = action === "skip" ? `已排队：跳过 ${todoId}` : `已排队：提前 ${todoId}`;
    live.planQueued = { label, events: (live.trace.events || []).length };
    live.planConfirm = null;
    paintPlan();
    toast(label + " · 下一轮生效");
  } catch (error) {
    toast("计划指令未送达：" + error.message);
  }
}

async function queueBudget() {
  if (!live || !live.running) return;
  const read = key => Number((document.querySelector(`[data-budget="${key}"]`) || {}).value || 0);
  const limits = lastBudget(live.trace) ? lastBudget(live.trace).limits : {};
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
    const response = await fetch(`/api/runs/${encodeURIComponent(live.id)}/budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    live.budgetEditing = false;
    live.budgetQueued = { events: (live.trace.events || []).length };
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
    queuedMsgs: [],
  };
}

function tabTitle(s) {
  return s.objective ? shortObjective(s.objective) : tplTitle(s.template);
}

function openLive(id, objective, template) {
  ledgerOpen = false;
  const fresh = !sessions.has(id);
  if (fresh) sessions.set(id, createSession(id, objective, template));
  const s = sessions.get(id);
  live = s;
  currentKey = "run:" + id;
  renderNav();
  renderTabs();
  if (fresh) {
    setComposerRunning(true);
    document.getElementById("tb-title").textContent = "运行 · " + tplTitle(template);
    document.getElementById("tb-chips").innerHTML = "";
    document.getElementById("rail-body").innerHTML = "";
    const main = document.getElementById("main");
    main.innerHTML = `<div class="empty">任务已提交，等待 Runtime 启动…</div>`;
    main.scrollTop = 0;
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
    if (live !== s) { stashSessionUpdate(s, data); return; }
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
      finished: !!delta.finished,
      status: delta.status,
      tracePath: delta.tracePath,
      error: delta.error,
    };
    if (live !== s) { stashSessionUpdate(s, data); return; }
    liveApply(s, data);
    if (data.finished) finishSession(s, data);
  });
  es.addEventListener("done", event => {
    let data = {};
    try { data = JSON.parse(event.data); } catch { /* empty */ }
    if (live !== s) {
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
    if (live !== s) {
      renderTabs();
      notify("Fcode · 运行失败", String(data.error || "Runtime 未返回任何快照").slice(0, 120));
      return;
    }
    document.getElementById("main").innerHTML =
      `<div class="empty">运行失败：${esc(data.error || "Runtime 未返回任何快照")}
        <div class="actions" style="justify-content:center"><button class="a-btn" data-act="retry">重试</button></div>
      </div>`;
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
  const main = document.getElementById("main");
  if (!s.trace) {
    main.innerHTML = `<div class="empty">任务已提交，等待 Runtime 启动…</div>`;
    return;
  }
  if (s.finished || (s.trace.terminal && s.trace.terminal.status)) {
    setComposerRunning(false);
    currentTrace = s.trace;
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
  if (s.finished) { if (live !== s) renderTabs(); return; }
  s.finished = true;
  s.running = false;
  s.pending = null;
  s.deciding = null;
  s.approvalKey = "";
  if (s.es) { s.es.close(); s.es = null; }
  s.queuedMsgs.forEach(m => {
    if (m.state === "queued") { m.state = "failed"; m.error = "运行已结束，消息未入链"; }
  });
  const trace = s.trace || (s.lastData && s.lastData.snapshot) || null;
  s.trace = trace;
  refreshRuns();
  const status = (trace && trace.terminal && trace.terminal.status) || (data && data.status) || "?";
  if (live !== s) {
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
    }
    cache.set("run:" + s.id, trace);
    verifyChain(trace).then(check => {
      if (live !== s) return;
      currentCheck = check;
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
  if (live === s) updateStatusline();
}

function detachLive() {
  /* 切走：会话保留在后台继续流式，不再渲染 */
  live = null;
  setComposerRunning(false);
  renderTabs();
}

function closeSessionTab(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.es) { s.es.close(); s.es = null; }
  sessions.delete(id);
  if (live === s) {
    live = null;
    setComposerRunning(false);
    document.getElementById("main").innerHTML =
      `<div class="empty">标签已关闭。运行仍在服务器上继续，可从左侧运行记录重新打开。</div>`;
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
    const active = live === s && currentKey === "run:" + s.id;
    const status = s.failed ? "bad"
      : s.finished ? (((s.trace || {}).terminal || {}).status === "succeeded" ? "ok" : "bad")
      : "live";
    return `<div class="tab${active ? " active" : ""}" data-tab="${esc(s.id)}" title="${esc(s.objective || "")}">
      <span class="tdot ${status}"></span>
      <span class="tlabel">${esc(tabTitle(s))}</span>
      <button class="tx" data-tabclose="${esc(s.id)}" title="关闭标签">×</button>
    </div>`;
  }).join("");
  for (const el of bar.querySelectorAll("[data-tab]")) {
    el.addEventListener("click", event => {
      if (event.target.closest("[data-tabclose]")) return;
      const id = el.dataset.tab;
      if (currentKey === "run:" + id && live === sessions.get(id)) return;
      const s = sessions.get(id);
      if (s) openLive(id, s.objective, s.template);
    });
  }
  for (const btn of bar.querySelectorAll("[data-tabclose]")) {
    btn.addEventListener("click", event => {
      event.stopPropagation();
      closeSessionTab(btn.dataset.tabclose);
    });
  }
}

/* 输入框统一入口：运行中 = 发消息，空闲 = 派新任务 */
function composerSubmit() {
  if (live && live.running && !live.finished) return sendOperatorMessage();
  return sendTask();
}

/* 运行中插话：乐观渲染排队气泡，入链后由 snapshot 事件确认 */
async function sendOperatorMessage() {
  if (!live || !live.running || live.finished) return;
  const ta = document.getElementById("composer-ta");
  const text = (ta.value || "").trim();
  if (!text) return;
  ta.value = "";
  autosize(ta);
  const msg = { text, state: "queued" };
  live.queuedMsgs.push(msg);
  paintQueuedMsgs();
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(live.id)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
  } catch (error) {
    msg.state = "failed";
    msg.error = error.message;
    paintQueuedMsgs();
    toast("消息未送达：" + error.message);
  }
}

function paintQueuedMsgs() {
  const slot = document.getElementById("queued-slot");
  if (!slot) return;
  const msgs = live && live.queuedMsgs ? live.queuedMsgs : [];
  slot.innerHTML = msgs.length ? `<div class="queued-msgs">${msgs.map(m => `
    <div class="msg op ${esc(m.state)}">
      <div class="msg-head">
        <span class="msg-who">你</span>
        <span class="msg-state">${m.state === "failed" ? "未送达 · " + esc(m.error || "") : "排队中 · 下一轮入链"}</span>
      </div>
      <div class="msg-text">${esc(m.text)}</div>
    </div>`).join("")}</div>` : "";
}

async function sendTask() {
  const ta = document.getElementById("composer-ta");
  const template = templates.find(t => t.key === tplKey) || {};
  const objective = ta.value.trim() || template.objective || "";
  if (!objective) return;
  if (!health || !health.live) {
    toast("回放模式：用 python3 viewer/server.py 启动后才能派任务");
    return;
  }
  const btn = document.getElementById("send");
  btn.disabled = true;
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective, template: tplKey, approval: approvalMode }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const run = await response.json();
    ta.value = "";
    autosize(ta);
    openLive(run.id, objective, run.template);
    refreshRuns();
    ta.blur();
  } catch (error) {
    document.getElementById("main").innerHTML =
      `<div class="empty">无法启动运行：${esc(error.message)}</div>`;
  } finally {
    if (!(live && live.running)) btn.disabled = !(health && health.live);
  }
}

async function stopRun() {
  if (!live || !live.running) return;
  document.getElementById("run-chip-text").textContent = "正在停止…";
  try {
    await fetch(`/api/runs/${encodeURIComponent(live.id)}/stop`, { method: "POST" });
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
  const label = document.getElementById("template-label");
  if (label) label.textContent = template ? template.title.split("：")[0] : (TPL_FALLBACK[key] || key);
  const ta = document.getElementById("composer-ta");
  if (template && ta && !ta.value) ta.placeholder = template.objective;
  renderTemplateMenu();
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
}

function renderApprovalMenu() {
  const menu = document.getElementById("approval-menu");
  if (!menu) return;
  menu.innerHTML = APPROVAL_MODES.map(([key, title, desc]) => `<button class="tpl-item${key === approvalMode ? " active" : ""}" data-approval-mode="${esc(key)}">
    <span class="t"><span>${esc(title)}</span><span class="m">${esc(key)}</span></span>
    <span class="d">${esc(desc)}</span>
  </button>`).join("") + `<div class="tpl-note">审批只发生在轮次边界，不打断工具执行；拒绝会终止运行并写入签名链。档位对新任务生效。</div>`;
  for (const button of menu.querySelectorAll("[data-approval-mode]")) {
    button.addEventListener("click", () => {
      const changed = button.dataset.approvalMode !== approvalMode;
      setApprovalMode(button.dataset.approvalMode);
      menu.hidden = true;
      if (changed && live && live.running) toast("已切换 · 下一个任务生效");
    });
  }
}

function renderTemplateMenu() {
  const menu = document.getElementById("tpl-menu");
  if (!menu) return;
  menu.innerHTML = templateGroups().map(group =>
    `<div class="tpl-group">${esc(group.title)}</div>` +
    group.items.map(t => `<button class="tpl-item${t.key === tplKey ? " active" : ""}" data-tpl="${esc(t.key)}">
      <span class="t"><span>${esc(t.title)}</span><span class="m">${t.limits ? t.limits.max_calls : "?"} calls · ${t.max_rounds} rounds</span></span>
      <span class="d">${esc(t.story)}</span>
    </button>`).join("")
  ).join("") + `<div class="tpl-note">离线 mock：任意目标都会执行同一套研究蓝图（作用于合成语料）；模块决定工具与验证，模板决定授权、预算与故障注入。</div>`;
  for (const button of menu.querySelectorAll("[data-tpl]")) {
    button.addEventListener("click", () => {
      setTemplate(button.dataset.tpl);
      menu.hidden = true;
    });
  }
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
  }
  if (!health.live) {
    const ta = document.getElementById("composer-ta");
    ta.placeholder = "静态回放模式 — 用 python3 server.py --repo … 启动控制台即可真实运行任务";
    document.getElementById("template-btn").disabled = true;
    document.getElementById("approval-btn").disabled = true;
    document.getElementById("send").disabled = true;
    setFoot("offline-mock · 只读回放", "");
    return;
  }
  setTemplate(templates.some(t => t.key === "full") ? "full" : templates[0].key);
  setComposerRunning(false);
  updateStatusline();
  fetch("/api/tools", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(data => {
    if (!data || !Array.isArray(data.tools)) return;
    toolContracts = data.tools;
    if (currentTrace) renderRail(currentTrace, currentCheck || { ok: false, reason: "" });
  }).catch(() => { /* the tools tab will show 加载中 */ });
  autosize(document.getElementById("composer-ta"));
  refreshRuns();
  setInterval(refreshRuns, 2500);
}

async function selectRun(id) {
  ledgerOpen = false;
  const existing = sessions.get(id);
  if (existing) return openLive(id, existing.objective, existing.template);
  const run = runHistory.find(item => item.id === id);
  if (run && (run.status === "running" || !run.tracePath)) {
    return openLive(id, run.objective, run.template);
  }
  if (live) detachLive();
  currentKey = "run:" + id;
  renderNav();
  const main = document.getElementById("main");
  const cached = cache.get("run:" + id);
  if (cached) {
    await render(cached, "运行 · " + tplTitle(run ? run.template : ""));
    return;
  }
  main.innerHTML = `<div class="empty">加载运行记录…</div>`;
  try {
    const path = (run && run.tracePath) || `runs/${id}/trace.json`;
    const trace = await fetch(path, { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    cache.set("run:" + id, trace);
    await render(trace, "运行 · " + tplTitle(run ? run.template : ""));
    renderNav();
  } catch (error) {
    main.innerHTML = `<div class="empty">无法加载运行记录：${esc(error.message)}</div>`;
  }
}

/* ------------------------------------------------------------------- load */

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
  if (key.startsWith("run:")) return selectRun(key.slice(4));
  ledgerOpen = false;
  if (live) detachLive();
  currentKey = key;
  renderNav();
  const main = document.getElementById("main");
  main.innerHTML = `<div class="empty">加载 ${esc(label)}…</div>`;
  const trace = await loadTrace(key);
  if (!trace) {
    document.getElementById("chain-badge").className = "chain-pill";
    document.getElementById("chain-badge").innerHTML = `<span class="dot"></span><span>无数据</span>`;
    main.innerHTML = `<div class="empty">
      ${esc(key)} 还没有 trace。先运行 <code>python demo.py ${esc(key)}</code>，或 <code>python demo.py all</code> 一次生成全部。
    </div>`;
    return;
  }
  await render(trace, label);
  renderNav();
}

/* --------------------------------------------------------------- handlers */

async function reverify() {
  if (!currentTrace) return;
  const check = await verifyChain(currentTrace);
  const badge = document.getElementById("chain-badge");
  badge.className = "chain-pill " + (check.ok ? "ok" : "bad") + " pulse";
  badge.innerHTML = check.ok
    ? `<span class="dot"></span><span>链验证通过 · ${check.events} events</span>`
    : `<span class="dot"></span><span>链断裂 · ${esc(check.reason)}</span>`;
  setTimeout(() => badge.classList.remove("pulse"), 700);
}

function exportTrace() {
  if (!currentTrace) return;
  const name = (currentKey ? currentKey.replace(/:/g, "-") : "trace") + ".trace.json";
  const blob = new Blob([JSON.stringify(currentTrace, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
  toast("已导出 trace JSON");
}

/* ------------------------------------------------------------ 运行操作 */

function currentRun() {
  if (currentKey && currentKey.startsWith("run:")) {
    return runHistory.find(item => item.id === currentKey.slice(4)) || null;
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
  </div>`;
}

function runActionsHtml(trace) {
  const terminal = trace.terminal || {};
  const status = terminal.status || "";
  if (!status) return "";
  const report = `<button class="a-btn strong" data-act="report">签发报告</button>`;
  if (!(currentKey && currentKey.startsWith("run:"))) {
    return `<div class="chips">${costChipsHtml(trace)}</div><div class="actions">${report}</div>`;
  }
  const failure = terminal.failure || {};
  const run = currentRun();
  const liveId = live && live.id;
  const canResume = !run || !!run.taskId || (liveId && liveId === run.id);
  const resumable = (failure.code === "BUDGET_EXCEEDED" || failure.code === "ROUND_LIMIT")
    && !(live && live.running)
    && canResume;
  const resume = resumable ? `<button class="a-btn strong" data-act="resume">追加预算并继续</button>` : "";
  const retry = status && status !== "succeeded"
    ? `<button class="a-btn" data-act="retry">重试</button>` : "";
  return `<div class="chips">${costChipsHtml(trace)}</div><div class="actions">${resume}${retry}${report}<button class="a-btn" data-act="diag">复制诊断</button></div>`;
}

/* ------------------------------------------------------------- 报告签发 */

let lastReportHtml = null;
let lastReportName = "fcode-report.html";

async function openReport() {
  if (!currentTrace || !(currentTrace.terminal && currentTrace.terminal.status)) {
    toast("运行结束后才能签发报告");
    return;
  }
  const check = await verifyChain(currentTrace);
  const run = currentRun();
  const task = currentTrace.task || {};
  const title = run ? (run.name || shortObjective(run.objective)) : shortObjective(task.objective || "工作底稿");
  lastReportHtml = FCReport.build(currentTrace, {
    title,
    runId: run ? run.id : (currentKey || "trace"),
    check,
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 19) + "Z",
  });
  lastReportName = "fcode-report-" + String(run ? run.id : (currentKey || "trace")).replace(/[^a-zA-Z0-9-]+/g, "-") + ".html";
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

/* --------------------------------------------------------------- 建单向导 */

const wizard = { step: 1, tplKey: "full", objective: "", approval: approvalMode, submitting: false };

function wizardTemplate() {
  return templates.find(t => t.key === wizard.tplKey) || {};
}

function openWizard() {
  if (!health || !health.live) {
    toast("回放模式：用 python3 viewer/server.py 启动后才能创建委托");
    return;
  }
  wizard.step = 1;
  wizard.tplKey = tplKey || "full";
  wizard.objective = "";
  wizard.approval = approvalMode;
  wizard.submitting = false;
  renderWizard();
  document.getElementById("wizard-layer").hidden = false;
}

function closeWizard() {
  document.getElementById("wizard-layer").hidden = true;
}

function renderWizard() {
  const body = document.getElementById("wizard-body");
  const foot = document.getElementById("wizard-foot");
  if (!body || !foot) return;
  document.getElementById("wizard-step").textContent = `${wizard.step} / 3`;
  const template = wizardTemplate();
  const limits = template.limits || {};

  if (wizard.step === 1) {
    body.innerHTML = `<div class="wz-hint">第一步 · 选择委托类型。类型决定授权范围、预算与轮次；带演示标记的类型会注入特定故障，用于观察运行时的防护。</div>
      ${templateGroups().map(group => `<div class="wz-group">${esc(group.title)}</div>
      <div class="wz-cards">${group.items.map(t => `
        <button class="wz-card${t.key === wizard.tplKey ? " active" : ""}" data-wz-tpl="${esc(t.key)}">
          <div class="wz-t"><span>${esc(tplTitle(t.key))}</span>
            <span class="wz-badge${t.key === "full" ? "" : " demo"}">${t.key === "full" ? "标准委托" : "演示"}</span></div>
          <div class="wz-d">${esc(t.story || "")}</div>
          <div class="wz-m">${t.limits ? num(t.limits.max_calls) + " calls · " + num(t.limits.max_cost_microusd) + " µUSD · " : ""}${t.max_rounds || "?"} 轮</div>
        </button>`).join("")}</div>`).join("")}`;
    foot.innerHTML = `<button class="a-btn" data-wz-close2>取消</button><span class="grow"></span><button class="a-btn strong" data-wz-next>下一步</button>`;
    return;
  }

  if (wizard.step === 2) {
    body.innerHTML = `<div class="wz-hint">第二步 · 委托说明。写清楚要判断什么、依据什么口径；留空将使用模板默认目标。</div>
      <textarea class="wz-ta" id="wz-objective" maxlength="600" rows="4"
        placeholder="${esc(template.objective || "描述这项委托…")}">${esc(wizard.objective)}</textarea>
      <div class="wz-count"><span id="wz-count">${wizard.objective.length} / 600</span></div>`;
    foot.innerHTML = `<button class="a-btn" data-wz-prev>上一步</button><span class="grow"></span><button class="a-btn strong" data-wz-next>下一步</button>`;
    const ta = document.getElementById("wz-objective");
    if (ta) ta.focus();
    return;
  }

  body.innerHTML = `<div class="wz-hint">第三步 · 审批档位。审批只发生在轮次边界，拒绝会终止运行并写入签名链。</div>
    <div class="wz-cards wz-modes">${APPROVAL_MODES.map(([key, t, d]) => `
      <button class="wz-card${key === wizard.approval ? " active" : ""}" data-wz-mode="${esc(key)}">
        <div class="wz-t"><span>${esc(t)}</span></div>
        <div class="wz-d">${esc(d)}</div>
      </button>`).join("")}</div>
    <div class="wz-summary">
      <div><span>类型</span><b>${esc(tplTitle(wizard.tplKey))}</b></div>
      <div><span>预算</span><b>${limits.max_calls ? num(limits.max_calls) + " calls · " + num(limits.max_cost_microusd) + " µUSD（可在运行中调高）" : "—"}</b></div>
      <div><span>轮次</span><b>至多 ${template.max_rounds || "?"} 轮</b></div>
      <div><span>审批</span><b>${esc(approvalTitle(wizard.approval))}</b></div>
      <div><span>目标</span><b>${esc(wizard.objective || template.objective || "—")}</b></div>
    </div>`;
  foot.innerHTML = `<button class="a-btn" data-wz-prev>上一步</button><span class="grow"></span><button class="a-btn strong" data-wz-submit>提交委托</button>`;
}

function wizardNext() {
  if (wizard.step === 2) {
    const ta = document.getElementById("wz-objective");
    wizard.objective = ta ? ta.value.trim() : wizard.objective;
  }
  wizard.step = Math.min(3, wizard.step + 1);
  renderWizard();
}

async function submitWizard() {
  if (wizard.submitting) return;
  const template = wizardTemplate();
  const objective = wizard.objective || template.objective || "";
  if (!objective) { toast("请填写委托说明"); return; }
  wizard.submitting = true;
  const submit = document.querySelector("[data-wz-submit]");
  if (submit) { submit.disabled = true; submit.textContent = "提交中…"; }
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective, template: wizard.tplKey, approval: wizard.approval }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const run = await response.json();
    setApprovalMode(wizard.approval);
    setTemplate(wizard.tplKey);
    closeWizard();
    toast("委托已受理 · 开始执行");
    openLive(run.id, objective, run.template);
    refreshRuns();
  } catch (error) {
    toast("委托提交失败：" + error.message);
    if (submit) { submit.disabled = false; submit.textContent = "提交委托"; }
  } finally {
    wizard.submitting = false;
  }
}

function bindWizard() {
  const layer = document.getElementById("wizard-layer");
  if (!layer) return;
  layer.addEventListener("click", event => {
    if (event.target.closest("[data-wz-close]")) { closeWizard(); return; }
    if (event.target.closest("#wizard-close") || event.target.closest("[data-wz-close2]")) { closeWizard(); return; }
    const tpl = event.target.closest("[data-wz-tpl]");
    if (tpl) { wizard.tplKey = tpl.dataset.wzTpl; renderWizard(); return; }
    const mode = event.target.closest("[data-wz-mode]");
    if (mode) { wizard.approval = mode.dataset.wzMode; renderWizard(); return; }
    if (event.target.closest("[data-wz-prev]")) { wizard.step = Math.max(1, wizard.step - 1); renderWizard(); return; }
    if (event.target.closest("[data-wz-next]")) { wizardNext(); return; }
    if (event.target.closest("[data-wz-submit]")) { submitWizard(); return; }
  });
  document.getElementById("wizard-body").addEventListener("input", event => {
    if (event.target.id === "wz-objective") {
      wizard.objective = event.target.value;
      const count = document.getElementById("wz-count");
      if (count) count.textContent = `${event.target.value.length} / 600`;
    }
  });
}

function openResumeForm() {
  const trace = currentTrace || {};
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
  const id = currentKey && currentKey.startsWith("run:") ? currentKey.slice(4) : null;
  if (!id) { toast("没有可续跑的运行"); return; }
  const saved = runHistory.find(item => item.id === id);
  if (saved && !saved.taskId && !(live && live.id === id)) { toast("这条运行没有可续跑的持久任务"); return; }
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
    const run = runHistory.find(item => item.id === id) || (live && live.id === id ? live : null);
    const objective = (run && run.objective) || (currentTrace && currentTrace.task && currentTrace.task.objective) || "";
    const template = (run && run.template) || ((currentTrace && currentTrace.task && currentTrace.task.binding || {}).scenario) || "full";
    toast("预算已追加 · 从事件日志续跑");
    // 续跑让同一个 run 恢复运行：丢弃旧会话缓存，重新以运行态打开
    const stale = sessions.get(id);
    if (stale) { if (stale.es) stale.es.close(); sessions.delete(id); }
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
  const trace = currentTrace || {};
  const task = trace.task || {};
  const objective = (run && run.objective) || task.objective || (live && live.objective);
  const template = (run && run.template) || (task.binding || {}).scenario || (live && live.template);
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
  const trace = currentTrace || {};
  const terminal = trace.terminal || {};
  const failure = terminal.failure || {};
  const task = trace.task || {};
  const active = live && live.running ? live : null;
  const lines = [
    "Fcode · 运行诊断",
    `run: ${(run && run.id) || (active && active.id) || currentKey || "（未选择运行）"}`,
    `template: ${(run && run.template) || (task.binding || {}).scenario || (active && active.template) || "—"}`,
    `objective: ${task.objective || (run && run.objective) || (active && active.objective) || "—"}`,
    `status: ${terminal.status || (run && run.status) || (active ? "running" : "—")}` +
      (failure.code ? ` · ${failure.code}` : "") + (failure.message ? ` · ${failure.message}` : ""),
    `rounds/events: ${(trace.rounds || []).length}/${(trace.events || []).length}` +
      (currentCheck ? ` · chain: ${currentCheck.ok ? "ok" : "broken(" + currentCheck.reason + ")"}` : ""),
    run && run.error ? `error: ${run.error}` : "",
    `at: ${new Date().toISOString()}`,
  ].filter(Boolean);
  const ok = await copyText(lines.join("\n"));
  toast(ok ? "诊断信息已复制" : "复制失败");
}

/* --------------------------------------------------------------- 通知 */

const NOTIFY_KEY = "fa.notify";
let notifyOn = localStorage.getItem(NOTIFY_KEY) === "1";

function notifyReady() {
  return notifyOn && ("Notification" in window) && Notification.permission === "granted";
}

async function toggleNotify() {
  if (notifyOn) {
    notifyOn = false;
    localStorage.setItem(NOTIFY_KEY, "0");
    toast("完成通知已关闭");
    return;
  }
  if (!("Notification" in window)) {
    toast("此浏览器不支持系统通知");
    return;
  }
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") {
    toast("通知权限未授予");
    return;
  }
  notifyOn = true;
  localStorage.setItem(NOTIFY_KEY, "1");
  toast("完成通知已开启");
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

/* ---------------------------------------------------------------- toast */

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

/* -------------------------------------------------------------- palette */

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
  const actions = [
    { ic: "＋", label: "新委托 · 建单向导", run: openWizard },
    { ic: "✎", label: "新任务 · 聚焦输入框", run: focusComposer },
  ];
  if (live && live.running) actions.push({ ic: "■", label: "停止当前运行", run: stopRun });
  if (currentRun() && !(live && live.running)) actions.push({ ic: "↻", label: "重试当前运行", run: retryCurrent });
  if (currentTrace) {
    actions.push({ ic: "⧉", label: "复制运行诊断", run: copyDiagnostics });
    actions.push({ ic: "↓", label: "导出 trace JSON", run: exportTrace });
    if (!(currentKey || "").startsWith("run:")) {
      actions.push({ ic: "⟲", label: "重放当前场景", run: replay });
    }
    if (currentTrace.terminal && currentTrace.terminal.status) {
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
  for (const [key, label] of SCENARIOS) {
    if (!query || label.toLowerCase().includes(query)) push("示例场景", {
      label, hint: "场景", run: () => { setScenesOpen(true); select(key, label); },
    });
  }
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
  for (const button of list.querySelectorAll("[data-idx]")) {
    const index = Number(button.dataset.idx);
    button.addEventListener("mousemove", () => {
      if (palActive !== index) { palActive = index; highlightPalette(); }
    });
    button.addEventListener("click", () => runPaletteItem(index));
  }
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

/* ----------------------------------------------------------- slash 命令 */
/* Codex 式入口：输入框以 / 开头弹出命令面板，↑↓ 选择，Tab 补全，Enter 执行。 */
const SLASH_COMMANDS = [
  { cmd: "/new", desc: "新建委托（打开建单向导）", run: () => openWizard() },
  { cmd: "/ledger", desc: "打开工作台账本", run: () => openLedger() },
  { cmd: "/report", desc: "签发当前运行的审计报告", run: () => openReport() },
  { cmd: "/stop", desc: "在轮次边界停止当前运行", run: () => stopRun() },
  { cmd: "/allow", desc: "批准挂起的审批请求", run: () => decideApproval(true) },
  { cmd: "/deny", desc: "拒绝挂起的审批请求", run: () => decideApproval(false) },
  { cmd: "/help", desc: "快捷键与命令说明", run: () => toast("⌘K 命令面板 · ⌘N 新建委托 · ⌘. 停止 · ⌘↵ 允许 · ⌘⌫ 拒绝 · ↑↓ 历史") },
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

function bind() {
  document.getElementById("new-run").addEventListener("click", openWizard);
  document.getElementById("desk-btn").addEventListener("click", openLedger);
  document.getElementById("composer-open").addEventListener("click", openWizard);
  bindWizard();
  document.getElementById("pick").addEventListener("change", event => {
    if (event.target.files[0]) fromFile(event.target.files[0]);
  });
  const ta = document.getElementById("composer-ta");
  ta.addEventListener("input", () => {
    autosize(ta);
    updateSlashMenu();
    if (!(live && live.running && !live.finished)) {
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
  document.getElementById("send").addEventListener("click", composerSubmit);
  document.getElementById("run-chip").addEventListener("click", stopRun);
  const tplBtn = document.getElementById("template-btn");
  const tplMenu = document.getElementById("tpl-menu");
  const apvBtn = document.getElementById("approval-btn");
  const apvMenu = document.getElementById("approval-menu");
  tplBtn.addEventListener("click", event => {
    event.stopPropagation();
    apvMenu.hidden = true;
    tplMenu.hidden = !tplMenu.hidden;
  });
  apvBtn.addEventListener("click", event => {
    event.stopPropagation();
    tplMenu.hidden = true;
    apvMenu.hidden = !apvMenu.hidden;
  });
  document.addEventListener("click", event => {
    if (!tplMenu.hidden && !tplBtn.contains(event.target) && !tplMenu.contains(event.target)) tplMenu.hidden = true;
    if (!apvMenu.hidden && !apvBtn.contains(event.target) && !apvMenu.contains(event.target)) apvMenu.hidden = true;
    const slashMenu = document.getElementById("slash-menu");
    const composerBox = document.getElementById("composer-box");
    if (slashMenu && !slashMenu.hidden && composerBox && !composerBox.contains(event.target)) slashMenu.hidden = true;
  });
  document.getElementById("chain-badge").addEventListener("click", reverify);
  document.getElementById("report-close").addEventListener("click", closeReport);
  document.querySelector(".report-scrim").addEventListener("click", closeReport);
  document.getElementById("report-print").addEventListener("click", printReport);
  document.getElementById("report-download").addEventListener("click", downloadReport);
  document.getElementById("run-search").addEventListener("input", event => {
    runFilter = event.target.value;
    renderRuns();
  });
  document.getElementById("scene-toggle").addEventListener("click", () => {
    const section = document.getElementById("scene-section");
    setScenesOpen(!(section && section.classList.contains("open")));
  });
  document.getElementById("palette-btn").addEventListener("click", openPalette);
  document.querySelector(".palette-scrim").addEventListener("click", closePalette);
  const palInput = document.getElementById("palette-input");
  palInput.addEventListener("input", () => { palActive = 0; renderPalette(); });
  palInput.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") { event.preventDefault(); palActive = Math.min(palItems.length - 1, palActive + 1); highlightPalette(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); palActive = Math.max(0, palActive - 1); highlightPalette(); }
    else if (event.key === "Enter") { event.preventDefault(); runPaletteItem(palActive); }
    else if (event.key === "Escape") { event.preventDefault(); closePalette(); }
  });
  document.getElementById("main").addEventListener("click", event => {
    if (event.target.closest("[data-wizard-open]")) { openWizard(); return; }
    const ledDel = event.target.closest("[data-led-del]");
    if (ledDel) {
      const id = ledDel.dataset.ledDel;
      if (ledgerConfirmId !== id) { ledgerConfirmId = id; renderLedger(); }
      else { ledgerConfirmId = null; deleteRun(id); }
      return;
    }
    const ledRow = event.target.closest("[data-led-row]");
    if (ledRow && !event.target.closest("[data-led-del]")) { selectRun(ledRow.dataset.ledRow); return; }
    const toggleHead = event.target.closest("[data-toggle]");
    if (toggleHead) {
      const round = toggleHead.closest(".round");
      if (round) {
        round.dataset.open = round.dataset.open === "true" ? "false" : "true";
        round.dataset.user = "1";
        return;
      }
    }
    const decision = event.target.closest("[data-decision]");
    if (decision) { decideApproval(decision.dataset.decision === "allow"); return; }
    const planEdit = event.target.closest("[data-plan-edit]");
    if (planEdit) {
      if (!live) return;
      live.planEditing = !live.planEditing;
      live.planConfirm = null;
      paintPlan();
      return;
    }
    const planAction = event.target.closest("[data-plan-action]");
    if (planAction && live) {
      const action = planAction.dataset.planAction;
      if (action === "cancel") {
        live.planConfirm = null;
        paintPlan();
      } else if (action === "skip") {
        live.planConfirm = planAction.dataset.todo;
        live.planEditing = true;
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
      if (!live) return;
      live.budgetEditing = !live.budgetEditing;
      paintBudget();
      return;
    }
    const budgetCancel = event.target.closest("[data-budget-cancel]");
    if (budgetCancel) {
      if (!live) return;
      live.budgetEditing = false;
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
  const app = document.getElementById("app");
  app.classList.toggle("rail-open", railOpen);
  app.classList.toggle("rail-hidden", !railOpen);
  document.getElementById("rail-toggle").addEventListener("click", () => {
    railOpen = !railOpen;
    app.classList.toggle("rail-hidden", !railOpen);
    app.classList.toggle("rail-open", railOpen);
  });
  for (const button of document.querySelectorAll("#rail-tabs button")) {
    button.addEventListener("click", () => {
      railTab = button.dataset.tab;
      if (currentTrace) renderRail(currentTrace, currentCheck || { ok: false, reason: "" });
    });
  }

  document.addEventListener("dragenter", e => e.preventDefault());
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", e => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) fromFile(file);
  });

  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); togglePalette(); return; }
    if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); openWizard(); return; }
    if (mod && e.key === ".") { e.preventDefault(); if (live && live.running) stopRun(); return; }
    if (mod && live && live.pending && !live.deciding && (e.key === "Enter" || e.key === "Backspace" || e.key === "Delete")) {
      const palette = document.getElementById("palette");
      if (palette && !palette.hidden) return;
      e.preventDefault();
      decideApproval(e.key === "Enter");
      return;
    }
    const typing = e.target && /INPUT|TEXTAREA/.test(e.target.tagName);
    if (!typing && live && live.pending && !live.deciding && (e.key === "1" || e.key === "2")) {
      const overlay = ["palette", "wizard-layer", "report-layer"].some(id => {
        const el = document.getElementById(id);
        return el && !el.hidden;
      });
      if (!overlay) {
        e.preventDefault();
        decideApproval(e.key === "1");
        return;
      }
    }
    if (e.key === "Escape") {
      const reportLayer = document.getElementById("report-layer");
      if (reportLayer && !reportLayer.hidden) { closeReport(); return; }
      const wizardLayer = document.getElementById("wizard-layer");
      if (wizardLayer && !wizardLayer.hidden) { closeWizard(); return; }
      const palette = document.getElementById("palette");
      if (palette && !palette.hidden) { closePalette(); return; }
      const menu = document.getElementById("tpl-menu");
      if (menu && !menu.hidden) { menu.hidden = true; return; }
      const approval = document.getElementById("approval-menu");
      if (approval && !approval.hidden) { approval.hidden = true; return; }
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
    if (!el || !live || !live.pendingDeadline) return;
    const left = (live.pendingDeadline - Date.now()) / 1000;
    el.textContent = left > 0 ? fmtCountdown(left) : "已到时限 · 等待 Runtime 拒绝";
  }, 500);
}

function replay() {
  if (currentKey && currentKey.startsWith("run:")) return; // run records are immutable
  if (currentKey) { cache.delete(currentKey); select(currentKey, labelOf(currentKey)); }
  else if (currentTrace) render(currentTrace, "trace");
}

async function fromFile(file) {
  try {
    ledgerOpen = false;
    const trace = JSON.parse(await file.text());
    if (live) detachLive();
    currentKey = null;
    renderNav();
    await render(trace, file.name);
  } catch (error) {
    document.getElementById("main").innerHTML =
      `<div class="empty">无法解析 ${esc(file.name)}：${esc(error.message)}</div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bind();
  renderNav();
  initLive();
  const param = new URLSearchParams(location.search).get("trace");
  if (param) {
    fetch(param, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(trace => render(trace, param.split("/").pop()))
      .catch(error => {
        document.getElementById("main").innerHTML =
          `<div class="empty">无法加载 ${esc(param)}：${esc(error.message)}</div>`;
      });
  } else {
    select("full", "完整研究");
  }
  // 预热其余场景，让侧栏状态点尽快着色
  for (const [key] of SCENARIOS) {
    if (key !== "full") loadTrace(key).then(() => renderNav());
  }
});
