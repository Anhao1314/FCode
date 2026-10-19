import assert from "node:assert/strict";
import test from "node:test";
import { computeRiskV021 } from "../src/risk-core-v021.js";
import { getPresetV021 } from "../src/presets.js";

function realInput() {
  const input = getPresetV021("healthy");
  input.assessmentMode = "real";
  input.evidence = [];
  return input;
}

function event(overrides = {}) {
  return {
    code: "CONFIRMED_SYBIL", status: "confirmed", verification: "counterparty_confirmed",
    sourceDomain: "identity_graph", evidenceRef: "review-record-001",
    verifiedAt: "2026-09-01T00:00:00Z", verifiedBy: "independent-risk-review",
    ...overrides
  };
}

test("missing or uncorroborated tokens cannot earn perfect reconciliation", () => {
  for (const input of [{}, { revenueUsd: 100000 }, { rawTokensM: 80 }, { inputTokensM: 64, outputTokensM: 16 }]) {
    const result = computeRiskV021(input);
    assert.equal(result.tokenComponentScores.reconciliation, null);
    assert.equal(result.TAI, null);
    assert.equal(result.CCI, null);
  }
});

test("a complete bucket comparison can reconcile the raw fallback independently", () => {
  const input = getPresetV021("healthy");
  delete input.inputTokensM;
  delete input.outputTokensM;
  const result = computeRiskV021(input);
  assert.equal(result.tokenComponentScores.reconciliation, 100);
  assert.equal(result.TAI, 93.8);
  assert.equal(result.CCI, 929);
});

test("critical malformed, invalid range, and invalid window inputs suppress aggregate scores", () => {
  const cases = [
    ["repayment above 100", input => { input.repaymentRatePct = 120; }, "repayment"],
    ["negative overdue", input => { input.overdue30Pct = -50; }, "repayment"],
    ["invalid token percentage", input => { input.validRatePct = 101; }, "tokenActivity"],
    ["negative compute expense", input => { input.computeSpendUsd = -1; }, "economics"],
    ["noninteger customer count", input => { input.payingCustomers = 1.5; }, "customer"],
    ["invalid customer HHI", input => { input.customerHHI = 10001; }, "customer"],
    ["zero GPU hours", input => { input.gpuHours = 0; }, "tokenActivity"],
    ["invalid scoring window", input => { input.periodStart = "2026-01-01"; }, null],
    ["calendar rollover", input => { input.periodStart = "2026-02-30"; input.periodEnd = "2026-03-30"; }, null],
    ["invalid assessment date", input => { input.assessmentAsOf = "not-a-date"; }, null],
    ["invalid historical money", input => { input.monthlyComputeSpendUsd[0] = -1; }, "economics"],
    ["negative monthly revenue", input => { input.monthlySeries[0].revenueUsd = -1; }, "tokenActivity"],
    ["malformed history", input => { input.C = [1, "bad", 3, 4, 5, 6]; }, "continuity"]
  ];
  for (const [name, mutate, dimension] of cases) {
    const input = realInput();
    mutate(input);
    const result = computeRiskV021(input);
    assert.equal(result.TAI, null, name);
    assert.equal(result.CCI, null, name);
    assert.equal(result.riskGrade, null, name);
    assert.equal(result.tokenMeteringStatus, "not-computable", name);
    assert.equal(result.decisionStatus, "insufficient-evidence", name);
    assert(result.integrityFindings.some(item => item.severity === "critical"), name);
    if (dimension) assert.equal(result.dimensionScores[dimension], null, name);
  }
});

test("invalid percentages do not masquerade as financial integrity signals", () => {
  const input = realInput();
  input.repaymentRatePct = -1;
  input.top5ConcentrationPct = 200;
  input.relatedPartyRevenuePct = 200;
  input.loopWashRatePct = 200;
  const result = computeRiskV021(input);
  assert.equal(result.integritySignals.length, 0);
  assert.equal(result.vetoApplied, false);
});

test("real hard events reject missing, malformed, future, and ineligible attestations", () => {
  const cases = [
    { verification: "self_reported" }, { verification: "uploaded_document" }, { verification: "simulation" },
    { verification: "invented" }, { verifiedAt: "not-a-date" }, { verifiedAt: "2026-02-30" },
    { verifiedAt: "2026-09-10T00:00:00Z" }, { verifiedAt: "" }, { verifiedBy: " " },
    { evidenceRef: " " }, { sourceDomain: "self_report" }
  ];
  for (const overrides of cases) {
    const input = realInput();
    input.integrityEvents = [event(overrides)];
    const result = computeRiskV021(input);
    assert.equal(result.vetoApplied, false, JSON.stringify(overrides));
    assert.equal(result.confirmedIntegrityEvents.length, 0);
    assert(result.integritySignals.some(item => item.code === "UNVERIFIED_HARD_EVENT"));
  }
});

test("eligible dated attestation retains hard-event veto semantics", () => {
  for (const verification of ["counterparty_confirmed", "system_api", "cryptographic", "cross_verified"]) {
    const input = realInput();
    input.integrityEvents = [event({ verification })];
    const result = computeRiskV021(input);
    assert.equal(result.vetoApplied, true);
    assert.equal(result.riskGrade, "D");
    assert.equal(result.decisionStatus, "reject-confirmed-integrity");
    assert.deepEqual(result.confirmedIntegrityEvents[0].evidenceRefs, ["review-record-001"]);
  }
});

test("existing deterministic simulation golden results remain unchanged", () => {
  const expected = { healthy: [93.8, 929, "A", false], watch: [82, 741, "B", false], sybil: [28.9, 193, "D", true] };
  for (const [name, golden] of Object.entries(expected)) {
    const result = computeRiskV021(getPresetV021(name));
    assert.deepEqual([result.TAI, result.CCI, result.riskGrade, result.vetoApplied], golden);
    assert.equal(result.decisionStatus, "simulation-only");
  }
});
