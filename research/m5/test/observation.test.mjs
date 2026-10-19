import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createObservableRuntime } from '../../../packages/native-agent/src/observable-runtime.mjs';
import { createEvidenceTools } from '../../../packages/native-agent/src/tools.mjs';
import { seedFixture, MODEL_GRANT } from '../../../packages/native-agent/src/fixtures.mjs';

const scratch = fileURLToPath(new URL('../../../work/m5/', import.meta.url));
const records = [];

async function setup(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'observe-'));
  const fixture = await seedFixture(root);
  const runtime = createObservableRuntime(root);
  const task = await runtime.harness.create({ assessmentId: fixture.assessmentId, objective: 'M5 synthetic observation projection', context: fixture.context, modelGrant: MODEL_GRANT });
  t.after(() => { records.push({ test: t.name, root, taskId: task.id }); });
  return { root, ...fixture, ...runtime, task };
}
const readStep = task => task.steps.find(step => step.tool === 'evidence.read');

test('M5 evidence.read returns the values a conclusion needs, not only fact ids', async t => {
  const fixture = await setup(t);
  const done = await fixture.harness.run(fixture.task.id, fixture.context);
  assert.equal(done.status, 'succeeded');

  const observation = readStep(done).result;
  assert.ok(Array.isArray(observation.facts) && observation.facts.length > 0);
  assert.deepEqual(observation.facts.map(fact => fact.id), observation.factIds, 'the accepted factIds projection is preserved');

  const revenue = observation.facts.find(fact => fact.metric === 'revenue');
  assert.equal(typeof revenue.value, 'number');
  assert.equal(revenue.unit, 'USD');
  assert.equal(revenue.period.kind, 'duration');
  assert.equal(revenue.scope, 'entity-total');
  assert.equal(revenue.basis, 'issuer-disclosed-IFRS');
  assert.equal(revenue.status, 'supported');
  assert.ok(revenue.sourceIds.length > 0);
});

test('M5 the fact summary excludes audit-only blocks so it stays within a prompt', async t => {
  const fixture = await setup(t);
  const done = await fixture.harness.run(fixture.task.id, fixture.context);
  const observation = readStep(done).result;

  for (const fact of observation.facts) {
    for (const excluded of ['authority', 'binding', 'observationDecisions', 'alternatives']) assert.equal(Object.hasOwn(fact, excluded), false, excluded);
    assert.deepEqual(Object.keys(fact).sort(), ['basis', 'id', 'metric', 'period', 'scope', 'sourceIds', 'status', 'unit', 'value']);
  }
  const bytes = Buffer.byteLength(JSON.stringify(observation));
  assert.ok(bytes < 8192, `observation must stay small enough for a prompt, got ${bytes}`);
});

test('M5 the observable tools verify their own projection and keep the authority assertion', async t => {
  const fixture = await setup(t);
  const done = await fixture.harness.run(fixture.task.id, fixture.context);
  const verified = await fixture.tools.verify(done, fixture.context);
  assert.equal(verified.verification, 'runtime-recomputed');
  assert.equal(verified.assessment.TAI, null);
  assert.equal(verified.assessment.vetoApplied, false);
});

test('M5 a tampered observation is rejected by the observable verifier', async t => {
  const fixture = await setup(t);
  const done = await fixture.harness.run(fixture.task.id, fixture.context);
  const forged = structuredClone(done);
  readStep(forged).result.facts[0].value = 1;
  await assert.rejects(fixture.tools.verify(forged, fixture.context), { code: 'RESULT_VERIFICATION_FAILED' });
});

test('M5 the accepted projection is unchanged for callers that still use it', async t => {
  const fixture = await setup(t);
  const base = createEvidenceTools({ service: fixture.service });
  const record = await fixture.service.read(fixture.assessmentId, fixture.context.authorization, fixture.context.accessToken);
  const accepted = await base.execute({ id: 'a', tool: 'evidence.read', arguments: {} }, fixture.context, fixture.task);
  assert.deepEqual(Object.keys(accepted).sort(), ['assessmentId', 'entity', 'factIds', 'revision', 'sources']);
  assert.equal(accepted.factIds.length, record.assessment.facts.length);
});

test.after(async () => {
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, 'observation-cases.json'), `${JSON.stringify({ version: 'flowcredit.m5-observation-tests/v1', generatedAt: new Date().toISOString(), records, failuresRetained: true }, null, 2)}\n`);
});
