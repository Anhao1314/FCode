"use strict";

/* ------------------------------------------------------------------- data */

const SCENARIOS = [
  ["full",        "完整研究"],
  ["tool-denied", "越权工具"],
  ["budget",      "预算耗尽"],
  ["crash",       "崩溃恢复"],
  ["unknown",     "未知对账"],
  ["open-ended",  "开放问题"],
];

const EVENT_DOT = {
  task_created: "", model_started: "info", model_unknown: "warn", model_reconciled: "ok",
  plan_validated: "", plan_updated: "", execution_started: "", tool_started: "info",
  tool_denied: "bad", tool_succeeded: "ok", verification_started: "info",
  task_succeeded: "ok", task_failed: "bad", task_stopped: "warn",
};

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
};
const dot = cls => `<span class="ev-dot ${cls || ""}"></span>`;

const cache = new Map();
let currentKey = null;
let currentTrace = null;
let currentCheck = null;
let railTab = "events";
let railOpen = true;

/* live console state */
const TPL_FALLBACK = { full: "完整研究", "tool-denied": "越权工具", budget: "预算耗尽", crash: "崩溃恢复", unknown: "未知对账", "open-ended": "开放问题" };
let health = null;      // /api/health payload
let templates = [];     // /api/templates
let tplKey = "full";    // selected template
let runHistory = [];    // /api/runs
let live = null;        // attached live run: { id, es, trace, ... }
let runFilter = "";     // 运行记录搜索词

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
const shortObjective = text => {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > 22 ? s.slice(0, 22) + "…" : s;
};

function renderNav() {
  renderScenarios();
  renderRuns();
}

function renderScenarios() {
  const nav = document.getElementById("nav");
  nav.innerHTML = SCENARIOS.map(([key, label]) => {
    const trace = cache.get(key);
    const meta = trace ? `${(trace.rounds || []).length} 轮` : "";
    return `<button class="session${key === currentKey ? " active" : ""}" data-key="${key}">
      <span class="sdot"></span>
      <span class="slabel">${esc(label)}</span>
      <span class="smeta">${meta}</span>
    </button>`;
  }).join("");
  for (const button of nav.querySelectorAll("button")) {
    button.addEventListener("click", () => select(button.dataset.key, labelOf(button.dataset.key)));
  }
}

function renderRuns() {
  const group = document.getElementById("run-group");
  const runNav = document.getElementById("run-nav");
  if (!group || !runNav) return;
  group.hidden = runHistory.length === 0;
  const query = runFilter.trim().toLowerCase();
  const runs = runHistory
    .filter(run => !query || `${run.name || ""} ${run.objective} ${run.id}`.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  runNav.innerHTML = runs.length ? runs.map(run => {
    const active = currentKey === "run:" + run.id;
    const running = run.status === "running";
    const cls = running ? "live" : stateClass(run.status);
    return `<div class="session run-row${active ? " active" : ""}${run.pinned ? " pinned" : ""}" data-run="${esc(run.id)}" title="${esc(run.objective)}">
      <span class="sdot ${running ? "live" : cls}"></span>
      <span class="slabel" data-name>${esc(runLabel(run))}</span>
      <span class="smeta">${running ? "运行中" : (run.rounds ? run.rounds + " 轮" : "—")}</span>
      <button class="pin" data-pin="${esc(run.id)}" title="${run.pinned ? "取消固定" : "固定"}">${run.pinned ? "★" : "☆"}</button>
    </div>`;
  }).join("") : `<div class="side-empty">没有匹配的运行</div>`;
  for (const row of runNav.querySelectorAll(".run-row")) {
    row.addEventListener("click", event => {
      if (event.target.closest("[data-pin]") || event.target.closest(".rename-input")) return;
      selectRun(row.dataset.run);
    });
    const label = row.querySelector("[data-name]");
    label.addEventListener("dblclick", event => { event.stopPropagation(); startRename(row.dataset.run, label); });
    const pin = row.querySelector("[data-pin]");
    pin.addEventListener("click", event => { event.stopPropagation(); togglePin(row.dataset.run); });
  }
}

/* ------------------------------------------------------------------ rail */

function renderRail(trace, check) {
  const body = document.getElementById("rail-body");
  if (!trace) { body.innerHTML = ""; return; }
  for (const button of document.querySelectorAll("#rail-tabs button")) {
    button.classList.toggle("active", button.dataset.tab === railTab);
  }

  if (railTab === "events") {
    const events = trace.events || [];
    body.innerHTML = events.map(e => `<div class="ev-item">
      <div class="ev-line">
        <span class="ev-seq">#${e.sequence}</span>
        ${dot(EVENT_DOT[e.type] || "")}
        <span class="ev-type">${esc(e.type)}</span>
        <span class="ev-hash">${esc(shortHash(e.hash))}</span>
      </div>
      ${summariseEvent(e) ? `<div class="ev-detail">${summariseEvent(e)}</div>` : ""}
    </div>`).join("");
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

function summariseEvent(e) {
  const d = e.payload && e.payload.detail;
  if (!d || Object.keys(d).length === 0) return "";
  if (e.type === "tool_started" || e.type === "tool_succeeded") return `${esc(d.tool || "")} ${d.arguments && Object.keys(d.arguments).length ? "(" + Object.entries(d.arguments).map(([k, v]) => `${esc(k)}=${esc(v)}`).join(", ") + ")" : "()"}`;
  if (e.type === "model_started") return `round ${esc(d.round)}`;
  if (e.type === "model_unknown") return esc(d.cause || "");
  if (e.type === "model_reconciled") return `receipt ${esc(shortHash(d.receipt_ref))}…`;
  if (e.type === "plan_updated") { const p = d.plan || {}; const done = (p.todos || []).filter(t => t.status === "done").length; return `revision ${esc(p.revision)} · ${done}/${(p.todos || []).length} settled`; }
  if (e.type === "plan_validated") return d.plan && d.plan.steps ? esc(d.plan.steps.map(s => s.id + ":" + s.tool).join(" ")) : "";
  return esc(JSON.stringify(d).slice(0, 120));
}

/* ------------------------------------------------------------ main render */

function renderPlan(plan) {
  if (!plan || !plan.todos || !plan.todos.length) return "";
  const done = plan.todos.filter(t => t.status === "done").length;
  const glyph = { done: "✓", blocked: "✕", abandoned: "–", active: "◐", pending: "○" };
  return `<div class="card">
    <div class="card-head">
      <span class="card-title">${ICON.file} Plan</span>
      <span class="grow"></span>
      <span class="card-meta">revision ${esc(plan.revision)} · <span style="color:var(--green)">${done}/${plan.todos.length}</span> 已完成</span>
    </div>
    <div class="card-rows">
      ${plan.todos.map(t => `<div class="row ${esc(t.status)}">
        <span class="r-icon">${glyph[t.status] || "○"}</span>
        <span class="r-text">${esc(t.text)}</span>
        <span class="r-meta">${esc(t.tool)}</span>
      </div>`).join("")}
    </div>
  </div>`;
}

function renderMeters(trace) {
  const b = lastBudget(trace);
  if (!b) return "";
  const lim = b.limits || {};
  const meters = [
    ["calls", b.calls_used, lim.max_calls, ""],
    ["reads", b.reads_used, lim.max_reads, ""],
    ["µUSD", b.cost_used_microusd, lim.max_cost_microusd, ""],
    ["tokens", b.tokens_used, lim.max_tokens, "m-tokens"],
  ];
  return `<div class="card meters">
    <div class="card-head">
      <span class="card-title">${ICON.lock} 预算</span>
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
    </div>
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

function renderToolDetail(obs) {
  const tool = obs.tool;
  const r = obs.result || {};
  switch (tool) {
    case "list_documents": {
      const docs = r.documents || [];
      if (!docs.length) return "";
      return `<div class="t-detail">${docs.map(d => `<div class="doc-row">
        <span class="id">${esc(d.id)}</span>
        <span class="meta2">${esc(d.kind || "")} · ${esc(d.period || "")}</span>
        <span class="grow"></span>
        <span class="meta2">${esc(d.unit_label || d.unit || "")} · ${esc(d.basis || "")}</span>
      </div>`).join("")}</div>`;
    }
    case "read_document": {
      const body = String(r.body || "");
      return `<div class="t-detail">
        <div class="doc-row"><span class="id">${esc(r.id || "")}</span><span class="meta2">${esc(r.title || "")}</span></div>
        ${body ? `<pre class="doc-body">${esc(body)}</pre>` : ""}
      </div>`;
    }
    case "normalize_units":
      return kvDetail([
        ["换算", `${r.source_unit} → ${r.target_unit}`],
        ["系数", `×${num(r.factor)}`],
        ["毛利（元）", num(r.gross_profit_cny)],
      ]);
    case "reconcile_basis":
      if (r.reconciled === false) return alertDetail("warn", "无法桥接口径", r.reason || "没有公布的桥接说明");
      return kvDetail([
        ["期间", r.period],
        ["口径", `${r.from_basis} → ${r.to_basis}`],
        ["差异", `${r.delta >= 0 ? "+" : ""}${r.delta}`],
        ["说明", r.reason || ""],
      ]);
    case "check_restatement":
      if (!r.restated) return kvDetail([["重述", "无重述记录"]]);
      return kvDetail([
        ["原值 → 重述", `${num(r.original_gross_profit)} → ${num(r.restated_gross_profit)}`],
        ["差异", `${r.delta >= 0 ? "+" : ""}${r.delta}`],
        ["说明", r.reason || ""],
      ]);
    case "calculate_margin":
      if (!r.computed) return alertDetail("bad", "无法计算", (r.blockers || []).join("；"));
      return `<div class="t-detail"><div class="t-metrics">
        <div><div class="k">FY2024</div><div class="v">${pct(r.margin_bp_2024)}</div></div>
        <div><div class="k">FY2025</div><div class="v">${pct(r.margin_bp_2025)}</div></div>
        <div><div class="k">变化</div><div class="v ${r.change_bp >= 0 ? "up" : "down"}">${pp(r.change_bp)}</div></div>
      </div></div>`;
    case "report_blocked":
      return alertDetail("bad", "声明受阻", r.reason || "");
    default:
      return "";
  }
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
  const icon = TOOL_ICON[tool] || ICON.term;

  return `<div class="card round${!round.observation && !denied ? " live" : ""}" data-open="${denied ? "true" : "false"}">
    <div class="card-head click" data-toggle>
      <span class="rno">#${round.index}</span>
      <span class="t-ic">${icon}</span>
      <span class="tool">${esc(tool)}</span>
      ${args ? `<span class="args">${esc(args)}</span>` : ""}
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

function renderResult(trace) {
  const terminal = trace.terminal || {};
  const result = terminal.result || {};
  const failure = terminal.failure || {};

  if (terminal.status === "succeeded" && result.change_bp !== undefined) {
    const chg = result.change_bp;
    return `<div class="card result">
      <div class="card-head">
        <span class="card-title">${ICON.check} 结果</span>
        <span class="badge pass" style="margin-left:2px"><span class="dot"></span>succeeded</span>
        <span class="grow"></span>
        <span class="card-meta">runtime-recomputed</span>
      </div>
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

  return `<div class="card result">
    <div class="card-head">
      <span class="card-title">${ICON.alert} 结果</span>
      <span class="badge ${stateClass(terminal.status)}" style="margin-left:2px"><span class="dot"></span>${esc(terminal.status || "?")}</span>
      <span class="grow"></span>
      <span class="card-meta">序列 ${esc(terminal.sequence)}</span>
    </div>
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
  document.getElementById("tb-chips").innerHTML = `
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
  for (const head of root.querySelectorAll("[data-toggle]")) {
    if (head.dataset.bound) continue;
    head.dataset.bound = "1";
    head.addEventListener("click", () => {
      const round = head.closest(".round");
      round.dataset.open = round.dataset.open === "true" ? "false" : "true";
      round.dataset.user = "1";
    });
  }
}

async function render(trace, title) {
  currentTrace = trace;
  const check = await verifyChain(trace);
  currentCheck = check;
  const task = trace.task || {};
  const terminal = trace.terminal || {};
  const rounds = trace.rounds || [];
  const status = terminal.status || task.status;
  const model = trace.model || {};
  const anns = annotateRounds(trace);

  renderHead(trace, title);
  setChainBadge(check);

  const started = (trace.events && trace.events[0] && trace.events[0].at)
    ? String(trace.events[0].at).replace("T", " ").slice(0, 19) : "";
  const statusColor = { ok: "var(--green)", bad: "var(--red)" }[stateClass(status)] || "var(--yellow)";

  document.getElementById("main").innerHTML = `
    <section class="prompt">
      <div class="prompt-kicker">任务 · ${esc(task.principal || "")}</div>
      <p class="prompt-text">${esc(task.objective || "")}</p>
      <p class="prompt-note">以下为 Runtime 生成的签名轨迹：每轮「模型提议 → 宿主门控 → 工具执行 → 收据入账」，
      全链可在浏览器里重算校对。模型 ${esc(model.model || "—")}（${esc(model.provider || "—")}）· 终态
      <span style="color:${statusColor}">${esc(status || "?")}</span>
      · ${rounds.length} 轮 · ${(trace.events || []).length} 事件${started ? " · " + esc(started) + "Z" : ""}</p>
    </section>
    <div id="plan-slot">${renderPlan(lastPlan(trace))}</div>
    <div id="budget-slot">${renderMeters(trace)}</div>
    <div id="rounds-slot">${rounds.map((r, i) => renderRound(r, i, anns[i])).join("")}</div>
    <div id="result-slot">${terminal && terminal.status ? renderResult(trace) : ""}</div>
  `;

  bindToggles(document);
  document.getElementById("foot-text").textContent =
    `${model.provider || "—"} · ${currentKey && currentKey.startsWith("run:") ? "运行记录" : "只读回放"}`;
  renderRail(trace, check);
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
      <p class="prompt-note" id="live-note">已提交，等待 Runtime 启动…</p>
    </section>
    <div id="plan-slot"></div>
    <div id="budget-slot"></div>
    <div id="rounds-slot"></div>
    <div id="result-slot"></div>`;
}

function liveNote(trace) {
  const events = trace.events || [];
  const rounds = trace.rounds || [];
  const last = events[events.length - 1];
  const running = !(trace.terminal && trace.terminal.status);
  const status = running ? "running" : trace.terminal.status;
  const statusColor = running ? "var(--accent)" : ({ ok: "var(--green)", bad: "var(--red)" }[stateClass(status)] || "var(--yellow)");
  const bits = [
    "事件按提交顺序实时写入，链随事件增长",
    `${rounds.length} 轮 · ${events.length} 事件`,
    `终态 <span style="color:${statusColor}">${esc(status)}</span>`,
  ];
  if (last) bits.push(`最近 <span style="font-family:var(--mono)">${esc(last.type)}</span>`);
  return bits.join(" · ");
}

function liveApply(data) {
  const trace = data.snapshot;
  if (!trace) return;
  const stick = nearMainBottom();
  const first = !live.trace;
  live.trace = trace;
  currentTrace = trace;
  currentKey = "run:" + live.id;
  currentCheck = { ok: true, live: true, events: (trace.events || []).length };

  const scenario = trace.task && trace.task.binding ? trace.task.binding.scenario : live.template;
  renderHead(trace, "运行 · " + tplTitle(scenario));

  if (first) {
    liveShell(trace);
    live.planHtml = "";
    live.budgetHtml = "";
    live.resultHtml = "";
    live.roundHtml = [];
    live.eventCount = 0;
  }

  const planHtml = renderPlan(lastPlan(trace));
  if (planHtml !== live.planHtml) {
    const slot = document.getElementById("plan-slot");
    if (slot) slot.innerHTML = planHtml;
    live.planHtml = planHtml;
  }

  const budgetHtml = renderMeters(trace);
  if (budgetHtml !== live.budgetHtml) {
    const slot = document.getElementById("budget-slot");
    if (slot) slot.innerHTML = budgetHtml;
    live.budgetHtml = budgetHtml;
  }

  syncLiveRounds(trace);

  const resultHtml = trace.terminal && trace.terminal.status ? renderResult(trace) : "";
  if (resultHtml !== live.resultHtml) {
    const slot = document.getElementById("result-slot");
    if (slot) slot.innerHTML = resultHtml;
    live.resultHtml = resultHtml;
  }

  const note = document.getElementById("live-note");
  if (note) note.innerHTML = liveNote(trace);

  const events = (trace.events || []).length;
  if (events !== live.eventCount) {
    live.eventCount = events;
    const railBody = document.getElementById("rail-body");
    const railStick = railBody.scrollHeight - railBody.scrollTop - railBody.clientHeight < 60;
    renderRail(trace, currentCheck);
    if (railStick) railBody.scrollTop = railBody.scrollHeight;
  }

  if (trace.terminal && trace.terminal.status) {
    const runId = live.id;
    verifyChain(trace).then(check => {
      if (!live || live.id !== runId || currentKey !== "run:" + runId) return;
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
  if (chip) chip.textContent = (trace.rounds || []).length ? `运行中 · 第 ${(trace.rounds || []).length} 轮` : "运行中";

  if (stick) scrollMainBottom();
}

function syncLiveRounds(trace) {
  const slot = document.getElementById("rounds-slot");
  if (!slot) return;
  const anns = annotateRounds(trace);
  const rounds = trace.rounds || [];
  const open = new Map();
  [...slot.children].forEach((el, i) => open.set(i, el.dataset.open));
  for (let i = 0; i < rounds.length; i++) {
    const html = renderRound(rounds[i], i, anns[i]);
    if (live.roundHtml[i] === html) continue;
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const node = holder.firstElementChild;
    const previous = slot.children[i];
    if (previous) {
      const wasLive = previous.classList.contains("live");
      const userToggled = previous.dataset.user === "1";
      if (open.has(i)) node.dataset.open = open.get(i);
      if (wasLive && !node.classList.contains("live") && !userToggled) node.dataset.open = "false";
      previous.replaceWith(node);
    } else {
      slot.append(node);
    }
    live.roundHtml[i] = html;
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
    btn.classList.add("stop");
    btn.disabled = false;
    btn.title = "停止运行";
    btn.innerHTML = `<svg class="i" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.6"/></svg>`;
    ta.disabled = true;
  } else {
    chip.hidden = true;
    btn.classList.remove("stop");
    btn.title = "发送任务";
    btn.innerHTML = `<svg class="i" viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>`;
    const enabled = !!(health && health.live);
    btn.disabled = !enabled;
    ta.disabled = !enabled;
  }
  document.getElementById("foot-text").textContent = running
    ? "offline-mock · 运行中"
    : (health && health.live ? "offline-mock · 可运行" : "offline-mock · 只读回放");
}

function openLive(id, objective, template) {
  detachLive();
  live = {
    id, es: null, trace: null, objective, template, running: true, finished: false,
    planHtml: "", budgetHtml: "", resultHtml: "", roundHtml: [], eventCount: 0,
  };
  currentKey = "run:" + id;
  renderNav();
  setComposerRunning(true);
  document.getElementById("tb-title").textContent = "运行 · " + tplTitle(template);
  document.getElementById("tb-chips").innerHTML = "";
  document.getElementById("rail-body").innerHTML = "";
  const main = document.getElementById("main");
  main.innerHTML = `<div class="empty">任务已提交，等待 Runtime 启动…</div>`;
  main.scrollTop = 0;

  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
  live.es = es;
  es.addEventListener("snapshot", event => {
    if (!live || live.id !== id) return;
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    liveApply(data);
    if (data.finished) finishLive(data);
  });
  es.addEventListener("done", event => {
    if (!live || live.id !== id) return;
    let data = {};
    try { data = JSON.parse(event.data); } catch { /* empty */ }
    finishLive(data);
  });
  es.addEventListener("failed", event => {
    if (!live || live.id !== id) return;
    let data = {};
    try { data = JSON.parse(event.data); } catch { /* empty */ }
    if (live.es) live.es.close();
    live.es = null;
    live.running = false;
    document.getElementById("main").innerHTML =
      `<div class="empty">运行失败：${esc(data.error || "Runtime 未返回任何快照")}
        <div class="actions" style="justify-content:center"><button class="a-btn" data-act="retry">重试</button></div>
      </div>`;
    setComposerRunning(false);
    notify("Fcode · 运行失败", String(data.error || "Runtime 未返回任何快照").slice(0, 120));
    refreshRuns();
  });
}

function finishLive(data) {
  if (!live || live.finished) return;
  const runId = live.id;
  live.finished = true;
  live.running = false;
  if (live.es) { live.es.close(); live.es = null; }
  setComposerRunning(false);
  const trace = live.trace;
  if (trace) {
    cache.set("run:" + runId, trace);
    verifyChain(trace).then(check => {
      if (!live || live.id !== runId) return;
      currentCheck = check;
      setChainBadge(check);
      renderRail(trace, check);
    });
    const status = (trace.terminal && trace.terminal.status) || data.status || "?";
    const rounds = (trace.rounds || []).length;
    document.getElementById("foot-text").textContent =
      `offline-mock · 运行${status === "succeeded" ? "完成" : "结束（" + status + "）"}`;
    notify(
      status === "succeeded" ? "Fcode · 运行完成" : `Fcode · 运行结束（${status}）`,
      `${shortObjective(live.objective)} · ${rounds} 轮`
    );
  }
  refreshRuns();
}

function detachLive() {
  if (live && live.es) live.es.close();
  live = null;
  setComposerRunning(false);
}

async function sendTask() {
  if (live && live.running) return stopRun();
  const ta = document.getElementById("composer-ta");
  const template = templates.find(t => t.key === tplKey) || {};
  const objective = ta.value.trim() || template.objective || "";
  if (!objective || !health || !health.live) return;
  const btn = document.getElementById("send");
  btn.disabled = true;
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective, template: tplKey }),
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

async function refreshRuns() {
  if (!health || !health.live) return;
  try {
    runHistory = await fetch("/api/runs", { cache: "no-store" }).then(r => r.json());
  } catch {
    return;
  }
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

function renderTemplateMenu() {
  const menu = document.getElementById("tpl-menu");
  if (!menu) return;
  menu.innerHTML = templates.map(t => `<button class="tpl-item${t.key === tplKey ? " active" : ""}" data-tpl="${esc(t.key)}">
    <span class="t"><span>${esc(t.title)}</span><span class="m">${t.limits ? t.limits.max_calls : "?"} calls · ${t.max_rounds} rounds</span></span>
    <span class="d">${esc(t.story)}</span>
  </button>`).join("") + `<div class="tpl-note">离线 mock：任意目标都会执行同一套研究蓝图（作用于合成语料）；模板决定授权、预算与故障注入。</div>`;
  for (const button of menu.querySelectorAll("[data-tpl]")) {
    button.addEventListener("click", () => {
      setTemplate(button.dataset.tpl);
      menu.hidden = true;
    });
  }
}

async function initLive() {
  try {
    health = await fetch("/api/health", { cache: "no-store" }).then(r => r.json());
  } catch {
    health = { ok: false, live: false, runtimeError: "静态托管模式：没有本地 API" };
  }
  if (health.live) {
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
    document.getElementById("send").disabled = true;
    document.getElementById("foot-text").textContent = "offline-mock · 只读回放";
    const group = document.getElementById("run-group");
    if (group) group.hidden = true;
    return;
  }
  setTemplate(templates.some(t => t.key === "full") ? "full" : templates[0].key);
  setComposerRunning(false);
  autosize(document.getElementById("composer-ta"));
  refreshRuns();
  setInterval(() => {
    if (runHistory.some(run => run.status === "running")) refreshRuns();
  }, 2500);
}

async function selectRun(id) {
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

function runActionsHtml(trace) {
  if (!(currentKey && currentKey.startsWith("run:"))) return "";
  const status = (trace.terminal || {}).status || "";
  const retry = status && status !== "succeeded"
    ? `<button class="a-btn" data-act="retry">重试</button>` : "";
  return `<div class="actions">${retry}<button class="a-btn" data-act="diag">复制诊断</button></div>`;
}

async function retryRun(objective, template) {
  try {
    const response = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective, template }),
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
    { ic: "＋", label: "新任务 · 聚焦输入框", run: focusComposer },
  ];
  if (live && live.running) actions.push({ ic: "■", label: "停止当前运行", run: stopRun });
  if (currentRun() && !(live && live.running)) actions.push({ ic: "↻", label: "重试当前运行", run: retryCurrent });
  if (currentTrace) {
    actions.push({ ic: "⧉", label: "复制运行诊断", run: copyDiagnostics });
    actions.push({ ic: "↓", label: "导出 trace JSON", run: exportTrace });
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
    if (!query || label.toLowerCase().includes(query)) push("演示场景", {
      label, hint: "场景", run: () => select(key, label),
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

function bind() {
  document.getElementById("open-file").addEventListener("click", () => document.getElementById("pick").click());
  document.getElementById("composer-open").addEventListener("click", () => document.getElementById("pick").click());
  document.getElementById("pick").addEventListener("change", event => {
    if (event.target.files[0]) fromFile(event.target.files[0]);
  });
  document.getElementById("replay-side").addEventListener("click", replay);
  const ta = document.getElementById("composer-ta");
  ta.addEventListener("input", () => {
    autosize(ta);
    if (!(live && live.running)) {
      document.getElementById("send").disabled = !(health && health.live);
    }
  });
  ta.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendTask();
    }
  });
  document.getElementById("send").addEventListener("click", sendTask);
  const tplBtn = document.getElementById("template-btn");
  const tplMenu = document.getElementById("tpl-menu");
  tplBtn.addEventListener("click", event => {
    event.stopPropagation();
    tplMenu.hidden = !tplMenu.hidden;
  });
  document.addEventListener("click", event => {
    if (!tplMenu.hidden && !tplBtn.contains(event.target) && !tplMenu.contains(event.target)) tplMenu.hidden = true;
  });
  document.getElementById("export").addEventListener("click", exportTrace);
  document.getElementById("reverify").addEventListener("click", reverify);
  document.getElementById("run-search").addEventListener("input", event => {
    runFilter = event.target.value;
    renderRuns();
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
    const button = event.target.closest("[data-act]");
    if (!button) return;
    if (button.dataset.act === "retry") retryCurrent();
    else if (button.dataset.act === "diag") copyDiagnostics();
  });
  document.getElementById("rail-toggle").addEventListener("click", () => {
    railOpen = !railOpen;
    const app = document.getElementById("app");
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
    if (mod && e.key === ".") { e.preventDefault(); if (live && live.running) stopRun(); return; }
    const typing = e.target && /INPUT|TEXTAREA/.test(e.target.tagName);
    if (e.key === "Escape") {
      const palette = document.getElementById("palette");
      if (palette && !palette.hidden) { closePalette(); return; }
      const menu = document.getElementById("tpl-menu");
      if (menu && !menu.hidden) { menu.hidden = true; return; }
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
}

function replay() {
  if (currentKey && currentKey.startsWith("run:")) return; // run records are immutable
  if (currentKey) { cache.delete(currentKey); select(currentKey, labelOf(currentKey)); }
  else if (currentTrace) render(currentTrace, "trace");
}

async function fromFile(file) {
  try {
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
