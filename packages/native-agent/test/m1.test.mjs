import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, unlink, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createM1Runtime, MOCK_AUTHORIZATION } from '../src/m1-runtime.mjs';
import { seedFixture, GOOD_PLAN, MODEL_GRANT } from '../src/fixtures.mjs';
import { DurableTaskStore, HISTORY_VERSION } from '../src/durable-store.mjs';
import { TaskStore, newTaskId } from '../src/task-store.mjs';
import { makeIntent, RECEIPT_VERSION } from '../src/durable-model-api.mjs';
import { digest } from '../src/baseline.mjs';
import { publishBytes } from '../src/durable-io.mjs';

const scratch = fileURLToPath(new URL('../../../work/m1/', import.meta.url));
const records = [];
test.after(async () => {
  await writeFile(new URL('../validation/m1-cases.json', import.meta.url), `${JSON.stringify({ version: 'flowcredit.m1-tests/v1', generatedAt: new Date().toISOString(), records, failuresRetained: true }, null, 2)}\n`);
});
async function setup(t, options = {}) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'case-'));
  const fixture = await seedFixture(root);
  const runtime = createM1Runtime(root, options);
  const task = await runtime.harness.create({ assessmentId: fixture.assessmentId, objective: 'M1 synthetic evidence and contextual ratios', context: fixture.context, modelGrant: MODEL_GRANT });
  t.after(() => { records.push({ test: t.name, root, taskId: task.id }); });
  return { root, ...fixture, ...runtime, task };
}
function start(args) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./m1-worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(args));
  return { child, output: () => ({ stdout, stderr }) };
}
async function killAt(args) {
  const current = start(args);
  let timer;
  try {
    await Promise.race([
      (async () => {
        while (!current.output().stdout.includes('stoppedAt')) {
          await Promise.race([once(current.child.stdout, 'data'), once(current.child, 'exit').then(() => { throw new Error(JSON.stringify(current.output())); })]);
        }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Crash boundary not reached')), 10000); })
    ]);
    const exited = once(current.child, 'exit'); current.child.kill('SIGKILL');
    const [code, signal] = await exited;
    assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const marker = JSON.parse(current.output().stdout.trim().split('\n')[0]);
    records.push({ crash: args.mode, phase: args.phase || 'model_started', signal, marker, root: args.root });
    return marker;
  } finally { clearTimeout(timer); if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGKILL'); }
}
async function runChild(args) {
  const current = start(args); let timer;
  try {
    const exited = await Promise.race([once(current.child, 'exit'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('worker timeout')), 10000); })]);
    assert.equal(exited[0], 0, current.output().stderr);
    return JSON.parse(current.output().stdout.trim().split('\n').at(-1));
  } finally { clearTimeout(timer); if (current.child.exitCode === null) current.child.kill('SIGKILL'); }
}
async function unlock(s, runtime) {
  await runtime.store.recoverLock(s.task.id);
  const task = await runtime.store.load(s.task.id);
  if (task.model.intent) await runtime.ledgerStore.recoverLock(runtime.modelApi.scopeId(task.model.intent));
  return task;
}
async function prepare(s) {
  const task = await s.store.load(s.task.id);
  task.status = 'planning'; task.model.status = 'started'; task.model.attempts = 1;
  task.model.intent = makeIntent(task, s.harness.promptFor(task), MOCK_AUTHORIZATION);
  await s.store.exclusive(task.id, () => s.harness.checkpoint(task, 'model_started', { intentHash: digest(task.model.intent) }));
  return task;
}
async function unknownWithReceipt(t) {
  const s = await setup(t);
  await killAt({ root: s.root, id: s.task.id, context: s.context, mode: 'api-crash', phase: 'receipt_persisted' });
  const fresh = createM1Runtime(s.root, { responses: [] });
  await unlock(s, fresh);
  const task = await fresh.harness.run(s.task.id, s.context, { resume: true });
  const status = await fresh.modelApi.status(task.model.intent);
  assert.equal(task.status, 'recovery-required'); assert(status.receiptRef);
  return { s, fresh, task, ref: status.receiptRef };
}

test('M1 vertical loop has anchored history, one durable dispatch and matching signed receipt', async t => {
  const s = await setup(t);
  const result = await s.harness.run(s.task.id, s.context);
  assert.equal(result.status, 'succeeded'); assert.equal(s.modelApi.calls, 1);
  assert.equal(result.model.outcome, 'confirmed-valid');
  const receipt = await s.modelApi.readReceipt(result.model.receiptRef, result.model.intent);
  assert.equal(receipt.version, RECEIPT_VERSION); assert.equal(receipt.charge.externalBilling, 'not-verified');
  assert.equal(result.result.assessment.CCI, null);
  assert.equal((await s.store.anchored(result.id)).task.sequence, result.sequence);
  const ledger = await s.ledgerStore.load(s.modelApi.scopeId(result.model.intent));
  assert.equal(ledger.calls.length, 1); assert.equal(ledger.calls[0].reservedCalls, 1);
  assert.equal(ledger.calls[0].status, 'confirmed');
  assert.deepEqual(ledger.events.map(event => event.type), ['call_reserved', 'call_dispatched', 'call_confirmed']);
});

test('same request and reset priorCalls across API instances return one receipt without new dispatch', async t => {
  const s = await setup(t); const task = await prepare(s);
  const first = await s.modelApi.execute({ intent: task.model.intent, prompt: s.harness.promptFor(task), priorCalls: 0 });
  const fresh = createM1Runtime(s.root);
  const second = await fresh.modelApi.execute({ intent: task.model.intent, prompt: fresh.harness.promptFor(task), priorCalls: 0 });
  assert.equal(first.receiptRef, second.receiptRef); assert.equal(s.modelApi.calls, 1); assert.equal(fresh.modelApi.calls, 0);
});

test('two real processes competing for one intent dispatch at most once', async t => {
  const s = await setup(t); await prepare(s);
  const outcomes = await Promise.all([runChild({ root: s.root, id: s.task.id, mode: 'execute' }), runChild({ root: s.root, id: s.task.id, mode: 'execute' })]);
  assert.equal(outcomes.reduce((sum, item) => sum + item.calls, 0), 1);
  assert(outcomes.every(item => !item.errorCode || item.errorCode === 'TASK_BUSY'));
  records.push({ test: t.name, outcomes });
});

test('SIGKILL after task intent with absent call ledger blocks run and direct API dispatch', async t => {
  const s = await setup(t);
  await killAt({ root: s.root, id: s.task.id, context: s.context, mode: 'task-intent' });
  const fresh = createM1Runtime(s.root); await unlock(s, fresh);
  const unknown = await fresh.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(unknown.status, 'recovery-required');
  await assert.rejects(fresh.modelApi.execute({ intent: unknown.model.intent, prompt: fresh.harness.promptFor(unknown) }), { code: 'MODEL_RECONCILIATION_BLOCKED' });
  await assert.rejects(fresh.harness.reconcile(s.task.id, s.context), { code: 'MODEL_RECEIPT_REQUIRED' });
  assert.equal(fresh.modelApi.calls, 0);
});

for (const phase of ['intent_persisted', 'dispatch_persisted', 'adapter_returned']) test(`SIGKILL ${phase}: no matching receipt keeps unknown and never reissues`, async t => {
  const s = await setup(t);
  await killAt({ root: s.root, id: s.task.id, context: s.context, mode: 'api-crash', phase });
  const fresh = createM1Runtime(s.root); await unlock(s, fresh);
  const unknown = await fresh.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(unknown.status, 'recovery-required');
  const status = await fresh.modelApi.status(unknown.model.intent); assert.equal(status.receiptRef, null);
  await assert.rejects(fresh.harness.reconcile(s.task.id, s.context, { receiptRef: '0'.repeat(64) }), { code: 'MODEL_RECEIPT_MISMATCH' });
  await assert.rejects(fresh.modelApi.execute({ intent: unknown.model.intent, prompt: fresh.harness.promptFor(unknown) }), { code: 'MODEL_OUTCOME_UNKNOWN' });
  const ledger = await fresh.ledgerStore.load(fresh.modelApi.scopeId(unknown.model.intent));
  assert.equal(ledger.calls.length, 1); assert.equal(ledger.calls[0].status, 'unknown'); assert.equal(fresh.modelApi.calls, 0);
});

for (const phase of ['receipt_persisted', 'ledger_confirmed']) test(`SIGKILL ${phase}: trusted receipt explicitly reconciles unknown, idempotently`, async t => {
  const s = await setup(t);
  await killAt({ root: s.root, id: s.task.id, context: s.context, mode: 'api-crash', phase });
  const fresh = createM1Runtime(s.root, { responses: [] }); await unlock(s, fresh);
  const unknown = await fresh.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(unknown.status, 'recovery-required');
  const status = await fresh.modelApi.status(unknown.model.intent);
  assert(status.receiptRef);
  const reconciled = await fresh.harness.reconcile(s.task.id, s.context, { receiptRef: status.receiptRef });
  assert.equal(reconciled.status, 'planned'); assert.equal(reconciled.model.outcome, 'confirmed-valid');
  const repeated = await fresh.harness.reconcile(s.task.id, s.context, { receiptRef: status.receiptRef });
  assert.equal(repeated.sequence, reconciled.sequence);
  const result = await fresh.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(result.status, 'succeeded'); assert.equal(fresh.modelApi.calls, 0);
  assert(result.events.some(event => event.type === 'model_unknown'));
  assert(result.events.some(event => event.type === 'model_reconciled'));
});

test('concurrent reconciliation shares one persisted result and no extra task event', async t => {
  const { s, fresh, ref } = await unknownWithReceipt(t);
  const other = createM1Runtime(s.root, { responses: [] });
  const results = await Promise.all([fresh.harness.reconcile(s.task.id, s.context, { receiptRef: ref }), other.harness.reconcile(s.task.id, s.context, { receiptRef: ref })]);
  assert.equal(results[0].sequence, results[1].sequence);
  assert.equal((await fresh.store.load(s.task.id)).events.filter(event => event.type === 'model_reconciled').length, 1);
  assert.equal(fresh.modelApi.calls + other.modelApi.calls, 0);
});

test('timeout, HTTP uncertainty and in-flight abort retain reservations and cannot reconcile without result', async t => {
  for (const code of ['MODEL_TIMEOUT', 'MODEL_HTTP_ERROR']) {
    const s = await setup(t, { responses: [{ transportError: code }] });
    const task = await s.harness.run(s.task.id, s.context);
    assert.equal(task.status, 'recovery-required'); assert.equal(task.model.status, 'unknown');
    const status = await s.modelApi.status(task.model.intent); assert.equal(status.receiptRef, null); assert.equal(status.reservedCalls, 1);
    await assert.rejects(s.harness.reconcile(task.id, s.context), { code: 'MODEL_RECEIPT_REQUIRED' });
    const fresh = createM1Runtime(s.root); assert.equal((await fresh.harness.run(task.id, s.context)).status, 'recovery-required'); assert.equal(fresh.modelApi.calls, 0);
  }
  const controller = new AbortController();
  let abortTimer;
  t.after(() => clearInterval(abortTimer));
  const s = await setup(t, { responses: [{ transportError: 'MODEL_TIMEOUT' }], afterApiPhase: phase => {
    if (phase === 'dispatch_persisted') abortTimer = setInterval(() => {
      if (s.modelApi.calls === 1) { clearInterval(abortTimer); controller.abort(); }
    }, 1);
  } });
  const result = await s.harness.run(s.task.id, s.context, { signal: controller.signal });
  assert.equal(result.status, 'recovery-required'); assert.equal((await s.modelApi.status(result.model.intent)).reservedCalls, 1);
  assert.equal(s.modelApi.calls, 1, 'Abort must happen after the mock transport has started');
  const ledger = await s.ledgerStore.load(s.modelApi.scopeId(result.model.intent));
  assert.equal(ledger.calls[0].errorCode, 'MODEL_ABORTED');
});

test('fully received invalid model JSON is confirmed invalid, not retried or executed', async t => {
  const s = await setup(t, { responses: [{ ...GOOD_PLAN, CCI: 999 }] });
  const result = await s.harness.run(s.task.id, s.context);
  assert.equal(result.status, 'failed'); assert.equal(result.model.outcome, 'confirmed-invalid');
  assert.equal(result.failure.code, 'MODEL_SCHEMA_INVALID');
  const receipt = await s.modelApi.readReceipt(result.model.receiptRef, result.model.intent);
  assert.equal(receipt.plan, null); assert.equal(s.modelApi.calls, 1);
  assert.deepEqual(s.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
  await assert.rejects(s.harness.run(result.id, s.context, { resume: true }), { code: 'TASK_NOT_RECOVERABLE' });
});

test('receipt signature, version, issuer, result and every intent binding are checked', async t => {
  const { s, fresh, task, ref } = await unknownWithReceipt(t);
  const path = join(fresh.ledgerStore.root, 'receipts', `${ref}.json`);
  const original = await readFile(path, 'utf8');
  const sealed = JSON.parse(original); sealed.payload.plan.steps[0].id = 'tampered';
  await writeFile(path, JSON.stringify(sealed), { mode: 0o600 });
  await assert.rejects(fresh.harness.reconcile(s.task.id, s.context, { receiptRef: ref }), { code: 'MODEL_RECEIPT_UNTRUSTED' });
  await writeFile(path, original, { mode: 0o600 });
  const payload = await fresh.ledgerStore.unseal(Buffer.from(original));
  const mutations = [
    value => { value.version = 'future-v999'; }, value => { value.issuer = 'wrong-issuer'; },
    value => { value.planHash = '0'.repeat(64); }, value => { value.charge = null; },
    ...['requestId', 'taskId', 'principalHash', 'promptHash', 'contractVersion', 'bindingHash', 'toolPolicyHash', 'grantId', 'grantHash', 'authorizationHash', 'adapter', 'model'].map(field => value => { value.intent[field] = 'mismatched'; value.intentHash = digest(value.intent); })
  ];
  for (const mutate of mutations) {
    const value = structuredClone(payload); mutate(value);
    // Test the verifier against malformed but locally signed host data as well
    // as untrusted byte tampering; this is not a model's signing capability.
    await writeFile(path, JSON.stringify(await fresh.ledgerStore.seal(value)), { mode: 0o600 });
    await assert.rejects(fresh.harness.reconcile(s.task.id, s.context, { receiptRef: ref }), { code: 'MODEL_RECEIPT_MISMATCH' });
    assert.equal((await fresh.store.load(s.task.id)).sequence, task.sequence);
  }
  await writeFile(path, original, { mode: 0o600 });
  assert.equal((await fresh.harness.reconcile(s.task.id, s.context, { receiptRef: ref })).status, 'planned');
});

test('valid receipt for another task and model-self-reported receipt cannot reconcile', async t => {
  const { s, fresh, ref } = await unknownWithReceipt(t);
  const otherTask = await fresh.harness.create({ assessmentId: s.assessmentId, objective: 'Another synthetic task', context: s.context, modelGrant: MODEL_GRANT });
  const successful = createM1Runtime(s.root);
  const other = await successful.harness.run(otherTask.id, s.context);
  await assert.rejects(fresh.harness.reconcile(s.task.id, s.context, { receiptRef: other.model.receiptRef }), { code: 'MODEL_RECEIPT_MISMATCH' });
  await assert.rejects(fresh.harness.reconcile(s.task.id, s.context, { receiptRef: { issuer: 'mock', plan: GOOD_PLAN } }), { code: 'MODEL_RECEIPT_REQUIRED' });
  assert.equal((await fresh.harness.reconcile(s.task.id, s.context, { receiptRef: ref })).status, 'planned');
});

test('reconciliation rechecks owner, Evidence capability, current model grant and tool policy', async t => {
  const { s, fresh, ref, task } = await unknownWithReceipt(t);
  await assert.rejects(fresh.harness.reconcile(s.task.id, { ...s.context, principal: 'another' }, { receiptRef: ref }), { code: 'TASK_OWNER_DENIED' });
  await assert.rejects(fresh.harness.reconcile(s.task.id, { ...s.context, accessToken: undefined }, { receiptRef: ref }), { code: 'ASSESSMENT_NOT_FOUND' });
  await assert.rejects(fresh.harness.reconcile(s.task.id, { ...s.context, allowedTools: ['evidence.read'] }, { receiptRef: ref }), { code: 'TOOL_PERMISSION_DENIED' });
  for (const authorization of [
    { ...MOCK_AUTHORIZATION, revision: 2 },
    { ...MOCK_AUTHORIZATION, grant: { ...MODEL_GRANT, maxCalls: 0 } },
    { ...MOCK_AUTHORIZATION, grant: { ...MODEL_GRANT, allowedAdapters: [] } },
    { ...MOCK_AUTHORIZATION, grant: { ...MODEL_GRANT, maxCostMicrousd: 1 } }
  ]) {
    const restricted = createM1Runtime(s.root, { authorizer: async () => structuredClone(authorization) });
    await assert.rejects(restricted.harness.reconcile(s.task.id, s.context, { receiptRef: ref }), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
    assert.equal(restricted.modelApi.calls, 0);
  }
  assert.equal((await fresh.store.load(s.task.id)).sequence, task.sequence);
  await s.service.continue(s.assessmentId, { expectedRevision: 1, draft: { payingCustomers: 10 } }, { authorization: s.context.authorization, accessToken: s.context.accessToken });
  await assert.rejects(fresh.harness.reconcile(s.task.id, s.context, { receiptRef: ref }), { code: 'EVIDENCE_CONTEXT_CHANGED' });
});

test('signed latest rollback before dispatch is detected and explicit witness recovery cannot trigger replay', async t => {
  const s = await setup(t);
  const path = join(s.store.checkpoints, `${s.task.id}.json`); const older = await readFile(path);
  const completed = await s.harness.run(s.task.id, s.context);
  await writeFile(path, older, { mode: 0o600 });
  await assert.rejects(s.store.load(s.task.id), { code: 'M1_CHECKPOINT_ROLLBACK' });
  await assert.rejects(s.harness.run(s.task.id, s.context), { code: 'M1_CHECKPOINT_ROLLBACK' });
  const repaired = await s.store.recoverLatest(s.task.id); assert.equal(repaired.recovered, true);
  const fresh = createM1Runtime(s.root); const result = await fresh.harness.run(s.task.id, s.context);
  assert.equal(result.status, 'succeeded'); assert.equal(result.sequence, completed.sequence); assert.equal(fresh.modelApi.calls, 0);
  assert.equal((await readdir(join(s.store.root, 'recovery-evidence'))).length, 1);
});

test('history deletion, tampering and unknown version remain blocked with failure bytes retained', async t => {
  const s = await setup(t); await s.harness.run(s.task.id, s.context);
  const path = join(s.store.history, s.task.id, '1.json'); const bytes = await readFile(path);
  await unlink(path); await assert.rejects(s.store.load(s.task.id), { code: 'M1_HISTORY_GAP' });
  await writeFile(path, bytes, { mode: 0o600 });
  const forged = JSON.parse(bytes); forged.payload.task.objective = 'forged';
  await writeFile(path, JSON.stringify(forged), { mode: 0o600 });
  await assert.rejects(s.store.load(s.task.id), { code: 'M1_INTEGRITY_FAILURE' });
  await writeFile(path, bytes, { mode: 0o600 });
  const payload = await s.store.unseal(bytes); payload.version = 'future-v999';
  await writeFile(path, JSON.stringify(await s.store.seal(payload)), { mode: 0o600 });
  await assert.rejects(s.store.load(s.task.id), { code: 'M1_HISTORY_INTEGRITY' });
  // Keep the last invalid version as this case's retained failure evidence.
});

test('call ledger rollback, witness rollback and missing signer never reopen quota', async t => {
  const s = await setup(t); const task = await prepare(s);
  // Capture an early signed ledger checkpoint during a real dispatch boundary.
  let oldLedger;
  const current = createM1Runtime(s.root, { afterApiPhase: async phase => {
    if (phase === 'intent_persisted') oldLedger = await readFile(join(current.ledgerStore.checkpoints, `${current.modelApi.scopeId(task.model.intent)}.json`));
  } });
  await current.modelApi.execute({ intent: task.model.intent, prompt: current.harness.promptFor(task) });
  const id = current.modelApi.scopeId(task.model.intent); const path = join(current.ledgerStore.checkpoints, `${id}.json`);
  const latest = await readFile(path); await writeFile(path, oldLedger, { mode: 0o600 });
  const fresh = createM1Runtime(s.root);
  await assert.rejects(fresh.modelApi.execute({ intent: task.model.intent, prompt: fresh.harness.promptFor(task) }), { code: 'M1_CHECKPOINT_ROLLBACK' });
  assert.equal(fresh.modelApi.calls, 0); await writeFile(path, latest, { mode: 0o600 });
  const witnessPath = join(current.ledgerStore.witnessRoot, `${id}.json`);
  const witness = await current.ledgerStore.unseal(await readFile(witnessPath)); witness.sequence = 1;
  await writeFile(witnessPath, JSON.stringify(await current.ledgerStore.seal(witness)), { mode: 0o600 });
  await assert.rejects(fresh.modelApi.execute({ intent: task.model.intent, prompt: fresh.harness.promptFor(task) }), { code: 'M1_HISTORY_AHEAD' });
  await unlink(join(current.ledgerStore.witnessRoot, 'witness.key'));
  await assert.rejects(fresh.modelApi.execute({ intent: task.model.intent, prompt: fresh.harness.promptFor(task) }), { code: 'M1_RECORD_MISSING' });
  assert.equal(fresh.modelApi.calls, 0);
});

test('legacy v1 store cannot be silently imported as M1 and unknown task version is rejected', async t => {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(join(scratch, 'legacy-'));
  const fixture = await seedFixture(root); const runtime = createM1Runtime(root);
  const legacy = new TaskStore(join(root, 'tasks'));
  const old = { id: newTaskId(), sequence: 0, version: 'flowcredit.native-task/experimental-v1', events: [] };
  await legacy.create(old);
  await assert.rejects(runtime.store.load(old.id), { code: 'M1_IDENTITY_REQUIRED' });
  await assert.rejects(runtime.store.create({ ...old, id: newTaskId(), version: 'future-v999' }), { code: 'M1_TASK_VERSION_OR_STATE' });
  assert.equal((await legacy.load(old.id)).sequence, 0);
  records.push({ test: t.name, root, legacyPreserved: true });
});

for (const phase of ['history_published', 'witness_published', 'latest_published']) test(`real store SIGKILL ${phase} has explicit commit/recovery meaning`, async t => {
  const s = await setup(t);
  await killAt({ root: s.root, id: s.task.id, mode: 'store-save', phase, sequence: 2 });
  const fresh = createM1Runtime(s.root); await fresh.store.recoverLock(s.task.id);
  if (phase === 'history_published') {
    await assert.rejects(fresh.store.load(s.task.id), { code: 'M1_HISTORY_AHEAD' });
    await assert.rejects(fresh.store.recoverLatest(s.task.id), { code: 'M1_HISTORY_AHEAD' });
  } else if (phase === 'witness_published') {
    await assert.rejects(fresh.store.load(s.task.id), { code: 'M1_CHECKPOINT_ROLLBACK' });
    assert.equal((await fresh.store.recoverLatest(s.task.id)).sequence, 2);
    assert.equal((await fresh.store.load(s.task.id)).sequence, 2);
  } else assert.equal((await fresh.store.load(s.task.id)).sequence, 2);
  assert.equal(fresh.modelApi.calls, 0);
});

test('first create killed after witness can recover a missing latest with already durable key', async t => {
  const s = await setup(t);
  const firstRoot = await mkdtemp(join(scratch, 'first-create-'));
  const task = { ...structuredClone(s.task), id: newTaskId(), sequence: 0, events: [] };
  const marker = await killAt({ root: firstRoot, mode: 'store-create', task, phase: 'witness_published', sequence: 0 });
  const fresh = createM1Runtime(firstRoot); await fresh.store.recoverLock(marker.id);
  await assert.rejects(fresh.store.load(task.id), { code: 'TASK_NOT_FOUND' });
  assert.equal((await fresh.store.recoverLatest(task.id)).recovered, true);
  assert.equal((await fresh.store.load(task.id)).sequence, 0);
});

test('immutable event history, receipt ref and reserved fields cannot be rewritten by trusted mistakes', async t => {
  const s = await setup(t); const completed = await s.harness.run(s.task.id, s.context);
  for (const mutate of [
    task => { task.events[0].detail = {}; },
    task => { task.model.receiptRef = '0'.repeat(64); },
    task => { task.model.attempts = 0; },
    task => { task.model.outcome = 'confirmed-invalid'; }
  ]) {
    const changed = structuredClone(completed); mutate(changed);
    await assert.rejects(s.store.exclusive(changed.id, () => s.harness.checkpoint(changed, 'rewrite_attempt')), error => ['M1_EVENT_INTEGRITY', 'M1_HISTORY_REWRITE'].includes(error.code));
  }
  const id = s.modelApi.scopeId(completed.model.intent); const ledger = await s.ledgerStore.load(id);
  ledger.calls[0].reservedCalls = 0;
  await assert.rejects(s.ledgerStore.exclusive(id, () => s.modelApi.event(ledger, 'rewrite_attempt', {})), { code: 'M1_HISTORY_REWRITE' });
});

test('witness symlink into checkpoint root is rejected instead of faking path independence', async t => {
  const s = await setup(t);
  const alias = join(s.root, 'alias'); await symlink(s.store.root, alias, 'dir');
  const store = new DurableTaskStore(s.store.root, { witnessRoot: alias });
  await assert.rejects(store.load(s.task.id), { code: 'M1_CONFIGURATION' });
});

test('receipt publication I/O fault leaves unknown, retains quota, and never signs a retry permission', async t => {
  const s = await setup(t); const directory = join(s.ledgerStore.root, 'receipts');
  await mkdir(s.ledgerStore.root, { recursive: true }); await writeFile(directory, 'not a directory', { mode: 0o600 });
  const task = await s.harness.run(s.task.id, s.context);
  assert.equal(task.status, 'recovery-required'); assert.equal(s.modelApi.calls, 1);
  assert.equal(task.model.receipt, null);
  const ledger = await s.ledgerStore.load(s.modelApi.scopeId(task.model.intent));
  assert.equal(ledger.calls[0].status, 'dispatched'); assert.equal(ledger.calls.length, 1);
  const fresh = createM1Runtime(s.root); assert.equal((await fresh.harness.run(s.task.id, s.context)).status, 'recovery-required'); assert.equal(fresh.modelApi.calls, 0);
});

test('task checkpoint fault after confirmed response preserves receipt and allows explicit recovery only', async t => {
  const s = await setup(t, { afterTaskPhase: (phase, detail) => {
    if (phase === 'witness_published' && detail.sequence === 3) throw new Error('Injected local commit fault');
  } });
  await assert.rejects(s.harness.run(s.task.id, s.context));
  const fresh = createM1Runtime(s.root, { responses: [] });
  await assert.rejects(fresh.store.load(s.task.id), { code: 'M1_CHECKPOINT_ROLLBACK' });
  const repaired = await fresh.store.recoverLatest(s.task.id); assert.equal(repaired.sequence, 3);
  const confirmed = await fresh.store.load(s.task.id); assert.equal(confirmed.model.outcome, 'confirmed-valid');
  const receipt = await fresh.modelApi.readReceipt(confirmed.model.receiptRef, confirmed.model.intent);
  assert.equal(receipt.status, 'confirmed-valid'); assert.equal((await fresh.harness.run(s.task.id, s.context, { resume: true })).status, 'succeeded'); assert.equal(fresh.modelApi.calls, 0);
});

test('task and model records exclude current trusted Evidence secrets', async t => {
  const s = await setup(t); await s.harness.run(s.task.id, s.context);
  async function scan(root) {
    for (const name of await readdir(root, { withFileTypes: true })) {
      const path = join(root, name.name);
      if (name.isDirectory()) await scan(path);
      else if (name.name.endsWith('.json')) {
        const text = await readFile(path, 'utf8');
        assert.equal(text.includes(s.context.accessToken), false); assert.equal(text.includes(s.context.authorization), false);
      }
    }
  }
  await scan(s.store.root); await scan(s.ledgerStore.root); await scan(s.store.witnessRoot); await scan(s.ledgerStore.witnessRoot);
});
