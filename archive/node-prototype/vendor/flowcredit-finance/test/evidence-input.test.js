import assert from "node:assert/strict";
import test from "node:test";
import { parseEvidenceInput, safeTextDraft } from "../src/evidence-input.js";
import { extractNaturalLanguageDraft } from "../src/nl-draft-v01.js";

// Original evidence: Victor's 2026-10-06 feedback email, subject
// "FlowCredit on Finch: most input fields are not parsed (3 test invocations)".
// Original request/response bodies were not attached. These are report-derived
// reconstructions; assertion success is not an exact replay of the original calls.
export const VICTOR_CASE_PROVENANCE = Object.freeze({
  sourceType: "original-user-failure-report",
  reportDate: "2026-10-06",
  originalPayloadAvailable: false,
  payloadType: "report-derived-reconstruction",
  invocationIds: ["f1935db9-fd14-4e86-ad75-b3c176803f86", "4acae46d-b53d-42aa-81d4-89d14d905fc5", "782f6135-3eda-4967-a60f-fccdc25a759f"]
});

const rich = () => ({
  label: "MiniMax functional test reconstruction", taskType: "inference", gpuModel: "H100", gpuHours: 4200,
  revenueUsd: 116600000, computeSpendUsd: 289000000, periodStart: "2026-01-01", periodEnd: "2026-06-30",
  inputTokensM: 12, outputTokensM: 8, validRatePct: 95, repaymentRatePct: 96, overdue30Pct: 2,
  payingCustomers: 168, top5ConcentrationPct: 36, operatingHistoryDays: 800, dataCoveragePct: 100,
  R: [10, 11, 12, 13, 14, 15], C: [9, 10, 11, 12, 13, 14],
  monthlySeries: [{ period: "2026-01", rawTokensM: 20, validRatePct: 95, revenueUsd: 100000, computeSpendUsd: 50000 }],
  evidence: [{ field: "revenueUsd", sourceDomain: "self_report", verification: "self_reported", reference: "User functional test; values include rough estimates", note: "Not verified financial data" }]
});

test("Victor case 3 reconstruction: pure JSON retains every supplied fact and its original type", () => {
  const original = rich();
  const prompt = JSON.stringify(original);
  assert.deepEqual(Object.keys(extractNaturalLanguageDraft(prompt).draft), ["taskType", "gpuModel", "revenueUsd"]);
  const parsed = parseEvidenceInput(prompt);
  assert.equal(parsed.kind, "structured");
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.raw, original);
  assert.deepEqual(parsed.draft, original);
  assert.equal(parsed.draft.computeSpendUsd, 289000000);
  assert.equal(parsed.draft.gpuHours, 4200);
  assert.equal(parsed.draft.monthlySeries.length, 1);
  assert.deepEqual(parsed.draft.evidence, original.evidence);
});

test("fenced and balanced embedded JSON never reparse surrounding monetary prose", () => {
  const value = { label: 'A {quoted} name with \\"escaped\\" text', gpuHours: 12, revenueUsd: 100, computeSpendUsd: 50 };
  for (const prompt of [JSON.stringify(value), `Assess this:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, `old revenue $999999. Use ${JSON.stringify(value)} with compute spend $0.`]) {
    const parsed = parseEvidenceInput(prompt);
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.draft, value);
  }
});

test("flat and grouped input merge without losing flat facts; contradictions fail closed", () => {
  const parsed = parseEvidenceInput(JSON.stringify({ label: "Operator", revenueUsd: 100, computeBusiness: { gpuHours: 20, computeSpendUsd: 50 }, scope: { periodStart: "2026-09-01" } }));
  assert.deepEqual(parsed.draft, { label: "Operator", revenueUsd: 100, periodStart: "2026-09-01", gpuHours: 20, computeSpendUsd: 50 });
  assert.equal(parsed.sourcePaths.gpuHours, "computeBusiness.gpuHours");
  assert.equal(parseEvidenceInput('{"revenueUsd":100,"computeBusiness":{"revenueUsd":99}}').error.code, "STRUCTURED_INPUT_CONFLICT");
  assert.equal(parseEvidenceInput('{"draft":{"revenueUsd":100},"revenueUsd":99}').valid, false);
  assert.equal(parseEvidenceInput('{"computeBusiness":12}').valid, false);
});

test("draft wrappers keep raw unknown/results but exclude them from facts", () => {
  const raw = { apiVersion: "flowcredit.api/v1", draftId: "old-draft", draft: { gpuHours: 20, revenueUsd: 100, CCI: 999, unknownClaim: 7, tokenActivity: { inputTokensM: 1, riskGrade: "A" } }, unknownWrapper: true };
  const parsed = parseEvidenceInput(JSON.stringify(raw));
  assert.deepEqual(parsed.raw, raw);
  assert.deepEqual(parsed.draft, { gpuHours: 20, revenueUsd: 100, inputTokensM: 1 });
  assert.deepEqual(parsed.ignoredInputs, ["draft.CCI", "draft.tokenActivity.riskGrade", "draft.unknownClaim", "unknownWrapper"]);
  assert.equal(parseEvidenceInput('{"draft":[]}').valid, false);
});

test("invalid, multiple and duplicate JSON cannot fall back to monetary guessing", () => {
  for (const prompt of ['{"revenueUsd":100,}', '{"revenueUsd":100', 'JSON: invalid revenue $100', '```json\n{"revenueUsd":100}', '[{"revenueUsd":100}]', '{"revenueUsd":100} {"revenueUsd":99}', '{"revenueUsd":100,"revenueUsd":99}', '{"scope":{"label":"A","label":"B"}}']) {
    const parsed = parseEvidenceInput(prompt);
    assert.equal(parsed.valid, false, prompt);
    assert.equal(parsed.kind, "structured", prompt);
    assert.equal(parsed.draft, undefined, prompt);
  }
});

test("JSON duplicates are checked within each object, with escaped keys and strings", () => {
  assert.equal(parseEvidenceInput('{"label":"a,b", "revenueUsd":10,"evidence":[{"field":"revenueUsd"},{"field":"computeSpendUsd"}]}').valid, true);
  assert.equal(parseEvidenceInput('{"revenueUsd":10,"revenue\\u0055sd":20}').valid, false);
});

test("chat continuation controls remain in raw while draft facts are extracted deterministically", () => {
  const raw = { assessmentId: `ea-${"a".repeat(64)}`, expectedRevision: 1, draft: { overdue30Pct: 2 }, evidenceLabel: "Collections export" };
  const parsed = parseEvidenceInput(JSON.stringify(raw));
  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.raw, raw);
  assert.deepEqual(parsed.draft, { overdue30Pct: 2 });
  assert.deepEqual(parsed.ignoredInputs, []);
});

test("Victor case 2 reconstruction reproduces old wrong values and withholds unsafe totals", () => {
  const prompt = "MiniMax inference using H100 GPU 4200 hours. compute spend ~US$2.2 per GPU-hour; total compute spend US$289M. API revenue US$59M; total revenue US$116.6M.";
  const old = extractNaturalLanguageDraft(prompt).draft;
  assert.equal(old.computeSpendUsd, 2);
  assert.equal(old.revenueUsd, 59000000);
  const parsed = parseEvidenceInput(prompt);
  assert.equal(parsed.kind, "text");
  assert.equal(parsed.draft.revenueUsd, undefined);
  assert.equal(parsed.draft.computeSpendUsd, undefined);
  assert.equal(parsed.draft.gpuHours, 4200);
  assert.ok(parsed.withheldFields.find(item => item.field === "computeSpendUsd").reasons.includes("unit-price"));
  assert.ok(parsed.withheldFields.find(item => item.field === "revenueUsd").reasons.includes("component-total-ambiguity"));
});

test("Victor case 1 reconstruction keeps Arweave metrics out of inference facts", () => {
  const parsed = parseEvidenceInput("Assess Arweave using public on-chain metrics: transactions, storage capacity and active addresses.");
  assert.deepEqual(parsed.draft, {});
  assert.equal(VICTOR_CASE_PROVENANCE.originalPayloadAvailable, false);
});

test("conservative monetary text preserves explicit USD totals without rounding decimals", () => {
  assert.deepEqual(safeTextDraft("monthly revenue $100k, compute spend $58k").draft, { revenueUsd: 100000, computeSpendUsd: 58000 });
  assert.equal(safeTextDraft("revenueUsd: 2.2").draft.revenueUsd, 2.2);
  assert.equal(safeTextDraft("revenue $116.6 million").draft.revenueUsd, 116600000);
  assert.equal(safeTextDraft("月收入 10 万美元，算力支出 5.8 万美元").draft.computeSpendUsd, 58000);
});

test("non-USD, unit prices, estimates, negative values and competing amounts are quarantined", () => {
  for (const prompt of ["monthly revenue 100000 CNY", "月收入人民币 10 万元", "revenue -100000 USD", "revenue - $100", "revenue − 100 USD", "revenue (US$100)", "revenue $10 per user", "API revenue $59M", "revenue $10; revenue $20", "monthly revenue approximately $100k", "revenueUsd: 1e6", "revenue $1 crore", "revenue $1,2,3"]) {
    const parsed = safeTextDraft(prompt);
    assert.equal(parsed.draft.revenueUsd, undefined, prompt);
    assert.ok(parsed.withheldFields.some(item => item.field === "revenueUsd"), prompt);
  }
  assert.equal(safeTextDraft("compute cost $2.2 per GPU-hour").draft.computeSpendUsd, undefined);
  assert.equal(safeTextDraft("GPU hours -4200").draft.gpuHours, undefined);
  assert.equal(safeTextDraft("repayment rate -2%").draft.repaymentRatePct, undefined);
});

test("structured negative values and estimates are retained for authoritative downstream validation", () => {
  const parsed = parseEvidenceInput('{"revenueUsd":-10,"evidence":[{"field":"revenueUsd","estimated":true}],"gpuHours":"4200","TAI":100}');
  assert.equal(parsed.draft.revenueUsd, -10);
  assert.equal(parsed.draft.gpuHours, "4200");
  assert.equal(parsed.draft.evidence[0].estimated, true);
  assert.equal(parsed.draft.TAI, undefined);
  assert.deepEqual(parsed.ignoredInputs, ["TAI"]);
});
