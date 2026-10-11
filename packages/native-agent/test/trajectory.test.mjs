import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { digest } from '../src/baseline.mjs';
import { TrajectoryRecorder } from '../src/trajectory-recorder.mjs';
import { setup, saveCases, cases, rights } from './trajectory-fixtures.mjs';
import { PLAN_VERSION } from '../src/contracts.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createTrajectoryLoop } from '../src/trajectory-runtime.mjs';
import { RuntimeError } from '../src/contracts.mjs';
test.after(saveCases);

test('T0 captures the actual DeepSeek Harness Loop, provenance, independent verification and unknown billing', async t => {
  const s = await setup(t); const result = await s.runtime.harness.run(s.loop.id, s.context);
  const before = digest(result), calls = s.runtime.modelApi.calls, counts = s.runtime.tools.counts;
  const captured = await s.recorder.capture(s.loop.id, s.context), raw = await s.recorder.store.blob(captured.snapshotHash);
  assert.equal(captured.quality, 'verified-success'); assert.equal(raw.rounds.length, 2); assert.equal(raw.verification.modelSelfAssessmentUsed, false);
  assert.equal(new Set(raw.rounds.map(r => r.requestId)).size, 2); assert.ok(raw.evidence.sources.length > 0); assert.ok(raw.events.every(e => e.at && e.hash));
  for (const round of raw.rounds) { assert.equal(round.receipt.intent.requestId, round.requestId); assert.equal(round.steps[0].resultHash, digest(round.steps[0].result)); assert.equal(round.charge.actualCostMicrousd, null); assert.ok(round.ledger.call); }
  assert.equal(digest(await s.runtime.store.load(s.loop.id)), before); assert.equal(s.runtime.modelApi.calls, calls); assert.deepEqual(s.runtime.tools.counts, counts);
  const exported = await s.recorder.export(s.loop.id, s.context); assert.equal(exported.rows.length, 1); assert.equal(exported.rows[0].positiveEligible, true); assert.equal(exported.rows[0].teacherSampling, false);
  cases.push({ test: t.name, capture: captured, dataHash: exported.dataHash, exportedRows: exported.rows.length, privateOriginHash: digest(raw.origin.identity) });
});

test('repeat capture and restart export are byte-identical and create exactly one candidate', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context);
  const first = await s.recorder.capture(s.loop.id, s.context), exported = await s.recorder.export(s.loop.id, s.context);
  const restarted = new TrajectoryRecorder({ runtime: s.runtime, root: join(s.root, 'trajectory'), authorizeExport: request => rights(request) });
  const repeated = await restarted.capture(s.loop.id, s.context), again = await restarted.export(s.loop.id, s.context);
  assert.equal(repeated.deduplicated, true); assert.equal(repeated.captureCount, 1); assert.equal(repeated.snapshotHash, first.snapshotHash); assert.equal(again.jsonl, exported.jsonl); assert.equal(again.dataHash, exported.dataHash);
});

test('real empty Evidence changes the branch and never becomes a positive training sample', async t => {
  const s = await setup(t, { empty: true }); const loop = await s.runtime.harness.run(s.loop.id, s.context);
  assert.equal(loop.status, 'insufficient-evidence'); assert.deepEqual(loop.rounds.map(r => r.observation.tool), ['evidence.read', 'evidence.read']);
  const c = await s.recorder.capture(s.loop.id, s.context), data = await s.recorder.export(s.loop.id, s.context);
  assert.equal(c.quality, 'insufficient-evidence'); assert.equal(data.rows.length, 0);
});

test('runtime-denied model tool proposal receives an independently verified negative label', async t => {
  const plan = { version: PLAN_VERSION, steps: [{ id: 'attack', tool: 'finance.trade', arguments: {} }] };
  const s = await setup(t, { scenarios: [{ plan }] }); const loop = await s.runtime.harness.run(s.loop.id, s.context);
  assert.equal(loop.status, 'denied'); assert.deepEqual(s.runtime.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
  const c = await s.recorder.capture(s.loop.id, s.context), data = await s.recorder.export(s.loop.id, s.context);
  assert.equal(c.quality, 'verified-failure'); assert.equal(data.rows[0].positiveEligible, false); assert.equal(data.rows[0].rounds[0].actions[0].tool, 'unregistered-tool');
});

test('unknown model outcome retains liabilities, exports no positive rows and recording never retries', async t => {
  const s = await setup(t, { scenarios: [{ status: 503 }] }); const loop = await s.runtime.harness.run(s.loop.id, s.context);
  assert.equal(loop.status, 'recovery-required'); const calls = s.runtime.modelApi.calls;
  const c = await s.recorder.capture(s.loop.id, s.context), raw = await s.recorder.store.blob(c.snapshotHash), data = await s.recorder.export(s.loop.id, s.context);
  assert.equal(c.quality, 'unknown'); assert.equal(data.rows.length, 0); assert.equal(raw.rounds[0].lease.status, 'held'); assert.equal(raw.rounds[0].reservation.status, 'unknown');
  await s.recorder.capture(s.loop.id, s.context); assert.equal(s.runtime.modelApi.calls, calls);
});

test('export requires explicit source rights and current owner/model/Evidence authorization', async t => {
  const s = await setup(t, { authorizeExport: undefined }); await s.runtime.harness.run(s.loop.id, s.context); await s.recorder.capture(s.loop.id, s.context);
  await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'T0_EXPORT_RIGHTS_REQUIRED' });
  await assert.rejects(s.recorder.capture(s.loop.id, { ...s.context, principal: 'another-owner' }), { code: 'TASK_OWNER_DENIED' });
  await assert.rejects(s.recorder.export(s.loop.id, { ...s.context, accessToken: '0'.repeat(64) }), { code: 'ASSESSMENT_NOT_FOUND' });
  const changed = s.policy(); changed.revision += 1; s.setPolicy(changed);
  await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
});

test('raw objectives and source text remain private and public structural bytes contain no capabilities', async t => {
  const secret = 'alice@example.org Bearer secret-teacher-value /Users/private/record';
  const s = await setup(t, { objective: secret }); await s.runtime.harness.run(s.loop.id, s.context); const c = await s.recorder.capture(s.loop.id, s.context), data = await s.recorder.export(s.loop.id, s.context);
  const raw = await s.recorder.store.blob(c.snapshotHash); assert.equal(raw.objective, secret);
  for (const sensitive of [secret, 'alice@example.org', s.context.authorization, s.context.accessToken, s.context.principal, s.loop.id, ...raw.evidence.sources.map(source => source.contentHash)]) assert.equal(data.jsonl.includes(sensitive), false);
  assert.equal((await stat(s.recorder.store.localRoot)).mode & 0o777, 0o700); assert.equal((await stat(join(s.recorder.store.blobs, c.snapshotHash + '.json'))).mode & 0o777, 0o600);
});

test('tampered raw capture and unsafe preexisting storage cannot be accepted', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context); const c = await s.recorder.capture(s.loop.id, s.context);
  const path = join(s.recorder.store.blobs, c.snapshotHash + '.json'), original = await readFile(path), tampered = JSON.parse(original); tampered.payload.payload.verification.outcome = 'forged-gold';
  await writeFile(path, JSON.stringify(tampered)); await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'M1_INTEGRITY_FAILURE' });
  await chmod(s.recorder.store.localRoot, 0o755); await assert.rejects(s.recorder.capture(s.loop.id, s.context), { code: 'T0_PRIVATE_DIRECTORY_REQUIRED' });
});

test('concurrent capture and export deduplicate rather than appending training rows', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context);
  const captures = await Promise.all(Array.from({ length: 3 }, () => s.recorder.capture(s.loop.id, s.context)));
  assert.equal(new Set(captures.map(c => c.snapshotHash)).size, 1); assert.ok(captures.every(c => c.captureCount === 1));
  const exports = await Promise.all(Array.from({ length: 3 }, () => s.recorder.export(s.loop.id, s.context)));
  assert.equal(new Set(exports.map(data => data.dataHash)).size, 1); assert.ok(exports.every(data => data.rows.length === 1));
});

test('source rights mismatch and authorization revoked while rights review waits release no bytes', async t => {
  const s = await setup(t, { authorizeExport: request => rights(request, { sources: [] }) }); await s.runtime.harness.run(s.loop.id, s.context); await s.recorder.capture(s.loop.id, s.context);
  await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'T0_EXPORT_RIGHTS_DENIED' });
  s.recorder.authorizeExport = request => { const policy = s.policy(); policy.revision += 1; s.setPolicy(policy); return rights(request); };
  await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
});

test('not-dispatched quota denial is excluded from positive data', async t => {
  const s = await setup(t, { grant: { ...((await import('./deepseek-fixtures.mjs')).GRANT), maxCalls: 1 } });
  const loop = await s.runtime.harness.run(s.loop.id, s.context); assert.equal(loop.status, 'failed'); assert.equal(loop.failure.code, 'MODEL_CALL_QUOTA');
  const c = await s.recorder.capture(s.loop.id, s.context); assert.equal(c.quality, 'unverified-failure'); assert.equal((await s.recorder.export(s.loop.id, s.context)).rows.length, 0);
});

test('temporary tool failure is retained as unverified failure, not negative or positive Gold', async t => {
  const s = await setup(t, { beforeExecute: () => { throw new RuntimeError('TOOL_TEMPORARY_FAILURE', { retryable: true }); } });
  const loop = await s.runtime.harness.run(s.loop.id, s.context); assert.equal(loop.status, 'failed');
  const c = await s.recorder.capture(s.loop.id, s.context), raw = await s.recorder.store.blob(c.snapshotHash);
  assert.equal(c.quality, 'unverified-failure'); assert.equal(raw.rounds[0].steps[0].errorCode, 'TOOL_TEMPORARY_FAILURE'); assert.equal((await s.recorder.export(s.loop.id, s.context)).rows.length, 0);
});

test('recorded M4 Mock control retains a distinct origin and the same independent success gate', async t => {
  const control = await (await import('./loop-fixtures.mjs')).setup(t);
  await control.harness.run(control.loop.id, control.context);
  const recorder = new TrajectoryRecorder({ runtime: control, root: join(control.root, 'trajectory'), authorizeExport: request => rights(request) });
  const c = await recorder.capture(control.loop.id, control.context), data = await recorder.export(control.loop.id, control.context);
  assert.equal(c.quality, 'verified-success'); assert.equal(data.rows[0].executionOrigin, 'offline-mock'); assert.equal(data.rows[0].teacherSampling, false);
});

async function killedWorker(s, phase, operation = 'capture') {
  const config = join(s.root, 'worker-context.json'); await writeFile(config, JSON.stringify({ root: s.root, loopId: s.loop.id, context: s.context, authorization: s.policy(), phase, operation }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('./trajectory-worker.mjs', import.meta.url)), config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', data => { output += data; if (output.includes('T0_MARKER')) child.kill('SIGKILL'); }); child.stderr.on('data', data => { errors += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000); const [code, signal] = await once(child, 'exit'); clearTimeout(timer);
  assert.ok(output.includes('T0_MARKER'), errors); assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  cases.push({ test: 'Real process interruption', phase, operation, signal, marker: true, root: s.root });
}

// The accepted M3 lock contract deliberately requires explicit dead-process
// recovery. Recording must not silently change that execution boundary.
async function recoverDeadLocks(s, operation = 'capture') {
  assert.equal((await s.runtime.store.recoverLock(s.loop.id)).recovered, true);
  if (operation === 'capture') {
    const id = `task-${digest({ loopStoreId: await s.runtime.store.storeId(), loopId: s.loop.id }).slice(0, 32)}`;
    assert.equal((await s.recorder.store.recoverLock(id)).recovered, true);
  } else {
    const loop = await s.runtime.store.load(s.loop.id);
    for (const round of loop.rounds) {
      await s.runtime.childStore.recoverLock(round.childId);
      const child = await s.runtime.childStore.load(round.childId);
      if (child.model.intent) { await s.runtime.ledgerStore.recoverLock(s.runtime.modelApi.scopeId(child.model.intent)); await s.runtime.budgetStore.recoverLock(s.runtime.budgets.groupId(child.model.intent)); }
    }
    await s.runtime.budgetStore.recoverLock(s.runtime.budgets.poolId);
  }
}

test('SIGKILL after raw blob publication reuses the orphan blob without duplicating a capture', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context); await killedWorker(s, 'blob_published');
  await assert.rejects(s.recorder.capture(s.loop.id, s.context), { code: 'TASK_BUSY' }); await recoverDeadLocks(s);
  const c = await s.recorder.capture(s.loop.id, s.context); assert.equal(c.captureCount, 1); assert.equal((await s.recorder.export(s.loop.id, s.context)).rows.length, 1); assert.equal(s.runtime.modelApi.calls, 2);
});

test('SIGKILL after recording witness requires explicit matched recovery and preserves one sample', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context); await killedWorker(s, 'witness_published');
  await assert.rejects(s.recorder.capture(s.loop.id, s.context), { code: 'TASK_BUSY' }); await recoverDeadLocks(s);
  await assert.rejects(s.recorder.capture(s.loop.id, s.context), { code: 'M1_CHECKPOINT_ROLLBACK' });
  assert.equal((await s.recorder.recoverRecording(s.loop.id, s.context)).recovered, true);
  const c = await s.recorder.capture(s.loop.id, s.context); assert.equal(c.deduplicated, true); assert.equal(c.captureCount, 1); assert.equal((await s.recorder.export(s.loop.id, s.context)).rows.length, 1);
});

test('SIGKILL before recording witness remains explicitly blocked without guessing history', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context); await killedWorker(s, 'history_published');
  await assert.rejects(s.recorder.capture(s.loop.id, s.context), { code: 'TASK_BUSY' }); await recoverDeadLocks(s);
  await assert.rejects(s.recorder.capture(s.loop.id, s.context), { code: 'M1_HISTORY_AHEAD' });
  await assert.rejects(s.recorder.recoverRecording(s.loop.id, s.context), { code: 'M1_HISTORY_AHEAD' });
  await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'M1_HISTORY_AHEAD' });
  assert.equal((await s.runtime.store.load(s.loop.id)).status, 'completed'); assert.equal(s.runtime.modelApi.calls, 2);
});

test('SIGKILL model receipt records unknown first, then explicit reconciliation yields one positive candidate', async t => {
  const s = await setup(t); await killedWorker(s, 'receipt_persisted', 'run');
  await assert.rejects(s.runtime.harness.run(s.loop.id, s.context), { code: 'TASK_BUSY' }); await recoverDeadLocks(s, 'run');
  const unknown = await s.runtime.harness.run(s.loop.id, s.context); assert.equal(unknown.status, 'recovery-required'); assert.equal(s.runtime.modelApi.calls, 0);
  const old = await s.recorder.capture(s.loop.id, s.context); assert.equal(old.quality, 'unknown'); const oldBytes = await readFile(join(s.recorder.store.blobs, old.snapshotHash + '.json'));
  assert.equal((await s.recorder.export(s.loop.id, s.context)).rows.length, 0);
  const child = await s.runtime.childStore.load(unknown.rounds[0].childId), receiptRef = await s.runtime.modelApi.receiptRef(child.model.intent);
  await s.runtime.harness.reconcile(s.loop.id, s.context, { roundIndex: 1, receiptRef });
  const completed = await s.runtime.harness.run(s.loop.id, s.context); assert.equal(completed.status, 'completed'); assert.equal(s.runtime.modelApi.calls, 1);
  const c = await s.recorder.capture(s.loop.id, s.context); assert.equal(c.captureCount, 2); assert.equal(c.quality, 'verified-success'); assert.equal((await s.recorder.export(s.loop.id, s.context)).rows.length, 1);
  assert.deepEqual(await readFile(join(s.recorder.store.blobs, old.snapshotHash + '.json')), oldBytes);
});

test('tampered original checkpoint and re-signed forged trajectory label cannot manufacture Gold', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context); const c = await s.recorder.capture(s.loop.id, s.context);
  const path = join(s.recorder.store.blobs, c.snapshotHash + '.json'), blob = JSON.parse(await readFile(path)); blob.payload.payload.verification.outcome = 'model-self-rated-gold';
  await writeFile(path, JSON.stringify(await s.recorder.store.seal(blob.payload))); await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'T0_BLOB_INTEGRITY' });
  const checkpoint = join(s.runtime.store.checkpoints, s.loop.id + '.json'), bytes = JSON.parse(await readFile(checkpoint)); bytes.task.result.loopVerification = 'model-self-rated-gold'; await writeFile(checkpoint, JSON.stringify(bytes));
  await assert.rejects(s.recorder.capture(s.loop.id, s.context), { code: 'TASK_INTEGRITY_FAILURE' });
});

test('revocation during capture prevents signed manifest commit and leaves private orphan evidence', async t => {
  let s;
  s = await setup(t, { afterRecordingPhase: phase => { if (phase === 'blob_published') { const policy = s.policy(); policy.revision += 1; s.setPolicy(policy); } } });
  await s.runtime.harness.run(s.loop.id, s.context);
  await assert.rejects(s.recorder.capture(s.loop.id, s.context), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
  const id = `task-${digest({ loopStoreId: await s.runtime.store.storeId(), loopId: s.loop.id }).slice(0, 32)}`;
  assert.equal((await s.recorder.store.load(id)).captures.length, 0);
  assert.equal((await s.runtime.store.load(s.loop.id)).status, 'completed'); assert.equal(s.runtime.modelApi.calls, 2);
});

test('partial per-source clearance, expired approval and wrong dataset use block exports', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context); await s.recorder.capture(s.loop.id, s.context);
  for (const changes of [{ clearances: [] }, { expiresAt: Date.now() - 1 }, { use: 'unapproved-public-release' }]) {
    s.recorder.authorizeExport = request => rights(request, changes); await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'T0_EXPORT_RIGHTS_DENIED' });
  }
});

test('new package facade leaves run intact when a separate recorder directory is refused', async t => {
  const s = await setup(t); const root = join(s.root, 'facade'), recorderRoot = join(s.root, 'unsafe-recorder');
  await (await import('node:fs/promises')).mkdir(recorderRoot, { mode: 0o755 });
  const facade = createTrajectoryLoop(root, { service: s.service, mode: 'injected-http-test', http: s.fake.http, authorizer: async () => s.policy(), recorderRoot });
  assert.equal(facade.modelApi, undefined); assert.equal(facade.store, undefined);
  const loop = await facade.create({ assessmentId: s.loop.binding.assessmentId, objective: 'Safe facade experiment', context: s.context, modelGrant: s.policy().grant });
  const completed = await facade.run(loop.id, s.context); assert.equal(completed.status, 'completed');
  await assert.rejects(facade.capture(loop.id, s.context), { code: 'T0_PRIVATE_DIRECTORY_REQUIRED' });
  assert.equal((await facade.run(loop.id, s.context)).status, 'completed');
  assert.throws(() => createTrajectoryLoop(join(root, 'live'), { mode: 'live' }), { code: 'T0_OFFLINE_ONLY' });
});

test('approval expiry during artifact staging publishes no positive dataset file', async t => {
  let expiresAt, staged = false;
  const s = await setup(t, { authorizeExport: request => { expiresAt = Date.now() + 500; return rights(request, { expiresAt }); }, afterRecordingPhase: async phase => { if (phase === 'export_staged') { staged = true; await new Promise(resolve => setTimeout(resolve, Math.max(1, expiresAt - Date.now() + 10))); } } });
  await s.runtime.harness.run(s.loop.id, s.context); const c = await s.recorder.capture(s.loop.id, s.context);
  await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'T0_EXPORT_RIGHTS_DENIED' }); assert.equal(staged, true);
  await assert.rejects(stat(join(s.recorder.store.localRoot, 'exports', `${c.trajectoryId}-${c.snapshotHash}.json`)), { code: 'ENOENT' });
});

test('tampered controlled export cannot pass reproducible source-backed regeneration', async t => {
  const s = await setup(t); await s.runtime.harness.run(s.loop.id, s.context); const c = await s.recorder.capture(s.loop.id, s.context); const data = await s.recorder.export(s.loop.id, s.context);
  const path = join(s.recorder.store.localRoot, 'exports', `${c.trajectoryId}-${c.snapshotHash}.json`); const forged = structuredClone(data); forged.rows[0].quality = 'model-self-rated-gold'; await writeFile(path, JSON.stringify(forged));
  await assert.rejects(s.recorder.export(s.loop.id, s.context), { code: 'T0_EXPORT_CONFLICT' });
});

test('confirmed invalid model output is a signed negative diagnostic and never positive Gold', async t => {
  const s = await setup(t, { scenarios: [{ plan: 'not-json-model-output' }] }); const loop = await s.runtime.harness.run(s.loop.id, s.context);
  assert.equal(loop.status, 'failed'); const c = await s.recorder.capture(s.loop.id, s.context), raw = await s.recorder.store.blob(c.snapshotHash), data = await s.recorder.export(s.loop.id, s.context);
  assert.equal(c.quality, 'verified-failure'); assert.equal(raw.rounds[0].receipt.status, 'confirmed-invalid'); assert.equal(data.rows[0].positiveEligible, false); assert.equal(raw.verification.proof.verifier, 'signed-invalid-model-output');
  assert.deepEqual(s.runtime.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
});
