import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, fresh, staticControl, saveCases, cases } from './loop-fixtures.mjs';
import { digest } from '../src/baseline.mjs';
import { PLAN_VERSION, RuntimeError } from '../src/contracts.mjs';
import { LOOP_POLICY } from '../src/loop-contract.mjs';
import { offlineAuthorization, OFFLINE_GRANT, conditionalDecision } from '../src/offline-loop-model.mjs';
import { createLoopRuntime } from '../src/loop-runtime.mjs';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
test.after(saveCases);

for (const empty of [false, true]) test(`real ${empty ? 'empty' : 'rich'} Evidence result drives a different controlled path with unchanged static Plan control`, async t => {
  const s = await setup(t, { empty }); const loop = await s.harness.run(s.loop.id, s.context);
  assert.equal(loop.status, empty ? 'insufficient-evidence' : 'completed'); assert.equal(s.registry.calls, 2);
  assert.deepEqual(loop.rounds.map(round => round.observation.tool), empty ? ['evidence.read', 'evidence.read'] : ['evidence.read', 'evidence.assess']);
  assert.equal(loop.rounds[0].observation.result.factIds.length === 0, empty);
  assert.equal(s.registry.trace[1].context.observations[0].resultHash, loop.rounds[0].observation.resultHash);
  assert.equal(s.registry.trace[1].context.observations[0].factCount, loop.rounds[0].observation.result.factIds.length);
  const control = await staticControl(s);
  assert.equal(control.status, 'succeeded'); assert.equal(control.modelCalls, 1);
  assert.deepEqual(control.toolCounts, { 'evidence.read': 1, 'evidence.assess': 1 });
  assert.equal(control.goalHasFacts, !empty);
  cases.push({ test: t.name, dynamic: { status: loop.status, modelCalls: s.registry.calls, toolCounts: s.tools.counts }, static: control, researchGain: 'NOT_PROVEN' });
  const again = await s.harness.run(s.loop.id, s.context); assert.equal(again.sequence, loop.sequence); assert.equal(s.registry.calls, 2);
});

test('rounds have unique durable identity, signed receipt and shared non-refundable budget', async t => {
  const s = await setup(t); const loop = await s.harness.run(s.loop.id, s.context);
  assert.equal(new Set(loop.rounds.map(round => round.childId)).size, 2); assert.equal(new Set(loop.rounds.map(round => round.requestId)).size, 2); assert.equal(new Set(loop.rounds.map(round => round.receiptRef)).size, 2);
  for (const round of loop.rounds) {
    const child = await s.childStore.load(round.childId); assert.equal(child.status, 'paused');
    const receipt = await s.modelApi.readReceipt(round.receiptRef, child.model.intent);
    assert.equal(receipt.version, 'flowcredit.model-result/m4-l0-offline-v1'); assert.equal(receipt.charge.transportMode, 'offline-mock'); assert.equal(receipt.charge.actualCostMicrousd, null);
    assert.equal(child.model.intent.promptHash, digest(s.modelApi.promptForTask(child)));
  }
  const child = await s.childStore.load(loop.rounds[1].childId), budget = await s.budgets.snapshot(child.model.intent);
  assert.equal(budget.group.reservations.length, 2); assert.equal(budget.heldConcurrency, 0); assert(budget.totalReservedCostMicrousd > 0);
  cases.push({ test: t.name, budget });
});

const plan = (tool = 'evidence.read', args = {}, id = 'observe') => ({ version: PLAN_VERSION, steps: [{ id, tool, arguments: args }] });

test('model completion fields, empty finish and duplicate keys cannot complete a task', async t => {
  for (const output of [{ ...plan(), status: 'completed', risk: 900 }, { version: PLAN_VERSION, steps: [] }, `{"version":"${PLAN_VERSION}","steps":[],"steps":[]}`]) {
    const s = await setup(t, { decide: () => output }); const result = await s.harness.run(s.loop.id, s.context);
    assert.equal(result.status, 'failed'); assert.equal(s.registry.calls, 1); assert.deepEqual(s.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
  }
  const s = await setup(t, { decide: () => plan('evidence.read', {}, 'complete') });
  const paused = await s.harness.run(s.loop.id, s.context, { pauseAfterRounds: 1 }); assert.equal(paused.status, 'paused'); assert.equal(paused.result, null);
});

test('write tools, URL arguments and batch plans are refused before any execution', async t => {
  for (const [output, code] of [[plan('risk.calculate'), 'TOOL_NOT_REGISTERED'], [plan('evidence.read', { url: 'https://attacker.invalid' }), 'TOOL_ARGUMENTS_DENIED'], [{ version: PLAN_VERSION, steps: [plan().steps[0], plan('evidence.assess', {}, 'assess').steps[0]] }, 'M4_SINGLE_ACTION_REQUIRED']]) {
    const s = await setup(t, { decide: () => output }); const result = await s.harness.run(s.loop.id, s.context);
    assert.equal(result.status, 'denied'); assert.equal(result.failure.code, code); assert.deepEqual(s.tools.counts, { 'evidence.read': 0, 'evidence.assess': 0 });
    const child = await s.childStore.load(result.rounds[0].childId); assert.equal((await s.budgets.snapshot(child.model.intent)).heldConcurrency, 0);
  }
});

test('nonempty repeated read makes no progress and terminates instead of looping', async t => {
  const s = await setup(t, { decide: () => plan() }); const loop = await s.harness.run(s.loop.id, s.context);
  assert.equal(loop.status, 'denied'); assert.equal(loop.failure.code, 'M4_NO_PROGRESS'); assert.equal(s.registry.calls, 2); assert.equal(s.tools.counts['evidence.read'], 1);
  const again = await s.harness.run(loop.id, s.context); assert.equal(again.sequence, loop.sequence); assert.equal(s.registry.calls, 2);
});

test('last shared call allowance denies round two and records a terminal budget failure', async t => {
  const s = await setup(t, { authorization: offlineAuthorization({ ...OFFLINE_GRANT, maxCalls: 1 }) }); const loop = await s.harness.run(s.loop.id, s.context);
  assert.equal(loop.status, 'failed'); assert.equal(loop.failure.code, 'MODEL_CALL_QUOTA'); assert.equal(s.registry.calls, 1); assert.equal(loop.rounds.length, 2);
  const first = await s.childStore.load(loop.rounds[0].childId), denied = await s.childStore.load(loop.rounds[1].childId);
  assert.equal(denied.model.attempts, 0); assert.equal((await s.budgets.snapshot(first.model.intent)).group.reservations.length, 1);
});

test('paused loop correctly terminates at trusted round limit and clients cannot enlarge it', async t => {
  const s = await setup(t, { loopPolicy: { ...LOOP_POLICY, maxRounds: 1 } });
  await assert.rejects(s.harness.create({ assessmentId: s.loop.binding.assessmentId, objective: 'bad', context: s.context, modelGrant: s.policy().grant, maxRounds: 100 }), { code: 'M4_INPUT_DENIED' });
  const paused = await s.harness.run(s.loop.id, s.context, { pauseAfterRounds: 1 }); assert.equal(paused.status, 'paused');
  const failed = await s.harness.run(s.loop.id, s.context); assert.equal(failed.status, 'failed'); assert.equal(failed.failure.code, 'M4_ROUND_LIMIT'); assert.equal(s.registry.calls, 1);
});

test('oversized decision context fails closed without truncating or issuing a call', async t => {
  const s = await setup(t, { loopPolicy: { ...LOOP_POLICY, maxContextBytes: 256 } });
  await assert.rejects(s.harness.run(s.loop.id, s.context), { code: 'M4_CONTEXT_LIMIT' }); assert.equal(s.registry.calls, 0); assert.equal((await s.store.load(s.loop.id)).rounds.length, 0);
});

test('current authorization, tool scope, principal and policy are revalidated between rounds', async t => {
  const s = await setup(t); const paused = await s.harness.run(s.loop.id, s.context, { pauseAfterRounds: 1 });
  await assert.rejects(s.harness.run(s.loop.id, { ...s.context, principal: 'intruder' }), { code: 'TASK_OWNER_DENIED' });
  await assert.rejects(s.harness.run(s.loop.id, { ...s.context, allowedTools: ['evidence.read'] }), { code: 'TOOL_PERMISSION_DENIED' });
  s.setPolicy({ ...s.policy(), revision: 2 }); await assert.rejects(s.harness.run(s.loop.id, s.context), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
  assert.equal((await s.store.load(s.loop.id)).sequence, paused.sequence); assert.equal(s.registry.calls, 1);
  const changed = fresh(s, { authorization: { ...s.policy(), revision: 1 }, loopPolicy: { ...LOOP_POLICY, maxRounds: 3 } });
  await assert.rejects(changed.harness.run(s.loop.id, s.context), { code: 'M4_POLICY_CHANGED' }); assert.equal(changed.registry.calls, 0);
  s.setPolicy({ ...s.policy(), revision: 1 }); assert.equal((await s.harness.run(s.loop.id, s.context)).status, 'completed'); assert.equal(s.registry.calls, 2);
});

test('runtime is offline-only and client grant amplification is denied', async t => {
  const s = await setup(t);
  assert.throws(() => createLoopRuntime(s.root, { service: s.service, authorizer: async () => s.policy(), registry: { descriptor: { mode: 'injected-http-test' } } }), { code: 'M4_OFFLINE_ONLY' });
  await assert.rejects(s.harness.create({ assessmentId: s.loop.binding.assessmentId, objective: 'bad grant', context: s.context, modelGrant: { ...s.policy().grant, maxCalls: 1000 } }), { code: 'MODEL_CURRENT_AUTHORIZATION_DENIED' });
  assert.equal(s.registry.calls, 0);
});

async function worker(s, phase = null, contender = null) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./loop-worker.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, NODE_ENV: 'test' } });
  let stdout = '', stderr = '', timer;
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = once(child, 'exit'); child.stdin.end(JSON.stringify({ root: s.root, id: s.loop.id, context: s.context, authorization: s.policy(), crashPhase: phase }));
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker boundary timeout')), 15000); });
  try {
    if (phase) {
      await Promise.race([(async () => { while (!stdout.includes('stoppedAt')) await Promise.race([once(child.stdout, 'data'), exit.then(() => { throw new Error(stdout + stderr); })]); })(), timeout]);
      const marker = JSON.parse(stdout.trim()); if (contender) await contender(); child.kill('SIGKILL');
      const [, signal] = await exit; assert.equal(signal, 'SIGKILL'); cases.push({ crashPhase: phase, signal, marker, root: s.root, loopId: s.loop.id }); return marker;
    }
    const [code] = await Promise.race([exit, timeout]); assert.equal(code, 0, stderr); return JSON.parse(stdout.trim());
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
async function unlock(s, r) {
  await r.store.recoverLock(s.loop.id); const loop = await r.store.load(s.loop.id);
  for (const round of loop.rounds) {
    await r.childStore.recoverLock(round.childId); let child; try { child = await r.childStore.load(round.childId); } catch (error) { if (error.code === 'TASK_NOT_FOUND') continue; throw error; }
    if (child.model.intent) { await r.ledgerStore.recoverLock(r.modelApi.scopeId(child.model.intent)); await r.budgetStore.recoverLock(r.budgets.groupId(child.model.intent)); }
  }
  await r.budgetStore.recoverLock(r.budgets.poolId); return loop;
}

for (const phase of ['round_reserved', 'round_linked']) test(`real SIGKILL ${phase} preserves identity for the first unissued decision`, async t => {
  const s = await setup(t);
  const marker = await worker(s, phase, phase === 'round_linked' ? async () => { const other = await worker(s); assert.equal(other.errorCode, 'TASK_BUSY'); assert.equal(other.calls, 0); cases.push({ test: t.name, concurrentContender: other }); } : null);
  assert.equal(marker.calls, 0); const r = fresh(s), before = await unlock(s, r);
  const result = await r.harness.run(s.loop.id, s.context); assert.equal(result.status, 'completed'); assert.equal(r.registry.calls, 2); assert.equal(result.rounds[0].childId, before.rounds[0].childId);
});

for (const phase of ['dispatch_persisted', 'adapter_returned']) test(`real SIGKILL ${phase} never reissues an unknown decision or creates the next round`, async t => {
  const s = await setup(t); const marker = await worker(s, phase); assert.equal(marker.calls, phase === 'dispatch_persisted' ? 0 : 1);
  const r = fresh(s); await unlock(s, r); const result = await r.harness.run(s.loop.id, s.context);
  assert.equal(result.status, 'recovery-required'); assert.equal(result.rounds.length, 1); assert.equal(r.registry.calls, 0);
  const child = await r.childStore.load(result.rounds[0].childId); const snapshot = await r.budgets.snapshot(child.model.intent);
  assert.equal(snapshot.heldConcurrency, 1); assert.equal(snapshot.group.reservations.length, 1);
  await assert.rejects(r.modelApi.execute({ intent: child.model.intent, prompt: r.modelApi.promptForTask(child) }), { code: 'MODEL_OUTCOME_UNKNOWN' });
  await assert.rejects(r.harness.reconcile(s.loop.id, s.context, { roundIndex: 1 }), { code: 'MODEL_RECEIPT_REQUIRED' });
  assert.equal((await r.harness.run(s.loop.id, s.context)).sequence, result.sequence); assert.equal(r.registry.calls, 0);
  cases.push({ test: t.name, unknownBudget: snapshot, restartCalls: r.registry.calls });
});

test('real SIGKILL receipt_persisted requires explicit matching reconciliation then uses only a new round call', async t => {
  const s = await setup(t); const marker = await worker(s, 'receipt_persisted'); assert.equal(marker.calls, 1);
  const r = fresh(s); await unlock(s, r); const unknown = await r.harness.run(s.loop.id, s.context);
  assert.equal(unknown.status, 'recovery-required'); assert.equal(r.registry.calls, 0);
  const child = await r.childStore.load(unknown.rounds[0].childId), status = await r.modelApi.status(child.model.intent), before = await r.budgets.snapshot(child.model.intent);
  await assert.rejects(r.harness.reconcile(s.loop.id, s.context, { roundIndex: 2, receiptRef: status.receiptRef }), { code: 'MODEL_RECONCILIATION_BLOCKED' });
  const linked = await r.harness.reconcile(s.loop.id, s.context, { roundIndex: 1, receiptRef: status.receiptRef });
  assert.equal((await r.harness.reconcile(s.loop.id, s.context, { roundIndex: 1, receiptRef: status.receiptRef })).sequence, linked.sequence);
  const confirmed = await r.budgets.snapshot(child.model.intent); assert.equal(confirmed.totalReservedCostMicrousd, before.totalReservedCostMicrousd); assert.equal(confirmed.heldConcurrency, 0);
  const result = await r.harness.run(s.loop.id, s.context); assert.equal(result.status, 'completed'); assert.equal(r.registry.calls, 1); assert.equal(r.registry.trace[0].requestId, result.rounds[1].requestId);
  cases.push({ test: t.name, before, confirmed, restartedCalls: r.registry.calls });
});

for (const phase of ['tool_started', 'tool_succeeded', 'round_observed']) test(`real SIGKILL ${phase} recovers confirmed read observation without repeating its model call`, async t => {
  const s = await setup(t); const marker = await worker(s, phase); assert.equal(marker.calls, 1);
  const r = fresh(s); await unlock(s, r); const result = await r.harness.run(s.loop.id, s.context);
  assert.equal(result.status, 'completed'); assert.equal(r.registry.calls, 1); assert.equal(r.registry.trace[0].requestId, result.rounds[1].requestId);
  assert.equal(r.tools.counts['evidence.read'], phase === 'tool_started' ? 1 : 0);
});

test('unknown second round rejects first-round receipt and retains shared concurrency across another loop', async t => {
  const s = await setup(t, { decide: context => { if (context.round === 2) throw new RuntimeError('MODEL_UNAVAILABLE'); return conditionalDecision(context); } });
  const unknown = await s.harness.run(s.loop.id, s.context); assert.equal(unknown.status, 'recovery-required'); assert.equal(unknown.rounds.length, 2);
  await assert.rejects(s.harness.reconcile(s.loop.id, s.context, { roundIndex: 2, receiptRef: unknown.rounds[0].receiptRef }), { code: 'MODEL_RECEIPT_MISMATCH' });
  assert.equal((await s.store.load(s.loop.id)).sequence, unknown.sequence); assert.equal(s.registry.calls, 2);
  const other = await s.harness.create({ assessmentId: s.loop.binding.assessmentId, objective: 'Another loop', context: s.context, modelGrant: s.policy().grant });
  const blocked = await s.harness.run(other.id, s.context); assert.equal(blocked.status, 'failed'); assert.equal(blocked.failure.code, 'MODEL_CONCURRENCY_DENIED'); assert.equal(s.registry.calls, 2);
  const child = await s.childStore.load(unknown.rounds[1].childId); assert.equal((await s.budgets.snapshot(child.model.intent)).group.reservations.length, 2);
});

test('parent latest rollback and resigned observation tampering remain fail closed', async t => {
  const s = await setup(t); await s.harness.run(s.loop.id, s.context, { pauseAfterRounds: 1 });
  const path = join(s.store.checkpoints, `${s.loop.id}.json`), older = await readFile(path); const done = await s.harness.run(s.loop.id, s.context), latest = await readFile(path);
  await writeFile(path, older, { mode: 0o600 }); const r = fresh(s);
  await assert.rejects(r.harness.run(s.loop.id, s.context), { code: 'M1_CHECKPOINT_ROLLBACK' }); assert.equal(r.registry.calls, 0);
  await r.store.recoverLatest(s.loop.id);
  const envelope = JSON.parse(latest); envelope.task.rounds[0].observation.result.factIds = []; envelope.task.rounds[0].observation.resultHash = digest(envelope.task.rounds[0].observation.result);
  const { signature, ...payload } = envelope; envelope.signature = r.store.signature(payload, await r.store.key()); const attack = JSON.stringify(envelope);
  await mkdir(new URL('../validation/attacks/', import.meta.url), { recursive: true }); await writeFile(new URL(`../validation/attacks/${s.loop.id}.json`, import.meta.url), attack);
  await writeFile(path, attack, { mode: 0o600 }); await assert.rejects(r.harness.run(s.loop.id, s.context), { code: 'M1_CHECKPOINT_DIVERGENCE' }); assert.equal(r.registry.calls, 0);
  await writeFile(path, latest, { mode: 0o600 }); assert.equal((await r.harness.run(s.loop.id, s.context)).sequence, done.sequence);
});

test('history cannot replace round identity, append after completion or rewrite observed results', async t => {
  const s = await setup(t); const done = await s.harness.run(s.loop.id, s.context);
  for (const alter of [loop => { loop.rounds[0].childId = loop.rounds[1].childId; }, loop => { loop.status = 'active'; }, loop => { loop.rounds[0].observation.result.factIds = []; loop.rounds[0].observation.resultHash = digest(loop.rounds[0].observation.result); }]) {
    const forged = structuredClone(done); alter(forged);
    await assert.rejects(s.harness.checkpoint(forged, 'attacker_rewrite'), error => ['M4_LOOP_INTEGRITY', 'M4_HISTORY_REWRITE', 'M4_CONTEXT_MISMATCH'].includes(error.code));
  }
  assert.equal((await s.store.load(s.loop.id)).sequence, done.sequence); assert.equal(s.registry.calls, 2);
});

test('tool failure is retained as failed and never disguised as completion or automatic retry', async t => {
  const s = await setup(t, { beforeExecute: () => { throw new RuntimeError('TOOL_TEMPORARY_FAILURE', { retryable: true }); } });
  const failed = await s.harness.run(s.loop.id, s.context); assert.equal(failed.status, 'failed'); assert.equal(failed.failure.code, 'TOOL_TEMPORARY_FAILURE');
  assert.equal((await s.harness.run(s.loop.id, s.context)).sequence, failed.sequence); assert.equal(s.registry.calls, 1); assert.equal(failed.result, null);
});

test('all persisted model contexts and records exclude synthetic Evidence capabilities', async t => {
  const s = await setup(t); await s.harness.run(s.loop.id, s.context);
  const text = JSON.stringify(s.registry.trace); assert(!text.includes(s.context.accessToken)); assert(!text.includes(s.context.authorization));
  async function scan(root) { for (const entry of await readdir(root, { withFileTypes: true })) { const path = join(root, entry.name); if (entry.isDirectory()) await scan(path); else if (entry.name.endsWith('.json')) { const raw = await readFile(path, 'utf8'); assert(!raw.includes(s.context.accessToken)); assert(!raw.includes(s.context.authorization)); } } }
  for (const root of [s.store.root, s.childStore.root, s.ledgerStore.root, s.budgetStore.root]) await scan(root);
});

test('expanded current context cannot poison the frozen per-loop child tool scope', async t => {
  const s = await setup(t); const limited = { ...s.context, allowedTools: ['evidence.read'] };
  const loop = await s.harness.create({ assessmentId: s.loop.binding.assessmentId, objective: 'Read-only limited loop', context: limited, modelGrant: s.policy().grant });
  const result = await s.harness.run(loop.id, s.context); assert.equal(result.status, 'denied'); assert.equal(result.failure.code, 'TOOL_PERMISSION_DENIED');
  for (const round of result.rounds) assert.deepEqual((await s.childStore.load(round.childId)).allowedTools, ['evidence.read']);
  assert.equal(s.tools.counts['evidence.assess'], 0);
});

test('real SIGKILL model_started cannot use raw Model API to bypass conservative recovery', async t => {
  const s = await setup(t); const marker = await worker(s, 'model_started'); assert.equal(marker.calls, 0);
  const r = fresh(s), loop = await unlock(s, r), child = await r.childStore.load(loop.rounds[0].childId);
  await assert.rejects(r.modelApi.execute({ intent: child.model.intent, prompt: r.modelApi.promptForTask(child) }), { code: 'M4_DISPATCH_CONTEXT_REQUIRED' });
  assert.equal(r.registry.calls, 0); assert.equal((await r.budgets.snapshot(child.model.intent)).group, null);
  assert.equal((await r.harness.run(loop.id, s.context)).status, 'recovery-required'); assert.equal(r.registry.calls, 0);
});
