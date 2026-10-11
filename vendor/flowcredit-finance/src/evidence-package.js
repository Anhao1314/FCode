import { createHash } from "node:crypto";
import { INTAKE_SCHEMA_V03, canonicalGpu, validateDraftV03 } from "./intake-v03.js";
import { normalizeEvidenceV021 } from "./normalize-v021.js";
import { computeRiskV021 } from "./risk-core-v021.js";
import { evaluateFactAuthority, AUTHORITY_POLICY_VERSION } from "./evidence-authority.js";

export const EVIDENCE_VERSION = "flowcredit.evidence-assessment/v1";
export const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const digest = value => createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
const groups = ["scope", "tokenActivity", "computeBusiness", "creditProfile", "historyCrossCheck"];
const known = new Set([...Object.keys(INTAKE_SCHEMA_V03.fields), "taskType", "loopWashRatePct", "currentExposure", "monthlyRevenueUsd", "monthlyComputeSpendUsd"]);
const metadata = new Set(["label", "subjectId", "address", "assessmentAsOf", "evidence", "integrityEvents"]);
const forbidden = new Set(["TAI", "tai", "CCI", "cci", "riskGrade", "grade", "PD_pct", "decisionStatus", "recommendedLimit", "expectedLoss", "modelWeight", "taskWeight", "normalizationProfileId", "peerProfileId", "assessmentMode", "normalizedTokensM"]);
const pointer = key => String(key).replaceAll("~", "~0").replaceAll("/", "~1");

export function packageError(message, code = "INVALID_EVIDENCE", status = 400) {
  return Object.assign(new Error(message), { code, status });
}

// Preserve every submitted key in the source. Only explicitly defined, strictly typed
// facts may cross the calculation boundary; no numeric strings or unit guessing.
export function makeUserEvidence(raw, { entityId, now, label = "User-supplied records", defaultPeriod = null, origin = "user_structured", assessmentId = null, revision = 1 }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw packageError("Evidence must be a JSON object.");
  const draft = raw.draft && typeof raw.draft === "object" && !Array.isArray(raw.draft) ? raw.draft : raw;
  const prefix = draft === raw ? "" : "/draft";
  const entries = Object.entries(draft).filter(([key]) => !groups.includes(key)).map(([key, value]) => [key, value, `${prefix}/${pointer(key)}`]);
  for (const group of groups) {
    if (draft[group] != null && (typeof draft[group] !== "object" || Array.isArray(draft[group]))) throw packageError(`${group} must be an object.`);
    for (const [key, value] of Object.entries(draft[group] || {})) entries.push([key, value, `${prefix}/${group}/${pointer(key)}`]);
  }
  const time = now();
  const content = JSON.stringify(raw);
  const values = Object.fromEntries(entries.map(([key, value]) => [key, value]));
  for (const [field] of entries) {
    const duplicates = entries.filter(([key]) => key === field);
    if (new Set(duplicates.map(([, value]) => stable(value))).size > 1) throw packageError(`Conflicting structured values for '${field}'.`, "STRUCTURED_INPUT_CONFLICT");
  }
  const period = { kind: "duration", start: values.periodStart ?? defaultPeriod?.start ?? null, end: values.periodEnd ?? defaultPeriod?.end ?? null };
  const source = { id: `src-${digest({ content, label, origin, entityId, period, assessmentId, revision }).slice(0, 24)}`, kind: origin, title: label.slice(0, 200), retrievedAt: time, contentHash: digest(content), contentType: "application/json", verification: origin === "model_proposal" ? "unverified-proposal" : "user-declared", body: content, binding: { assessmentId, revision, entityId, period } };
  const estimatedFields = new Set(entries.filter(([key]) => key === "estimatedFields").flatMap(([, value]) => Array.isArray(value) ? value : []));
  const invalidBindings = new Set();
  for (const item of Array.isArray(values.evidence) ? values.evidence : []) {
    if (!item || typeof item !== "object") continue;
    for (const field of [...(Array.isArray(item.fields) ? item.fields : []), ...(item.field ? [item.field] : [])]) {
      if (item.estimated === true || item.measurementStatus === "estimated") estimatedFields.add(field);
      if (item.unit !== undefined && item.unit !== (INTAKE_SCHEMA_V03.fields[field]?.unit || "declared") || item.entityId !== undefined && item.entityId !== entityId || item.period !== undefined && (item.period?.start !== period.start || item.period?.end !== period.end)) invalidBindings.add(field);
    }
  }
  const observations = [];
  const retainedUnmapped = [];
  for (const [field, value, locator] of entries) {
    if (forbidden.has(field)) throw packageError(`Computed or server-owned field '${field}' cannot be supplied as evidence.`);
    if (!known.has(field) || metadata.has(field)) { retainedUnmapped.push(locator); continue; }
    const specification = INTAKE_SCHEMA_V03.fields[field];
    let valid = true;
    if (specification?.type === "number" || specification?.type === "integer" || ["loopWashRatePct", "currentExposure"].includes(field)) {
      valid = typeof value === "number" && Number.isFinite(value) && value >= (specification?.min ?? 0) && value <= (specification?.max ?? Number.MAX_SAFE_INTEGER);
      if (specification?.type === "integer") valid &&= Number.isInteger(value);
    } else if (["number_array", "array"].includes(specification?.type) || ["monthlyRevenueUsd", "monthlyComputeSpendUsd"].includes(field)) {
      valid = Array.isArray(value) && value.length > 0;
      if (specification?.type === "number_array" || ["monthlyRevenueUsd", "monthlyComputeSpendUsd"].includes(field)) valid &&= value.every(item => typeof item === "number" && Number.isFinite(item) && item >= 0);
    } else if (specification?.type === "date") {
      valid = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    } else if (specification?.type === "object") valid = value && typeof value === "object" && !Array.isArray(value);
    else valid = typeof value === "string" && value.length > 0;
    if (field === "tokenBucketsM" && valid) valid = Object.entries(value).every(([key, amount]) => ["valid", "idle", "duplicate", "pulse", "unclassified"].includes(key) && typeof amount === "number" && Number.isFinite(amount) && amount >= 0);
    if (field === "monthlySeries" && valid) valid = value.every(row => row && typeof row === "object" && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.period) && ["rawTokensM", "validRatePct", "revenueUsd", "computeSpendUsd"].every(key => typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0) && row.validRatePct <= 100);
    if (field === "monthlySeries" && valid) {
      const last = value.at(-1);
      valid = typeof period.end === "string" && last.period === period.end.slice(0, 7) && value.every(row => row.period <= period.end.slice(0, 7));
      for (const key of ["revenueUsd", "computeSpendUsd", "rawTokensM", "validRatePct"]) if (typeof values[key] === "number" && last[key] !== values[key]) valid = false;
    }
    if (specification?.type === "enum" && valid) valid = (INTAKE_SCHEMA_V03.enums[specification.enum] || []).includes(field === "gpuModel" ? canonicalGpu(value) : value);
    if (field === "taskType" && valid) valid = value === "inference";
    if (invalidBindings.has(field)) valid = false;
    const canonicalValue = field === "gpuModel" && valid ? canonicalGpu(value) : value;
    const estimated = estimatedFields.has(field);
    observations.push({ id: `obs-${digest({ sourceId: source.id, locator }).slice(0, 24)}`, metric: field, value: canonicalValue, unit: specification?.unit || "declared", period, scope: "ai-operation", basis: "user-declared-operation", entityId, sourceId: source.id, locator, origin, validation: !valid ? "invalid" : estimated ? "estimated" : "valid" });
  }
  return { sources: [source], observations, retainedUnmapped, warnings: (draft.evidence || draft.integrityEvents) ? ["Submitted verification labels and integrity confirmations are retained in the source, but do not become independent attestations."] : [] };
}

function factKey(observation) {
  return stable([observation.entityId, observation.metric, observation.unit, observation.period, observation.scope, observation.basis]);
}

export function canonicalFacts(record) {
  const sourceById = new Map(record.sources.map(source => [source.id, source]));
  const groupsByKey = new Map();
  for (const observation of record.observations) {
    const source = sourceById.get(observation.sourceId);
    if (!source || source.supersededBy) continue;
    const key = factKey(observation);
    if (!groupsByKey.has(key)) groupsByKey.set(key, []);
    groupsByKey.get(key).push(observation);
  }
  return [...groupsByKey.values()].map(items => {
    const eligible = items.filter(item => item.validation === "valid" && !(typeof item.value === "number" && !Number.isFinite(item.value)) && (item.origin === "user_structured" && sourceById.get(item.sourceId)?.kind === "user_structured" || item.origin === "public_adapter" && ["issuer_disclosure", "public_api"].includes(sourceById.get(item.sourceId)?.kind)));
    const unique = new Map(eligible.map(item => [stable(item.value), item.value]));
    const status = unique.size > 1 ? "disputed" : unique.size === 1 ? "supported" : items.some(item => item.validation === "invalid") ? "invalid" : items.some(item => item.validation === "estimated") ? "estimated" : "proposal";
    const first = items[0];
    return { id: `fact-${digest(factKey(first)).slice(0, 24)}`, metric: first.metric, value: status === "supported" ? [...unique.values()][0] : null, alternatives: [...unique.values()], unit: first.unit, period: first.period, scope: first.scope, basis: first.basis, entityId: first.entityId, status, observationIds: items.map(item => item.id), sourceIds: [...new Set(items.map(item => item.sourceId))], trust: eligible.some(item => item.origin === "public_adapter") ? "retrieved-public-disclosure" : "user-declared" };
  });
}

const PRIVATE_REQUESTS = [
  { id: "billing", title: "Usage and validity records", fields: ["inputTokensM", "outputTokensM", "validRatePct", "tokenBucketsM"], why: "Token activity needs metered input/output totals and validity evidence for the same month.", acceptableEvidence: "Billing export or metering records; Token totals are in millions, with mutually exclusive validity buckets.", unlocks: ["Token validity", "TAI"] },
  { id: "compute", title: "Compute use and monthly economics", fields: ["gpuModel", "gpuHours", "revenueUsd", "computeSpendUsd"], why: "Physical and commercial consistency compare the same operation and month. A per-hour price or a half-year company total cannot substitute.", acceptableEvidence: "GPU usage export, monthly operation revenue and total compute invoices in USD.", unlocks: ["Physical consistency", "Commercial consistency"] },
  { id: "collections", title: "Authenticated collections and overdue receivables", fields: ["repaymentRatePct", "overdue30Pct"], why: "A declared percentage or one paid invoice does not establish a complete due cohort, collection timing or debt more than 30 days overdue for this entity and period.", acceptableEvidence: "Authorized read-only account bound to the assessed operation; complete due-invoice cohort, collection allocations and timestamps, credit notes/refunds, currency minor units and a fixed as-of. The private-source authority policy is not implemented yet.", unlocks: ["A future qualified repayment calculation"] },
  { id: "customers", title: "Paying customers and concentration", fields: ["payingCustomers", "top5ConcentrationPct"], why: "A count of registered users or total customer revenue does not identify paying-customer concentration.", acceptableEvidence: "Distinct paying-customer count and revenue share of the largest five customers.", unlocks: ["Customer dimension"] },
  { id: "history", title: "Comparable monthly history", fields: ["monthlySeries", "operatingHistoryDays", "dataCoveragePct", "R", "C"], why: "Continuity requires six contiguous months and an independent same-unit cross-check. It cannot be inferred from one disclosure.", acceptableEvidence: "Monthly billing and compute records covering at least six contiguous months, operating history, data coverage and independently comparable activity records. This prototype cannot authenticate those cross-checks.", unlocks: ["Continuity", "TAI", "CCI"] }
];

const round = number => Math.round(number * 100) / 100;
export function assessEvidencePackage(record) {
  const facts = canonicalFacts(record);
  const observationsById = new Map(record.observations.map(item => [item.id, item]));
  const sourcesById = new Map(record.sources.map(item => [item.id, item]));
  for (const fact of facts) fact.authority = evaluateFactAuthority(record, fact, observationsById, sourcesById);
  const calculations = [];
  const publicFacts = facts.filter(fact => fact.status === "supported" && fact.authority.permissions.contextualCalculation && fact.scope !== "ai-operation" && fact.entityId === record.entity.id);
  // Ratios only join facts with identical entity, period, scope, currency and basis.
  const financialGroups = new Map();
  for (const fact of publicFacts) {
    const key = stable([fact.entityId, fact.period, fact.scope, fact.unit, fact.basis]);
    if (!financialGroups.has(key)) financialGroups.set(key, new Map());
    financialGroups.get(key).set(fact.metric, fact);
  }
  for (const fields of financialGroups.values()) {
    for (const [id, numerator, denominator, multiplier, label] of [
      ["gross-margin", "gross_profit", "revenue", 100, "Disclosed gross margin"],
      ["current-ratio", "current_assets", "current_liabilities", 1, "Disclosed current ratio"],
      ["operating-margin", "operating_profit", "revenue", 100, "Disclosed operating margin"]
    ]) {
      const left = fields.get(numerator), right = fields.get(denominator);
      if (left && right && typeof left.value === "number" && Number.isFinite(left.value) && typeof right.value === "number" && Number.isFinite(right.value) && right.value > 0 && Number.isFinite(left.value / right.value * multiplier)) calculations.push({ id: `${id}-${left.id}`, label, value: round(left.value / right.value * multiplier), unit: multiplier === 100 ? "percent" : "ratio", formula: `${numerator} / ${denominator}${multiplier === 100 ? ' * 100' : ''}`, inputs: [left.id, right.id], period: left.period, meaning: "A disclosed financial relationship, not a calibrated credit score." });
    }
    // Negative disclosed earnings are a sign check, not a model-generated risk grade.
    for (const metric of ["operating_profit", "net_profit", "net_loss", "adjusted_net_loss", "operating_cash_flow"]) {
      const fact = fields.get(metric);
      if (fact && typeof fact.value === "number") calculations.push({ id: `sign-${fact.id}`, label: metric.replaceAll("_", " "), value: fact.value, unit: fact.unit, formula: `${metric} < 0`, finding: fact.value < 0 ? "negative-disclosed-result" : "non-negative-disclosed-result", inputs: [fact.id], period: fact.period });
    }
  }
  for (const fact of publicFacts) {
    if (["block_height", "total_value_locked"].includes(fact.metric)) {
      const ageSeconds = (Date.parse(record.updatedAt) - Date.parse(fact.period.end)) / 1000;
      if (Number.isFinite(ageSeconds) && ageSeconds >= 0) calculations.push({ id: `freshness-${fact.id}`, label: "Age of public observation", value: round(ageSeconds), unit: "seconds", formula: "assessment timestamp - source observation timestamp", inputs: [fact.id], period: fact.period, meaning: "Freshness of one retrieved provider observation; not consensus verification, protocol security or solvency." });
    }
    if (fact.metric === "upload_price_per_1000000_bytes" && fact.unit === "Winston/1000000-bytes" && typeof fact.value === "number" && Number.isFinite(fact.value)) calculations.push({ id: `quote-ar-${fact.id}`, label: "Quoted upload price for 1,000,000 bytes", value: fact.value / 1e12, unit: "AR/1000000-bytes", formula: "quoted Winston / 1000000000000", inputs: [fact.id], period: fact.period, meaning: "A gateway unit-price quote. It is not USD, revenue or a period total." });
  }
  const conflicts = facts.filter(fact => fact.status === "disputed");
  const invalid = facts.filter(fact => fact.status === "invalid");
  let engine = null;
  let coreInput = null;
  let coreFactLinks = {};
  const privateFacts = facts.filter(fact => fact.scope === "ai-operation");
  const compatible = privateFacts.filter(fact => fact.authority.permissions.scenarioCalculation && fact.period.start === record.operationPeriod?.start && fact.period.end === record.operationPeriod?.end && fact.entityId === record.entity.id && fact.basis === "user-declared-operation" && fact.unit === (INTAKE_SCHEMA_V03.fields[fact.metric]?.unit || "declared"));
  // A different-basis claim can never silently win by insertion order.
  const byMetric = new Map();
  for (const fact of compatible) { if (!byMetric.has(fact.metric)) byMetric.set(fact.metric, []); byMetric.get(fact.metric).push(fact); }
  const supplied = {};
  for (const [metric, candidates] of byMetric) {
    const eligible = candidates.filter(fact => fact.status === "supported");
    if (eligible.length === candidates.length && new Set(eligible.map(fact => stable(fact.value))).size === 1) {
      supplied[metric] = eligible[0].value;
      coreFactLinks[metric] = eligible.map(fact => fact.id);
    }
  }
  const seriesConflicts = [];
  if (Array.isArray(supplied.monthlySeries)) {
    for (const [field, rowField] of [["monthlyRevenueUsd", "revenueUsd"], ["monthlyComputeSpendUsd", "computeSpendUsd"]]) {
      if (supplied[field] && stable(supplied[field]) !== stable(supplied.monthlySeries.map(row => row[rowField]))) seriesConflicts.push(field);
    }
    const last = supplied.monthlySeries.at(-1);
    if (!last || last.period !== record.operationPeriod?.end?.slice(0, 7)) seriesConflicts.push("monthlySeries");
    for (const field of ["revenueUsd", "computeSpendUsd", "rawTokensM", "validRatePct"]) if (typeof supplied[field] === "number" && supplied[field] !== last?.[field]) seriesConflicts.push(field);
  }
  if (seriesConflicts.length) for (const field of ["monthlySeries", "monthlyRevenueUsd", "monthlyComputeSpendUsd"]) { delete supplied[field]; delete coreFactLinks[field]; }
  const periodDays = record.operationPeriod ? (Date.parse(record.operationPeriod.end) - Date.parse(record.operationPeriod.start)) / 86400000 : NaN;
  const profileApplicable = record.entity.status === "resolved" && record.profile === "ai-inference" && !["network", "protocol"].includes(record.entity.kind);
  const scopeValid = profileApplicable && periodDays >= 27 && periodDays <= 31;
  const validation = scopeValid ? validateDraftV03({ ...supplied, label: record.entity.name, periodStart: record.operationPeriod.start, periodEnd: record.operationPeriod.end }) : null;
  if (validation?.valid) {
    const draft = validation.draft;
    // Preserve explicit canonical model/task classifications. The legacy sanitizer's
    // H100→flagship assumption must not overwrite structured evidence.
    draft.modelTier = supplied.modelTier ?? null;
    if (supplied.taskType) draft.taskType = supplied.taskType;
    delete draft.integrityEvents;
    // No uploaded label can elevate trust. References point back to actual stored observations.
    draft.evidence = Object.entries(coreFactLinks).flatMap(([field, ids]) => ids.map(id => ({ field, sourceDomain: "self_report", verification: "self_reported", observedAt: record.updatedAt, coveragePct: 0, evidenceRef: id })));
    draft.assessmentAsOf = record.updatedAt;
    coreInput = normalizeEvidenceV021(draft);
    engine = computeRiskV021(coreInput);
    const dependencies = { tokenActivity: ["inputTokensM", "outputTokensM", "rawTokensM", "validRatePct", "tokenBucketsM", "gpuModel", "gpuHours", "revenueUsd", "computeSpendUsd", "modelTier", "taskType", "monthlySeries"], repayment: ["repaymentRatePct", "overdue30Pct"], customer: ["payingCustomers", "top5ConcentrationPct", "customerHHI", "relatedPartyRevenuePct"], economics: ["revenueUsd", "computeSpendUsd", "monthlySeries", "monthlyRevenueUsd", "monthlyComputeSpendUsd"], continuity: ["operatingHistoryDays", "dataCoveragePct", "R", "C"] };
    for (const [dimension, value] of Object.entries(engine.dimensionScores)) if (value !== null) calculations.push({ id: `scenario-${dimension}`, label: `${dimension} (declaration scenario)`, value, unit: "score", formula: `flowcredit.risk_result/v0.2.1.dimensionScores.${dimension}`, inputs: dependencies[dimension].flatMap(field => coreFactLinks[field] || []), period: { kind: "duration", ...record.operationPeriod }, authority: "scenario-only", riskEligible: false, meaning: "A hypothetical calculation from user declarations. It cannot authorize risk scores, grades, signals or integrity Veto." });
  }
  const gapRequests = [];
  if (record.profile === "ai-inference") {
    if (!profileApplicable) gapRequests.push({ id: "wrong-profile", title: "Choose a risk scope appropriate to this target", fields: [], why: "A network or protocol is not an AI inference operation. Its public metrics cannot supply the Token credit screen.", acceptableEvidence: "A contract or exposure-specific question, or a separate assessment of the actual inference business.", unlocks: ["An applicable risk assessment"] });
    if (!("modelTier" in supplied)) gapRequests.push({ id: "model-reference", title: "Identify the actual model classification", fields: ["modelTier"], why: "GPU hardware does not identify the inference model class. Missing classifications cannot inherit a flagship weight.", acceptableEvidence: "An explicit model classification in operating records; current reference profiles remain simulated.", unlocks: ["Reproducible Token normalization"] });
    if (!scopeValid) gapRequests.push({ id: "window", title: "Choose one operation and one month", fields: ["periodStart", "periodEnd"], why: "The Token risk screen requires a 27–31 day primary window. Half-year or annual financials stay public context.", acceptableEvidence: "Start/end dates for the same AI inference operation; no pro-rating of financial totals.", unlocks: ["Scoped risk calculation"] });
    for (const request of PRIVATE_REQUESTS) {
      const fields = request.fields.filter(field => !(field in supplied));
      if (fields.length) gapRequests.push({ ...request, fields });
    }
    gapRequests.push({ id: "private-authority", title: "Authorize a scoped private source", fields: ["repaymentRatePct", "overdue30Pct"], why: "Current sources cannot qualify any private fact for authoritative risk. Supplied JSON percentages are retained as declarations, even when a scenario can be calculated.", acceptableEvidence: "An authorized read-only billing or receivables account, entity mapping, complete due cohort, currency, period and fixed as-of. No authenticated private-source adapter is available in this version.", unlocks: ["A future qualified repayment calculation"] });
    if (engine) gapRequests.push({ id: "verification", title: "Establish source authority and independent corroboration", fields: [], why: "Retrieval and authentication alone do not establish independent truth verification. All current peer/normalization profiles are simulated; a complete input cannot establish verified credit risk.", acceptableEvidence: "Field-specific authority policies and independently calibrated reference data. Corroboration must identify genuinely independent origins; multiple endpoints from one issuer do not qualify.", unlocks: ["Evidence strength", "Production assessment readiness"] });
  } else {
    gapRequests.push({ id: "target-risk", title: "Provide the exposure or decision being assessed", fields: [], why: "Public context alone does not establish contractual exposure, repayment capacity or the security of a protocol.", acceptableEvidence: "Your contract, exposure, assessment period and relevant private records. Select AI inference operations only when that is the actual scope.", unlocks: ["A decision-specific assessment"] });
  }
  for (const conflict of conflicts) gapRequests.unshift({ id: `resolve-${conflict.id}`, title: `Resolve conflicting ${conflict.metric}`, fields: [conflict.metric], why: "Comparable evidence gives different values; this fact is withheld from calculations.", acceptableEvidence: "An explanatory correction with a reference to the superseded user submission, or independently corroborating evidence.", unlocks: ["A canonical fact"] });
  const findings = [
    ...(record.acquisition || []).filter(item => item.status !== "acquired").map(item => ({ code: item.code || "PUBLIC_SOURCE_UNAVAILABLE", message: `${item.provider}: ${item.message}`, factIds: [] })),
    ...(seriesConflicts.length ? [{ code: "CONFLICTING_MONTHLY_SERIES", message: "Explicit financial series disagree with the monthly rows; both representations are withheld.", fields: ["monthlySeries", ...seriesConflicts] }] : []),
    ...conflicts.map(fact => ({ code: "CONFLICTING_FACT", message: `Conflicting ${fact.metric} is withheld.`, factIds: [fact.id] })),
    ...invalid.map(fact => ({ code: "INVALID_FACT", message: `Invalid ${fact.metric} is retained for review and withheld.`, factIds: [fact.id] })),
    ...(validation?.errors || []).map(error => ({ code: "INVALID_OPERATION_INPUT", message: error.message, fields: [error.field] }))
  ];
  const sourceDates = record.sources.filter(source => !source.supersededBy && ["issuer_disclosure", "public_api"].includes(source.kind)).map(source => Date.parse(source.retrievedAt)).filter(Number.isFinite);
  const latestObservation = publicFacts.map(fact => Date.parse(fact.period.end)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (latestObservation && Date.parse(record.updatedAt) - latestObservation > 180 * 86400000) findings.push({ code: "OLD_PUBLIC_PERIOD", message: "The latest public observation is over 180 days old; retrieval today does not make that reporting period current.", factIds: publicFacts.map(fact => fact.id) });
  const status = record.entity.status !== "resolved" ? "needs-identity" : publicFacts.length || engine ? "partial" : "needs-evidence";
  const summary = record.entity.status !== "resolved" ? "The target could not be resolved by a supported source. Choose an exact identity or add records; no risk grade is inferred." : `${publicFacts.length} acquired public assertions retained; ${calculations.length} contextual or declaration-scenario calculations available. ${conflicts.length ? `${conflicts.length} conflicting facts withheld. ` : ""}No authenticated private evidence qualifies for authoritative TAI, CCI, risk grade or Veto.`;
  return { version: EVIDENCE_VERSION, status, summary, facts, calculations, findings, evidenceRequests: gapRequests, authorityPolicy: { version: AUTHORITY_POLICY_VERSION, authenticatedPrivateSourceAvailable: false, independentlyCorroborated: false, independentSourceCount: 0, riskEligibleFactIds: [], reason: "No controlled authenticated private-source policy is implemented. Caller labels and retrieval alone never grant risk authority." }, deterministicRisk: null, canonicalCoreInput: null, coreFactLinks: {}, scenarioAssessment: engine ? { scope: "declaration-scenario", riskEligible: false, input: coreInput, factLinks: coreFactLinks, result: engine } : null, publicEvidence: { supportedFacts: publicFacts.length, sourceCount: sourceDates.length }, TAI: null, CCI: null, riskGrade: null, vetoApplied: false, limitations: ["Source retrieval preserves assertions; it does not establish independent corroboration.", "Declaration scenarios are hypothetical and cannot authorize risk calculations, grades or Veto.", "No authenticated private evidence is available; no real private-risk calculation has changed.", "TAI/CCI formulas and simulated reference profiles remain unchanged and uncalibrated.", "Not a statutory audit or assurance opinion; not financial advice."] };
}
