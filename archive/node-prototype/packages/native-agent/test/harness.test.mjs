import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NativeHarness } from '../src/harness.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { createModelApi } from '../src/model-api.mjs';
import { createEvidenceTools } from '../src/tools.mjs';
import { seedFixture, offlineService, GOOD_PLAN, MODEL_GRANT } from '../src/fixtures.mjs';
import { RuntimeError } from '../src/contracts.mjs';
import { digest } from '../src/baseline.mjs';

const scratch = fileURLToPath(new URL('../../../work/', import.meta.url));
async function setup(t, options = {}) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'native-harness-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await seedFixture(root);
  const store = new TaskStore(join(root, 'tasks'));
  const api = createModelApi({ responses: options.responses || [GOOD_PLAN] });
  const tools = createEvidenceTools({ service: fixture.service, beforeExecute: options.beforeExecute });
  const harness = new NativeHarness({ store, modelApi: api, tools });
  const task = await harness.create({ assessmentId: fixture.assessmentId, objective: 'Inspect the synthetic financial fixture and calculate disclosed ratios.', context: fixture.context, modelGrant: MODEL_GRANT });
  return { root, store, api, tools, harness, task, ...fixture };
}
function restart(s) {
  const store = new TaskStore(join(s.root, 'tasks'));
  const api = createModelApi({ responses: [] });
  const tools = createEvidenceTools({ service: offlineService(s.root) });
  return { store, api, tools, harness: new NativeHarness({ store, modelApi: api, tools }) };
}
function crash(s, crashAt = 'tool_started') {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-worker.mjs', import.meta.url))], {
    input: JSON.stringify({ root: s.root, id: s.task.id, context: s.context, crashAt }),
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, NODE_ENV: 'test' }
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 86, child.stderr);
  return child;
}

test('mock plan executes real Evidence parser, authority and deterministic finance', async t => {
  const s = await setup(t);
  const result = await s.harness.run(s.task.id, s.context);
  assert.equal(result.status, 'succeeded');
  assert.equal(s.api.calls, 1);
  assert.deepEqual(s.tools.counts, { 'evidence.read': 1, 'evidence.assess': 1 });
  const assessment = result.result.assessment;
  assert.equal(assessment.calculations.find(item => item.id.startsWith('gross-margin')).value, 17.85);
  assert.equal(assessment.calculations.find(item => item.id.startsWith('current-ratio')).value, 3.94);
  assert.equal(assessment.CCI, null);
  assert.equal(assessment.riskGrade, null);
  assert.equal(assessment.vetoApplied, false);
  assert.equal(result.result.assessmentHash, digest(assessment));
  assert.equal(result.result.dataKind, 'synthetic-offline-fixture');
  const checkpoint = await readFile(join(s.root, 'tasks', 'checkpoints', `${s.task.id}.json`), 'utf8');
  assert.equal(checkpoint.includes(s.context.accessToken), false);
  assert.equal(checkpoint.includes(s.context.authorization), false);
});

test('transient tool failure is retained and a new instance skips succeeded steps', async t => {
  const s = await setup(t, { beforeExecute: async ({ step }) => {
    if (step.tool === 'evidence.assess') throw new RuntimeError('TOOL_TEMPORARY_FAILURE');
  } });
  const failed = await s.harness.run(s.task.id, s.context);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.retryable, true);
  assert.deepEqual(failed.steps.map(step => step.status), ['succeeded', 'failed']);
  const fresh = restart(s);
  const recovered = await fresh.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(recovered.status, 'succeeded');
  assert.deepEqual(fresh.tools.counts, { 'evidence.read': 0, 'evidence.assess': 1 });
  assert.deepEqual(recovered.steps.map(step => step.attempts), [1, 2]);
  assert.equal(fresh.api.calls, 0);
  assert(recovered.events.some(event => event.type === 'tool_failed'));
  assert(recovered.events.some(event => event.type === 'recovery_authorized'));
});

test('unregistered action is denied before any tool runs and cannot be auto-retried', async t => {
  const plan = structuredClone(GOOD_PLAN);
  plan.steps.splice(1, 0, { id: 'transfer', tool: 'money.transfer', arguments: {} });
  const s = await setup(t, { responses: [plan] });
  const denied = await s.harness.run(s.task.id, s.context);
  assert.equal(denied.status, 'denied');
  assert.equal(denied.failure.code, 'TOOL_NOT_REGISTERED');
  assert.deepEqual(s.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
  assert(denied.events.some(event => event.type === 'tool_denied'));
  await assert.rejects(s.harness.run(s.task.id, s.context, { resume: true }), { code: 'TASK_NOT_RECOVERABLE' });
});

test('forged result fields fail Model API schema rather than entering verification', async t => {
  const s = await setup(t, { responses: [{ ...GOOD_PLAN, CCI: 999, authority: { riskCalculation: true } }] });
  const failed = await s.harness.run(s.task.id, s.context);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.code, 'MODEL_SCHEMA_INVALID');
  assert.equal(failed.result, null);
  assert.equal(failed.model.attempts, 1);
  assert.equal(failed.model.receipt.status, 'failed');
});

test('model transport failure consumes reserved attempt and remains failed', async t => {
  const s = await setup(t, { responses: [{ transportError: 'MODEL_HTTP_ERROR' }] });
  const failed = await s.harness.run(s.task.id, s.context);
  assert.equal(failed.failure.code, 'MODEL_HTTP_ERROR');
  assert.equal(failed.model.attempts, 1);
  assert.equal(failed.model.receipt.errorCode, 'MODEL_HTTP_ERROR');
  await assert.rejects(s.harness.run(s.task.id, s.context, { resume: true }), { code: 'TASK_NOT_RECOVERABLE' });
});

test('Evidence revision drift blocks resume without overwriting previous progress', async t => {
  const s = await setup(t);
  const paused = await s.harness.run(s.task.id, s.context, { pauseAfterSteps: 1 });
  await s.service.continue(s.assessmentId, { expectedRevision: 1, draft: { revenueUsd: 100 } }, { authorization: s.context.authorization, accessToken: s.context.accessToken });
  const fresh = restart(s);
  await assert.rejects(fresh.harness.run(s.task.id, s.context, { resume: true }), { code: 'EVIDENCE_CONTEXT_CHANGED' });
  const retained = await fresh.store.load(s.task.id);
  assert.equal(retained.sequence, paused.sequence);
  assert.equal(retained.status, 'paused');
  assert.equal(fresh.api.calls, 0);
});

test('incomplete valid plan fails final verification', async t => {
  const plan = { ...GOOD_PLAN, steps: [GOOD_PLAN.steps[0]] };
  const s = await setup(t, { responses: [plan] });
  const failed = await s.harness.run(s.task.id, s.context);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.code, 'RESULT_INCOMPLETE');
  assert.equal(failed.result, null);
});

test('checkpoint result and event forgery is detected without model rerun', async t => {
  const s = await setup(t);
  await s.harness.run(s.task.id, s.context, { pauseAfterSteps: 1 });
  const checkpoint = join(s.root, 'tasks', 'checkpoints', `${s.task.id}.json`);
  const envelope = JSON.parse(await readFile(checkpoint, 'utf8'));
  // Modifying signed bytes must fail before any runtime or model work.
  const modified = JSON.stringify(envelope).replace('paused', 'succeeded');
  await writeFile(checkpoint, modified, { mode: 0o600 });
  await assert.rejects(restart(s).harness.run(s.task.id, s.context, { resume: true }), { code: 'TASK_INTEGRITY_FAILURE' });
});

test('real child process exits after tool intent; dead task lock recovery skips completed read', async t => {
  const s = await setup(t);
  await s.harness.run(s.task.id, s.context, { pauseAfterSteps: 1 });
  crash(s);
  const interrupted = await s.store.load(s.task.id);
  assert.equal(interrupted.status, 'running');
  assert.deepEqual(interrupted.steps.map(step => step.status), ['succeeded', 'started']);
  const fresh = restart(s);
  await assert.rejects(fresh.harness.run(s.task.id, s.context, { resume: true }), { code: 'TASK_BUSY' });
  await fresh.store.recoverLock(s.task.id);
  const recovered = await fresh.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(recovered.status, 'succeeded');
  assert.deepEqual(recovered.steps.map(step => step.attempts), [1, 2]);
  assert.deepEqual(fresh.tools.counts, { 'evidence.read': 0, 'evidence.assess': 1 });
  assert.equal(fresh.api.calls, 0);
});

test('real child crash after model reservation blocks unknown outcome and does not reissue', async t => {
  const s = await setup(t);
  crash(s, 'model_started');
  const fresh = restart(s);
  await fresh.store.recoverLock(s.task.id);
  const blocked = await fresh.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(blocked.status, 'recovery-required');
  assert.equal(blocked.failure.code, 'MODEL_OUTCOME_UNKNOWN');
  assert.equal(blocked.model.attempts, 1);
  assert.equal(fresh.api.calls, 0);
  assert.equal(blocked.result, null);
});

test('aborted tool work is recorded and requires an explicit retry', async t => {
  const s = await setup(t);
  await s.harness.run(s.task.id, s.context, { pauseAfterSteps: 1 });
  const controller = new AbortController(); controller.abort();
  const failed = await s.harness.run(s.task.id, s.context, { resume: true, signal: controller.signal });
  assert.equal(failed.failure.code, 'TASK_ABORTED');
  assert.equal(failed.failure.retryable, true);
  assert.equal(failed.steps[0].attempts, 1);
});

test('read-only interrupted steps have a bounded retry limit', async t => {
  const s = await setup(t, { beforeExecute: async ({ step }) => {
    if (step.tool === 'evidence.assess') throw new RuntimeError('TOOL_TEMPORARY_FAILURE');
  } });
  await s.harness.run(s.task.id, s.context);
  await s.harness.run(s.task.id, s.context, { resume: true });
  await s.harness.run(s.task.id, s.context, { resume: true });
  const stopped = await s.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(stopped.failure.code, 'TOOL_RETRY_LIMIT');
  assert.equal(stopped.failure.retryable, false);
  assert.deepEqual(stopped.steps.map(step => step.attempts), [1, 3]);
});
