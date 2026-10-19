import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { acquirePublicEvidence, MINIMAX_H1_2026_URL } from "../src/public-evidence.js";

const now = () => new Date("2026-10-06T08:00:00.000Z");
const makeRow = (name, value, prior = "30,429") => `<tr><td>${name}</td><td></td><td>${value}</td><td></td><td></td><td>${prior}</td><td></td></tr>`;
const durationHeader = `<tr><td></td><td></td><td>2026</td><td></td><td></td><td>2025</td></tr><tr><td></td><td></td><td>USD&#39;000</td><td></td><td></td><td>USD'000</td></tr>`;
// Shape replayed from the real issuer's static HTML tables; all extraction binds labeled columns.
const minimaxHtml = () => `<h1>MiniMax Announces First Half 2026 Financial Results</h1><p>MiniMax Group Inc. HKEX: 00100</p>
<p>Total revenue US$116.6 million; platform revenue US$73.9 million; product price US$0.30; loss per share US$1.18.</p>
<table><tr><td>INTERIM CONDENSED CONSOLIDATED INCOME STATEMENT</td></tr><tr><td>For the six months ended June 30, 2026</td></tr>${durationHeader}
${makeRow("REVENUE", "116,573")}${makeRow("Cost of sales", "(95,760)")}${makeRow("Gross profit", "20,813")}${makeRow("LOSS FOR THE PERIOD", "(357,997)")}${makeRow("Research and development expenses", "(296,870)")}${makeRow("Basic and diluted– For loss for the period (USD)", "(1.18)")}</table>
<table><tr><td>INTERIM CONDENSED CONSOLIDATED BALANCE SHEET</td></tr><tr><td></td><td></td><td>June 30,</td><td></td><td></td><td>December 31,</td></tr>${durationHeader}
${makeRow("Cash and cash equivalents", "930,905")}${makeRow("Total current assets", "1,428,617")}${makeRow("Total current liabilities", "362,932")}</table>
<table><tr><td>Reconciliation of Non-IFRS Measures</td></tr><tr><td>For the six months ended June 30, 2026</td></tr>${durationHeader}${makeRow("Adjusted net loss (non-IFRS measure<sup>(3)</sup>)", "(293,031)")}</table>`;

function fetchReplay(entries, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, "error");
    if (options.signal.aborted) throw new DOMException("Stopped", "AbortError");
    const reply = entries[url];
    assert.ok(reply !== undefined, `Unregistered request ${url}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === "object" && reply?.response ? reply.response : new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status: 200 });
  };
}

test("issuer extraction binds total revenue, USD'000, H1 duration and signed loss independently of component and unit prices", async () => {
  const html = minimaxHtml();
  const result = await acquirePublicEvidence("MiniMax", { now, fetchImpl: fetchReplay({ [MINIMAX_H1_2026_URL]: html }) });
  assert.equal(result.entity.id, "hkex:00100");
  assert.equal(result.acquisition.at(-1).status, "acquired");
  assert.equal(result.observations.length, 9);
  const facts = Object.fromEntries(result.observations.map(item => [item.metric, item]));
  assert.equal(facts.revenue.value, 116573000);
  assert.equal(facts.cost_of_revenue.value, 95760000);
  assert.equal(facts.net_loss.value, -357997000);
  assert.equal(facts.adjusted_net_loss.value, -293031000);
  assert.equal(facts.adjusted_net_loss.basis, "issuer-disclosed-non-IFRS");
  assert.equal(facts.revenue.basis, "issuer-disclosed-IFRS");
  assert.deepEqual(facts.revenue.period, { start: "2026-01-01", end: "2026-06-30", kind: "duration" });
  assert.deepEqual(facts.current_assets.period, { end: "2026-06-30", kind: "instant" });
  assert.equal(facts.revenue.scope, "entity-total");
  assert.equal(facts.revenue.origin, "public_adapter");
  assert.equal(facts.revenue.validation, "valid");
  assert.equal(result.sources[0].contentHash, createHash("sha256").update(html).digest("hex"));
  assert.match(facts.revenue.locator, /table\[0\]\/row\[4\]\/cell\[2\]/);
  assert.equal(result.observations.some(item => ["TAI", "CCI", "operating_loss", "revenueUsd"].includes(item.metric)), false);
});

test("issuer adapter reads changed table values rather than storing a hardcoded result", async () => {
  const html = minimaxHtml().replace("116,573", "117,573").replace("20,813", "21,813");
  const result = await acquirePublicEvidence("MiniMax", { now, fetchImpl: fetchReplay({ [MINIMAX_H1_2026_URL]: html }) });
  assert.equal(result.acquisition.at(-1).status, "acquired");
  assert.equal(result.observations.find(item => item.metric === "revenue").value, 117573000);
});

for (const [name, mutate, expected] of [
  ["currency", html => html.replaceAll("USD&#39;000", "HKD'000"), "SOURCE_UNIT_MISMATCH"],
  ["period", html => html.replaceAll("For the six months ended June 30, 2026", "For the six months ended December 31, 2026"), "SOURCE_PERIOD_MISMATCH"],
  ["missing total", html => html.replace("<td>REVENUE</td>", "<td>Platform revenue</td>"), "SOURCE_SCHEMA_DRIFT"],
  ["decimal unit price in total cell", html => html.replace("116,573", "0.30"), "SOURCE_SCHEMA_DRIFT"],
  ["accounting mismatch", html => html.replace("116,573", "73,900"), "SOURCE_RECONCILIATION_FAILED"],
  ["duplicate total", html => html.replace("</table>", `${makeRow("REVENUE", "73,900")}</table>`), "SOURCE_SCHEMA_DRIFT"],
  ["wrong issuer", html => html.replace("HKEX: 00100", "HKEX: 00999"), "ENTITY_MISMATCH"]
]) test(`issuer schema drift fails closed: ${name}`, async () => {
  const result = await acquirePublicEvidence("MiniMax", { now, fetchImpl: fetchReplay({ [MINIMAX_H1_2026_URL]: mutate(minimaxHtml()) }) });
  assert.equal(result.observations.length, 0);
  assert.equal(result.sources.length, 1, "failed extraction source remains reviewable");
  assert.equal(result.acquisition.at(-1).code, expected);
});

const blockHash = "a".repeat(64);
const blockUrl = `https://arweave.net/block/hash/${blockHash}`;
const arweaveReplay = (overrides = {}) => ({
  "https://arweave.net/info": { network: "arweave.N.1", current: blockHash, height: 2015633, peers: 212 },
  [blockUrl]: { indep_hash: blockHash, height: 2015633, timestamp: 1791273035, weave_size: "391950485201142", block_size: "50331648" },
  "https://arweave.net/price/1000000": "13302035613",
  ...overrides
});

test("Arweave binds hash and height and keeps a per-upload Winston price distinct from total monetary amount", async () => {
  const calls = [];
  const result = await acquirePublicEvidence("Arweave", { now, fetchImpl: fetchReplay(arweaveReplay(), calls) });
  assert.equal(result.acquisition.at(-1).status, "acquired");
  assert.equal(result.sources.length, 3);
  const facts = Object.fromEntries(result.observations.map(item => [item.metric, item]));
  assert.equal(facts.weave_size.value, 391950485201142);
  assert.equal(facts.weave_size.unit, "bytes");
  assert.equal(facts.upload_price_per_1000000_bytes.unit, "Winston/1000000-bytes");
  assert.equal(facts.upload_price_per_1000000_bytes.basis, "gateway-unit-price");
  assert.equal(facts.upload_price_per_1000000_bytes.value, 13302035613);
  assert.equal(facts.upload_price_per_1000000_bytes.period.end, now().toISOString());
  assert.equal(facts.weave_size.locator, "/weave_size");
  assert.equal(result.observations.some(item => item.metric === "revenue" || item.metric === "network_peers"), false);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url.startsWith("https://arweave.net/")));
});

test("Arweave rejects an inconsistent block without numeric observations", async () => {
  const replay = arweaveReplay();
  replay[blockUrl].height += 1;
  const result = await acquirePublicEvidence("Arweave", { now, fetchImpl: fetchReplay(replay) });
  assert.equal(result.acquisition.at(-1).code, "BLOCK_IDENTITY_MISMATCH");
  assert.equal(result.observations.length, 0);
});

test("Arweave never rounds unsafe integer storage facts or substitutes zero for null", async () => {
  for (const weaveSize of ["9007199254740993", null]) {
    const replay = arweaveReplay();
    replay[blockUrl].weave_size = weaveSize;
    const result = await acquirePublicEvidence("Arweave", { now, fetchImpl: fetchReplay(replay) });
    assert.equal(result.acquisition.at(-1).code, "SOURCE_SCHEMA_DRIFT");
    assert.equal(result.observations.length, 0);
  }
});

test("Arweave preserves valid block evidence if its optional quote is unavailable", async () => {
  const replay = arweaveReplay({ "https://arweave.net/price/1000000": { response: new Response("blocked", { status: 403 }) } });
  const result = await acquirePublicEvidence("Arweave", { now, fetchImpl: fetchReplay(replay) });
  assert.equal(result.observations.length, 3);
  assert.equal(result.acquisition[0].status, "blocked");
  assert.equal(result.acquisition.at(-1).status, "acquired");
});

test("Aave uses provider total TVL without adding borrowed or chain components", async () => {
  const data = { name: "Aave", isParentProtocol: true, tvl: [{ date: 1791269663, totalLiquidityUSD: 19395797317 }], currentChainTvls: { Ethereum: 100, borrowed: 200 }, mcap: 1 };
  const result = await acquirePublicEvidence("Aave", { now, fetchImpl: fetchReplay({ "https://api.llama.fi/protocol/aave": data }) });
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].metric, "total_value_locked");
  assert.equal(result.observations[0].value, 19395797317);
  assert.equal(result.observations[0].scope, "protocol-total");
  assert.equal(result.observations[0].locator, "/tvl/0/totalLiquidityUSD");
});

test("unknown or arbitrary URL targets make no external requests", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; throw new Error("Should not fetch"); };
  for (const target of ["Aave Labs", "Apple", "https://169.254.169.254/latest/meta-data", "https://arweave.net.evil.example"]) {
    const result = await acquirePublicEvidence(target, { now, fetchImpl });
    assert.equal(result.entity.status, "unresolved");
    assert.equal(result.acquisition[0].code, "UNRESOLVED_ENTITY");
  }
  assert.equal(requests, 0);
});

test("unsupported MiniMax periods are not substituted with H1 figures", async () => {
  const result = await acquirePublicEvidence({ name: "MiniMax", period: { start: "2026-07-01", end: "2026-07-31" } }, { now, fetchImpl: async () => { throw new Error("Should not fetch"); } });
  assert.equal(result.acquisition[0].code, "UNSUPPORTED_PERIOD");
  assert.equal(result.observations.length, 0);
});

test("Finch natural prompts resolve explicit supported names, refusing multi-entity ambiguity", async () => {
  for (const prompt of ["请评估 Arweave 的网络风险", "Assess Arweave network"]) {
    const result = await acquirePublicEvidence(prompt, { now, fetchImpl: fetchReplay(arweaveReplay()) });
    assert.equal(result.entity.id, "arweave:mainnet");
    assert.equal(result.acquisition.at(-1).status, "acquired");
  }
  const issuer = await acquirePublicEvidence("请评估 MiniMax H1 2026", { now, fetchImpl: fetchReplay({ [MINIMAX_H1_2026_URL]: minimaxHtml() }) });
  assert.equal(issuer.entity.id, "hkex:00100");
  const ambiguous = await acquirePublicEvidence("Compare MiniMax and Arweave", { now, fetchImpl: async () => { throw new Error("Must not fetch ambiguous target"); } });
  assert.equal(ambiguous.acquisition[0].code, "AMBIGUOUS_ENTITY");
  assert.deepEqual(ambiguous.entity.candidates.map(item => item.id), ["arweave:mainnet", "hkex:00100"]);
});

test("routine HTTP block, redirect, oversize and cancellation produce inspectable acquisition outcomes", async () => {
  const blocked = await acquirePublicEvidence("MiniMax", { now, fetchImpl: fetchReplay({ [MINIMAX_H1_2026_URL]: { response: new Response("Forbidden", { status: 403 }) } }) });
  assert.equal(blocked.acquisition[0].status, "blocked");
  assert.equal(blocked.acquisition[0].code, "HTTP_403");
  const redirected = await acquirePublicEvidence("MiniMax", { now, fetchImpl: async () => ({ ok: true, status: 200, redirected: true }) });
  assert.equal(redirected.acquisition[0].code, "SOURCE_REDIRECT");
  const oversized = await acquirePublicEvidence("MiniMax", { now, fetchImpl: async () => new Response("x", { headers: { "content-length": String(17 * 1024 * 1024) } }) });
  assert.equal(oversized.acquisition[0].code, "SOURCE_TOO_LARGE");
  const canceled = await acquirePublicEvidence("MiniMax", { now, signal: AbortSignal.abort(), fetchImpl: fetchReplay({ [MINIMAX_H1_2026_URL]: minimaxHtml() }) });
  assert.equal(canceled.acquisition[0].code, "ACQUISITION_TIMEOUT");
});
