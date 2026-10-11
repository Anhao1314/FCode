import { AssessmentStore } from "./assessment-store.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalGpu } from "./intake-v03.js";
import { acquirePublicEvidence } from "./public-evidence.js";
import { parseEvidenceInput, safeTextDraft } from "./evidence-input.js";
import { EVIDENCE_VERSION, assessEvidencePackage, digest, stable, makeUserEvidence, packageError } from "./evidence-package.js";
import { replaySavedPublicSource } from "./public-source-replay.js";
import { evaluateObservationAuthority } from "./evidence-authority.js";

function response(record) {
  return { ...record, continuation: { assessmentId: record.id, expectedRevision: record.revision, read: `/api/v1/assessments/${record.id}`, addEvidence: `/api/v1/assessments/${record.id}/evidence`, refresh: `/api/v1/assessments/${record.id}/refresh`, instructions: "Use the creation access token in X-FlowCredit-Assessment-Token, or assessmentAccessToken in a Finch continuation prompt. Add dated records with expectedRevision. Conflicts are retained and withheld; a reasoned correction can supersede a prior user source." } };
}
const ownerFor = authorization => digest(String(authorization || "local-session"));
function authorize(record, authorization, accessToken) {
  const supplied = typeof accessToken === "string" && /^[a-f0-9]{64}$/.test(accessToken) ? digest(accessToken) : "";
  if (record.owner !== ownerFor(authorization) || !/^[a-f0-9]{64}$/.test(record.accessTokenHash || "") || !supplied || !timingSafeEqual(Buffer.from(supplied), Buffer.from(record.accessTokenHash))) throw packageError("Assessment not found.", "ASSESSMENT_NOT_FOUND", 404);
}
function publicRecord(record) { const copy = response(record); delete copy.owner; delete copy.accessTokenHash; delete copy.storageIntegrity; return copy; }
function ensureLimits(record) {
  if (record.sources.length > 40 || record.observations.length > 300) throw packageError("This assessment has reached its evidence limit. Create a new scoped assessment.", "EVIDENCE_LIMIT", 413);
  const manifest = { ...record, sources: record.sources.map(({ body, ...source }) => source) };
  if (Buffer.byteLength(JSON.stringify(manifest)) > 480 * 1024) throw packageError("The evidence record is too large. Use smaller submissions or a new scoped assessment.", "EVIDENCE_LIMIT", 413);
}

export class EvidenceAssessmentService {
  constructor({ root, store = new AssessmentStore(root), acquire = acquirePublicEvidence, now = () => new Date().toISOString() }) {
    this.store = store; this.acquire = acquire; this.now = now;
  }
  async read(id, authorization, accessToken) { const record = await this.store.load(id, { authorize: item => authorize(item, authorization, accessToken) }); record.assessment = assessEvidencePackage(record); return publicRecord(record); }
  async source(id, sourceId, authorization, accessToken) { const record = await this.store.load(id, { authorize: item => authorize(item, authorization, accessToken) }); return this.store.source(record, sourceId); }
  add(record, acquired) {
    const sources = new Map(record.sources.map(item => [item.id, item]));
    const observations = new Map(record.observations.map(item => [item.id, item]));
    const immutable = ({ body, retrievedAt, supersededBy, correctionReason, ...item }) => item;
    for (const source of acquired.sources || []) {
      if (source.body !== undefined && digest(source.body) !== source.contentHash) throw packageError("Source body does not match its content hash.", "SOURCE_INTEGRITY_FAILURE", 500);
      const previous = sources.get(source.id);
      if (previous && (previous.supersededBy || stable(immutable(previous)) !== stable(immutable(source)))) throw packageError("Source identity cannot be rebound or reactivated.", "SOURCE_INTEGRITY_FAILURE", 500);
      sources.set(source.id, previous || source);
    }
    for (const item of acquired.observations || []) {
      const source = sources.get(item.sourceId);
      if (item.entityId !== record.entity.id || !source) throw packageError("An observation did not bind to the resolved entity and source.", "SOURCE_INTEGRITY_FAILURE", 500);
      if (item.origin === "user_structured" && source.body !== undefined) {
        let value = JSON.parse(source.body);
        for (const segment of item.locator.slice(1).split("/")) { const key = segment.replaceAll("~1", "/").replaceAll("~0", "~"); value = value && Object.hasOwn(value, key) ? value[key] : undefined; }
        if (item.metric === "gpuModel" && typeof value === "string") value = canonicalGpu(value);
        if (stable(value) !== stable(item.value)) throw packageError("Observation differs from its raw record locator.", "SOURCE_INTEGRITY_FAILURE", 500);
      }
      const previous = observations.get(item.id);
      // A refresh reproduces the parser tuple, not its later application receipt.
      // Compare every parser field and retain the server-owned derivation below.
      const comparable = previous?.origin === "public_adapter" && item.origin === "public_adapter" && previous.derivation && !Object.hasOwn(item, "derivation")
        ? (({ derivation, ...parserObservation }) => parserObservation)(previous) : previous;
      if (previous && stable(comparable) !== stable(item)) throw packageError("Observation identity cannot be rebound.", "SOURCE_INTEGRITY_FAILURE", 500);
      observations.set(item.id, previous || item);
    }
    record.sources = [...sources.values()]; record.observations = [...observations.values()];
    record.acquisition.push(...(acquired.acquisition || []));
    record.warnings = [...new Set([...record.warnings, ...(acquired.warnings || [])])];
    record.retainedUnmapped = [...new Set([...record.retainedUnmapped, ...(acquired.retainedUnmapped || [])])];
  }
  async create(body, { authorization, signal } = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw packageError("Provide a target or structured evidence.");
    for (const key of Object.keys(body)) if (!["target", "draft", "prompt", "profile", "evidenceLabel"].includes(key)) throw packageError(`Unknown request field '${key}'.`);
    if (body.prompt && (body.target || body.draft)) throw packageError("Use either prompt or target/draft input, not both.");
    let raw = body.draft;
    let target = body.target;
    let inputKind = raw ? "structured" : "target";
    let warnings = [];
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string" || body.prompt.length > 10000 || !body.prompt.trim()) throw packageError("Provide a prompt between 1 and 10000 characters.");
      const input = parseEvidenceInput(body.prompt);
      if (!input.valid) throw packageError(input.error.message, input.error.code);
      inputKind = input.kind;
      if (input.kind === "structured") { raw = input.raw || input.draft; target = raw?.target || input.draft?.label || raw?.draft?.label || raw?.label; warnings = input.warnings || []; }
      else {
        // Exact names resolve publicly; descriptive operational prose is conservative intake.
        target = body.prompt.trim();
        const extraction = safeTextDraft(body.prompt);
        if (Object.keys(extraction.draft || {}).length) raw = extraction.draft;
        warnings = extraction.warnings || [];
      }
    }
    if (raw && (typeof raw !== "object" || Array.isArray(raw))) throw packageError("draft must be a JSON object.");
    target ||= raw?.label || raw?.draft?.label || "Submitted operation";
    if (typeof target !== "string" || !target.trim() || target.length > (body.prompt !== undefined ? 10000 : 2000)) throw packageError("Provide a target name or one assessment request within the input length limit.");
    const profile = body.profile || raw?.profile || (raw ? "ai-inference" : "public-context");
    if (!["ai-inference", "public-context"].includes(profile)) throw packageError("Unknown assessment profile.");
    const acquired = await this.acquire(target.trim(), { signal, now: this.now });
    signal?.throwIfAborted();
    const time = this.now();
    const entity = acquired.entity?.id ? acquired.entity : { ...acquired.entity, id: `user-${digest(target).slice(0, 24)}`, name: acquired.entity?.name || target, kind: acquired.entity?.kind || "unknown", status: "unresolved" };
    if (raw && entity.status !== "resolved" && !(acquired.acquisition || []).some(item => item.code === "AMBIGUOUS_ENTITY")) Object.assign(entity, { status: "resolved", kind: "user-declared-operation", identityBasis: "User-declared target; not independently resolved." });
    const assessmentAccessToken = randomBytes(32).toString("hex");
    const record = { id: this.store.newId(), owner: ownerFor(authorization), accessTokenHash: digest(assessmentAccessToken), version: EVIDENCE_VERSION, revision: 1, createdAt: time, updatedAt: time, target, entity, profile, inputKind, operationPeriod: null, sources: [], observations: [], acquisition: [], warnings, retainedUnmapped: [], history: [{ revision: 1, at: time, action: "created" }] };
    this.add(record, acquired);
    if (body.prompt !== undefined) {
      const content = JSON.stringify({ prompt: body.prompt });
      const promptSource = { id: `src-${digest(content).slice(0, 24)}`, kind: "user_prompt", title: "Original user prompt", retrievedAt: time, contentHash: digest(content), contentType: "application/json", verification: "user-declared", body: content };
      record.sources.push(promptSource);
      if (raw) {
        this.addUser(record, raw, body.evidenceLabel, { parentSourceId: promptSource.id, extractionMethod: "evidence-input/v0.1", ...(inputKind === "text" ? { title: "Deterministic text extraction (user-declared)" } : {}) });
      }
    } else if (raw) this.addUser(record, raw, body.evidenceLabel);
    ensureLimits(record);
    record.assessment = assessEvidencePackage(record);
    ensureLimits(record);
    const saved = await this.store.save(record, 0, signal);
    return { ...publicRecord(saved), assessmentAccessToken };
  }
  addUser(record, raw, label, metadata = {}, revision = record.revision) {
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 200)) throw packageError("evidenceLabel must contain 1–200 characters.");
    const acquired = makeUserEvidence(raw, { entityId: record.entity.id, assessmentId: record.id, revision, now: this.now, label, defaultPeriod: record.operationPeriod });
    const dates = Object.fromEntries(acquired.observations.filter(item => ["periodStart", "periodEnd"].includes(item.metric) && item.validation === "valid").map(item => [item.metric, item.value]));
    if (record.operationPeriod && (dates.periodStart && dates.periodStart !== record.operationPeriod.start || dates.periodEnd && dates.periodEnd !== record.operationPeriod.end)) throw packageError("A new primary period requires a new assessment. This assessment retains its original operation window.", "SCOPE_CHANGE_REQUIRES_NEW_ASSESSMENT", 409);
    if (!record.operationPeriod && dates.periodStart && dates.periodEnd) record.operationPeriod = { start: dates.periodStart, end: dates.periodEnd };
    const source = acquired.sources[0];
    Object.assign(source, metadata);
    const draft = raw.draft || raw;
    if (draft.publicClaims !== undefined) {
      if (!Array.isArray(draft.publicClaims) || !draft.publicClaims.length || draft.publicClaims.length > 20) throw packageError("publicClaims must contain 1–20 reviews of existing facts.");
      for (const [index, claim] of draft.publicClaims.entries()) {
        if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw packageError("Each public claim review must be a JSON object.");
        const fact = record.assessment?.facts.find(item => item.id === claim.factId && item.scope !== "ai-operation");
        if (!fact || typeof claim.value !== "number" || !Number.isFinite(claim.value)) throw packageError("A public claim review requires an existing public fact and a finite numeric value.");
        for (const key of Object.keys(claim)) if (!["factId", "value", "referenceUrl", "note", "estimated"].includes(key)) throw packageError(`Unknown public claim review field '${key}'.`);
        if (claim.referenceUrl && (typeof claim.referenceUrl !== "string" || claim.referenceUrl.length > 2000 || !/^https:\/\//.test(claim.referenceUrl))) throw packageError("A declared reference must be an HTTPS URL; it will be retained, not automatically fetched.");
        const locator = `${raw.draft ? '/draft' : ''}/publicClaims/${index}/value`;
        acquired.observations.push({ id: `obs-${digest({ sourceId: source.id, locator }).slice(0, 24)}`, metric: fact.metric, value: claim.value, unit: fact.unit, period: fact.period, scope: fact.scope, basis: fact.basis, entityId: record.entity.id, sourceId: source.id, locator, origin: "user_structured", validation: claim.estimated === true ? "estimated" : "valid", semanticNotes: "A user-declared review of a retrieved public claim; its reference was not independently acquired." });
      }
    }
    this.add(record, acquired);
    return acquired.sources[0].id;
  }
  // The publisher accepts observation identities, never model values or authority.
  // It re-extracts independently from saved bytes before touching Evidence state.
  async publishReplayedPublic(id, request, { authorization, accessToken, signal } = {}) {
    return this.store.exclusive(id, async () => {
      const record = await this.store.load(id, { authorize: item => authorize(item, authorization, accessToken) });
      if (request.expectedRevision !== record.revision) throw packageError("Reload before applying evidence.", "REVISION_CONFLICT", 409);
      const replay = await replaySavedPublicSource(record, request.sourceId, sid => this.store.source(record, sid));
      const selected = request.observationIds.map(oid => replay.anchors.find(item => item.id === oid));
      if (!/^cp-[a-f0-9]{64}$/.test(request.proposalId) || !/^[a-f0-9]{64}$/.test(request.proposalHash) || selected.some(item => !item || !evaluateObservationAuthority(record, item, replay.source).permissions.contextualCalculation)) throw packageError("No deterministic public extraction qualifies this proposal.", "PROPOSAL_REJECTED", 409);
      const additions = selected.filter(item => !record.observations.some(existing => existing.id === item.id)).map(item => ({ ...item, derivation: { method: "registered-source-replay", proposalReceiptId: request.proposalId, proposalOutputHash: request.proposalHash, sourceHash: replay.source.contentHash, extractorVersion: item.providerVersion } }));
      if (!additions.length) return publicRecord(record);
      this.add(record, { observations: additions });
      record.revision += 1; record.updatedAt = this.now();
      record.history.push({ revision: record.revision, at: record.updatedAt, action: "deterministic-public-extraction-applied", proposalReceiptId: request.proposalId });
      record.assessment = assessEvidencePackage(record); ensureLimits(record);
      signal?.throwIfAborted();
      return publicRecord(await this.store.save(record, request.expectedRevision, signal));
    });
  }
  async continue(id, body, { authorization, accessToken, signal, refresh = false } = {}) {
    return this.store.exclusive(id, async () => {
      const record = await this.store.load(id, { authorize: item => authorize(item, authorization, accessToken) });
      if (!body || !Number.isInteger(body.expectedRevision) || body.expectedRevision !== record.revision) throw packageError("Provide the current expectedRevision before adding evidence.", "REVISION_CONFLICT", 409);
      for (const key of Object.keys(body)) if (!["expectedRevision", "draft", "structuredText", "evidenceLabel", "correctsSourceId", "reason", "profile"].includes(key)) throw packageError(`Unknown continuation field '${key}'.`);
      if (body.profile && !["ai-inference", "public-context"].includes(body.profile)) throw packageError("Unknown assessment profile.");
      if (body.profile) record.profile = body.profile;
      if (refresh) {
        if (body.draft || body.structuredText || body.correctsSourceId) throw packageError("Refresh does not accept private evidence.");
        const acquired = await this.acquire(record.target, { signal, now: this.now });
        if (acquired.entity?.status === "resolved" && acquired.entity.id !== record.entity.id) throw packageError("Refresh resolved a different identity. Create a new assessment.", "ENTITY_CONFLICT", 409);
        this.add(record, acquired);
      } else {
        let raw = body.draft;
        if (body.structuredText !== undefined) {
          if (raw || typeof body.structuredText !== "string" || !body.structuredText.trim() || body.structuredText.length > 65536) throw packageError("Use one draft object or one structuredText JSON object.");
          const parsed = parseEvidenceInput(body.structuredText);
          if (!parsed.valid || parsed.kind !== "structured") throw packageError(parsed.error?.message || "structuredText must contain one JSON object.", parsed.error?.code || "INVALID_EVIDENCE");
          raw = parsed.raw;
        }
        if (!raw) throw packageError("Provide structured draft evidence to continue.");
        const correcting = body.correctsSourceId ? record.sources.find(source => source.id === body.correctsSourceId) : null;
        if (body.correctsSourceId && (!correcting || correcting.kind !== "user_structured" || correcting.supersededBy || typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000)) throw packageError("Corrections require an active user source and a reason (up to 1000 characters).");
        let original;
        if (body.structuredText !== undefined) {
          const content = JSON.stringify({ structuredText: body.structuredText });
          original = { id: `src-${digest(content).slice(0, 24)}`, kind: "user_input", title: "Original structured evidence text", retrievedAt: this.now(), contentHash: digest(content), contentType: "application/json", verification: "user-declared", body: content };
          if (!record.sources.some(source => source.id === original.id)) record.sources.push(original);
        }
        const newSourceId = this.addUser(record, raw, body.evidenceLabel, original ? { parentSourceId: original.id, extractionMethod: "evidence-input/v0.1" } : {}, record.revision + 1);
        if (correcting) {
          if (correcting.id === newSourceId) throw packageError("A correction must provide changed evidence.");
          Object.assign(correcting, { supersededBy: newSourceId, correctionReason: body.reason });
        }
      }
      signal?.throwIfAborted();
      ensureLimits(record);
      record.revision += 1;
      record.updatedAt = this.now();
      record.history.push({ revision: record.revision, at: record.updatedAt, action: refresh ? "public-refreshed" : body.correctsSourceId ? "user-corrected" : "evidence-added", ...(body.correctsSourceId ? { correctsSourceId: body.correctsSourceId, reason: body.reason } : {}) });
      record.assessment = assessEvidencePackage(record);
      ensureLimits(record);
      const saved = await this.store.save(record, body.expectedRevision, signal);
      return publicRecord(saved);
    });
  }
}
