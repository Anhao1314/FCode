import { createHash } from "node:crypto";
import { INTAKE_SCHEMA_V03 } from "./intake-v03.js";
import { MINIMAX_H1_2026_URL, PUBLIC_EVIDENCE_VERSION } from "./public-evidence.js";

export const AUTHORITY_POLICY_VERSION = "flowcredit.evidence-authority/v1";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const reason = (code, message) => ({ code, message });
const deniedPermissions = () => ({ contextualCalculation: false, scenarioCalculation: false, riskCalculation: false, independentCorroboration: false, integrityVeto: false });
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const same = (left, right) => JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
const samePeriod = (left, right) => left?.kind === right?.kind && left?.start === right?.start && left?.end === right?.end;
const nonfinite = value => typeof value === "number" ? !Number.isFinite(value) : Array.isArray(value) ? value.some(nonfinite) : value && typeof value === "object" ? Object.values(value).some(nonfinite) : false;
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, value.length === 10 ? 10 : 19) === value.slice(0, value.length === 10 ? 10 : 19);
const userMetrics = new Set([...Object.keys(INTAKE_SCHEMA_V03.fields).filter(field => !["label", "subjectId", "evidence", "integrityEvents"].includes(field)), "taskType", "loopWashRatePct", "currentExposure", "monthlyRevenueUsd", "monthlyComputeSpendUsd"]);
const publicMetrics = {
  "hkex:00100": { profile: "minimax-h1-2026-v1", kind: "issuer_disclosure", metrics: new Set(["revenue", "cost_of_revenue", "gross_profit", "net_loss", "research_and_development_expense", "cash_and_cash_equivalents", "current_assets", "current_liabilities", "adjusted_net_loss"]) },
  "arweave:mainnet": { profile: "arweave-mainnet-v1", kind: "public_api", metrics: new Set(["block_height", "weave_size", "block_size", "upload_price_per_1000000_bytes"]) },
  "defillama:aave": { profile: "defillama-aave-v1", kind: "public_api", metrics: new Set(["total_value_locked"]) }
};

function binding(record, observation, source) {
  return {
    assessmentId: record?.id ?? null, revision: record?.revision ?? null,
    entityId: observation?.entityId ?? null, metric: observation?.metric ?? null,
    unit: observation?.unit ?? null, period: structuredClone(observation?.period ?? null),
    scope: observation?.scope ?? null, basis: observation?.basis ?? null,
    sourceHash: source?.contentHash ?? null, sourceId: source?.id ?? null,
    observationIds: observation?.id ? [observation.id] : [], locator: observation?.locator ?? null
  };
}

function publicSemantics(observation, source, registry) {
  let url;
  try { url = new URL(source.url); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || url.search) return false;
  if (!registry.metrics.has(observation.metric) || source.kind !== registry.kind || source.providerVersion !== PUBLIC_EVIDENCE_VERSION || observation.providerVersion !== `${PUBLIC_EVIDENCE_VERSION}/${registry.profile}`) return false;
  if (observation.entityId === "hkex:00100") {
    const balance = ["cash_and_cash_equivalents", "current_assets", "current_liabilities"].includes(observation.metric);
    return source.url === MINIMAX_H1_2026_URL && observation.unit === "USD" && observation.scope === "entity-total"
      && observation.basis === (observation.metric === "adjusted_net_loss" ? "issuer-disclosed-non-IFRS" : "issuer-disclosed-IFRS")
      && samePeriod(observation.period, balance ? { kind: "instant", end: "2026-06-30" } : { kind: "duration", start: "2026-01-01", end: "2026-06-30" });
  }
  if (observation.entityId === "arweave:mainnet") {
    const quote = observation.metric === "upload_price_per_1000000_bytes";
    return url.hostname === "arweave.net" && (quote ? url.pathname === "/price/1000000" : /^\/block\/hash\/[A-Za-z0-9_-]{64}$/.test(url.pathname))
      && observation.scope === "network" && observation.period?.kind === "instant" && observation.period.start == null && validDate(observation.period.end)
      && observation.unit === (quote ? "Winston/1000000-bytes" : observation.metric === "block_height" ? "blocks" : "bytes")
      && observation.basis === (quote ? "gateway-unit-price" : "gateway-reported-mainnet");
  }
  return source.url === "https://api.llama.fi/protocol/aave" && observation.unit === "USD" && observation.scope === "protocol-total"
    && observation.basis === "defillama-tvl-usd" && observation.period?.kind === "instant" && observation.period.start == null && validDate(observation.period.end);
}

/**
 * This policy grants only contextual arithmetic or explicitly declared scenarios.
 * No controlled private connector, independent verifier or Veto authority is
 * implemented. A string/boolean named authenticated, verification, authority or
 * connector can never enable any of those permissions.
 */
export function evaluateObservationAuthority(record, observation, source) {
  const permissions = deniedPermissions();
  const reasons = [];
  let assertionClass = "rejected";
  const bound = binding(record, observation, source);
  const reject = (code, message) => reasons.push(reason(code, message));
  if (!observation || !source || source.id !== observation.sourceId) reject("SOURCE_BINDING_MISMATCH", "The observation must reference a source in this assessment.");
  else if (source.supersededBy) reject("SUPERSEDED_SOURCE", "An inactive source cannot qualify this observation.");
  else if (observation.entityId !== record?.entity?.id) reject("ENTITY_MISMATCH", "The observation concerns a different assessment entity.");
  else if (source.binding?.assessmentId != null && source.binding.assessmentId !== record?.id || source.binding?.entityId != null && source.binding.entityId !== observation.entityId || source.binding && Number.isInteger(record?.revision) && (!Number.isInteger(source.binding.revision) || source.binding.revision < 1 || source.binding.revision > record.revision)) reject("RECEIPT_CONTEXT_MISMATCH", "The receipt must retain its original assessment, entity and published revision context.");
  else if (!hashPattern.test(source.contentHash || "")) reject("RAW_HASH_MISSING", "The raw-record content hash is missing or malformed.");
  else if (source.body !== undefined && sha256(typeof source.body === "string" ? source.body : JSON.stringify(source.body)) !== source.contentHash) reject("RAW_HASH_MISMATCH", "The retained raw record does not match its content hash.");
  else if (typeof observation.locator !== "string" || !observation.locator.trim()) reject("RAW_LOCATOR_MISSING", "The observation must identify a location in the raw record.");
  else if (observation.origin === "model_proposal" && source.kind === "model_proposal") {
    assertionClass = "model-proposal";
    reject("MODEL_PROPOSAL_ONLY", "A model proposal remains inspectable and cannot authorize a calculation.");
  } else if (observation.validation !== "valid" || nonfinite(observation.value) || observation.value == null) reject("OBSERVATION_NOT_VALID", "Invalid, estimated or unvalidated observations do not qualify for calculations.");
  else if (observation.origin === "user_structured" && source.kind === "user_structured") {
    assertionClass = "user-declaration";
    const specification = INTAKE_SCHEMA_V03.fields[observation.metric];
    const expectedPeriod = { kind: "duration", ...record.operationPeriod };
    if (!userMetrics.has(observation.metric) || observation.scope !== "ai-operation" || observation.basis !== "user-declared-operation") reject("DECLARATION_SCOPE_MISMATCH", "This declaration does not belong to a recognized operation scenario field.");
    else if (observation.unit !== (specification?.unit || "declared")) reject("DECLARATION_UNIT_MISMATCH", "The declared unit does not match the field's explicit unit.");
    else if (!record.operationPeriod || !validDate(expectedPeriod.start) || !validDate(expectedPeriod.end) || !samePeriod(observation.period, expectedPeriod)) reject("DECLARATION_PERIOD_MISMATCH", "This declaration does not match the assessment operation period.");
    else {
      permissions.scenarioCalculation = true;
      reasons.push(reason("DECLARED_SCENARIO_ONLY", "The caller supplied this value. It may support a labeled scenario, not an authoritative risk calculation."));
    }
  } else if (observation.origin === "public_adapter" && ["issuer_disclosure", "public_api"].includes(source.kind)) {
    assertionClass = source.kind === "issuer_disclosure" ? "issuer-assertion" : "public-provider-assertion";
    const registry = publicMetrics[observation.entityId];
    const matchingAcquisition = (record.acquisition || []).some(item => item.provider === registry?.profile && item.status === "acquired");
    if (!registry || !publicSemantics(observation, source, registry)) reject("PUBLIC_PROVIDER_BINDING_MISMATCH", "The entity, endpoint, extraction profile, period, scope, basis and unit must match a registered public source.");
    else if (!matchingAcquisition || !validDate(source.retrievedAt)) reject("PUBLIC_ACQUISITION_RECEIPT_MISSING", "Registered extraction metadata and a completed acquisition receipt are required for contextual arithmetic.");
    else if (!validDate(observation.period?.end) || Date.parse(observation.period.end) > Date.parse(source.retrievedAt) + 300000 || !validDate(record.updatedAt) || Date.parse(source.retrievedAt) > Date.parse(record.updatedAt) + 300000) reject("PUBLIC_PERIOD_AFTER_ACQUISITION", "An assertion's observation period cannot postdate the acquisition receipt or assessment publication.");
    else if (typeof observation.value !== "number" || !Number.isFinite(observation.value)) reject("PUBLIC_VALUE_NOT_NUMERIC", "Only an explicitly extracted finite numeric assertion qualifies for public contextual arithmetic.");
    else {
      permissions.contextualCalculation = true;
      reasons.push(reason("ACQUIRED_ASSERTION_ONLY", "Acquisition binds the returned publisher assertion to its raw record. It does not verify the assertion's truth or independently corroborate it."));
    }
  } else reject("ORIGIN_CHANNEL_MISMATCH", "A caller-provided origin, connector or verification label cannot create a trusted acquisition channel.");
  reasons.push(reason("PRIVATE_AUTHORITY_NOT_IMPLEMENTED", "No authenticated private-source policy is implemented; risk calculation, independent corroboration and integrity Veto remain denied."));
  return { policyVersion: AUTHORITY_POLICY_VERSION, assertionClass, permissions, reasons, binding: bound, independentSourceCount: 0, riskEligible: false, vetoEligible: false, independentlyCorroborated: false };
}

function lookup(collection, id) {
  return collection instanceof Map ? collection.get(id) : Array.isArray(collection) ? collection.find(item => item.id === id) : collection?.[id];
}

export function evaluateFactAuthority(record, fact, observationsById, sourcesById) {
  const permissions = deniedPermissions();
  const decisions = (fact.observationIds || []).map(id => {
    const observation = lookup(observationsById, id);
    const source = lookup(sourcesById, observation?.sourceId);
    const authority = evaluateObservationAuthority(record, observation, source);
    const comparable = observation && observation.entityId === fact.entityId && observation.metric === fact.metric && observation.unit === fact.unit && samePeriod(observation.period, fact.period) && observation.scope === fact.scope && observation.basis === fact.basis && same(observation.value, fact.value);
    return { observationId: id, sourceId: observation?.sourceId ?? null, comparable: Boolean(comparable), ...authority };
  });
  const supported = fact.status === "supported" && fact.entityId === record.entity?.id && fact.value != null && !nonfinite(fact.value);
  const contextual = supported && decisions.some(item => item.comparable && item.permissions.contextualCalculation);
  const scenario = supported && decisions.some(item => item.comparable && item.permissions.scenarioCalculation);
  permissions.contextualCalculation = Boolean(contextual);
  permissions.scenarioCalculation = Boolean(scenario);
  // The rights of one observation never transfer to agreeing assertions from
  // another source. Shared hashes/parents remain provenance, not independence.
  const qualified = decisions.filter(item => item.comparable && (item.permissions.contextualCalculation || item.permissions.scenarioCalculation));
  const assertionClass = contextual ? qualified.find(item => item.permissions.contextualCalculation).assertionClass : scenario ? "user-declaration" : decisions.every(item => item.assertionClass === "model-proposal") && decisions.length ? "model-proposal" : "rejected";
  return {
    policyVersion: AUTHORITY_POLICY_VERSION, assertionClass, permissions,
    reasons: [reason(supported ? qualified.length ? "PER_OBSERVATION_PERMISSIONS_RETAINED" : "NO_QUALIFIED_OBSERVATION" : "FACT_NOT_SUPPORTED", supported ? qualified.length ? "This fact retains each source's actual permission; agreement never upgrades source authority." : "No observation with qualifying entity, period, unit and source bindings supports this fact." : "Disputed, invalid, estimated and proposal facts cannot qualify for calculations."), reason("PRIVATE_AUTHORITY_NOT_IMPLEMENTED", "No authenticated private-source policy is implemented; no authoritative risk or Veto calculation is permitted.")],
    binding: { assessmentId: record.id ?? null, revision: record.revision ?? null, entityId: fact.entityId, metric: fact.metric, unit: fact.unit, period: structuredClone(fact.period), scope: fact.scope, basis: fact.basis, sourceId: fact.sourceIds?.length === 1 ? fact.sourceIds[0] : null, sourceHash: fact.sourceIds?.length === 1 ? lookup(sourcesById, fact.sourceIds[0])?.contentHash ?? null : null, sourceIds: [...(fact.sourceIds || [])], sourceHashes: (fact.sourceIds || []).map(id => ({ sourceId: id, contentHash: lookup(sourcesById, id)?.contentHash ?? null })), observationIds: [...(fact.observationIds || [])] },
    observationDecisions: decisions, independentSourceCount: 0, riskEligible: false, vetoEligible: false, independentlyCorroborated: false
  };
}
