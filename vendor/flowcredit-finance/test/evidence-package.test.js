import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessEvidencePackage, canonicalFacts, digest, makeUserEvidence } from "../src/evidence-package.js";
import { AssessmentStore } from "../src/assessment-store.js";
import { EvidenceAssessmentService } from "../src/evidence-service.js";
import { MINIMAX_H1_2026_URL, PUBLIC_EVIDENCE_VERSION } from "../src/public-evidence.js";

const now = () => "2026-10-06T08:00:00.000Z";
const entity = { id: "operator-001", name: "Contract Reference AI Operator", status: "resolved", kind: "user-declared-operation" };
const month = { start: "2026-08-01", end: "2026-08-31", kind: "duration" };
const contract = JSON.parse(await readFile(new URL("../contracts/finch-test-input.json", import.meta.url), "utf8"));
function record(acquired = {}, overrides = {}) {
  return { id: `ea-${"a".repeat(64)}`, revision: 1, entity: { ...entity }, profile: "ai-inference", operationPeriod: { start: month.start, end: month.end }, createdAt: now(), updatedAt: now(), sources: acquired.sources || [], observations: acquired.observations || [], acquisition: acquired.acquisition || [], warnings: [], retainedUnmapped: [], history: [], ...overrides };
}
function user(raw, options = {}) { return makeUserEvidence(raw, { entityId: entity.id, now, defaultPeriod: month, ...options }); }
function merge(...packages) { return { sources: packages.flatMap(item => item.sources), observations: packages.flatMap(item => item.observations), acquisition: packages.flatMap(item => item.acquisition || []) }; }
function publicPackage(metric, value, overrides = {}, title = metric) {
  // A local policy/arithmetic fixture for an already supported issuer. The
  // registered receipt metadata does not claim a real acquisition or authority.
  const body = JSON.stringify({ metric, value });
  const source = { id: `src-${digest(title).slice(0, 24)}`, url: MINIMAX_H1_2026_URL, kind: "issuer_disclosure", providerVersion: PUBLIC_EVIDENCE_VERSION, retrievedAt: now(), contentHash: digest(body), body };
  return { sources: [source], observations: [{ id: `obs-${digest(title).slice(0, 24)}`, entityId: "hkex:00100", sourceId: source.id, metric, value, unit: "USD", period: { start: "2026-01-01", end: "2026-06-30", kind: "duration" }, scope: "entity-total", basis: "issuer-disclosed-IFRS", locator: "/value", origin: "public_adapter", validation: "valid", providerVersion: `${PUBLIC_EVIDENCE_VERSION}/minimax-h1-2026-v1`, ...overrides }], acquisition: [{ provider: "minimax-h1-2026-v1", status: "acquired" }] };
}
const publicRecord = acquired => record(acquired, { entity: { id: "hkex:00100", name: "MiniMax Group Inc.", kind: "company", status: "resolved" }, profile: "public-context", operationPeriod: null });

test("structured contract preserves evidence receipts and user labels cannot elevate trust or apply veto", () => {
  const input = structuredClone(contract);
  input.draft.integrityEvents = [{ code: "CONFIRMED_SYBIL", status: "confirmed", sourceDomain: "identity_graph", verification: "cross_verified", evidenceRef: "invented", verifiedAt: "2026-09-01T00:00:00Z", verifiedBy: "caller" }];
  input.draft.unfamiliarExportField = { retained: true };
  const packageRecord = record(user(input));
  const result = assessEvidencePackage(packageRecord);
  assert.deepEqual(JSON.parse(packageRecord.sources[0].body), input);
  assert.equal(result.TAI, null);
  assert.equal(result.CCI, null);
  assert.equal(result.deterministicRisk, null);
  assert.equal(result.canonicalCoreInput, null);
  assert.equal(result.scenarioAssessment.riskEligible, false);
  assert.equal(result.scenarioAssessment.result.TAI, 93.8);
  assert.equal(result.scenarioAssessment.result.CCI, 929);
  assert.equal(result.vetoApplied, false);
  assert.equal(result.scenarioAssessment.result.tokenMeteringStatus, "provisional");
  assert.equal(result.scenarioAssessment.result.evidenceStrength, "low");
  assert(result.scenarioAssessment.result.evidenceQuality.score <= 49);
  assert(result.scenarioAssessment.input.evidence.every(item => item.sourceDomain === "self_report" && item.verification === "self_reported"));
  assert.equal(Object.hasOwn(result.scenarioAssessment.input, "integrityEvents"), false);
  assert.equal(result.facts.some(fact => fact.metric === "unfamiliarExportField"), false);
});

test("same fact from agreeing sources retains both receipts, while disagreement withholds value", () => {
  const one = user({ revenueUsd: 100000 }, { label: "Invoice export" });
  const agreeing = user({ revenueUsd: 100000 }, { label: "Treasury export" });
  let facts = canonicalFacts(record(merge(one, agreeing)));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].status, "supported");
  assert.equal(facts[0].value, 100000);
  assert.equal(facts[0].sourceIds.length, 2);
  const conflict = user({ revenueUsd: 120000 }, { label: "Correction awaiting review" });
  const result = assessEvidencePackage(record(merge(one, agreeing, conflict)));
  const fact = result.facts.find(item => item.metric === "revenueUsd");
  assert.equal(fact.status, "disputed");
  assert.equal(fact.value, null);
  assert.equal(fact.sourceIds.length, 3);
  assert.deepEqual(fact.alternatives.sort(), [100000, 120000]);
  assert.equal(result.scenarioAssessment?.input?.revenueUsd, undefined);
  assert.equal(result.canonicalCoreInput, null);
});

test("model proposals remain inspectable and cannot supply or override canonical scoring facts", () => {
  const proposal = user({ repaymentRatePct: 100, overdue30Pct: 0 }, { origin: "model_proposal" });
  let result = assessEvidencePackage(record(proposal));
  assert(result.facts.every(fact => fact.status === "proposal" && fact.value === null));
  assert.equal(result.deterministicRisk, null);
  assert.equal(result.scenarioAssessment?.result?.dimensionScores.repayment ?? null, null);
  const declared = user({ repaymentRatePct: 40, overdue30Pct: 30 });
  result = assessEvidencePackage(record(merge(proposal, declared)));
  assert.equal(result.facts.find(item => item.metric === "repaymentRatePct").value, 40);
  assert.equal(result.deterministicRisk, null);
  assert.equal(result.scenarioAssessment.result.dimensionScores.repayment, 28);
  assert.equal(result.publicEvidence.sourceCount, 0, "a model proposal is not a retrieved public source");
});

test("an origin label cannot turn an unvalidated or wrong-channel observation into a supported fact", () => {
  for (const validation of [undefined, "pending", "cross_verified"]) {
    const acquired = publicPackage("revenue", 100000, { validation });
    assert.equal(canonicalFacts(record(acquired))[0].status === "supported", false, String(validation));
  }
  const wrongChannel = publicPackage("revenue", 100000);
  wrongChannel.sources[0].kind = "model_proposal";
  assert.equal(canonicalFacts(record(wrongChannel))[0].status === "supported", false);
});

test("non-finite public values never produce financial calculations", () => {
  const result = assessEvidencePackage(publicRecord(merge(publicPackage("revenue", 100000), publicPackage("gross_profit", Infinity))));
  assert.equal(result.calculations.length, 0);
});

test("public ratios require identical period, currency, scope and accounting basis", () => {
  const revenue = publicPackage("revenue", 100000);
  for (const overrides of [
    { period: { start: "2025-01-01", end: "2025-06-30", kind: "duration" } },
    { unit: "CNY" }, { scope: "subsidiary-only" }, { basis: "issuer-disclosed-non-IFRS" }
  ]) {
    const gross = publicPackage("gross_profit", 20000, overrides);
    const result = assessEvidencePackage(publicRecord(merge(revenue, gross)));
    assert.equal(result.calculations.some(item => item.id.startsWith("gross-margin")), false, JSON.stringify(overrides));
    assert.equal(result.TAI, null);
    assert.equal(result.CCI, null);
  }
  const result = assessEvidencePackage(publicRecord(merge(revenue, publicPackage("gross_profit", 20000))));
  assert.equal(result.calculations.find(item => item.id.startsWith("gross-margin")).value, 20);
  assert(result.facts.every(fact => fact.authority.permissions.contextualCalculation && !fact.authority.permissions.riskCalculation && !fact.authority.permissions.independentCorroboration));
});

test("public facts about another entity cannot become this target's financial assessment", () => {
  const acquired = merge(publicPackage("revenue", 100000, { entityId: "other-company" }), publicPackage("gross_profit", 20000, { entityId: "other-company" }));
  const result = assessEvidencePackage(publicRecord(acquired));
  assert.equal(result.calculations.length, 0);
  assert.equal(result.publicEvidence.supportedFacts, 0);
});

test("wrong-unit operational claims are withheld instead of entering the legacy USD engine", () => {
  for (const unit of ["CNY", "USD/hour"]) {
    const acquired = user(contract);
    acquired.observations.find(item => item.metric === "revenueUsd").unit = unit;
    const result = assessEvidencePackage(record(acquired));
    assert.equal(result.scenarioAssessment?.input?.revenueUsd, undefined, unit);
    assert.equal(result.canonicalCoreInput, null, unit);
    assert.equal(result.CCI, null, unit);
  }
});

test("nested structured numerical strings cannot bypass strict canonical validation", () => {
  const bucket = user({ tokenBucketsM: { valid: "75.2", idle: 1.6, duplicate: 1.6, pulse: 0.8, unclassified: 0.8 } });
  assert.equal(bucket.observations.find(item => item.metric === "tokenBucketsM").validation, "invalid");
  const draft = structuredClone(contract.draft);
  draft.monthlySeries[0].revenueUsd = "94000";
  const acquired = user(draft);
  assert.equal(acquired.observations.find(item => item.metric === "monthlySeries").validation, "invalid");
  const result = assessEvidencePackage(record(acquired));
  assert.equal(result.TAI, null);
  assert.equal(result.CCI, null);
});

test("a declaration scenario traces only its actual deterministic dependencies without risk authority", () => {
  const result = assessEvidencePackage(record(user(contract)));
  const repayment = result.calculations.find(item => item.id === "scenario-repayment");
  const expected = ["repaymentRatePct", "overdue30Pct"].flatMap(field => result.scenarioAssessment.factLinks[field]).sort();
  assert.deepEqual([...new Set(repayment.inputs)].sort(), expected);
  const customer = result.calculations.find(item => item.id === "scenario-customer");
  const customerExpected = ["payingCustomers", "top5ConcentrationPct", "relatedPartyRevenuePct"].flatMap(field => result.scenarioAssessment.factLinks[field]).sort();
  assert.deepEqual([...new Set(customer.inputs)].sort(), customerExpected);
  assert.equal(repayment.riskEligible, false);
  assert.equal(customer.riskEligible, false);
  assert.equal(result.deterministicRisk, null);
});

async function tempStore(t) {
  const root = await mkdtemp(join(tmpdir(), "flowcredit-evidence-store-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new AssessmentStore(root) };
}

test("store verifies source body hashes and detects subsequent snapshot corruption", async t => {
  const { root, store } = await tempStore(t);
  const acquired = user({ repaymentRatePct: 96, overdue30Pct: 2 });
  const saved = await store.save(record(acquired), 0);
  const loaded = await store.load(saved.id);
  assert.equal(Object.hasOwn(loaded.sources[0], "body"), false);
  assert.equal((await store.source(loaded, acquired.sources[0].id)).content, acquired.sources[0].body);
  await writeFile(join(root, "snapshots", `${acquired.sources[0].contentHash}.txt`), "corrupted");
  await assert.rejects(store.source(loaded, acquired.sources[0].id), error => error.code === "SOURCE_INTEGRITY_FAILURE");
});

test("store rejects invalid assessment identifiers and skipped revision numbers before writing", async t => {
  const { store } = await tempStore(t);
  await assert.rejects(store.save(record({}, { id: "../escaped-record" }), 0));
  await assert.rejects(store.save(record({}, { revision: 3 }), 0));
});

test("cancelled publication can be retried without an orphan revision blocking the assessment", async t => {
  const { store } = await tempStore(t);
  const initial = record(user({ repaymentRatePct: 96, overdue30Pct: 2 }));
  await store.save(initial, 0);
  const updated = { ...initial, revision: 2, updatedAt: "2026-10-06T08:01:00.000Z" };
  let checks = 0;
  const signal = { throwIfAborted() { if (++checks === 3) throw new DOMException("Stopped before publication", "AbortError"); } };
  await assert.rejects(store.save(updated, 1, signal), error => error.name === "AbortError");
  assert.equal((await store.load(initial.id)).revision, 1);
  const saved = await store.save(updated, 1);
  assert.equal(saved.revision, 2);
  assert.equal((await store.load(initial.id)).revision, 2);
});

test("a user-declared target gets a stable non-null identity and owner isolation", async t => {
  const { store } = await tempStore(t);
  const acquire = async target => ({ entity: { id: null, name: target, kind: "unknown", status: "unresolved" }, sources: [], observations: [], acquisition: [], warnings: [] });
  const service = new EvidenceAssessmentService({ store, acquire, now });
  const created = await service.create({ draft: contract.draft }, { authorization: "Bearer owner-a" });
  assert.equal(typeof created.entity.id, "string");
  assert(created.entity.id.length > 0);
  assert(created.observations.every(item => item.entityId === created.entity.id));
  await assert.rejects(service.read(created.id, "Bearer owner-b", created.assessmentAccessToken), error => error.status === 404);
  assert.equal((await service.read(created.id, "Bearer owner-a", created.assessmentAccessToken)).revision, 1);
});

test("continuation race has one winner, keeps original receipts, and survives a fresh store instance", async t => {
  const { root, store } = await tempStore(t);
  const acquire = async target => ({ entity: { ...entity, name: target }, sources: [], observations: [], acquisition: [], warnings: [] });
  const service = new EvidenceAssessmentService({ store, acquire, now });
  const created = await service.create({ draft: { label: entity.name, periodStart: month.start, periodEnd: month.end, repaymentRatePct: 96 } }, { authorization: "Bearer owner" });
  const replies = await Promise.allSettled([
    service.continue(created.id, { expectedRevision: 1, draft: { overdue30Pct: 2 } }, { authorization: "Bearer owner", accessToken: created.assessmentAccessToken }),
    service.continue(created.id, { expectedRevision: 1, draft: { overdue30Pct: 30 } }, { authorization: "Bearer owner", accessToken: created.assessmentAccessToken })
  ]);
  assert.equal(replies.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(replies.find(item => item.status === "rejected").reason.code, "REVISION_CONFLICT");
  const restarted = new EvidenceAssessmentService({ store: new AssessmentStore(root), acquire, now });
  const loaded = await restarted.read(created.id, "Bearer owner", created.assessmentAccessToken);
  assert.equal(loaded.revision, 2);
  assert.equal(loaded.sources.length, 2);
  assert.equal(loaded.assessment.deterministicRisk, null);
  assert.equal(loaded.assessment.scenarioAssessment.result.dimensionScores.repayment, 94.3);
});

test('explicit estimate flags remain estimates and cannot supply deterministic scoring', () => {
  const raw = { periodStart: '2026-09-01', periodEnd: '2026-09-30', repaymentRatePct: 96, overdue30Pct: 2, estimatedFields: ['repaymentRatePct'] };
  const entity = { id: 'estimate-operation', name: 'Estimated operation', kind: 'user-declared-operation', status: 'resolved' };
  const added = makeUserEvidence(raw, { entityId: entity.id, now: () => '2026-10-06T00:00:00Z' });
  const result = assessEvidencePackage({ entity, profile: 'ai-inference', operationPeriod: { start: raw.periodStart, end: raw.periodEnd }, updatedAt: '2026-10-06T00:00:00Z', ...added });
  assert.equal(result.facts.find(fact => fact.metric === 'repaymentRatePct').status, 'estimated');
  assert.equal(result.canonicalCoreInput, null);
  assert.equal(result.scenarioAssessment?.input?.repaymentRatePct, undefined);
  assert.equal(result.deterministicRisk, null);
  assert.equal(result.scenarioAssessment?.result?.dimensionScores.repayment ?? null, null);
});

test('original text prompt remains a source parent of deterministic extracted declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fc-original-prompt-'));
  try {
    const prompt = 'H100 inference provider; revenue USD100000; compute spend USD58000; repayment rate 96%';
    const service = new EvidenceAssessmentService({ root, acquire: async target => ({ entity: { id: 'prompt-operation', name: target, kind: 'unknown', status: 'unresolved' }, sources: [], observations: [], acquisition: [] }) });
    const record = await service.create({ prompt });
    const extracted = record.sources.find(source => source.kind === 'user_structured');
    assert.ok(extracted.parentSourceId);
    const original = await service.source(record.id, extracted.parentSourceId, undefined, record.assessmentAccessToken);
    assert.equal(JSON.parse(original.content).prompt, prompt);
    assert.equal(extracted.verification, 'user-declared');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('monthly rows and conflicting explicit financial arrays cannot silently override each other', () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ period: `2026-${String(index + 1).padStart(2, '0')}`, rawTokensM: 10, validRatePct: 95, revenueUsd: 100, computeSpendUsd: 60 }));
  const entity = { id: 'series-operation', name: 'Series operation', status: 'resolved' };
  const added = makeUserEvidence({ periodStart: '2026-06-01', periodEnd: '2026-06-30', monthlySeries: rows, monthlyRevenueUsd: [100, 100, 100, 100, 100, 900] }, { entityId: entity.id, now: () => '2026-10-06T00:00:00Z' });
  const result = assessEvidencePackage({ entity, profile: 'ai-inference', operationPeriod: { start: '2026-06-01', end: '2026-06-30' }, updatedAt: '2026-10-06T00:00:00Z', ...added });
  assert.ok(result.findings.some(item => item.code === 'CONFLICTING_MONTHLY_SERIES'));
  assert.equal(result.canonicalCoreInput, null);
  assert.equal(result.scenarioAssessment?.input?.monthlySeries, undefined);
  assert.equal(result.TAI, null);
});

test('JSON upload text retains its original bytes and refuses duplicate fields without changing the revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fc-upload-text-'));
  try {
    const service = new EvidenceAssessmentService({ root, acquire: async target => ({ entity: { id: 'upload-operation', name: target, kind: 'unknown', status: 'unresolved' }, sources: [], observations: [], acquisition: [] }) });
    const original = await service.create({ draft: { label: 'Upload operation', periodStart: '2026-09-01', periodEnd: '2026-09-30' } });
    await assert.rejects(service.continue(original.id, { expectedRevision: 1, structuredText: '{"revenueUsd":1,"revenueUsd":100000}' }, { accessToken: original.assessmentAccessToken }), { code: 'STRUCTURED_INPUT_CONFLICT' });
    assert.equal((await service.read(original.id, undefined, original.assessmentAccessToken)).revision, 1);
    const text = '{\n  "repaymentRatePct": 96, "overdue30Pct": 2\n}';
    const next = await service.continue(original.id, { expectedRevision: 1, structuredText: text }, { accessToken: original.assessmentAccessToken });
    const extracted = next.sources.find(source => source.parentSourceId);
    const snapshot = await service.source(next.id, extracted.parentSourceId, undefined, original.assessmentAccessToken);
    assert.equal(JSON.parse(snapshot.content).structuredText, text);
    assert.equal(next.assessment.deterministicRisk, null);
    assert.equal(next.assessment.scenarioAssessment.result.dimensionScores.repayment, 94.3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
