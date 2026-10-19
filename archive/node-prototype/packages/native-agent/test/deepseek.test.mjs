import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, fresh, saveCases, cases, envelope, approval, GRANT, modelAuth, fakeHttp } from './deepseek-fixtures.mjs';
import { createDeepSeekHarness } from '../src/public-api.mjs';
import { DEEPSEEK_MODEL } from '../src/deepseek-profile.mjs';
import { createDeepSeekInternalRuntime } from '../src/deepseek-runtime.mjs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
test.after(saveCases);

test('DeepSeek nonthinking JSON Plan runs through the original durable Harness and real finance tools', async t => {
  const s = await setup(t); const task = await s.harness.run(s.task.id, s.context);
  assert.equal(task.status, 'succeeded'); assert.equal(s.transport.transmissions, 1); assert.equal(s.transport.credentialReads, 0);
  assert.deepEqual(s.tools.counts, { 'evidence.read': 1, 'evidence.assess': 1 });
  const wire = s.fake.wire[0]; assert.equal(wire.model, DEEPSEEK_MODEL); assert.deepEqual(wire.thinking, { type: 'disabled' }); assert.equal(wire.maxTokens, 512); assert.equal(wire.systemHasJsonExample, true); assert.equal(wire.redirect, 'error'); assert.equal(wire.hasTools, false);
  const receipt = await s.modelApi.readReceipt(task.model.receiptRef, task.model.intent);
  assert.equal(receipt.version, 'flowcredit.model-result/m3-a-v1'); assert.equal(receipt.charge.transportMode, 'deepseek-injected-http-test'); assert.equal(receipt.adapterReceipt.providerDetails.cacheHitTokens, 40); assert.equal(receipt.charge.actualCostMicrousd, null);
  assert.equal(task.result.assessment.CCI, null); assert.equal(task.result.assessment.calculations.find(item => item.id.startsWith('gross-margin')).value, 17.85);
});

test('DeepSeek adapter drives the existing two-round Loop while offline Mock remains the separate control', async t => {
  const s = await setup(t, { loop: true }); const loop = await s.harness.run(s.task.id, s.context);
  assert.equal(loop.status, 'completed'); assert.equal(s.transport.transmissions, 2); assert.deepEqual(loop.rounds.map(round => round.observation.tool), ['evidence.read', 'evidence.assess']);
  assert.equal(new Set(loop.rounds.map(round => round.requestId)).size, 2);
  const child = await s.childStore.load(loop.rounds[1].childId); assert.equal((await s.budgets.snapshot(child.model.intent)).group.reservations.length, 2);
});

test('default disabled entry reads no credentials and exposes no raw model or registry handle', async t => {
  const s = await setup(t, { mode: 'disabled' }); await assert.rejects(s.harness.run(s.task.id, s.context), { code: 'DEEPSEEK_DISABLED' });
  assert.equal(s.transport.transmissions, 0); assert.equal(s.transport.credentialReads, 0); assert.equal((await s.store.load(s.task.id)).model.attempts, 0);
  const api = createDeepSeekHarness(s.root + '/facade', { authorizer: async () => s.policy() }); assert.deepEqual(Object.keys(api).sort(), ['create', 'reconcile', 'run', 'status']);
});

test('live mode is blocked without a current bound host approval and explicit unproven-budget acceptance', async t => {
  for (const [overrides, code] of [[{ enabled: false }, 'DEEPSEEK_LIVE_AUTHORIZATION_DENIED'], [{ requestId: 'other-request' }, 'DEEPSEEK_LIVE_AUTHORIZATION_DENIED'], [{ expiresAt: Date.now() - 1 }, 'DEEPSEEK_LIVE_AUTHORIZATION_DENIED'], [{ acceptUnprovenTokenAndBillingBounds: false }, 'DEEPSEEK_BUDGET_GUARANTEE_NOT_PROVEN']]) {
    const s = await setup(t, { mode: 'live', authorizeTransmission: request => approval(request, overrides) });
    await assert.rejects(s.harness.run(s.task.id, s.context), { code }); assert.equal(s.transport.transmissions, 0); assert.equal(s.transport.credentialReads, 0); assert.equal((await s.store.load(s.task.id)).model.attempts, 0);
  }
});

test('live-mode boundary uses only replaced fetch and a lazy synthetic credential after durable reservations', async t => {
  const s = await setup(t, { mode: 'live' }); assert.equal(s.transport.credentialReads, 0);
  const done = await s.harness.run(s.task.id, s.context); assert.equal(done.status, 'succeeded'); assert.equal(s.transport.credentialReads, 1); assert.equal(s.transport.transmissions, 1);
  assert.equal(s.fake.wire[0].authorizationHeaderCount, 1); assert.equal(s.fake.wire[0].usesOnlyTestCredential, true); assert.equal(s.fake.wire[0].placeholder, false);
  const receipt = await s.modelApi.readReceipt(done.model.receiptRef, done.model.intent); assert.equal(receipt.charge.transportMode, 'deepseek-live'); assert.equal(receipt.adapterReceipt.transmission.tokenAndBillingGuarantee, 'NOT_PROVEN');
  cases.push({ test: t.name, boundaryOnly: true, actualExternalModelRequests: 0, actualCredentialsRead: false });
});

test('revocation after dispatch publication blocks both key resolution and HTTP but retains unknown liabilities', async t => {
  let enabled = true;
  const s = await setup(t, { mode: 'live', authorizeTransmission: request => approval(request, { enabled }), afterApiPhase: phase => { if (phase === 'dispatch_persisted') enabled = false; } });
  const unknown = await s.harness.run(s.task.id, s.context); assert.equal(unknown.status, 'recovery-required'); assert.equal(s.transport.credentialReads, 0); assert.equal(s.transport.transmissions, 0);
  const budget = await s.budgets.snapshot(unknown.model.intent); assert.equal(budget.heldConcurrency, 1); assert(budget.totalReservedCostMicrousd > 0);
});

test('model authorization revoked during lazy synthetic key acquisition is checked again before HTTP', async t => {
  let s;
  s = await setup(t, { mode: 'live', credentialProvider: async () => { s.setPolicy({ ...s.policy(), revision: 2 }); return 'synthetic-lazy-test-secret'; } });
  const unknown = await s.harness.run(s.task.id, s.context); assert.equal(unknown.status, 'recovery-required'); assert.equal(s.transport.credentialReads, 1); assert.equal(s.transport.transmissions, 0);
  assert.equal((await s.budgets.snapshot(unknown.model.intent)).heldConcurrency, 1);
});

test('raw adapter and fresh Model API calls require the Runtime dispatch context', async t => {
  const s = await setup(t); await assert.rejects(s.registry.route(s.policy().routeId).plan({ requestId: 'forged', prompt: 'raw', taskId: s.task.id }), { code: 'DEEPSEEK_DISPATCH_REQUIRED' });
  assert.equal(s.transport.transmissions, 0); assert.equal(s.transport.credentialReads, 0); assert.equal(s.modelApi.calls, 0);
});

test('budget and client configuration gates precede any transmission or credential acquisition', async t => {
  const s = await setup(t, { authorization: modelAuth({ ...GRANT, maxCostMicrousd: 1 }) });
  await assert.rejects(s.harness.run(s.task.id, s.context), { code: 'MODEL_COST_BUDGET_DENIED' }); assert.equal(s.transport.transmissions, 0); assert.equal(s.transport.credentialReads, 0);
  await assert.rejects(s.harness.create({ assessmentId: s.assessmentId, objective: 'bad', context: s.context, modelGrant: s.policy().grant, apiKey: 'client-string' }), { code: 'MODEL_CLIENT_CONFIGURATION_DENIED' });
});

test('static Harness and Loop share the same durable grant budget and host pool', async t => {
  const s = await setup(t, { authorization: modelAuth({ ...GRANT, maxCalls: 2 }) }); const done = await s.harness.run(s.task.id, s.context); assert.equal(done.status, 'succeeded');
  const fake = fakeHttp({ loop: true }); const r = createDeepSeekInternalRuntime(s.root, { loop: true, mode: 'injected-http-test', service: s.service, authorizer: async () => s.policy(), http: fake.http });
  const loop = await r.harness.create({ assessmentId: s.assessmentId, objective: 'Shared-budget loop', context: s.context, modelGrant: s.policy().grant }); const limited = await r.harness.run(loop.id, s.context);
  assert.equal(limited.status, 'failed'); assert.equal(limited.failure.code, 'MODEL_CALL_QUOTA'); assert.equal(r.transport.transmissions, 1);
  const budget = await r.budgets.snapshot(done.model.intent); assert.equal(budget.group.reservations.length, 2); assert.equal(r.budgets.poolId, s.budgets.poolId);
});

test('wrong model, thinking content, finish reasons and invalid metadata confirm invalid without tool execution', async t => {
  const variations = [value => { value.model = 'deepseek-v4-pro'; }, value => { value.choices[0].message.reasoning_content = 'Synthetic reasoning never persisted'; }, value => { value.choices[0].finish_reason = 'length'; }, value => { value.choices[0].finish_reason = 'aborted'; }, value => { value.object = 'chat.completion.chunk'; }, value => { value.choices[0].index = 1; }];
  for (const mutate of variations) { const value = envelope(); mutate(value); const s = await setup(t, { scenarios: [{ envelope: value }] }); const result = await s.harness.run(s.task.id, s.context); assert.equal(result.status, 'failed'); assert.equal(result.model.outcome, 'confirmed-invalid'); assert.deepEqual(s.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 }); }
});

test('malformed JSON, duplicates, empty output and model authority claims are refused', async t => {
  const values = [envelope('{invalid'), envelope(''), envelope('{"version":"bad","version":"bad","steps":[]}'), envelope({ version: 'flowcredit.native-plan/experimental-v1', steps: [], riskGrade: 'A' })];
  for (const value of values) { const s = await setup(t, { scenarios: [{ envelope: value }] }); const result = await s.harness.run(s.task.id, s.context); assert.equal(result.status, 'failed'); assert.equal(result.model.outcome, 'confirmed-invalid'); assert.equal(s.tools.counts['evidence.read'], 0); }
});

test('contradictory cache or reasoning usage withholds estimates rather than treating unknown cost as free', async t => {
  for (const usage of [{ ...envelope().usage, prompt_cache_miss_tokens: 70 }, { ...envelope().usage, prompt_tokens_details: { cached_tokens: 30 } }, { ...envelope().usage, completion_tokens_details: { reasoning_tokens: -1 } }, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 0 } }, { ...envelope().usage, prompt_tokens_details: null }]) {
    const s = await setup(t, { scenarios: [{ usage }] }); const result = await s.harness.run(s.task.id, s.context);
    if (usage.completion_tokens_details.reasoning_tokens === -1) assert.equal(result.status, 'failed'); else assert.equal(result.status, 'succeeded');
    const receipt = await s.modelApi.readReceipt(result.model.receiptRef, result.model.intent); assert.equal(receipt.charge.usageStatus, 'invalid'); assert.equal(receipt.charge.estimatedCostMicrousd, null); assert.equal(receipt.charge.actualCostMicrousd, null); assert((await s.budgets.snapshot(result.model.intent)).totalReservedCostMicrousd > 0);
  }
});

test('missing usage preserves unknown fees; explicit partial overage freezes the grant', async t => {
  const missing = envelope(); delete missing.usage;
  const s = await setup(t, { scenarios: [{ envelope: missing }] }); const done = await s.harness.run(s.task.id, s.context); const receipt = await s.modelApi.readReceipt(done.model.receiptRef, done.model.intent);
  assert.equal(receipt.charge.usageStatus, 'missing'); assert.equal(receipt.charge.estimatedCostMicrousd, null); assert.equal((await s.budgets.snapshot(done.model.intent)).heldConcurrency, 0);
  const over = await setup(t, { scenarios: [{ usage: { completion_tokens: 513 } }] }); const failed = await over.harness.run(over.task.id, over.context); assert.equal(failed.status, 'failed'); assert.equal((await over.budgets.snapshot(failed.model.intent)).group.blocked, true);
});

test('HTTP failures, redirects and malformed status stay unknown after restart without retries', async t => {
  for (const scenario of [{ status: 401 }, { status: 402 }, { status: 429 }, { status: 503 }, { status: 302 }, { kind: 'bad-status' }]) {
    const s = await setup(t, { scenarios: [scenario] }); const unknown = await s.harness.run(s.task.id, s.context); assert.equal(unknown.status, 'recovery-required');
    const r = fresh(s); assert.equal((await r.harness.run(s.task.id, s.context)).status, 'recovery-required'); assert.equal(r.transport.transmissions, 0);
    const budget = await r.budgets.snapshot(unknown.model.intent); assert.equal(budget.heldConcurrency, 1); assert(budget.totalReservedCostMicrousd > 0);
    await assert.rejects(r.harness.reconcile(s.task.id, s.context), { code: 'MODEL_RECEIPT_REQUIRED' });
  }
});

test('real in-flight cancellation and timeout retain unknown concurrency and budgets', async t => {
  const s = await setup(t, { limits: { timeoutMs: 10 }, scenarios: [{ kind: 'timeout' }] }); const timeout = await s.harness.run(s.task.id, s.context); assert.equal(timeout.status, 'recovery-required'); assert.equal(s.transport.transmissions, 1);
  const aborted = await setup(t, { scenarios: [{ kind: 'timeout' }] }); const controller = new AbortController(), running = aborted.harness.run(aborted.task.id, aborted.context, { signal: controller.signal });
  while (aborted.transport.transmissions !== 1) await new Promise(resolve => setTimeout(resolve, 1)); controller.abort(); const result = await running; assert.equal(result.status, 'recovery-required'); assert.equal((await aborted.budgets.snapshot(result.model.intent)).heldConcurrency, 1);
});

test('ignored abort cannot free persistent concurrency by constructing a new API', async t => {
  const s = await setup(t, { limits: { timeoutMs: 5 }, scenarios: [{ kind: 'ignore-abort' }] }); const unknown = await s.harness.run(s.task.id, s.context); assert.equal(unknown.status, 'recovery-required'); assert.equal(s.registry.route(s.policy().routeId).activeHttp, 1);
  const r = fresh(s, { limits: { timeoutMs: 5 } }); const other = await r.harness.create({ assessmentId: s.assessmentId, objective: 'Another task', context: s.context, modelGrant: s.policy().grant });
  await assert.rejects(r.harness.run(other.id, s.context), { code: 'MODEL_CONCURRENCY_DENIED' }); assert.equal(r.transport.transmissions, 0);
  s.fake.release(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal((await r.budgets.snapshot(unknown.model.intent)).heldConcurrency, 1);
});

async function crash(s, phase, loop = false) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./deepseek-worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test' } }); let stdout = '', stderr = '', timer;
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; }); const exit = once(child, 'exit');
  child.stdin.end(JSON.stringify({ root: s.root, id: s.task.id, context: s.context, authorization: s.policy(), phase, loop }));
  try { await Promise.race([(async () => { while (!stdout.includes('stoppedAt')) await Promise.race([once(child.stdout, 'data'), exit.then(() => { throw new Error(stdout + stderr); })]); })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Crash timeout')), 15000); })]); const marker = JSON.parse(stdout.trim()); child.kill('SIGKILL'); const [, signal] = await exit; assert.equal(signal, 'SIGKILL'); cases.push({ crashPhase: phase, loop, marker, signal, root: s.root }); return marker; }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
async function unlock(s, r, loop = false) {
  await r.store.recoverLock(s.task.id); const parent = await r.store.load(s.task.id); let task = parent;
  if (loop) { await r.childStore.recoverLock(parent.rounds.at(-1).childId); task = await r.childStore.load(parent.rounds.at(-1).childId); }
  if (task.model.intent) { await r.ledgerStore.recoverLock(r.modelApi.scopeId(task.model.intent)); await r.budgetStore.recoverLock(r.budgets.groupId(task.model.intent)); }
  await r.budgetStore.recoverLock(r.budgets.poolId); return task;
}

for (const phase of ['model_started', 'dispatch_persisted', 'adapter_returned']) test(`real SIGKILL ${phase} cannot bypass conservative recovery or automatically retransmit`, async t => {
  const s = await setup(t); await crash(s, phase); const r = fresh(s), task = await unlock(s, r);
  if (phase === 'model_started') await assert.rejects(r.modelApi.execute({ intent: task.model.intent, prompt: r.modelApi.promptForTask(task) }), { code: 'DEEPSEEK_RUNTIME_REQUIRED' });
  const unknown = await r.harness.run(s.task.id, s.context); assert.equal(unknown.status, 'recovery-required'); assert.equal(r.transport.transmissions, 0);
  await assert.rejects(r.harness.reconcile(s.task.id, s.context), { code: 'MODEL_RECEIPT_REQUIRED' });
});

test('real SIGKILL receipt_persisted permits only explicit signed reconciliation without retransmission', async t => {
  const s = await setup(t); await crash(s, 'receipt_persisted'); const r = fresh(s); await unlock(s, r); const unknown = await r.harness.run(s.task.id, s.context);
  const status = await r.modelApi.status(unknown.model.intent), before = await r.budgets.snapshot(unknown.model.intent);
  const plan = await r.harness.reconcile(s.task.id, s.context, { receiptRef: status.receiptRef }); assert.equal(plan.status, 'planned');
  const result = await r.harness.run(s.task.id, s.context, { resume: true }); assert.equal(result.status, 'succeeded'); assert.equal(r.transport.transmissions, 0);
  const after = await r.budgets.snapshot(unknown.model.intent); assert.equal(after.heldConcurrency, 0); assert.equal(after.totalReservedCostMicrousd, before.totalReservedCostMicrousd); cases.push({ test: t.name, before, after, restartTransmissions: r.transport.transmissions });
});

test('DeepSeek Loop receipt recovery continues with only the next independent round identity', async t => {
  const s = await setup(t, { loop: true }); await crash(s, 'receipt_persisted', true); const r = fresh(s, { loop: true }); const child = await unlock(s, r, true);
  const unknown = await r.harness.run(s.task.id, s.context); assert.equal(unknown.status, 'recovery-required'); const status = await r.modelApi.status(child.model.intent);
  await r.harness.reconcile(s.task.id, s.context, { roundIndex: 1, receiptRef: status.receiptRef }); const done = await r.harness.run(s.task.id, s.context); assert.equal(done.status, 'completed'); assert.equal(r.transport.transmissions, 1);
  assert.notEqual(done.rounds[0].requestId, done.rounds[1].requestId);
});

test('signed transmission-mode tampering and profile changes cannot reconcile an old outcome', async t => {
  const s = await setup(t); const done = await s.harness.run(s.task.id, s.context), path = join(s.ledgerStore.root, 'receipts', `${done.model.receiptRef}.json`), original = await readFile(path);
  const receipt = await s.ledgerStore.unseal(original); receipt.adapterReceipt.transmission.mode = 'live'; await writeFile(path, JSON.stringify(await s.ledgerStore.seal(receipt)), { mode: 0o600 });
  await assert.rejects(s.modelApi.readReceipt(done.model.receiptRef, done.model.intent), { code: 'MODEL_RECEIPT_MISMATCH' }); await writeFile(path, original, { mode: 0o600 });
  const changed = fresh(s, { limits: { maxOutputTokens: 256 } }); await assert.rejects(changed.modelApi.status(done.model.intent), { code: 'MODEL_ROUTE_CHANGED' }); assert.equal(changed.transport.transmissions, 0);
});

test('all persisted records omit synthetic keys, credential error contents and Evidence capabilities', async t => {
  const s = await setup(t, { mode: 'live' }); await s.harness.run(s.task.id, s.context);
  async function scan(root) { for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) await scan(path); else if (entry.name.endsWith('.json')) { const raw = await readFile(path, 'utf8'); for (const secret of ['synthetic-lazy-test-secret', 'transport-placeholder-not-a-real-key', s.context.accessToken, s.context.authorization]) assert.equal(raw.includes(secret), false); } } }
  for (const root of [s.store.root, s.ledgerStore.root, s.budgetStore.root]) await scan(root);
});
