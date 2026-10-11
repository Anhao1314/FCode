import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createM2Runtime } from '../src/m2-runtime.mjs';
import { seedFixture, GOOD_PLAN } from '../src/fixtures.mjs';
import { fixtureRegistry, routes, authorization, GRANT, envelope, SYNTHETIC_KEY } from './m2-fixtures.mjs';
import { digest } from '../src/baseline.mjs';

const scratch = fileURLToPath(new URL('../../../work/m2/', import.meta.url));
const cases = [];
test.after(async () => { await writeFile(new URL('../validation/m2-cases.json', import.meta.url), `${JSON.stringify({ version: 'flowcredit.m2-test-cases/v1', generatedAt: new Date().toISOString(), cases, actualExternalHttpCalls: 0, paidCalls: 0, runtimeEvidenceRetained: true }, null, 2)}\n`); });
async function setup(t, options = {}) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(join(scratch, 'case-'));
  const fixture = await seedFixture(root); let policy = options.authorization || authorization();
  const definitions = options.definitions || routes(), fake = fixtureRegistry({ definitions, responses: options.responses });
  const runtime = createM2Runtime(root, { registry: fake.registry, authorizer: async () => structuredClone(policy), maxConcurrent: options.maxConcurrent || 1, afterApiPhase: options.afterApiPhase, afterBudgetPhase: options.afterBudgetPhase });
  const task = await runtime.harness.create({ assessmentId: fixture.assessmentId, objective: 'M2 synthetic financial evidence research', context: fixture.context, modelGrant: policy.grant });
  t.after(() => { cases.push({ test: t.name, root, taskId: task.id, injectedWire: fake.wire }); });
  return { root, ...fixture, ...runtime, fake, task, definitions, policy: () => policy, setPolicy: value => { policy = structuredClone(value); } };
}
async function another(s, runtime = s, policy = s.policy()) { return runtime.harness.create({ assessmentId: s.assessmentId, objective: 'Another M2 synthetic research task', context: s.context, modelGrant: policy.grant }); }
function fresh(s, options = {}) {
  const fake = fixtureRegistry({ definitions: options.definitions || s.definitions, responses: options.responses });
  return { ...createM2Runtime(s.root, { registry: fake.registry, authorizer: async () => options.authorization || s.policy(), maxConcurrent: options.maxConcurrent || 1 }), fake };
}
async function startWorker(args, crash = false) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./m2-worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
  let stdout = '', stderr = '', timer;
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.stdin.end(JSON.stringify(args));
  try {
    if (crash) {
      await Promise.race([(async () => {
        while (!stdout.includes('stoppedAt')) await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error(stdout + stderr); })]);
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Crash boundary timeout')), 15000); })]);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
      const marker = JSON.parse(stdout.trim()); cases.push({ crashPhase: args.crashPhase, signal, marker, root: args.root }); return marker;
    }
    const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker timeout')), 15000); })]);
    assert.equal(code, 0, stderr); return JSON.parse(stdout.trim());
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
async function heldWorker(args, whileHeld) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./m2-worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
  let stdout = '', stderr = '', timer;
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit'); child.stdin.end(JSON.stringify(args));
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Held worker timeout')), 15000); });
  try {
    await Promise.race([(async () => {
      while (!stdout.includes('pausedAt')) await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error(stdout + stderr); })]);
    })(), timeout]);
    const marker = JSON.parse(stdout.trim()); assert.equal(marker.pausedAt, 'intent_persisted'); assert.equal(marker.calls, 0);
    const contender = await whileHeld(); child.send('continue');
    const [code] = await Promise.race([exited, timeout]); assert.equal(code, 0, stderr);
    const first = JSON.parse(stdout.trim().split('\n').at(-1));
    return { marker, results: [first, contender] };
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
const args = (s, id, phase) => ({ root: s.root, id, context: s.context, definitions: s.definitions, authorization: s.policy(), ...(phase ? { crashPhase: phase } : {}) });
async function unlock(s, runtime) {
  await runtime.store.recoverLock(s.task.id);
  const task = await runtime.store.load(s.task.id);
  if (task.model.intent) await runtime.ledgerStore.recoverLock(runtime.modelApi.scopeId(task.model.intent));
  await runtime.budgetStore.recoverLock(runtime.budgets.poolId);
  if (task.model.intent) await runtime.budgetStore.recoverLock(runtime.budgets.groupId(task.model.intent));
  return task;
}
async function afterReceiptCrash(t) {
  const s = await setup(t); await startWorker(args(s, s.task.id, 'receipt_persisted'), true);
  const r = fresh(s); await unlock(s, r);
  const unknown = await r.harness.run(s.task.id, s.context, { resume: true });
  const status = await r.modelApi.status(unknown.model.intent); assert(status.receiptRef);
  return { s, r, unknown, ref: status.receiptRef };
}

test('two configured suppliers execute the existing Harness with normalized signed results', async t => {
  const s = await setup(t);
  const first = await s.harness.run(s.task.id, s.context); assert.equal(first.status, 'succeeded');
  const firstReceipt = await s.modelApi.readReceipt(first.model.receiptRef, first.model.intent);
  assert.equal(firstReceipt.charge.estimatedCostMicrousd, 140); assert.equal(firstReceipt.charge.actualCostMicrousd, null);
  assert.equal(firstReceipt.charge.externalBilling, 'not-verified');
  s.setPolicy({ ...s.policy(), routeId: 'compatible-candidate', revision: 2 });
  const secondTask = await another(s); const second = await s.harness.run(secondTask.id, s.context);
  assert.equal(second.status, 'succeeded'); assert.equal(second.model.intent.provider, 'openai-compatible');
  assert.equal(first.plan.version, second.plan.version); assert.equal(second.result.assessment.CCI, null);
  assert.equal(second.result.assessment.calculations.find(item => item.id.startsWith('gross-margin')).value, 17.85);
  const snapshot = await s.budgets.snapshot(second.model.intent); assert.equal(snapshot.group.reservations.length, 2); assert.equal(snapshot.heldConcurrency, 0);
  assert(snapshot.totalReservedCostMicrousd > firstReceipt.charge.estimatedCostMicrousd);
  cases.push({ test: t.name, providerSwitch: [first.model.intent.provider, second.model.intent.provider], normalizedCharge: firstReceipt.charge, budget: snapshot });
});

test('client cannot expand grant or select endpoint/model/token caps', async t => {
  const s = await setup(t); const base = { assessmentId: s.assessmentId, objective: 'Client attempt', context: s.context, modelGrant: s.policy().grant };
  for (const extra of [{ model: 'attacker-model' }, { endpoint: 'https://attacker.invalid' }, { maxTokens: 4096 }]) await assert.rejects(s.harness.create({ ...base, ...extra }), { code: 'MODEL_CLIENT_CONFIGURATION_DENIED' });
  await assert.rejects(s.harness.create({ ...base, modelGrant: { ...s.policy().grant, maxCalls: 100 } }), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
  const completed = await s.harness.run(s.task.id, s.context);
  for (const extra of [{ priorCalls: 0 }, { model: 'other' }, { maxCostMicrousd: Number.MAX_SAFE_INTEGER }]) await assert.rejects(s.modelApi.execute({ intent: completed.model.intent, prompt: s.harness.promptFor(completed), ...extra }), { code: 'MODEL_CLIENT_CONFIGURATION_DENIED' });
  assert.equal(s.modelApi.calls, 1);
});

test('input bytes, input token bound and output cap deny before any HTTP', async t => {
  for (const grant of [{ ...GRANT, maxInputBytes: 1 }, { ...GRANT, maxInputTokens: 1 }, { ...GRANT, maxOutputTokens: 1 }]) {
    const s = await setup(t, { authorization: authorization('deepseek-candidate', grant) });
    await assert.rejects(s.harness.run(s.task.id, s.context), error => ['MODEL_INPUT_BUDGET_DENIED', 'MODEL_TOKEN_BUDGET_DENIED'].includes(error.code));
    assert.equal(s.modelApi.calls, 0); assert.equal((await s.store.load(s.task.id)).status, 'created');
  }
});

test('insufficient total cost, total tokens and calls deny without issuing a request', async t => {
  for (const [grant, code] of [[{ ...GRANT, maxCostMicrousd: 1 }, 'MODEL_COST_BUDGET_DENIED'], [{ ...GRANT, maxTotalTokens: 1 }, 'MODEL_TOKEN_BUDGET_DENIED']]) {
    const s = await setup(t, { authorization: authorization('deepseek-candidate', grant) });
    await assert.rejects(s.harness.run(s.task.id, s.context), { code }); assert.equal(s.modelApi.calls, 0);
  }
  const s = await setup(t, { authorization: authorization('deepseek-candidate', { ...GRANT, maxCalls: 1 }) });
  await s.harness.run(s.task.id, s.context); const next = await another(s);
  await assert.rejects(s.harness.run(next.id, s.context), { code: 'MODEL_CALL_QUOTA' }); assert.equal(s.modelApi.calls, 1);
});

test('missing and invalid usage confirm result but preserve unknown fees and full reservation', async t => {
  const missing = envelope('deepseek-flash'); delete missing.usage;
  for (const scenario of [{ envelope: missing }, { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 121 } }]) {
    const s = await setup(t, { responses: { 'deepseek-candidate': [scenario] } });
    const result = await s.harness.run(s.task.id, s.context); assert.equal(result.status, 'succeeded');
    const receipt = await s.modelApi.readReceipt(result.model.receiptRef, result.model.intent);
    assert.equal(receipt.charge.usage, null); assert.equal(receipt.charge.estimatedCostMicrousd, null); assert.equal(receipt.charge.actualCostMicrousd, null);
    const snapshot = await s.budgets.snapshot(result.model.intent);
    assert.equal(snapshot.group.reservations[0].billingStatus, 'unknown'); assert.equal(snapshot.heldConcurrency, 0);
    assert.equal(snapshot.totalReservedCostMicrousd, receipt.charge.reservedCostMicrousd);
    cases.push({ test: t.name, taskStatus: result.status, charge: receipt.charge, budget: snapshot });
  }
});

test('token overage confirms invalid result, freezes grant and withholds costs', async t => {
  const s = await setup(t, { responses: { 'deepseek-candidate': [{ usage: { completion_tokens: 129 } }] } });
  const result = await s.harness.run(s.task.id, s.context);
  assert.equal(result.status, 'failed'); assert.equal(result.model.outcome, 'confirmed-invalid');
  const receipt = await s.modelApi.readReceipt(result.model.receiptRef, result.model.intent); assert.equal(receipt.charge.usageStatus, 'over-budget'); assert.equal(receipt.charge.estimatedCostMicrousd, null);
  assert.equal((await s.budgets.snapshot(result.model.intent)).group.blocked, true);
  const next = await another(s); await assert.rejects(s.harness.run(next.id, s.context), { code: 'MODEL_BUDGET_POLICY_CHANGED' }); assert.equal(s.modelApi.calls, 1);
});

test('fully received outer/inner invalid responses are signed as invalid without tool execution', async t => {
  for (const scenario of [{ rawText: '{invalid' }, { envelope: envelope('wrong-model') }, { plan: { ...GOOD_PLAN, permissions: ['riskCalculation'] } }]) {
    const s = await setup(t, { responses: { 'deepseek-candidate': [scenario] } });
    const result = await s.harness.run(s.task.id, s.context); assert.equal(result.status, 'failed'); assert.equal(result.model.outcome, 'confirmed-invalid');
    assert.deepEqual(s.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
    const receipt = await s.modelApi.readReceipt(result.model.receiptRef, result.model.intent);
    assert(['wire-envelope', 'inner-text'].includes(receipt.adapterReceipt.responseHashKind));
  }
});

test('invalid HTTP status never becomes a valid plan or releases an unknown lease', async t => {
  for (const status of [undefined, '200', NaN]) {
    const s = await setup(t, { responses: { 'deepseek-candidate': [{ kind: 'invalid-status', status }] } });
    const result = await s.harness.run(s.task.id, s.context); assert.equal(result.status, 'recovery-required');
    assert.deepEqual(s.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
    assert.equal((await s.budgets.snapshot(result.model.intent)).heldConcurrency, 1);
  }
});

test('timeout, HTTP errors and redirects keep unknown outcome, budget and concurrency after restart', async t => {
  for (const kind of ['timeout', 'http-error', 'redirect']) {
    const definitions = routes(); definitions[0].timeoutMs = 10;
    const s = await setup(t, { definitions, responses: { 'deepseek-candidate': [{ kind }] } });
    const result = await s.harness.run(s.task.id, s.context); assert.equal(result.status, 'recovery-required');
    const snapshot = await s.budgets.snapshot(result.model.intent); assert.equal(snapshot.heldConcurrency, 1); assert(snapshot.totalReservedCostMicrousd > 0);
    const r = fresh(s); assert.equal((await r.harness.run(s.task.id, s.context)).status, 'recovery-required'); assert.equal(r.modelApi.calls, 0);
    await assert.rejects(r.harness.reconcile(s.task.id, s.context), { code: 'MODEL_RECEIPT_REQUIRED' });
    const next = await another(s, r); await assert.rejects(r.harness.run(next.id, s.context), { code: 'MODEL_CONCURRENCY_DENIED' });
    cases.push({ test: t.name, kind, outcome: result.model.status, budget: snapshot, restartCalls: r.modelApi.calls });
  }
});

test('pre-aborted request has no durable attempt; in-flight cancellation keeps unknown lease', async t => {
  const s = await setup(t); const before = new AbortController(); before.abort();
  await assert.rejects(s.harness.run(s.task.id, s.context, { signal: before.signal }), { code: 'MODEL_ABORTED' });
  assert.equal((await s.store.load(s.task.id)).model.attempts, 0); assert.equal(s.modelApi.calls, 0);
  const definitions = routes(); definitions[0].timeoutMs = 1000;
  const running = await setup(t, { definitions, responses: { 'deepseek-candidate': [{ kind: 'timeout' }] } });
  const controller = new AbortController(); const pending = running.harness.run(running.task.id, running.context, { signal: controller.signal });
  while (running.modelApi.calls !== 1) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(); const unknown = await pending;
  assert.equal(unknown.status, 'recovery-required'); assert.equal((await running.budgets.snapshot(unknown.model.intent)).heldConcurrency, 1);
});

test('abort-ignoring transport cannot free its slot by returning a timeout or by recreating API', async t => {
  const definitions = routes(); definitions[0].timeoutMs = 5;
  const s = await setup(t, { definitions, responses: { 'deepseek-candidate': [{ kind: 'ignore-abort' }] } });
  const result = await s.harness.run(s.task.id, s.context); assert.equal(result.status, 'recovery-required');
  assert.equal(s.registry.route('deepseek-candidate').activeHttp, 1);
  const r = fresh(s); const next = await another(s, r);
  await assert.rejects(r.harness.run(next.id, s.context), { code: 'MODEL_CONCURRENCY_DENIED' }); assert.equal(r.modelApi.calls, 0);
  s.fake.releaseIgnored(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.registry.route('deepseek-candidate').activeHttp, 0);
  assert.equal((await r.budgets.snapshot(result.model.intent)).heldConcurrency, 1);
});

test('current authorization revoked at dispatch marker stops HTTP and retains unknown liabilities', async t => {
  let s;
  s = await setup(t, { afterApiPhase: phase => { if (phase === 'dispatch_persisted') s.setPolicy({ ...s.policy(), revision: 2 }); } });
  const result = await s.harness.run(s.task.id, s.context);
  assert.equal(result.status, 'recovery-required'); assert.equal(s.modelApi.calls, 0);
  assert.equal((await s.budgets.snapshot(result.model.intent)).heldConcurrency, 1);
  await assert.rejects(s.modelApi.status(result.model.intent), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
});

test('unknown calls cannot switch suppliers or change price/profile during execute/status/reconcile', async t => {
  const { s, r, unknown, ref } = await afterReceiptCrash(t);
  const switched = fresh(s, { authorization: { ...s.policy(), routeId: 'compatible-candidate', revision: 2 } });
  await assert.rejects(switched.harness.reconcile(s.task.id, s.context, { receiptRef: ref }), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
  for (const alter of [route => { route.pricing.version = 'synthetic-price-v2'; }, route => { route.model = 'other-model'; route.acceptedReportedModels = ['other-model']; }, route => { route.maxOutputTokens = 64; }]) {
    const definitions = structuredClone(s.definitions); alter(definitions[0]); const changed = fresh(s, { definitions });
    await assert.rejects(changed.modelApi.execute({ intent: unknown.model.intent, prompt: changed.harness.promptFor(unknown) }), { code: 'MODEL_ROUTE_CHANGED' });
    await assert.rejects(changed.modelApi.status(unknown.model.intent), { code: 'MODEL_ROUTE_CHANGED' });
    await assert.rejects(changed.harness.reconcile(s.task.id, s.context, { receiptRef: ref }), { code: 'MODEL_ROUTE_CHANGED' });
    assert.equal(changed.modelApi.calls, 0);
  }
  assert.equal(r.modelApi.calls, 0);
});

for (const phase of ['budget_reserved', 'dispatch_persisted', 'adapter_returned']) test(`real SIGKILL ${phase} without receipt never automatically resends`, async t => {
  const s = await setup(t); await startWorker(args(s, s.task.id, phase), true);
  const r = fresh(s); await unlock(s, r); const task = await r.harness.run(s.task.id, s.context, { resume: true });
  assert.equal(task.status, 'recovery-required'); assert.equal(r.modelApi.calls, 0);
  assert.equal((await r.budgets.snapshot(task.model.intent)).heldConcurrency, 1);
  await assert.rejects(r.harness.reconcile(task.id, s.context), { code: 'MODEL_RECEIPT_REQUIRED' });
});

for (const phase of ['receipt_persisted', 'budget_confirmed']) test(`real SIGKILL ${phase} reconciles once and releases only a confirmed response slot`, async t => {
  const s = await setup(t); await startWorker(args(s, s.task.id, phase), true);
  const r = fresh(s); await unlock(s, r); const unknown = await r.harness.run(s.task.id, s.context, { resume: true });
  const status = await r.modelApi.status(unknown.model.intent); assert(status.receiptRef);
  const before = await r.budgets.snapshot(unknown.model.intent);
  const plan = await r.harness.reconcile(s.task.id, s.context, { receiptRef: status.receiptRef });
  assert.equal(plan.status, 'planned'); const second = await r.harness.reconcile(s.task.id, s.context, { receiptRef: status.receiptRef }); assert.equal(second.sequence, plan.sequence);
  const result = await r.harness.run(s.task.id, s.context, { resume: true }); assert.equal(result.status, 'succeeded'); assert.equal(r.modelApi.calls, 0);
  const after = await r.budgets.snapshot(unknown.model.intent); assert.equal(after.totalReservedCostMicrousd, before.totalReservedCostMicrousd); assert.equal(after.group.reservations.length, 1); assert.equal(after.heldConcurrency, 0);
  cases.push({ test: t.name, receiptRef: status.receiptRef, before, after, restartedHttpCalls: r.modelApi.calls });
});

test('two live processes compete for the last durable cross-task grant allowance with at most one dispatch', async t => {
  const policy = authorization('deepseek-candidate', { ...GRANT, maxCalls: 2 });
  const s = await setup(t, { authorization: policy });
  // Initialize identities and spend the first allowance before racing the last.
  // A cold-store identity conflict must not count as proof of quota enforcement.
  const warmup = await s.harness.run(s.task.id, s.context); assert.equal(warmup.status, 'succeeded');
  const first = await another(s), second = await another(s);
  // Overlap at the committed reservation boundary, after the pool lock releases.
  // The second live process must reach durable quota, rather than a busy lock.
  const { marker, results } = await heldWorker({ ...args(s, first.id), pausePhase: 'intent_persisted' }, () => startWorker(args(s, second.id)));
  cases.push({ test: t.name, warmupCalls: s.modelApi.calls, initializedBeforeRace: true, overlapBoundary: marker, results });
  assert.equal(results.reduce((sum, item) => sum + item.calls, 0), 1);
  const winner = results.findIndex(item => item.calls === 1), loser = results[1 - winner];
  assert.equal(loser.errorCode || loser.failure?.code, 'MODEL_CALL_QUOTA');
  assert.equal(results[winner].status, 'succeeded');
  const task = await s.store.load(winner === 0 ? first.id : second.id);
  assert.equal((await s.budgets.snapshot(task.model.intent)).group.reservations.length, 2);
});

test('durable host concurrency is shared across routes, principals and API instances', async t => {
  const s = await setup(t, { responses: { 'deepseek-candidate': [{ kind: 'http-error' }] } });
  const held = await s.harness.run(s.task.id, s.context);
  const alternate = fresh(s, { authorization: { ...s.policy(), routeId: 'compatible-candidate' } });
  const otherContext = { ...s.context, principal: 'another-host-authorized-researcher' };
  const task = await alternate.harness.create({ assessmentId: s.assessmentId, objective: 'Other route and principal', context: otherContext, modelGrant: s.policy().grant });
  await assert.rejects(alternate.harness.run(task.id, otherContext), { code: 'MODEL_CONCURRENCY_DENIED' });
  assert.equal(alternate.modelApi.calls, 0); assert.equal((await alternate.budgets.snapshot(held.model.intent)).heldConcurrency, 1);
});

test('budget latest rollback is rejected and cannot refund a consumed reservation', async t => {
  const s = await setup(t); let oldBytes, id;
  const runtime = createM2Runtime(s.root, { registry: s.registry, authorizer: async () => s.policy(), afterBudgetPhase: async phase => {
    if (phase === 'budget_reserved') { const task = await s.store.load(s.task.id); id = s.budgets.groupId(task.model.intent); oldBytes = await readFile(join(s.budgetStore.checkpoints, `${id}.json`)); }
  } });
  const result = await runtime.harness.run(s.task.id, s.context);
  await writeFile(join(s.budgetStore.checkpoints, `${id}.json`), oldBytes, { mode: 0o600 });
  const r = fresh(s); const next = await another(s, r);
  await assert.rejects(r.harness.run(next.id, s.context), { code: 'M1_CHECKPOINT_ROLLBACK' }); assert.equal(r.modelApi.calls, 0);
  await r.budgetStore.recoverLatest(id);
  assert.equal((await r.budgets.snapshot(result.model.intent)).group.reservations[0].status, 'confirmed');
});

test('receipt route/price/hash-kind/charge tampering blocks reconciliation', async t => {
  const { s, r, unknown, ref } = await afterReceiptCrash(t);
  const path = join(r.ledgerStore.root, 'receipts', `${ref}.json`), original = await readFile(path);
  const payload = await r.ledgerStore.unseal(original);
  for (const mutate of [value => { value.intent.routeId = 'compatible-candidate'; }, value => { value.adapterReceipt.pricingHash = '0'.repeat(64); }, value => { value.adapterReceipt.responseHashKind = 'wire-envelope'; }, value => { value.charge.estimatedCostMicrousd = 0; }]) {
    const value = structuredClone(payload); mutate(value); await writeFile(path, JSON.stringify(await r.ledgerStore.seal(value)), { mode: 0o600 });
    await assert.rejects(r.harness.reconcile(s.task.id, s.context, { receiptRef: ref }), { code: 'MODEL_RECEIPT_MISMATCH' });
    assert.equal((await r.store.load(s.task.id)).sequence, unknown.sequence);
  }
  await writeFile(path, original, { mode: 0o600 }); assert.equal((await r.harness.reconcile(s.task.id, s.context, { receiptRef: ref })).status, 'planned');
});

test('all task, call and budget evidence excludes even synthetic credential material', async t => {
  const s = await setup(t); await s.harness.run(s.task.id, s.context);
  async function scan(root) {
    for (const item of await readdir(root, { withFileTypes: true })) {
      const path = join(root, item.name); if (item.isDirectory()) await scan(path);
      else if (item.name.endsWith('.json')) { const value = await readFile(path, 'utf8'); assert.equal(value.includes(SYNTHETIC_KEY), false); assert.equal(value.includes(s.context.accessToken), false); assert.equal(value.includes(s.context.authorization), false); }
    }
  }
  for (const root of [s.store.root, s.ledgerStore.root, s.budgetStore.root, s.store.witnessRoot, s.ledgerStore.witnessRoot, s.budgetStore.witnessRoot]) await scan(root);
});
