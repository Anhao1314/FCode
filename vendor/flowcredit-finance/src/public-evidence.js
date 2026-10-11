import { createHash } from "node:crypto";

export const PUBLIC_EVIDENCE_VERSION = "flowcredit.public-evidence/v0.1";
export const MINIMAX_H1_2026_URL = "https://www.minimax.io/news/minimax-announces-first-half-2026-financial-results-1787744160";
export const SUPPORTED_PUBLIC_TARGETS = Object.freeze([
  { id: "arweave:mainnet", name: "Arweave", kind: "network", profile: "arweave-mainnet-v1" },
  { id: "hkex:00100", name: "MiniMax Group Inc.", kind: "company", profile: "minimax-h1-2026-v1" },
  { id: "defillama:aave", name: "Aave", kind: "protocol", profile: "defillama-aave-v1" }
]);

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_ACQUISITION_MS = 12000;
const hash = value => createHash("sha256").update(value).digest("hex");
const finite = value => typeof value === "number" && Number.isFinite(value);
const stamp = now => new Date(now()).toISOString();
const targetText = target => String(typeof target === "string" ? target : target?.name ?? target?.query ?? target?.id ?? "").trim().toLowerCase();
const ALIASES = new Map([
  ...["arweave", "arweave network", "arweave:mainnet", "arweave.net", "https://arweave.net", "https://arweave.net/"].map(name => [name, "arweave:mainnet"]),
  ...["minimax", "minimax h1 2026", "minimax group", "minimax group inc.", "minimax group inc", "hkex:00100", "00100.hk"].map(name => [name, "hkex:00100"]),
  ...["aave", "aave protocol", "defillama:aave"].map(name => [name, "defillama:aave"])
]);

function resolveTarget(target) {
  const text = targetText(target);
  if (ALIASES.has(text)) return [ALIASES.get(text)];
  // A URL supplied as a target is never interpreted as arbitrary browsing permission.
  if (/^https?:\/\//.test(text)) return [];
  // An explicit unsupported assessment object must not resolve to a supported
  // company mentioned only as its comparison/reference later in the request.
  const explicit = /\b(?:assess|evaluate)\s+(?:the\s+)?(?:(?:company|network|protocol|project)\s+)?([a-z0-9_:.-]+)|评估\s*([a-z0-9_:.-]+)/i.exec(text);
  const requested = (explicit?.[1] || explicit?.[2] || '').replace(/[.]+$/, '');
  if (explicit && /(?:do\s+not|don't|not|不要|不)\s*$/.test(text.slice(0, explicit.index))) return [];
  if (requested === 'aave' && /^\s+(?:labs|limited|inc\.?|company)\b/.test(text.slice(explicit.index + explicit[0].length))) return [];
  if (requested && !['whether', 'how', 'my', 'our', 'this', 'that', 'a', 'an', 'these', 'both', 'business', 'risk', 'the'].includes(requested) && !ALIASES.has(requested) && !/^(?:minimax|arweave|aave)$/.test(requested)) return [];
  const mentions = [...text.matchAll(/(?<![a-z0-9_])(?:arweave|minimax|aave)(?![a-z0-9_])/g)]
    .filter(match => match[0] !== "aave" || !/^aave\s+(?:labs|limited|inc\.?|company)\b/.test(text.slice(match.index)))
    .map(match => ALIASES.get(match[0]));
  return [...new Set(mentions)];
}

class AcquisitionError extends Error {
  constructor(code, message, status = "unavailable") { super(message); this.code = code; this.status = status; }
}

function allowedUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) return false;
  if (parsed.hostname === "arweave.net") return /^\/(?:info|price\/1000000|block\/hash\/[A-Za-z0-9_-]{64})$/.test(parsed.pathname) && !parsed.search;
  if (url === MINIMAX_H1_2026_URL) return true;
  return parsed.hostname === "api.llama.fi" && parsed.pathname === "/protocol/aave" && !parsed.search;
}

async function readSource(url, kind, context) {
  if (!allowedUrl(url)) throw new AcquisitionError("SOURCE_NOT_ALLOWED", "Source is outside the registered public provider", "blocked");
  const response = await context.fetchImpl(url, {
    method: "GET", redirect: "error", signal: context.signal,
    headers: { Accept: kind === "issuer_disclosure" ? "text/html" : "application/json", "User-Agent": "FlowCredit/0.1 public evidence (https://github.com/Anhao1314/flowcredit)" }
  });
  if (!response.ok) throw new AcquisitionError(`HTTP_${response.status}`, `Public source returned HTTP ${response.status}`, [401, 403, 429].includes(response.status) ? "blocked" : "unavailable");
  // fetchImpl is injectable for replay tests; a live redirect must never expand the source allowlist.
  if (response.redirected || (response.url && response.url !== url)) throw new AcquisitionError("SOURCE_REDIRECT", "Public source redirected outside its exact registered URL", "blocked");
  const length = Number(response.headers?.get?.("content-length"));
  if (finite(length) && length > MAX_SOURCE_BYTES) throw new AcquisitionError("SOURCE_TOO_LARGE", "Public source exceeds the 16 MiB acquisition limit", "blocked");
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_SOURCE_BYTES) { await reader.cancel(); throw new AcquisitionError("SOURCE_TOO_LARGE", "Public source exceeds the 16 MiB acquisition limit", "blocked"); }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    bytes = Buffer.concat(chunks);
  } else {
    bytes = Buffer.from(await response.text(), "utf8");
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new AcquisitionError("SOURCE_TOO_LARGE", "Public source exceeds the 16 MiB acquisition limit", "blocked");
  }
  const contentHash = hash(bytes);
  const source = {
    id: `src-${hash(`${url}\n${contentHash}`).slice(0, 24)}`, url, retrievedAt: stamp(context.now),
    contentHash, contentType: response.headers?.get?.("content-type") || (kind === "issuer_disclosure" ? "text/html" : "application/json"),
    kind, verification: "retrieved", body: bytes.toString("utf8"), providerVersion: PUBLIC_EVIDENCE_VERSION
  };
  // Even an unreadable or drifted source remains inspectable; retrieval is distinct from verification.
  context.result.sources.push(source);
  return source;
}

function readJson(source) {
  try { return JSON.parse(source.body); }
  catch { throw new AcquisitionError("INVALID_SOURCE_JSON", "Provider did not return parseable JSON", "blocked"); }
}

function safeNonnegativeInteger(value, field) {
  if (typeof value !== "string" && typeof value !== "number") throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", `${field} is missing or is not numeric`, "blocked");
  if (typeof value === "string" && !/^\d+$/.test(value)) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", `${field} is not an integer`, "blocked");
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", `${field} is not a safe nonnegative integer`, "blocked");
  return number;
}

function observation(entity, source, metric, value, unit, period, scope, locator, basis, profile) {
  return {
    id: `obs-${hash(JSON.stringify([entity.id, source.id, metric, locator, period])).slice(0, 24)}`,
    metric, value, unit, period, scope, entityId: entity.id, sourceId: source.id, locator,
    basis: profile === "minimax-h1-2026-v1" ? "issuer-disclosed-IFRS" : profile === "arweave-mainnet-v1" ? "gateway-reported-mainnet" : "defillama-tvl-usd",
    semanticNotes: basis, origin: "public_adapter", validation: "valid", providerVersion: `${PUBLIC_EVIDENCE_VERSION}/${profile}`
  };
}

async function arweave(context) {
  const { entity } = context.result;
  const infoSource = await readSource("https://arweave.net/info", "public_api", context);
  const info = readJson(infoSource);
  if (info.network !== "arweave.N.1" || !/^[A-Za-z0-9_-]{64}$/.test(info.current || "")) throw new AcquisitionError("ENTITY_MISMATCH", "Gateway did not identify the registered Arweave mainnet", "blocked");
  const height = safeNonnegativeInteger(info.height, "height");
  const blockSource = await readSource(`https://arweave.net/block/hash/${info.current}`, "public_api", context);
  const block = readJson(blockSource);
  if (block.indep_hash !== info.current || safeNonnegativeInteger(block.height, "block.height") !== height) throw new AcquisitionError("BLOCK_IDENTITY_MISMATCH", "Block does not match the gateway's reported hash and height", "blocked");
  const time = safeNonnegativeInteger(block.timestamp, "timestamp");
  if (time * 1000 > Date.parse(blockSource.retrievedAt) + 300000) throw new AcquisitionError("FUTURE_OBSERVATION", "Block timestamp is unexpectedly in the future", "blocked");
  const period = { end: new Date(time * 1000).toISOString(), kind: "instant" };
  const profile = "arweave-mainnet-v1";
  const observations = [
    observation(entity, blockSource, "block_height", height, "blocks", period, "network", "/height", "Block height in the gateway-retrieved mainnet block; block identity matched /info, consensus proof not verified", profile),
    observation(entity, blockSource, "weave_size", safeNonnegativeInteger(block.weave_size, "weave_size"), "bytes", period, "network", "/weave_size", "Protocol-reported cumulative weave byte extent; not replicated disk capacity, revenue, or a proof of data availability", profile),
    observation(entity, blockSource, "block_size", safeNonnegativeInteger(block.block_size, "block_size"), "bytes", period, "network", "/block_size", "Protocol-reported byte extent added by this block; not monthly storage demand", profile)
  ];
  context.result.observations.push(...observations);
  context.result.warnings.push("Arweave evidence is a single gateway observation. It does not verify consensus, permanent availability, active network-wide peers, or commercial revenue.");
  // The upload quote is optional and explicitly a price for 1,000,000 bytes in Winston.
  try {
    const priceSource = await readSource("https://arweave.net/price/1000000", "public_api", context);
    const price = safeNonnegativeInteger(priceSource.body.trim(), "upload quote");
    const quote = observation(entity, priceSource, "upload_price_per_1000000_bytes", price, "Winston/1000000-bytes", { end: priceSource.retrievedAt, kind: "instant" }, "network", "$", "Gateway transaction fee quote for a 1,000,000-byte upload; 1 AR = 10^12 Winston; not USD or total revenue", profile);
    quote.basis = "gateway-unit-price";
    context.result.observations.push(quote);
  } catch (error) {
    context.result.acquisition.push({ provider: profile, status: error.status || "unavailable", code: error.code || "FETCH_FAILED", message: "Network block acquired; upload price quote unavailable" });
  }
}

function decodeHtml(value) {
  const named = { amp: "&", quot: '"', apos: "'", nbsp: " ", lt: "<", gt: ">", rsquo: "'", lsquo: "'", ndash: "–", mdash: "—" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity) => {
    if (entity.startsWith("#")) {
      const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    return named[entity.toLowerCase()] ?? full;
  });
}

function parseTables(html) {
  // A deliberately narrow static-table reader, not a browser or script evaluator.
  const inert = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const text = value => decodeHtml(value.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
  return [...inert.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)].map((table, tableIndex) => {
    if (/<table\b/i.test(table[1])) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", "Nested financial tables are unsupported", "blocked");
    return {
      tableIndex,
      rows: [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row, rowIndex) => ({
        rowIndex, cells: [...row[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(cell => text(cell[2]))
      }))
    };
  });
}

function financialTable(tables, title, periodLabel, balance = false) {
  const matches = tables.filter(table => table.rows.some(row => row.cells[0]?.toLowerCase() === title.toLowerCase()));
  if (matches.length !== 1) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", `Expected one ${title} table`, "blocked");
  const table = matches[0];
  if (!balance && !table.rows.some(row => row.cells.includes(periodLabel))) throw new AcquisitionError("SOURCE_PERIOD_MISMATCH", "Financial disclosure period does not match the registered H1 2026 profile", "blocked");
  const header = table.rows.find(row => row.cells.includes("2026") && row.cells.includes("2025"));
  const column = header?.cells.indexOf("2026");
  if (column == null || column < 1 || header.cells.filter(cell => cell === "2026").length !== 1 || !table.rows.some(row => row.cells[column] === "USD'000")) throw new AcquisitionError("SOURCE_UNIT_MISMATCH", "Financial table must bind a unique 2026 column to explicit USD'000 units", "blocked");
  if (balance && !table.rows.some(row => row.cells[column] === "June 30,")) throw new AcquisitionError("SOURCE_PERIOD_MISMATCH", "Balance-sheet date is not June 30, 2026", "blocked");
  return { ...table, column };
}

function tableNumber(table, label) {
  const rows = table.rows.filter(row => row.cells[0]?.toLowerCase() === label.toLowerCase());
  if (rows.length !== 1) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", `Expected one financial row labeled ${label}`, "blocked");
  const row = rows[0], raw = row.cells[table.column];
  // Whole accounting numbers only. A per-share decimal, product price, or free-text amount cannot enter this path.
  if (!/^\(?\d{1,3}(?:,\d{3})*\)?$|^\(?\d+\)?$/.test(raw || "") || raw.startsWith("(") !== raw.endsWith(")")) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", `Financial row ${label} has an unexpected amount`, "blocked");
  const number = Number(raw.replace(/[(),]/g, "")) * (raw.startsWith("(") ? -1 : 1) * 1000;
  if (!Number.isSafeInteger(number)) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", `Financial row ${label} exceeds safe numeric precision`, "blocked");
  return { value: number, locator: `table[${table.tableIndex}]/row[${row.rowIndex}]/cell[${table.column}]`, raw };
}

async function minimax(context) {
  const source = await readSource(MINIMAX_H1_2026_URL, "issuer_disclosure", context);
  const tables = parseTables(source.body);
  // Exact issuer + reporting-period guards prevent a URL returning another page from becoming financial evidence.
  const visible = decodeHtml(source.body.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
  if (!visible.includes("MiniMax Group Inc.") || !visible.includes("HKEX: 00100") || !visible.includes("MiniMax Announces First Half 2026 Financial Results")) throw new AcquisitionError("ENTITY_MISMATCH", "Disclosure does not identify the registered MiniMax issuer and H1 2026 release", "blocked");
  const income = financialTable(tables, "INTERIM CONDENSED CONSOLIDATED INCOME STATEMENT", "For the six months ended June 30, 2026");
  const balance = financialTable(tables, "INTERIM CONDENSED CONSOLIDATED BALANCE SHEET", "", true);
  const { entity } = context.result, profile = "minimax-h1-2026-v1";
  const duration = { start: "2026-01-01", end: "2026-06-30", kind: "duration" };
  const instant = { end: "2026-06-30", kind: "instant" };
  const specs = [
    [income, "REVENUE", "revenue", duration, false],
    [income, "Cost of sales", "cost_of_revenue", duration, true],
    [income, "Gross profit", "gross_profit", duration, false],
    [income, "LOSS FOR THE PERIOD", "net_loss", duration, false],
    [income, "Research and development expenses", "research_and_development_expense", duration, true],
    [balance, "Cash and cash equivalents", "cash_and_cash_equivalents", instant, false],
    [balance, "Total current assets", "current_assets", instant, false],
    [balance, "Total current liabilities", "current_liabilities", instant, false]
  ];
  // Validate every required row before committing observations: drift leaves a retained source and zero numeric facts.
  const observations = specs.map(([table, label, metric, period, expense]) => {
    const fact = tableNumber(table, label);
    if (expense && fact.value > 0) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", `Expected a parenthesized expense for ${label}`, "blocked");
    return observation(entity, source, metric, expense ? -fact.value : fact.value, "USD", period, "entity-total", fact.locator,
      `Issuer's unaudited consolidated disclosure; exact row ${label}, 2026 column, USD'000 multiplied by 1000${expense ? "; parenthesized expense normalized to positive cost" : ""}; not monthly AI-operation revenue or verified private operating data`, profile);
  });
  const revenue = observations.find(item => item.metric === "revenue").value;
  const cost = observations.find(item => item.metric === "cost_of_revenue").value;
  const profit = observations.find(item => item.metric === "gross_profit").value;
  if (Math.abs(revenue - cost - profit) > 1000) throw new AcquisitionError("SOURCE_RECONCILIATION_FAILED", "Disclosed revenue, cost of sales and gross profit do not reconcile within the disclosed USD'000 precision", "blocked");
  context.result.observations.push(...observations);
  try {
    const adjusted = financialTable(tables, "Reconciliation of Non-IFRS Measures", "For the six months ended June 30, 2026");
    const fact = tableNumber(adjusted, "Adjusted net loss (non-IFRS measure(3))");
    const item = observation(entity, source, "adjusted_net_loss", fact.value, "USD", duration, "entity-total", fact.locator, "Issuer-disclosed adjusted net loss; share-based payments, fair-value loss on financial liabilities and listing expenses added back; not IFRS net loss or operating cash burn", profile);
    item.basis = "issuer-disclosed-non-IFRS";
    context.result.observations.push(item);
  } catch {
    context.result.warnings.push("Adjusted net loss could not be bound to the explicit non-IFRS reconciliation table; the IFRS facts remain available.");
  }
  context.result.warnings.push("MiniMax provider supports the registered H1 2026 issuer disclosure only. Six-month consolidated amounts are not converted to monthly values; product revenue, adjusted loss, cash-balance composites and per-share amounts are separate definitions.");
  context.result.warnings.push("The issuer release is unaudited and retrieved from one publisher. No independent source verification, monthly Token telemetry, repayment ledger or calibrated AI peer data was acquired.");
}

async function aave(context) {
  const source = await readSource("https://api.llama.fi/protocol/aave", "public_api", context);
  const data = readJson(source);
  if (data.name !== "Aave" || data.isParentProtocol !== true || !Array.isArray(data.tvl) || !data.tvl.length) throw new AcquisitionError("ENTITY_MISMATCH", "Analytics source does not identify the Aave parent protocol", "blocked");
  const latest = data.tvl.at(-1);
  if (!finite(latest.totalLiquidityUSD) || latest.totalLiquidityUSD < 0) throw new AcquisitionError("SOURCE_SCHEMA_DRIFT", "Protocol TVL is not a finite nonnegative number", "blocked");
  const time = safeNonnegativeInteger(latest.date, "TVL observation timestamp");
  if (time * 1000 > Date.parse(source.retrievedAt) + 300000) throw new AcquisitionError("FUTURE_OBSERVATION", "Protocol observation timestamp is unexpectedly in the future", "blocked");
  context.result.observations.push(observation(context.result.entity, source, "total_value_locked", latest.totalLiquidityUSD, "USD", { end: new Date(time * 1000).toISOString(), kind: "instant" }, "protocol-total", `/tvl/${data.tvl.length - 1}/totalLiquidityUSD`, "DefiLlama parent protocol aggregate at its supplied timestamp; provider methodology and token prices, not issuer revenue or borrower exposure; chain and borrowed components not added again", "defillama-aave-v1"));
  context.result.warnings.push("DefiLlama is an analytics provider. Aave parent protocol TVL covers versions and markets; it is not Aave Labs financial revenue, protocol solvency, net inflow, or a user's collateral health factor.");
}

/** Bounded retrieval and deterministic provider extraction. No arbitrary URL fetching, LLM, or risk scoring. */
export async function acquirePublicEvidence(target, { fetchImpl = globalThis.fetch, signal, now = () => new Date() } = {}) {
  const matchedIds = resolveTarget(target), id = matchedIds.length === 1 ? matchedIds[0] : null;
  const registered = SUPPORTED_PUBLIC_TARGETS.find(item => item.id === id);
  const result = {
    entity: registered ? { id: registered.id, name: registered.name, kind: registered.kind, status: "resolved" } : { id: null, name: (typeof target === "string" ? target : target?.name || "Unknown target").slice(0, 160), kind: "unknown", status: "unresolved", candidates: SUPPORTED_PUBLIC_TARGETS.filter(item => matchedIds.length < 2 || matchedIds.includes(item.id)).map(item => ({ ...item })) },
    sources: [], observations: [], acquisition: [], warnings: []
  };
  if (!registered) {
    result.acquisition.push({ provider: "registry", status: "unsupported", code: matchedIds.length > 1 ? "AMBIGUOUS_ENTITY" : "UNRESOLVED_ENTITY", message: matchedIds.length > 1 ? "Multiple registered entities were mentioned. Choose which entity this assessment concerns." : "No supported explicit entity mention. Provide a registered target or supply source-backed evidence; no name was guessed." });
    return result;
  }
  if (registered.id === "hkex:00100" && target && typeof target === "object" && target.period && (target.period.start !== "2026-01-01" || target.period.end !== "2026-06-30")) {
    result.acquisition.push({ provider: registered.profile, status: "unsupported", code: "UNSUPPORTED_PERIOD", message: "MiniMax public profile supports H1 2026 only; the requested period requires another disclosure" });
    return result;
  }
  const timeout = AbortSignal.timeout(MAX_ACQUISITION_MS);
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const context = { result, fetchImpl, signal: boundedSignal, now };
  try {
    await ({ "arweave:mainnet": arweave, "hkex:00100": minimax, "defillama:aave": aave })[registered.id](context);
    result.acquisition.push({ provider: registered.profile, status: "acquired", message: `${result.observations.length} observations extracted with retained source locators` });
  } catch (error) {
    const interrupted = boundedSignal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError";
    result.acquisition.push({ provider: registered.profile, status: error.status || "unavailable", code: interrupted ? "ACQUISITION_TIMEOUT" : error.code || "FETCH_FAILED", message: interrupted ? "Public acquisition stopped within its time budget; retained evidence can still be inspected" : error instanceof AcquisitionError ? error.message : "Public source could not be retrieved" });
    result.warnings.push("Public retrieval failure leaves unknowns unknown. Retained source text is not automatically accepted as canonical numeric evidence.");
  }
  return result;
}
