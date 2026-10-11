import { join } from 'node:path';
import { digest, stable } from './baseline.mjs';
import { fail } from './contracts.mjs';
import { matchChild } from './loop-contract.mjs';
import { projectEvidenceObservation } from './tools.mjs';
import { TrajectoryStore, TRAJECTORY_VERSION, privateDirectory, publishApprovedArtifact } from './trajectory-store.mjs';
import { rightsRequest, checkRights, datasetFor, encodeDataset } from './trajectory-export.mjs';
import { publishBytes, privateBytes } from './durable-io.mjs';

const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'T0_UNVERIFIED_FAILURE';
export class TrajectoryRecorder {
  constructor({ runtime, root, authorizeExport, afterPhase = async () => {}, afterStorePhase }) {
    if (typeof runtime?.harness?.terminalResult !== 'function') fail('T0_LOOP_REQUIRED');
    this.runtime = runtime; this.store = new TrajectoryStore(root, { afterPhase: afterStorePhase }); this.authorizeExport = authorizeExport; this.afterPhase = afterPhase;
  }
  async project(id, context) {
    const r = this.runtime, loop = await r.store.load(id), anchor = await r.store.anchored(id);
    let record;
    try { ({ record } = await r.harness.authorize(loop, context)); }
    catch (error) { fail(safeCode(error)); }
    await r.harness.verifyPrefix(loop, context, record);
    const identity = { loopStoreId: await r.store.storeId(), loopId: id };
    const mode = r.modelApi.transportMode;
    if (!['deepseek-injected-http-test', 'offline-mock', 'deepseek-disabled'].includes(mode)) fail('T0_OFFLINE_ONLY');
    const rounds = [];
    for (const round of loop.rounds) {
      let child;
      try { child = await r.childStore.load(round.childId); } catch (error) { if (error.code !== 'TASK_NOT_FOUND' || round.status !== 'reserved') throw error; }
      if (!child) { rounds.push({ index: round.index, childId: round.childId, requestId: round.requestId, context: round.context, roundStatus: round.status, child: null, receiptRef: null, plan: null, steps: [], verifiedStepIds: [], charge: null, reservation: null }); continue; }
      matchChild(loop, round, child); await r.childHarnessFor(child.id).authorizeTask(child, context);
      const childAnchor = await r.childStore.anchored(child.id);
      let receipt = null, reservation = null, lease = null, ledger = null;
      if (child.model.intent) {
        await r.modelApi.validateIntent(child.model.intent);
        if (child.model.receiptRef) receipt = await r.modelApi.readReceipt(child.model.receiptRef, child.model.intent);
        const budget = await r.budgets.snapshot(child.model.intent);
        reservation = budget.group?.reservations.find(item => item.requestId === round.requestId) || null;
        lease = budget.pool?.leases.find(item => item.requestId === round.requestId) || null;
        try { const state = await r.ledgerStore.load(r.modelApi.scopeId(child.model.intent)); ledger = { storeId: await r.ledgerStore.storeId(), hash: digest(state), events: state.events, call: state.calls.find(item => item.intent.requestId === round.requestId) || null }; }
        catch (error) { if (error.code !== 'TASK_NOT_FOUND') throw error; }
      }
      const verifiedStepIds = [];
      for (const step of child.steps) if (step.status === 'succeeded') {
        r.tools.gate(step, context, child);
        if (!receipt || receipt.status !== 'confirmed-valid' || receipt.planHash !== digest(child.plan) || step.resultHash !== digest(step.result) || step.resultHash !== digest(projectEvidenceObservation(step.tool, record))) fail('T0_OBSERVATION_UNVERIFIED');
        verifiedStepIds.push(step.id);
      }
      rounds.push({ index: round.index, childId: child.id, requestId: round.requestId, context: round.context, roundStatus: round.status, childVersion: child.version, childHash: digest(child), childHistoryHash: childAnchor.historyHash, events: child.events, model: child.model, plan: child.plan, steps: child.steps, verifiedStepIds, failure: child.failure, childStatus: child.status, receiptRef: child.model.receiptRef || null, receipt, charge: receipt?.charge || null, reservation, lease, ledger });
    }
    let outcome = 'in-progress', proof = null;
    if (['completed', 'insufficient-evidence'].includes(loop.status)) {
      proof = await r.harness.terminalResult(loop, context, record);
      if (!proof || proof.status !== loop.status || stable(proof.result) !== stable(loop.result)) fail('T0_TERMINAL_UNVERIFIED');
      outcome = loop.status === 'completed' ? 'verified-success' : 'insufficient-evidence';
    } else if (loop.status === 'recovery-required' || rounds.some(round => round.model?.intent && !round.model.receiptRef)) outcome = 'unknown';
    else if (['failed', 'denied'].includes(loop.status)) {
      outcome = 'unverified-failure';
      const last = rounds.at(-1);
      if (last?.receipt?.status === 'confirmed-invalid' && last.failure?.code === last.receipt.adapterReceipt.errorCode) { outcome = 'verified-failure'; proof = { verifier: 'signed-invalid-model-output', code: last.failure.code }; }
      else if (loop.failure?.code === 'M4_ROUND_LIMIT' && loop.rounds.length === loop.policy.maxRounds && loop.rounds.every(round => round.status === 'observed') && !await r.harness.terminalResult(loop, context, record)) { outcome = 'verified-failure'; proof = { verifier: 'runtime-round-limit', code: 'M4_ROUND_LIMIT' }; }
      else if (last?.plan && last.childStatus === 'denied') {
        try { for (const step of last.plan.steps) r.tools.gate(step, context, { allowedTools: loop.allowedTools }); }
        catch (error) { if (safeCode(error) === last.failure?.code && ['TOOL_NOT_REGISTERED', 'TOOL_ARGUMENTS_DENIED', 'TOOL_PERMISSION_DENIED'].includes(error.code)) { outcome = 'verified-failure'; proof = { verifier: 'runtime-tool-gate', code: error.code }; } }
      }
    }
    return { version: TRAJECTORY_VERSION, origin: { identity, principalHash: loop.principalHash, loopVersion: loop.version, sequence: loop.sequence, loopHash: digest(loop), historyHash: anchor.historyHash, witness: anchor.witness }, objective: loop.objective, status: loop.status, binding: loop.binding, policy: loop.policy, generationOrigin: mode, events: loop.events, rounds, evidence: { version: record.version, revision: record.revision, createdAt: record.createdAt, updatedAt: record.updatedAt, sources: record.sources.map(({ body, ...source }) => source), observationsHash: digest(record.observations), assessmentHash: digest(record.assessment) }, verification: { version: 'flowcredit.trajectory-verifier/t0-v1', outcome, proof, resultHash: loop.result ? digest(loop.result) : null, labelScope: 'offline-runtime-execution-only', modelSelfAssessmentUsed: false } };
  }
  async capture(id, context) {
    return this.runtime.store.exclusive(id, async () => {
      const payload = await this.project(id, context), originHash = digest(payload.origin.identity), recordId = `task-${originHash.slice(0, 32)}`;
      await this.store.initialize();
      return this.store.exclusive(recordId, async () => {
        let record;
        try { record = await this.store.load(recordId); } catch (error) { if (error.code !== 'TASK_NOT_FOUND') throw error; record = { id: recordId, version: TRAJECTORY_VERSION, sequence: 0, originHash, captures: [], events: [] }; await this.store.create(record); }
        if (stable(await this.project(id, context)) !== stable(payload)) fail('T0_CAPTURE_STATE_CHANGED');
        const ref = await this.store.publishBlob(payload);
        await this.afterPhase('blob_published', { recordId, ref });
        if (stable(await this.project(id, context)) !== stable(payload)) fail('T0_CAPTURE_STATE_CHANGED');
        const existing = record.captures.find(item => item.ref === ref);
        if (!existing) {
          const at = new Date().toISOString(), prior = record.sequence;
          record.captures.push({ ref, loopSequence: payload.origin.sequence, quality: payload.verification.outcome, at });
          const event = { sequence: prior + 1, at, type: 'capture_committed', ref, previousHash: record.events.at(-1)?.hash || null };
          record.events.push({ ...event, hash: digest(event) }); record.sequence += 1;
          await this.store.save(record, prior); await this.afterPhase('capture_committed', { recordId, ref });
        }
        return { trajectoryId: recordId, snapshotHash: ref, quality: payload.verification.outcome, captureCount: record.captures.length, deduplicated: !!existing };
      });
    });
  }
  async export(id, context) {
    return this.runtime.store.exclusive(id, async () => {
      const payload = await this.project(id, context), ref = digest(payload), recordId = `task-${digest(payload.origin.identity).slice(0, 32)}`;
      await this.store.initialize();
      return this.store.exclusive(recordId, async () => {
        const record = await this.store.load(recordId);
        if (!record.captures.some(item => item.ref === ref) || stable(await this.store.blob(ref)) !== stable(payload)) fail('T0_CAPTURE_REQUIRED');
        const request = rightsRequest(payload, ref), approval = await checkRights(this.authorizeExport, request);
        // Host callbacks are asynchronous. Recheck auth and source/receipt state
        // immediately before releasing any candidate bytes.
        if (stable(await this.project(id, context)) !== stable(payload)) fail('T0_EXPORT_STATE_CHANGED');
        if (approval.expiresAt <= Date.now()) fail('T0_EXPORT_RIGHTS_DENIED');
        const dataset = encodeDataset(datasetFor(payload, ref, recordId));
        const approvalDirectory = join(this.store.localRoot, 'export-approvals'); await privateDirectory(approvalDirectory);
        const approvalHash = digest(approval), approvalPath = join(approvalDirectory, `${approvalHash}.json`);
        const evidence = { version: 'flowcredit.trajectory-export-approval/t0-v1', trajectoryId: recordId, snapshotHash: ref, dataHash: dataset.dataHash, approvalHash, approval };
        try { const old = await this.store.unseal(await privateBytes(approvalPath)); if (stable(old) !== stable(evidence)) fail('T0_EXPORT_CONFLICT'); }
        catch (error) { if (error.code !== 'M1_RECORD_MISSING') throw error; await publishBytes(approvalPath, JSON.stringify(await this.store.seal(evidence)), { immutable: true }); }
        const directory = join(this.store.localRoot, 'exports'); await privateDirectory(directory);
        const path = join(directory, `${recordId}-${ref}.json`), bytes = stable(dataset);
        try { const previous = await privateBytes(path, 2 * 1024 * 1024); if (previous.toString('utf8') !== bytes) fail('T0_EXPORT_CONFLICT'); }
        catch (error) { if (error.code !== 'M1_RECORD_MISSING') throw error; await publishApprovedArtifact(path, bytes, async () => {
          await this.afterPhase('export_staged', { recordId, ref });
          if (stable(await this.project(id, context)) !== stable(payload)) fail('T0_EXPORT_STATE_CHANGED');
          return approval.expiresAt;
        }); }
        if (approval.expiresAt <= Date.now()) fail('T0_EXPORT_RIGHTS_DENIED');
        return dataset;
      });
    });
  }
  async recoverRecording(id, context) {
    return this.runtime.store.exclusive(id, async () => { const payload = await this.project(id, context); await this.store.initialize(); return this.store.recoverLatest(`task-${digest(payload.origin.identity).slice(0, 32)}`); });
  }
}
