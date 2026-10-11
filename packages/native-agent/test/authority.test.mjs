import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/task-store.mjs';
import { NativeHarness } from '../src/harness.mjs';
import { createModelApi } from '../src/model-api.mjs';
import { createEvidenceTools, TOOL_NAMES } from '../src/tools.mjs';
import { seedFixture, GOOD_PLAN, MODEL_GRANT } from '../src/fixtures.mjs';
import { RuntimeError } from '../src/contracts.mjs';

const workRoot = fileURLToPath(new URL('../../../work/', import.meta.url));
const clonePlan = () => structuredClone(GOOD_PLAN);
const zeroTools = tools => assert.deepEqual(tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });

async function setup(t, { plan = clonePlan(), toolWrapper, apiWrapper } = {}) {
  await mkdir(workRoot, { recursive: true });
  const root = await mkdtemp(join(workRoot, 'authority-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await seedFixture(root);
  const store = new TaskStore(join(root, 'tasks'));
  const modelApi = createModelApi({ responses: [plan] });
  const tools = createEvidenceTools({ service: fixture.service });
  const harness = new NativeHarness({ store, modelApi: apiWrapper ? apiWrapper(modelApi) : modelApi, tools: toolWrapper ? toolWrapper(tools) : tools });
  const task = await harness.create({ assessmentId: fixture.assessmentId, objective: 'Offline synthetic fixture research', context: fixture.context, modelGrant: MODEL_GRANT });
  return { root, ...fixture, store, modelApi, tools, harness, task };
}

async function assertAccessDenied(env, context, code, options = {}) {
  const prior = await env.store.load(env.task.id);
  const namesBefore = await readdir(join(env.store.root, 'audit')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  await assert.rejects(env.harness.run(env.task.id, context, options), error => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, code);
    assert.equal(error.receipt.status, 'denied');
    assert.equal(error.receipt.errorCode, code);
    assert.equal(error.receipt.taskId, env.task.id);
    return true;
  });
  assert.deepEqual(await env.store.load(env.task.id), prior, 'Unauthorized access must not change legitimate task state');
  const added = (await readdir(join(env.store.root, 'audit'))).filter(name => !namesBefore.includes(name));
  assert.equal(added.length, 1);
  const audit = JSON.parse(await readFile(join(env.store.root, 'audit', added[0]), 'utf8'));
  assert.equal(audit.errorCode, code);
  return audit;
}

test('unknown tool denies the entire plan before its valid first step executes', async t => {
  const plan = clonePlan(); plan.steps[1].tool = 'system.exec';
  const env = await setup(t, { plan });
  const result = await env.harness.run(env.task.id, env.context);
  assert.equal(result.status, 'denied');
  assert.equal(result.failure.code, 'TOOL_NOT_REGISTERED');
  assert.equal(result.failure.retryable, false);
  assert.ok(result.events.some(event => event.type === 'tool_denied' && event.detail.code === 'TOOL_NOT_REGISTERED'));
  zeroTools(env.tools);
  assert.equal(env.modelApi.calls, 1);
  await assert.rejects(env.harness.run(env.task.id, env.context, { resume: true }), error => error.code === 'TASK_NOT_RECOVERABLE');
  zeroTools(env.tools);
});

test('model-supplied assessment, capability, permission and URL arguments cannot alter scope', async t => {
  for (const argumentsValue of [
    { assessmentId: `ea-${'a'.repeat(64)}` },
    { accessToken: 'model-invented-capability' },
    { permissions: { riskCalculation: true } },
    { url: 'https://model-invented.invalid/source' }
  ]) {
    const plan = clonePlan(); plan.steps[1].arguments = argumentsValue;
    const env = await setup(t, { plan });
    const result = await env.harness.run(env.task.id, env.context);
    assert.equal(result.status, 'denied');
    assert.equal(result.failure.code, 'TOOL_ARGUMENTS_DENIED');
    zeroTools(env.tools);
  }
});

test('formal financial result and execution permissions in a model plan fail schema validation', async t => {
  const extraResult = clonePlan(); extraResult.riskGrade = 'A'; extraResult.CCI = 999;
  const extraRights = clonePlan(); extraRights.steps[0].permissions = ['riskCalculation'];
  for (const plan of [extraResult, extraRights]) {
    const env = await setup(t, { plan });
    const result = await env.harness.run(env.task.id, env.context);
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.code, 'MODEL_SCHEMA_INVALID');
    assert.equal(result.model.receipt.errorCode, 'MODEL_SCHEMA_INVALID');
    assert.ok(result.events.some(event => event.type === 'model_failed'));
    zeroTools(env.tools);
  }
});

test('another principal is denied with an audit receipt and cannot poison task state', async t => {
  const env = await setup(t);
  await assertAccessDenied(env, { ...env.context, principal: 'different-researcher' }, 'TASK_OWNER_DENIED');
  zeroTools(env.tools);
  assert.equal(env.modelApi.calls, 0);
  assert.equal((await env.harness.run(env.task.id, env.context)).status, 'succeeded');
});

test('missing and another assessment capability deny before model or tool execution', async t => {
  const env = await setup(t);
  const other = await env.service.create({ target: 'MiniMax', profile: 'public-context' }, { authorization: env.context.authorization });
  for (const accessToken of [undefined, other.assessmentAccessToken]) {
    await assertAccessDenied(env, { ...env.context, accessToken }, 'ASSESSMENT_NOT_FOUND');
    zeroTools(env.tools);
    assert.equal(env.modelApi.calls, 0);
  }
  assert.equal((await env.harness.run(env.task.id, env.context)).status, 'succeeded');
});

test('changed credential context fails even when task principal and capability match', async t => {
  const env = await setup(t);
  await assertAccessDenied(env, { ...env.context, authorization: 'different-synthetic-credential' }, 'ASSESSMENT_NOT_FOUND');
  zeroTools(env.tools);
  assert.equal(env.modelApi.calls, 0);
});

test('resuming with fewer permitted tools denies without repeating a completed step', async t => {
  const env = await setup(t);
  const paused = await env.harness.run(env.task.id, env.context, { pauseAfterSteps: 1 });
  assert.equal(paused.status, 'paused');
  assert.deepEqual(env.tools.counts, { 'evidence.read': 1, 'evidence.assess': 0 });
  const denied = await env.harness.run(env.task.id, { ...env.context, allowedTools: [TOOL_NAMES[0]] }, { resume: true });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.failure.code, 'TOOL_PERMISSION_DENIED');
  assert.equal(denied.steps[0].status, 'succeeded');
  assert.deepEqual(env.tools.counts, { 'evidence.read': 1, 'evidence.assess': 0 });
  assert.equal(env.modelApi.calls, 1);
  assert.ok(denied.events.some(event => event.type === 'task_paused'));
  assert.ok(denied.events.some(event => event.type === 'tool_denied'));
});

test('a malformed string tool policy cannot authorize names by substring matching', async t => {
  const env = await setup(t);
  const result = await env.harness.run(env.task.id, { ...env.context, allowedTools: 'evidence.read,evidence.assess.audit' });
  assert.equal(result.status, 'denied');
  assert.equal(result.failure.code, 'TOOL_PERMISSION_DENIED');
  zeroTools(env.tools);
});

test('restored owner capability can safely resume after an unauthorized attempt', async t => {
  const env = await setup(t);
  await env.harness.run(env.task.id, env.context, { pauseAfterSteps: 1 });
  await assertAccessDenied(env, { ...env.context, accessToken: undefined }, 'ASSESSMENT_NOT_FOUND', { resume: true });
  const completed = await env.harness.run(env.task.id, env.context, { resume: true });
  assert.equal(completed.status, 'succeeded');
  assert.deepEqual(env.tools.counts, { 'evidence.read': 1, 'evidence.assess': 1 });
  assert.equal(env.modelApi.calls, 1);
  assert.equal(completed.result.assessment.riskGrade, null);
  assert.equal(completed.result.assessment.CCI, null);
  assert.equal(completed.result.assessment.vetoApplied, false);
});

test('new Evidence revision blocks a saved checkpoint instead of validating stale results', async t => {
  const env = await setup(t);
  await env.harness.run(env.task.id, env.context, { pauseAfterSteps: 1 });
  await env.service.continue(env.assessmentId, { expectedRevision: 1, draft: { payingCustomers: 10 } }, { authorization: env.context.authorization, accessToken: env.context.accessToken });
  await assertAccessDenied(env, env.context, 'EVIDENCE_CONTEXT_CHANGED', { resume: true });
  assert.deepEqual(env.tools.counts, { 'evidence.read': 1, 'evidence.assess': 0 });
  assert.equal(env.modelApi.calls, 1);
});

test('corrupted saved raw evidence fails closed on resume with no replacement claim', async t => {
  const env = await setup(t);
  await env.harness.run(env.task.id, env.context, { pauseAfterSteps: 1 });
  const record = await env.service.read(env.assessmentId, env.context.authorization, env.context.accessToken);
  const snapshot = join(env.root, 'evidence', 'snapshots', `${record.sources[0].contentHash}.txt`);
  await writeFile(snapshot, 'Explicitly tampered synthetic financial evidence');
  await assertAccessDenied(env, env.context, 'SOURCE_INTEGRITY_FAILURE', { resume: true });
  assert.deepEqual(env.tools.counts, { 'evidence.read': 1, 'evidence.assess': 0 });
});

test('a forged tool result with authoritative scores is rejected by independent recomputation', async t => {
  const env = await setup(t, { toolWrapper: tools => ({
    ...tools,
    async execute(step, context, task, signal) {
      const result = await tools.execute(step, context, task, signal);
      if (step.tool === 'evidence.assess') {
        result.assessment.CCI = 999;
        result.assessment.riskGrade = 'A';
        result.assessment.vetoApplied = true;
      }
      return result;
    }
  }) });
  const result = await env.harness.run(env.task.id, env.context);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'RESULT_VERIFICATION_FAILED');
  assert.equal(result.result, null);
  assert.ok(result.events.some(event => event.type === 'verification_failed'));
  const canonical = await env.service.read(env.assessmentId, env.context.authorization, env.context.accessToken);
  assert.equal(canonical.assessment.CCI, null);
  assert.equal(canonical.assessment.riskGrade, null);
  assert.equal(canonical.assessment.vetoApplied, false);
});

test('task prompts, checkpoints and audit records exclude trusted context secrets', async t => {
  let observedPrompt;
  const env = await setup(t, { apiWrapper: api => ({
    ...api,
    async plan(request) { observedPrompt = request.prompt; return api.plan(request); }
  }) });
  await env.harness.run(env.task.id, env.context);
  await assertAccessDenied(env, { ...env.context, principal: 'unauthorized-reader' }, 'TASK_OWNER_DENIED');
  const checkpoint = await readFile(join(env.store.checkpoints, `${env.task.id}.json`), 'utf8');
  const audits = await Promise.all((await readdir(join(env.store.root, 'audit'))).map(name => readFile(join(env.store.root, 'audit', name), 'utf8')));
  for (const content of [observedPrompt, checkpoint, ...audits]) {
    assert.equal(content.includes(env.context.accessToken), false);
    assert.equal(content.includes(env.context.authorization), false);
  }
});
