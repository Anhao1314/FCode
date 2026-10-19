import { digest, stable } from './baseline.mjs';
import { exactKeys, fail } from './contracts.mjs';
import { hash } from './trajectory-store.mjs';

export const DATASET_VERSION = 'flowcredit.trajectory-dataset/t0-v1';
export const RIGHTS_VERSION = 'flowcredit.trajectory-rights/t0-v1';
export const USE = 'offline-training-candidate';
export function rightsRequest(payload, ref) {
  return { version: RIGHTS_VERSION, schemaVersion: DATASET_VERSION, use: USE, snapshotHash: ref, principalHash: payload.origin.principalHash, originHash: digest(payload.origin.identity), sources: payload.evidence.sources.map(source => ({ id: source.id, contentHash: source.contentHash, kind: source.kind, verification: source.verification || null })).sort((a, b) => a.id.localeCompare(b.id)) };
}
export async function checkRights(callback, request) {
  if (typeof callback !== 'function') fail('T0_EXPORT_RIGHTS_REQUIRED');
  const approval = await callback(structuredClone(request));
  if (!exactKeys(approval, ['version', 'schemaVersion', 'use', 'snapshotHash', 'principalHash', 'originHash', 'sources', 'clearances', 'allow', 'expiresAt', 'reviewerHash', 'rightsEvidenceHash', 'privacyReviewHash']) || ['version', 'schemaVersion', 'use', 'snapshotHash', 'principalHash', 'originHash'].some(key => approval[key] !== request[key]) || stable(approval.sources) !== stable(request.sources) || approval.allow !== true || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= Date.now() || approval.expiresAt > Date.now() + 3600000 || ![approval.reviewerHash, approval.rightsEvidenceHash, approval.privacyReviewHash].every(hash)) fail('T0_EXPORT_RIGHTS_DENIED');
  if (!Array.isArray(approval.clearances) || approval.clearances.length !== request.sources.length || approval.clearances.some((clearance, index) => !exactKeys(clearance, ['source', 'use', 'decision', 'basis', 'evidenceHash']) || stable(clearance.source) !== stable(request.sources[index]) || clearance.use !== USE || clearance.decision !== 'allow' || !['synthetic-fixture-consent', 'restricted-local-training-approval'].includes(clearance.basis) || !hash(clearance.evidenceHash))) fail('T0_EXPORT_RIGHTS_DENIED');
  return approval;
}
// Structural candidates intentionally exclude all free text, raw IDs, URLs,
// source hashes/bodies, provider text, assessments and capability material.
export function datasetFor(payload, ref, trajectoryId) {
  const pseudo = value => value === null || value === undefined ? null : digest([payload.origin.identity, DATASET_VERSION, value]);
  const verified = ['verified-success', 'verified-failure'].includes(payload.verification.outcome);
  const rows = verified ? [{
    version: DATASET_VERSION, rowId: digest([trajectoryId, DATASET_VERSION]), trajectoryId, snapshotHash: ref,
    objectiveRef: pseudo(payload.objective), executionOrigin: payload.generationOrigin,
    quality: payload.verification.outcome, positiveEligible: payload.verification.outcome === 'verified-success',
    intendedUse: USE, labelScope: 'offline-runtime-execution-only', teacherSampling: false,
    bindingRef: pseudo(payload.binding), sourceRefs: payload.evidence.sources.map(source => pseudo([source.id, source.contentHash])),
    terminalStatus: payload.status, verificationRef: pseudo(payload.verification),
    rounds: payload.rounds.map(round => ({ index: round.index, taskRef: pseudo(round.childId), requestRef: pseudo(round.requestId), contextRef: pseudo(round.context), receiptRef: pseudo(round.receiptRef), decisionRef: pseudo(round.plan),
      actions: round.steps.map(step => ({ actionRef: pseudo(step.id), tool: ['evidence.read', 'evidence.assess'].includes(step.tool) ? step.tool : 'unregistered-tool', arguments: {}, status: ['pending', 'started', 'succeeded', 'failed'].includes(step.status) ? step.status : 'unconfirmed', attempts: step.attempts, observationRef: pseudo(step.result), observationSummary: step.status === 'succeeded' ? { factCount: step.result.factIds?.length ?? step.result.assessment?.facts?.length ?? 0, calculationCount: step.result.assessment?.calculations?.length ?? 0 } : null, verifiedObservation: step.status === 'succeeded' && round.verifiedStepIds.includes(step.id) })),
      fees: { usageStatus: round.charge?.usageStatus || 'unknown', estimatedCostMicrousd: round.charge?.estimatedCostMicrousd ?? null, actualCostMicrousd: null, externalBilling: 'not-verified', reservationStatus: round.reservation?.status || 'none' }
    }))
  }] : [];
  return { version: DATASET_VERSION, trajectoryId, snapshotHash: ref, quality: payload.verification.outcome, excludedReason: verified ? null : 'NO_VERIFIED_TRAINING_LABEL', rows };
}
export function encodeDataset(dataset) { const jsonl = dataset.rows.map(row => stable(row) + '\n').join(''); return { ...dataset, jsonl, dataHash: digest(jsonl) }; }
