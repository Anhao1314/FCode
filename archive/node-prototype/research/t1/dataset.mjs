import { join } from 'node:path';
import { digest, stable } from '../../packages/native-agent/src/baseline.mjs';
import { fail, exactKeys } from '../../packages/native-agent/src/contracts.mjs';
import { privateDirectory, publishApprovedArtifact } from '../../packages/native-agent/src/trajectory-store.mjs';
import { privateBytes } from '../../packages/native-agent/src/durable-io.mjs';
import { checkFixture, CORPUS_VERSION } from './corpus.mjs';

export const VERSION = 'flowcredit.action-sft/t1-v1';
export const USE = 'offline-second-action-policy-research';
export const POLICY = 'presence-then-assess-otherwise-one-reread/t1-v1';
const SYSTEM = 'Select one read-only evidence action under the fixed two-observation policy. Output only a tool and empty arguments as JSON. Evidence presence is not a financial truth label.';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Independently specified rule. Never imports the Teacher's decision function,
// the Runtime's expectedAction, or a model-provided quality assessment.
export function oracle(input) {
  if (!exactKeys(input, ['policy', 'prior']) || input.policy !== POLICY || !exactKeys(input.prior, ['tool', 'evidencePresence']) || input.prior.tool !== 'evidence.read' || !['present', 'absent'].includes(input.prior.evidencePresence)) fail('T1_PREFIX_SCHEMA');
  return { tool: input.prior.evidencePresence === 'present' ? 'evidence.assess' : 'evidence.read', arguments: {} };
}
export function example(input, actualAction) {
  const expected = oracle(input);
  if (stable(actualAction) !== stable(expected)) fail('T1_POLICY_MISMATCH');
  return { version: VERSION, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: stable(input) }, { role: 'assistant', content: stable(actualAction) }] };
}
export function validateExample(row) {
  if (!exactKeys(row, ['version', 'messages']) || row.version !== VERSION || !Array.isArray(row.messages) || row.messages.length !== 3 || row.messages.some((m, i) => !exactKeys(m, ['role', 'content']) || m.role !== ['system', 'user', 'assistant'][i] || typeof m.content !== 'string') || row.messages[0].content !== SYSTEM) fail('T1_EXAMPLE_SCHEMA');
  let input, target;
  try { input = JSON.parse(row.messages[1].content); target = JSON.parse(row.messages[2].content); } catch { fail('T1_EXAMPLE_SCHEMA'); }
  if (stable(example(input, target)) !== stable(row)) fail('T1_EXAMPLE_SCHEMA');
  return { inputHash: digest(input), targetHash: digest(target) };
}
function candidate(payload) {
  // Unknown, failed and still-running tasks never become positive SFT targets.
  if (!['verified-success', 'insufficient-evidence'].includes(payload.verification.outcome)) fail(payload.verification.outcome === 'unknown' ? 'T1_UNKNOWN_OUTCOME' : 'T1_NO_VERIFIED_POLICY_TARGET');
  if (payload.rounds.length !== 2) fail('T1_PREFIX_SCHEMA');
  const [first, second] = payload.rounds;
  for (const r of [first, second]) {
    if (r.receipt?.status !== 'confirmed-valid' || r.plan?.steps.length !== 1 || r.steps.length !== 1 || r.verifiedStepIds.length !== 1 || r.steps[0].id !== r.verifiedStepIds[0] || r.steps[0].status !== 'succeeded' || r.reservation?.status !== 'confirmed' || r.lease?.status !== 'released' || !r.charge?.usage) fail('T1_UNCONFIRMED_ACTION');
  }
  const prior = first.steps[0], current = second.steps[0];
  if (prior.tool !== 'evidence.read' || !Array.isArray(prior.result.factIds)) fail('T1_PREFIX_SCHEMA');
  const input = { policy: POLICY, prior: { tool: 'evidence.read', evidencePresence: prior.result.factIds.length ? 'present' : 'absent' } };
  const row = example(input, { tool: current.tool, arguments: current.arguments });
  const observation = second.context.observations;
  if (observation.length !== 1 || observation[0].resultHash !== prior.resultHash || observation[0].factCount !== prior.result.factIds.length) fail('T1_PREFIX_SCHEMA');
  return { row, ...validateExample(row), labels: { execution: payload.verification.outcome, actionExecution: 'runtime-verified', policy: 'independent-fixed-rule-match', financialFactTruth: 'not-evaluated', strategyOptimality: 'not-proven', teacherSelfLabelUsed: false }, action: { round: second.index, childId: second.childId, requestId: second.requestId, receiptRef: second.receiptRef, planHash: digest(second.plan), stepId: current.id, resultHash: current.resultHash, priorResultHash: prior.resultHash, charge: second.charge, reservation: second.reservation.status }, bootstrap: 'excluded-no-prior-observation' };
}
async function inspect(entry) {
  const { recorder, runtime, loop, context, capture } = entry;
  if (!capture || recorder.runtime !== runtime) fail('T1_CAPTURE_REQUIRED');
  const payload = await recorder.project(loop.id, context), snapshotHash = digest(payload);
  const trajectoryId = `task-${digest(payload.origin.identity).slice(0, 32)}`;
  if (capture.snapshotHash !== snapshotHash || capture.trajectoryId !== trajectoryId) fail('T1_CAPTURE_NOT_CURRENT');
  const record = await recorder.store.load(trajectoryId);
  await recorder.store.anchored(trajectoryId);
  if (!record.captures.some(c => c.ref === snapshotHash) || stable(await recorder.store.blob(snapshotHash)) !== stable(payload)) fail('T1_CAPTURE_REQUIRED');
  const { record: evidence } = await runtime.tools.inspect(payload.binding.assessmentId, context, payload.binding);
  const clearance = checkFixture(entry.fixture, evidence);
  return { payload, snapshotHash, trajectoryId, clearance };
}
function code(error) { return /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'T1_UNVERIFIED'; }

// Group before admitting rows. Cross-split collisions quarantine BOTH sides;
// input-only dedup also catches contradictory targets and empty-source aliases.
export function partition(candidates, assignments = candidates) {
  const rejected = [], accepted = [];
  for (const item of candidates) {
    let reason = null;
    for (const other of assignments) if (item !== other) {
      const lineage = item.clearance.family === other.clearance.family || item.clearance.entity === other.clearance.entity || item.clearance.bodyHashes.some(h => other.clearance.bodyHashes.includes(h));
      if (item.split !== other.split && lineage) { reason = 'T1_CROSS_SPLIT_LINEAGE'; break; }
      if (item.inputHash === other.inputHash && other.targetHash !== undefined && item.targetHash !== other.targetHash) { reason = 'T1_CONTRADICTORY_TARGET'; break; }
      if (item.split !== other.split && item.inputHash === other.inputHash) reason ||= 'T1_CROSS_SPLIT_INPUT';
    }
    if (reason) rejected.push({ ...item, reason }); else accepted.push(item);
  }
  const unique = [], seen = new Set();
  for (const item of accepted.sort((a, b) => a.snapshotHash.localeCompare(b.snapshotHash))) {
    const key = `${item.split}:${item.inputHash}`;
    if (seen.has(key)) rejected.push({ ...item, reason: 'T1_DUPLICATE_INPUT' });
    else { seen.add(key); unique.push(item); }
  }
  return { accepted: unique, rejected };
}
export function syntheticApproval(request, changes = {}) {
  return { ...request, allow: true, expiresAt: Date.now() + 60000, reviewer: 'local-synthetic-corpus-review/t1', basis: 'closed-synthetic-fixtures-only', ...changes };
}
async function approve(callback, request) {
  if (typeof callback !== 'function') fail('T1_RIGHTS_REQUIRED');
  // Snapshot callback-owned memory before retaining it across any I/O awaits.
  const response = structuredClone(await callback(structuredClone(request)));
  const { allow, expiresAt, reviewer, basis, ...bound } = response || {};
  if (allow !== true || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 3600000 || reviewer !== 'local-synthetic-corpus-review/t1' || basis !== 'closed-synthetic-fixtures-only' || stable(bound) !== stable(request)) fail('T1_RIGHTS_DENIED');
  return response;
}
async function locked(entries, fn, index = 0) {
  if (index === entries.length) return fn();
  const e = entries[index];
  return e.runtime.store.exclusive(e.loop.id, () => locked(entries, fn, index + 1));
}
export async function buildDataset({ entries, outputRoot, authorize, afterStaged = async () => {} }) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 32 || entries.some(e => !['train', 'eval'].includes(e.split))) fail('T1_BATCH_SCHEMA');
  // Sorting by durable store + loop identity makes concurrent batch locking
  // deterministic. Repeated handles cannot deadlock their own loop.
  const keyed = await Promise.all(entries.map(async e => ({ e, key: `${await e.runtime.store.storeId()}:${e.loop.id}` })));
  if (new Set(keyed.map(x => x.key)).size !== entries.length) fail('T1_DUPLICATE_ENTRY');
  keyed.sort((a, b) => a.key.localeCompare(b.key));
  return locked(keyed.map(x => x.e), async () => {
    const valid = [], rejected = [], checked = [];
    for (const entry of entries) {
      try {
        const s = await inspect(entry); checked.push({ entry, state: s });
        const c = candidate(s.payload);
        valid.push({ ...c, snapshotHash: s.snapshotHash, trajectoryId: s.trajectoryId, clearance: s.clearance, binding: s.payload.binding, sourceVersions: { trajectory: s.payload.version, loop: s.payload.origin.loopVersion, evidence: s.payload.evidence.version }, split: entry.split, generation: s.payload.generationOrigin });
      } catch (error) { rejected.push({ reason: code(error), snapshotHash: hash(entry.capture?.snapshotHash) ? entry.capture.snapshotHash : null, split: entry.split }); }
    }
    // Reserve split lineage even for failed/unknown trajectories. Filtering for
    // successful labels first must not erase a predeclared evaluation source.
    const assignments = checked.map(({ entry, state }) => {
      const first = state.payload.rounds[0], step = first?.steps?.[0];
      const presence = step?.tool === 'evidence.read' && first.verifiedStepIds.includes(step.id) && Array.isArray(step.result?.factIds) ? (step.result.factIds.length ? 'present' : 'absent') : null;
      return { split: entry.split, clearance: state.clearance, inputHash: presence ? digest({ policy: POLICY, prior: { tool: 'evidence.read', evidencePresence: presence } }) : null };
    });
    // Only real candidate targets participate in contradiction checking.
    const parts = partition(valid, [...valid, ...assignments]);
    if (entries.some(e => e.split === 'eval' && !checked.some(s => s.entry === e))) {
      parts.rejected.push(...parts.accepted.map(c => ({ ...c, reason: 'T1_UNVERIFIED_SPLIT_ASSIGNMENT' }))); parts.accepted = [];
    }
    rejected.push(...parts.rejected.map(({ row, ...r }) => r));
    const rows = Object.fromEntries(['train', 'eval'].map(split => [split, parts.accepted.filter(c => c.split === split).map(c => c.row).sort((a, b) => stable(a).localeCompare(stable(b)))]));
    const data = { version: VERSION, purpose: USE, rows };
    const dataHash = digest(data);
    const provenance = parts.accepted.map(({ row, ...c }) => ({ ...c, sampleHash: digest(row) })).sort((a, b) => a.sampleHash.localeCompare(b.sampleHash));
    const audit = { version: 'flowcredit.dataset-audit/t1-v1', dataHash, provenance, rejected: rejected.sort((a, b) => stable(a).localeCompare(stable(b))), readiness: 'BLOCKED', reasons: ['synthetic-fixed-policy-only', 'no-independent-unseen-policy-evaluation', 'learning-gain-not-measured'], actualTeacherSampling: false, financialGoldLabels: false };
    const auditHash = digest(audit);
    const request = { version: 'flowcredit.dataset-rights/t1-v1', schema: VERSION, use: USE, corpus: CORPUS_VERSION, dataHash, auditHash, snapshots: checked.map(s => ({ snapshotHash: s.state.snapshotHash, principalHash: s.state.payload.origin.principalHash, sources: s.state.clearance })).sort((a, b) => a.snapshotHash.localeCompare(b.snapshotHash)) };
    const approval = await approve(authorize, request);
    const recheck = async () => {
      for (const { entry, state } of checked) if (stable(await inspect(entry)) !== stable(state)) fail('T1_STATE_CHANGED');
      if (approval.expiresAt <= Date.now()) fail('T1_RIGHTS_DENIED');
    };
    await recheck();
    await privateDirectory(outputRoot);
    // One immutable artifact commits rows + provenance + approval together.
    // A crash cannot publish a dataset without its audit. Stable identity ignores
    // approval expiry; repeat exports verify bytes and require fresh permission.
    const bundle = { data, audit, approval };
    const artifactHash = digest({ data, audit }), path = join(outputRoot, `${artifactHash}.json`);
    const signer = keyed[0].e.recorder.store;
    let existing;
    try { existing = await signer.unseal(await privateBytes(path, 2 * 1024 * 1024)); } catch (error) { if (error.code !== 'M1_RECORD_MISSING') throw error; }
    if (existing) {
      if (stable({ data: existing.data, audit: existing.audit }) !== stable({ data, audit })) fail('T1_EXPORT_CONFLICT');
      // Original grant remains provenance; this operation separately reauthorizes.
      await recheck();
    } else {
      await publishApprovedArtifact(path, stable(await signer.seal(bundle)), async () => { await afterStaged(); await recheck(); return approval.expiresAt; });
    }
    return { data, audit, dataHash, artifactHash, path, deduplicated: !!existing };
  });
}
