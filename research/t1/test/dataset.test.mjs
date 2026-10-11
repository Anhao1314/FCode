import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { scenario } from '../corpus.mjs';
import { buildDataset, syntheticApproval, example, validateExample, oracle, POLICY, partition } from '../dataset.mjs';
import { digest, stable } from '../../../packages/native-agent/src/baseline.mjs';
import { PLAN_VERSION } from '../../../packages/native-agent/src/contracts.mjs';
import { rights } from '../../../packages/native-agent/test/trajectory-fixtures.mjs';

const base = fileURLToPath(new URL('../../../work/t1/', import.meta.url));
await mkdir(base, { recursive: true, mode: 0o700 });
const cases = [];
async function setup(options = {}) {
  const root = await mkdtemp(join(base, 'case-'));
  const s = await scenario(root, options);
  const before = await s.runtime.harness.run(s.loop.id, s.context);
  const capture = await s.recorder.capture(s.loop.id, s.context);
  cases.push({ fixture: s.fixture, root, task: s.loop.id, outcome: capture.quality, snapshotHash: capture.snapshotHash, calls: s.fake.wire.length });
  return { ...s, capture, before, split: 'train' };
}
async function build(entries, options = {}) { return buildDataset({ entries, outputRoot: join(entries[0].root, 'dataset'), authorize: syntheticApproval, ...options }); }
const plan = tool => ({ version: PLAN_VERSION, steps: [{ id: 'choose', tool, arguments: {} }] });
const input = presence => ({ policy: POLICY, prior: { tool: 'evidence.read', evidencePresence: presence } });

test('real Harness positive and empty outcomes yield two distinct policy candidates, no financial gold', async () => {
  const positive = await setup(), empty = await setup({ fixture: 'empty' });
  assert.equal(positive.before.status, 'completed'); assert.equal(empty.before.status, 'insufficient-evidence');
  const result = await build([positive, empty]);
  assert.equal(result.data.rows.train.length, 2); assert.equal(result.data.rows.eval.length, 0);
  assert.deepEqual(result.audit.provenance.map(p => p.labels.execution).sort(), ['insufficient-evidence', 'verified-success']);
  for (const p of result.audit.provenance) { assert.equal(p.labels.financialFactTruth, 'not-evaluated'); assert.equal(p.action.round, 2); assert.ok(p.action.receiptRef); }
  for (const row of result.data.rows.train) validateExample(row);
  const publicBytes = await readFile(new URL('../examples/action-candidates.jsonl', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../examples/manifest.json', import.meta.url)));
  assert.equal(digest(publicBytes), manifest.sha256);
  const publicRows = publicBytes.trim().split('\n').map(line => JSON.parse(line));
  for (const row of publicRows) validateExample(row);
  assert.deepEqual(publicRows, result.data.rows.train, 'fresh executions reproduce the inspected model-facing example bytes');
  assert.equal(result.audit.readiness, 'BLOCKED');
  const raw = await positive.recorder.store.blob(positive.capture.snapshotHash);
  const assessment = raw.rounds[1].steps[0].result.assessment;
  assert.equal(assessment.calculations.find(c => c.formula === 'gross_profit / revenue * 100').value, 17.85);
  assert.equal(assessment.calculations.find(c => c.formula === 'current_assets / current_liabilities').value, 3.94);
  assert.equal(assessment.TAI, null); assert.equal(assessment.deterministicRisk, null);
  // Existing T0 research label and zero-row behavior are not relaxed.
  empty.recorder.authorizeExport = request => rights(request);
  const old = await empty.recorder.export(empty.loop.id, empty.context);
  assert.equal(old.rows.length, 0);
  const actions = result.data.rows.train.map(row => JSON.parse(row.messages[2].content).tool);
  const controls = { alwaysRead: actions.filter(a => a === 'evidence.read').length / actions.length, alwaysAssess: actions.filter(a => a === 'evidence.assess').length / actions.length, independentFixedRule: result.data.rows.train.filter(row => stable(oracle(JSON.parse(row.messages[1].content))) === row.messages[2].content).length / actions.length };
  assert.deepEqual(controls, { alwaysRead: 0.5, alwaysAssess: 0.5, independentFixedRule: 1 });
  cases.push({ experiment: 'accepted-policy-candidates', result, controls });
});

test('replicated executions do not manufacture sample volume, restart and concurrent builds are stable', async () => {
  const a = await setup(), b = await setup();
  const first = await build([a, b]);
  assert.equal(first.data.rows.train.length, 1); assert.equal(first.audit.rejected[0].reason, 'T1_DUPLICATE_INPUT');
  const calls = a.fake.wire.length + b.fake.wire.length;
  const restarted = { ...a, ...a.restart() };
  const results = await Promise.all([build([restarted, b]), build([restarted, b])]);
  assert.ok(results.every(r => r.deduplicated && r.dataHash === first.dataHash && r.artifactHash === first.artifactHash));
  assert.equal(a.fake.wire.length + b.fake.wire.length, calls);
  assert.equal((await a.recorder.capture(a.loop.id, a.context)).captureCount, 1);
  assert.equal((await lstat(first.path)).mode & 0o777, 0o600);
  assert.equal((await lstat(join(a.root, 'dataset'))).mode & 0o777, 0o700);
});

test('same entity/source lineage across train and eval quarantines both sides', async () => {
  const train = await setup(), evaluation = { ...await setup(), split: 'eval' };
  const result = await build([train, evaluation]);
  assert.equal(result.data.rows.train.length + result.data.rows.eval.length, 0);
  assert.equal(result.audit.rejected.length, 2);
  assert.ok(result.audit.rejected.every(r => r.reason === 'T1_CROSS_SPLIT_LINEAGE'));
  cases.push({ experiment: 'lineage-isolation', result });
});

test('different empty fixture families still collide after removing identity, exposing absent holdout information', async () => {
  const train = await setup({ fixture: 'empty' }), evaluation = { ...await setup({ fixture: 'empty-unseen' }), split: 'eval' };
  const result = await build([train, evaluation]);
  assert.equal(result.data.rows.train.length + result.data.rows.eval.length, 0);
  assert.ok(result.audit.rejected.every(r => r.reason === 'T1_CROSS_SPLIT_INPUT'));
  cases.push({ experiment: 'semantic-isolation', result });
});

test('wrong policy and model self labels cannot become SFT positives', async () => {
  assert.throws(() => example(input('present'), { tool: 'evidence.read', arguments: {} }), { code: 'T1_POLICY_MISMATCH' });
  assert.throws(() => example(input('absent'), { tool: 'evidence.assess', arguments: {} }), { code: 'T1_POLICY_MISMATCH' });
  const s = await setup({ scenarios: [{}, { plan: plan('evidence.read') }] });
  assert.notEqual(s.before.status, 'completed');
  const result = await build([s]); assert.equal(result.data.rows.train.length, 0);
  assert.equal(result.audit.rejected[0].reason, 'T1_NO_VERIFIED_POLICY_TARGET');
  const row = example(input('present'), oracle(input('present')));
  assert.throws(() => validateExample({ ...row, gold: true }), { code: 'T1_EXAMPLE_SCHEMA' });
});

test('tool escalation is denied by original Runtime, valid JSON is insufficient for a positive', async () => {
  const s = await setup({ scenarios: [{ plan: plan('finance.trade') }] });
  assert.equal(s.before.status, 'denied');
  assert.deepEqual(s.runtime.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
  const result = await build([s]); assert.equal(result.data.rows.train.length, 0);
  assert.equal(result.audit.rejected[0].reason, 'T1_NO_VERIFIED_POLICY_TARGET');
  cases.push({ experiment: 'denied-tool', result });
});

test('unknown keeps reservation and lease; reloading and building cannot resend or label it', async () => {
  const s = await setup({ scenarios: [{}, { status: 503 }] });
  assert.equal(s.capture.quality, 'unknown'); const calls = s.fake.wire.length;
  const raw = await s.recorder.store.blob(s.capture.snapshotHash);
  assert.equal(raw.rounds[1].reservation.status, 'unknown'); assert.equal(raw.rounds[1].lease.status, 'held');
  const restarted = { ...s, ...s.restart() };
  await restarted.runtime.harness.run(s.loop.id, s.context);
  const result = await build([restarted]);
  assert.equal(result.data.rows.train.length, 0); assert.equal(result.audit.rejected[0].reason, 'T1_UNKNOWN_OUTCOME');
  assert.equal(s.fake.wire.length, calls);
  const after = await restarted.recorder.project(s.loop.id, s.context);
  assert.equal(after.rounds[1].reservation.costBound, raw.rounds[1].reservation.costBound);
  const positive = await setup();
  const mixed = await build([positive, { ...restarted, split: 'eval' }]);
  assert.equal(mixed.data.rows.train.length, 0, 'unknown eval source must reserve lineage before label filtering');
  assert.ok(mixed.audit.rejected.some(r => r.reason === 'T1_CROSS_SPLIT_LINEAGE'));
  cases.push({ experiment: 'unknown-not-reissued', result });
});

test('unsealed input, stale capture, altered source clearance and tampered blob are rejected', async () => {
  const s = await setup();
  let r = await build([{ ...s, capture: null }]); assert.equal(r.audit.rejected[0].reason, 'T1_CAPTURE_REQUIRED');
  r = await build([{ ...s, capture: { ...s.capture, snapshotHash: 'a'.repeat(64) } }]); assert.equal(r.audit.rejected[0].reason, 'T1_CAPTURE_NOT_CURRENT');
  r = await build([{ ...s, fixture: 'empty' }]); assert.equal(r.audit.rejected[0].reason, 'T1_SOURCE_NOT_CLEARED');
  const path = join(s.recorder.store.blobs, `${s.capture.snapshotHash}.json`), original = await readFile(path);
  await writeFile(join(s.root, 'original-blob.private'), original, { mode: 0o600, flag: 'wx' });
  await writeFile(path, original.toString().replace('verified-success', 'verified-failure'));
  r = await build([s]); assert.equal(r.data.rows.train.length, 0); assert.match(r.audit.rejected[0].reason, /INTEGRITY|SIGNATURE/);
});

test('purpose, content hash, source clearance, privacy callback and expiry require new exact T1 rights', async () => {
  const s = await setup();
  for (const changes of [{ use: 'offline-training-candidate' }, { dataHash: 'a'.repeat(64) }, { snapshots: [] }, { basis: 'model-says-public' }, { expiresAt: 1 }, { allow: false }]) {
    await assert.rejects(build([s], { authorize: request => syntheticApproval(request, changes) }), { code: 'T1_RIGHTS_DENIED' });
  }
  await assert.rejects(build([s], { authorize: undefined }), { code: 'T1_RIGHTS_REQUIRED' });
  await assert.rejects(readFile(join(s.root, 'dataset', 'not-created')), { code: 'ENOENT' });
  let retained;
  const result = await build([s], { authorize: request => {
    retained = syntheticApproval(request);
    setImmediate(() => { retained.allow = false; retained.dataHash = 'b'.repeat(64); });
    return retained;
  } });
  assert.equal(retained.allow, false);
  const bundle = await s.recorder.store.unseal(await readFile(result.path));
  assert.equal(bundle.approval.allow, true, 'published grant must be an immutable snapshot of approved fields');
  assert.equal(bundle.approval.dataHash, result.dataHash);
});

test('authorization revoked during asynchronous approval prevents release', async () => {
  const s = await setup();
  await assert.rejects(build([s], { authorize: request => { s.context.allowedTools = []; return syntheticApproval(request); } }), error => /PERMISSION|AUTHORIZ|CONTEXT|TOOLS/.test(error.code));
  assert.equal((await readdir(s.root)).includes('dataset'), false);
  const staged = await setup();
  await assert.rejects(build([staged], { afterStaged: async () => { staged.context.allowedTools = []; } }), error => /PERMISSION|AUTHORIZ|CONTEXT|TOOLS/.test(error.code));
  assert.equal((await readdir(join(staged.root, 'dataset'))).filter(p => p.endsWith('.json')).length, 0);
});

test('prefix whitelist rejects future results and identifiers; raw private objective never enters rows', async () => {
  for (const extra of [{ finalStatus: 'completed' }, { financialGold: true }, { taskId: 'identity-canary' }, { futureObservation: {} }]) assert.throws(() => oracle({ ...input('present'), ...extra }), { code: 'T1_PREFIX_SCHEMA' });
  const marker = 'SYNTHETIC_PRIVATE_TEXT_DO_NOT_EXPORT@example.invalid';
  const s = await setup({ objective: marker }); const r = await build([s]);
  assert.equal(r.data.rows.train.length, 1);
  const bytes = stable(r.data); assert.ok(!bytes.includes(marker));
  assert.ok(!/requestId|resultHash|snapshotHash|status|Bearer|https:|@/.test(bytes));
});

test('contradictory targets are quarantined even with distinct identities', () => {
  const a = { snapshotHash: 'a', split: 'train', inputHash: 'same', targetHash: 'a', clearance: { family: 'a', entity: 'a', bodyHashes: [] } };
  const b = { ...a, snapshotHash: 'b', targetHash: 'b', clearance: { family: 'b', entity: 'b', bodyHashes: [] } };
  const p = partition([a, b]); assert.equal(p.accepted.length, 0); assert.ok(p.rejected.every(r => r.reason === 'T1_CONTRADICTORY_TARGET'));
});

test('tampered exported audit is rejected rather than silently replaced', async () => {
  const s = await setup(), r = await build([s]), original = await readFile(r.path);
  await writeFile(join(s.root, 'original-export.private'), original, { flag: 'wx', mode: 0o600 });
  await writeFile(r.path, original.toString().replace('not-evaluated', 'verified-fact'));
  await assert.rejects(build([s]), error => /INTEGRITY|SIGNATURE/.test(error.code));
});

test('real SIGKILL before publication leaves no sample; explicit lock recovery publishes exactly once', async t => {
  const s = await setup(), outputRoot = join(s.root, 'dataset'), handoff = join(s.root, 'handoff.private');
  await writeFile(handoff, JSON.stringify({ root: s.root, loop: { id: s.loop.id }, context: s.context, fixture: s.fixture, capture: s.capture, split: 'train', outputRoot }), { mode: 0o600, flag: 'wx' });
  const child = fork(fileURLToPath(new URL('./crash-worker.mjs', import.meta.url)), [handoff], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const staged = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('worker exited before staged: ' + stderr); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('worker stage timeout')), 15000); timer.unref(); })]);
  assert.equal(staged[0].phase, 'staged'); const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  assert.equal(child.signalCode, 'SIGKILL');
  assert.equal((await readdir(outputRoot)).filter(p => p.endsWith('.json')).length, 0);
  const restarted = { ...s, ...s.restart() };
  await assert.rejects(build([restarted]), { code: 'TASK_BUSY' });
  await restarted.runtime.store.recoverLock(s.loop.id);
  const recovered = await build([restarted]), repeated = await build([restarted]);
  assert.equal(recovered.data.rows.train.length, 1); assert.equal(repeated.deduplicated, true);
  assert.equal((await readdir(outputRoot)).filter(p => p.endsWith('.json')).length, 1);
  assert.equal(s.fake.wire.length, 2); assert.equal(restarted.runtime.modelApi.calls, 0);
  cases.push({ experiment: 'SIGKILL-before-publication', signal: child.signalCode, recovered: recovered.artifactHash, callsAfterRecovery: restarted.runtime.modelApi.calls });
});

test.after(async () => { await writeFile(new URL('../../../validation/t1-cases.json', import.meta.url), JSON.stringify({ version: 'flowcredit.t1-experiment/v1', cases, realTeacherCalls: 0, trainingRuns: 0 }, null, 2), { flag: 'wx', mode: 0o600 }); });
