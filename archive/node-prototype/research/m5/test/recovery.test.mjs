import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecoveringDurableTaskStore } from '../../../packages/native-agent/src/recovery-store.mjs';
import { publishBytes } from '../../../packages/native-agent/src/durable-io.mjs';
import { digest } from '../../../packages/native-agent/src/baseline.mjs';
import { TASK_VERSION, TOOL_VERSION, PLAN_VERSION } from '../../../packages/native-agent/src/contracts.mjs';

const scratch = fileURLToPath(new URL('../../../work/m5/', import.meta.url));
const records = [];

async function setup(t) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'recovery-'));
  const tasks = join(root, 'tasks'), witness = join(root, 'witness');
  const store = new RecoveringDurableTaskStore(tasks, { witnessRoot: witness });
  const id = `task-${'a'.repeat(32)}`;
  await store.create({
    id, sequence: 0, version: TASK_VERSION, toolVersion: TOOL_VERSION, planVersion: PLAN_VERSION,
    status: 'created', principalHash: digest('principal'), objective: 'synthetic recovery fixture',
    binding: { assessmentId: 'assessment', revision: 1, sourcesHash: digest('s'), assessmentHash: digest('a') },
    allowedTools: [], modelGrant: { allowedAdapters: ['mock'], maxCalls: 1, allowPaid: false, maxCostMicrousd: 0 },
    model: { attempts: 0, status: 'not-started', receipt: null },
    plan: null, steps: [], events: [], failure: null, result: null
  });
  t.after(() => { records.push({ test: t.name, root, taskId: id }); });
  return { root, tasks, witness, store, id };
}
const reopen = ({ tasks, witness }) => new RecoveringDurableTaskStore(tasks, { witnessRoot: witness });

test('M5 an unattested history entry is fatal for load but repairable by explicit recovery', async t => {
  const fixture = await setup(t);
  const history = join(fixture.tasks, 'history', fixture.id);
  await copyFile(join(history, '0.json'), join(history, '1.json'));

  // A fresh instance has an empty cache, which is exactly the post-crash state.
  const after = reopen(fixture);
  await assert.rejects(after.load(fixture.id), { code: 'M1_HISTORY_AHEAD' });

  const repaired = await after.recoverLatest(fixture.id);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.quarantined, 1);
  assert.equal(repaired.sequence, 0);
  assert.equal(repaired.recovered, false);
  assert.equal((await after.load(fixture.id)).sequence, 0);
  assert.deepEqual(await readdir(join(fixture.tasks, 'quarantine', fixture.id)), ['1.json']);
  assert.equal((await readdir(history)).join(','), '0.json');
});

test('M5 the quarantine preserves exact bytes and seals a recovery record', async t => {
  const fixture = await setup(t);
  const history = join(fixture.tasks, 'history', fixture.id);
  await copyFile(join(history, '0.json'), join(history, '2.json'));
  const original = await readFile(join(history, '2.json'), 'utf8');

  await reopen(fixture).recoverLatest(fixture.id);

  assert.equal(await readFile(join(fixture.tasks, 'quarantine', fixture.id, '2.json'), 'utf8'), original);
  const evidence = await readdir(join(fixture.tasks, 'recovery-evidence'));
  assert.equal(evidence.length, 1);
  const sealed = JSON.parse(await readFile(join(fixture.tasks, 'recovery-evidence', evidence[0]), 'utf8'));
  assert.deepEqual(Object.keys(sealed).sort(), ['payload', 'signature']);
  assert.equal(sealed.payload.version, 'flowcredit.durable-recovery/m5-v1');
  assert.equal(sealed.payload.quarantined.length, 1);
  assert.equal(sealed.payload.quarantined[0].hash, digest(original));
});

test('M5 repair is idempotent and leaves a clean history untouched', async t => {
  const fixture = await setup(t);
  const after = reopen(fixture);
  const first = await after.repairHistory(fixture.id);
  assert.equal(first.repaired, false);
  assert.deepEqual(first.quarantined, []);
  const second = await after.recoverLatest(fixture.id);
  assert.equal(second.repaired, false);
  assert.equal(second.quarantined, 0);
  assert.equal((await readdir(join(fixture.tasks, 'recovery-evidence')).catch(() => [])).length, 0);
});

test('M5 the verified cache is populated, reused and advanced by commit', async t => {
  const fixture = await setup(t);
  const first = await fixture.store.load(fixture.id);
  assert.equal(fixture.store.verified.size, 1);
  assert.equal(digest(first), digest(await fixture.store.load(fixture.id)));

  const at = '2026-10-19T00:00:00.000Z';
  const data = { sequence: 1, type: 'm5_test', at, detail: {}, previousHash: null };
  const next = { ...structuredClone(first), sequence: 1, events: [{ ...data, hash: digest(data) }] };
  await fixture.store.save(next, 0);

  assert.equal((await fixture.store.anchored(fixture.id)).task.sequence, 1);
  assert.equal((await fixture.store.load(fixture.id)).sequence, 1);
  assert.equal(fixture.store.verified.get(fixture.id).task.sequence, 1);
});

test('M5 the cache is process-local so a restart still verifies the whole chain', async t => {
  const fixture = await setup(t);
  await fixture.store.load(fixture.id);
  const history = join(fixture.tasks, 'history', fixture.id);
  // Rewrite the attested entry after the cached instance already verified it.
  await rm(join(history, '0.json'));
  await publishBytes(join(history, '0.json'), JSON.stringify({ payload: { version: 'x' }, signature: 'y' }), { immutable: true });

  assert.equal((await fixture.store.load(fixture.id)).sequence, 0, 'the live instance answers from its cache');
  await assert.rejects(reopen(fixture).load(fixture.id), { code: 'M1_INTEGRITY_FAILURE' });
});

test.after(async () => {
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, 'recovery-cases.json'), `${JSON.stringify({ version: 'flowcredit.m5-recovery-tests/v1', generatedAt: new Date().toISOString(), records, failuresRetained: true }, null, 2)}\n`);
});
