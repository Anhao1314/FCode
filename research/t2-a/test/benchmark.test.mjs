import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { corpus, observation, splitAudit, execute, realAuthorityControl, ACTIONS } from '../environment.mjs';
import { BenchmarkExecutor } from '../executor.mjs';
import { STRATEGIES } from '../strategies.mjs';
import { gold, score } from '../verifier.mjs';
import { runExperiment } from '../experiment.mjs';
import { digest, stable } from '../../../packages/native-agent/src/baseline.mjs';
import { offlineService } from '../../../packages/native-agent/src/fixtures.mjs';

const root = fileURLToPath(new URL('../../../work/t2/', import.meta.url));
await mkdir(root, { recursive: true, mode: 0o700 });
const evidence = [], context = { principal: 't2-local-researcher' };
async function setup(caseId = 'a0', options = {}) {
  const path = await mkdtemp(join(root, 'case-')), executor = new BenchmarkExecutor(path, options), task = await executor.create(caseId, 'script', context);
  evidence.push({ path, id: task.id, caseId }); return { path, executor, task };
}

test('frozen Gold and corpus are independent, counterfactuals change one visible condition, semantic overlaps are disclosed', async () => {
  const { data, freeze } = await corpus(), labels = await gold();
  assert.equal(freeze.freezeBeforeStrategyImplementation, true); assert.equal(data.cases.length, 12);
  assert.equal(new Set(data.cases.map(c => c.family)).size, 6);
  for (const [a, b] of data.counterfactualPairs) {
    const x = data.cases.find(c => c.id === a), y = data.cases.find(c => c.id === b);
    assert.equal(x.split, y.split);
    assert.equal(Object.keys(x.observation).filter(k => stable(x.observation[k]) !== stable(y.observation[k])).length, 1);
    assert.notDeepEqual(labels.labels[a].acceptable, labels.labels[b].acceptable);
  }
  const audit = splitAudit(data); assert.equal(audit.conflicts.length, 0); assert.deepEqual(audit.withinSplitDuplicates, [['a0', 'b0']]); assert.equal(audit.blindEvaluation, false);
  const policy = (await readFile(new URL('../strategies.mjs', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.ok(!/\b(?:caseId|family|split)\b|from ['"][^'"]*(?:gold|corpus|freeze)/.test(policy), 'no task labels or frozen-label imports; Object.freeze is ordinary JS immutability');
  const verifier = await readFile(new URL('../verifier.mjs', import.meta.url), 'utf8'); assert.ok(!/from ['"].*(?:strategies|environment)/.test(verifier));
});

test('all four frozen strategies use identical inputs and actual signed execution; simple-rule ceiling is retained', async () => {
  const path = await mkdtemp(join(root, 'matrix-')), result = await runExperiment(path);
  assert.equal(result.rows.length, 48); assert.equal(result.proposalCalls, 48);
  for (const id of new Set(result.rows.map(r => r.caseId))) assert.equal(new Set(result.rows.filter(r => r.caseId === id).map(r => r.inputHash)).size, 1);
  for (const r of result.rows) { assert.ok(r.proposalRef); if (r.status === 'finished') assert.ok(r.actionRef); assert.equal(r.score.financialFactTruth, 'NOT_PROVEN'); }
  const all = result.metrics.filter(m => m.split === 'all');
  assert.ok(all.every(m => m.n === 12 && m.acceptable >= 0 && m.acceptable <= m.n));
  assert.ok(result.metrics.filter(m => m.split === 'eval').every(m => m.n === 4));
  assert.equal(result.counterfactuals.length, 6);
  // No PASS threshold on a policy's research accuracy. Record its actual score,
  // including zero or a heuristic ceiling; do not tune Gold to the outcome.
  assert.equal(result.T1_TRAINING_READY, 'BLOCKED'); evidence.push({ experiment: 'controlled-matrix', path, result });
});

test('multiple reasonable actions are accepted independently; preparatory completion is not financial research completion', async () => {
  const { data } = await corpus(), labels = await gold(), task = data.cases.find(c => c.id === 'a1');
  for (const tool of ['read.supplement', 'inspect.comparability']) {
    const result = execute(task, { tool, arguments: {} }), assessment = score(task, { tool, arguments: {} }, { status: 'finished', result, resultHash: digest(result) }, labels);
    assert.equal(assessment.strategyAcceptable, true); assert.equal(assessment.executionComplete, true); assert.equal(assessment.researchGoalComplete, false);
  }
  const scaled = data.cases.find(c => c.id === 'c0'), alternative = execute(scaled, { tool: 'read.supplement', arguments: {} }), normalized = execute(scaled, { tool: 'normalize.units', arguments: {} });
  assert.equal(alternative.documents[0].statements[0].grossProfit, normalized.statements[1].grossProfit);
  assert.equal(alternative.documents[0].statements[0].revenue, normalized.statements[1].revenue);
  const underCredit = score(scaled, { tool: 'read.supplement', arguments: {} }, { status: 'finished', result: alternative, resultHash: digest(alternative) }, labels);
  assert.equal(underCredit.legality, true); assert.equal(underCredit.executionComplete, true); assert.equal(underCredit.strategyAcceptable, false, 'frozen label is restrictive; preserve and disclose, do not rewrite Gold');
  evidence.push({ experiment: 'frozen-gold-under-coverage', underCredit, criterion: labels.labels.c0.criterion });
});

test('new synthetic arithmetic is experimental; original Authority rejects it, original financial calculation still runs', async () => {
  const authority = realAuthorityControl(); assert.equal(authority.permissions.contextualCalculation, false); assert.equal(authority.permissions.riskCalculation, false);
  assert.ok(authority.reasons.some(r => r.code === 'PUBLIC_PROVIDER_BINDING_MISMATCH'));
  const path = await mkdtemp(join(root, 'original-control-')), service = offlineService(path), created = await service.create({ target: 'MiniMax', profile: 'public-context' }, { authorization: 'synthetic-t2-control' });
  const record = await service.read(created.id, 'synthetic-t2-control', created.assessmentAccessToken);
  assert.equal(record.assessment.calculations.find(c => c.formula === 'gross_profit / revenue * 100').value, 17.85); assert.equal(record.assessment.deterministicRisk, null);
  evidence.push({ experiment: 'original-authority-and-arithmetic', authority });
});

test('unsupported currency, period, conflicting revisions, bad numeric values and invented FX never enter calculation', async () => {
  const { data } = await corpus();
  for (const id of ['a1', 'b1', 'c0', 'c1', 'd0', 'd1', 'e0', 'e1', 'f0', 'f1']) assert.throws(() => execute(data.cases.find(c => c.id === id), { tool: 'calculate.margin', arguments: {} }), { code: 'T2_CALCULATION_BLOCKED' });
  const invalid = structuredClone(data.cases[0]); invalid.observation.statements[0].revenue = 0;
  assert.throws(() => execute(invalid, { tool: 'calculate.margin', arguments: {} }), { code: 'T2_CALCULATION_BLOCKED' });
  assert.throws(() => execute(data.cases[0], { tool: 'calculate.margin', arguments: { fxRate: 1 } }), { code: 'T2_ACTION_DENIED' });
  const crossPeriodCurrency = structuredClone(data.cases[0]); crossPeriodCurrency.observation.statements[1].currency = 'EUR'; crossPeriodCurrency.observation.statements[1].profitCurrency = 'EUR';
  assert.equal(execute(crossPeriodCurrency, { tool: 'calculate.margin', arguments: {} }).changePp, -10, 'dimensionless margins may compare currencies when each numerator/denominator matches');
});

test('unknown proposal preserves original budgets, same identity and lease; no signature or wrong receipt cannot reconcile', async () => {
  const s = await setup('a1'), outcome = await s.executor.run(s.task.id, context, () => { throw Object.assign(Error('injected uncertain proposal'), { code: 'T2_INJECTED_UNKNOWN' }); });
  assert.equal(outcome.status, 'unknown'); const before = await s.executor.budgets.snapshot(outcome.intent);
  assert.equal(before.group.reservations[0].status, 'unknown'); assert.equal(before.pool.leases[0].status, 'held');
  const restarted = new BenchmarkExecutor(s.path); const again = await restarted.run(s.task.id, context, STRATEGIES.researchCandidate);
  assert.equal(again.intent.requestId, outcome.intent.requestId); assert.equal(restarted.calls, 0);
  await assert.rejects(restarted.reconcile(s.task.id, context, { kind: 'proposal', receiptRef: 'f'.repeat(64) }), { code: 'T2_RECEIPT_MISMATCH' });
  const after = await restarted.budgets.snapshot(outcome.intent); assert.equal(after.totalReservedTokens, before.totalReservedTokens); evidence.push({ experiment: 'unknown-proposal', outcome });
});

test('persisted receipt after interruption requires explicit reconciliation, never an automatic new proposal', async () => {
  let ref;
  const s = await setup('a0', { afterPhase: async (phase, r) => { if (phase === 'proposal-receipt') { ref = r.receiptRef; throw Object.assign(Error('after receipt'), { code: 'T2_AFTER_RECEIPT' }); } } });
  const unknown = await s.executor.run(s.task.id, context, STRATEGIES.researchCandidate); assert.equal(unknown.status, 'unknown');
  const restarted = new BenchmarkExecutor(s.path); assert.equal((await restarted.run(s.task.id, context, () => { throw Error('must not call'); })).status, 'unknown');
  assert.equal((await restarted.reconcile(s.task.id, context, { kind: 'proposal', receiptRef: ref })).status, 'ready');
  const completed = await restarted.run(s.task.id, context, () => { throw Error('must not call'); }); assert.equal(completed.status, 'finished'); assert.equal(restarted.calls, 0);
});

test('unknown tool outcome holds document quota; matching signed result can reconcile without reading again', async () => {
  let ref;
  const s = await setup('a1', { afterPhase: async (phase, r) => { if (phase === 'action-receipt') { ref = r.receiptRef; throw Object.assign(Error('result checkpoint interrupted'), { code: 'T2_RESULT_INTERRUPTED' }); } } });
  const unknown = await s.executor.run(s.task.id, context, STRATEGIES.researchCandidate); assert.equal(unknown.status, 'unknown');
  const { data } = await corpus(), task = data.cases.find(t => t.id === 'a1'), proposal = await s.executor.readReceipt(unknown, 'proposal', unknown.proposalRef, task), quota = await s.executor.readBudgets.snapshot(s.executor.readIntent(unknown, proposal.action));
  assert.equal(quota.pool.leases[0].status, 'held'); assert.equal(quota.group.reservations[0].status, 'unknown');
  const restart = new BenchmarkExecutor(s.path); assert.equal((await restart.run(s.task.id, context, STRATEGIES.researchCandidate)).status, 'unknown');
  assert.equal((await restart.reconcile(s.task.id, context, { kind: 'action', receiptRef: ref })).status, 'finished'); assert.equal(restart.calls, 0); assert.equal(restart.executions, 0);
  evidence.push({ experiment: 'unknown-action-explicit-receipt', unknown });
});

test('malicious tool, arguments, self-Gold and financial authority claims are refused before action', async () => {
  for (const action of [{ tool: 'finance.trade', arguments: {} }, { tool: 'calculate.margin', arguments: { access: 'expanded' } }, { tool: 'calculate.margin', arguments: {}, gold: true }, { tool: 'calculate.margin', arguments: {}, riskAuthorized: true }]) {
    const s = await setup(), r = await s.executor.run(s.task.id, context, () => action); assert.equal(r.status, 'denied'); assert.equal(s.executor.executions, 0); evidence.push({ experiment: 'malicious-proposal', action, record: r });
  }
});

test('host authorization changes and current tool/read limits cannot be expanded by strategy or context', async () => {
  const s = await setup('a0', { host: { allowedActions: ['report.insufficient'] } });
  let seen;
  const denied = await s.executor.run(s.task.id, context, o => { seen = o.permissions.allowedActions; return { tool: 'calculate.margin', arguments: {} }; });
  assert.deepEqual(seen, ['report.insufficient']); assert.equal(denied.status, 'denied'); assert.equal(s.executor.executions, 0);
  const revoked = await setup('a0', { afterPhase: async phase => { if (phase === 'reserved') revoked.executor.host.revision++; } });
  const outcome = await revoked.executor.run(revoked.task.id, context, STRATEGIES.researchCandidate); assert.equal(outcome.status, 'unknown'); assert.equal(revoked.executor.calls, 0);
  const quota = await revoked.executor.budgets.snapshot(outcome.intent); assert.equal(quota.pool.leases[0].status, 'held');
  await assert.rejects(revoked.executor.run(outcome.id, context, STRATEGIES.researchCandidate), { code: 'T2_AUTHORIZATION_CHANGED' });
  await assert.rejects(s.executor.run(s.task.id, { principal: 'another-owner' }, STRATEGIES.researchCandidate), { code: 'T2_OWNER_DENIED' });
  const stopped = await setup('a1', { host: { allowedActions: ['report.insufficient'], maxReads: 0 } }), result = await stopped.executor.run(stopped.task.id, context, () => ({ tool: 'report.insufficient', arguments: {} }));
  assert.equal(result.status, 'finished'); assert.equal(result.result.remainingReads, 0, 'signed result must describe host-filtered permissions'); assert.equal(result.result.resolvingReadAvailable, false);
});

test('concurrent duplicate tasks and repeated completed runs retain one proposal/result; grant quota survives new task identity', async () => {
  const s = await setup('a0', { host: { maxCalls: 1 } }), created = await s.executor.create('a0', 'script', context); assert.equal(created.id, s.task.id);
  const result = await Promise.all([s.executor.run(created.id, context, STRATEGIES.researchCandidate), s.executor.run(created.id, context, STRATEGIES.researchCandidate)]);
  assert.ok(result.every(r => r.status === 'finished')); assert.equal(s.executor.calls, 1); assert.equal(s.executor.executions, 1);
  const next = await s.executor.create('b0', 'other', context); await assert.rejects(s.executor.run(next.id, context, STRATEGIES.researchCandidate), { code: 'MODEL_CALL_QUOTA' });
  const restart = new BenchmarkExecutor(s.path, { host: { maxCalls: 1 } }); await restart.run(created.id, context, STRATEGIES.researchCandidate); assert.equal(restart.calls, 0);
  const limited = await setup('a1', { host: { maxReads: 1 } });
  assert.equal((await limited.executor.run(limited.task.id, context, STRATEGIES.researchCandidate)).status, 'finished');
  const another = await limited.executor.create('b1', 'other', context), blocked = await limited.executor.run(another.id, context, STRATEGIES.researchCandidate);
  assert.equal(blocked.status, 'unknown'); assert.equal(blocked.error, 'MODEL_CALL_QUOTA'); assert.equal(limited.executor.executions, 1);
  const snapshot = await limited.executor.readBudgets.snapshot(limited.executor.readIntent(blocked, { tool: 'read.supplement', arguments: {} })); assert.equal(snapshot.group.reservations.length, 1);
  evidence.push({ experiment: 'global-document-quota-not-reset', blocked });
});

test('checkpoint, signed result content and historical rewrites fail closed with original witnesses', async () => {
  const s = await setup(), r = await s.executor.run(s.task.id, context, STRATEGIES.researchCandidate);
  const path = join(s.executor.store.checkpoints, `${r.id}.json`), original = await readFile(path); await writeFile(join(s.path, 'before-tamper.private'), original, { mode: 0o600, flag: 'wx' });
  await writeFile(path, original.toString().replace('finished', 'unknown')); await assert.rejects(s.executor.run(r.id, context, STRATEGIES.researchCandidate), error => /INTEGRITY|SIGNATURE/.test(error.code));
  const second = await setup(), done = await second.executor.run(second.task.id, context, STRATEGIES.researchCandidate), receiptPath = join(second.path, 'research-receipts', `${done.actionRef}.json`), bytes = await readFile(receiptPath);
  await writeFile(join(second.path, 'before-result-tamper.private'), bytes, { mode: 0o600, flag: 'wx' }); await writeFile(receiptPath, bytes.toString().replace('changePp', 'forgedDelta'));
  await assert.rejects(second.executor.run(done.id, context, STRATEGIES.researchCandidate), error => /INTEGRITY|SIGNATURE/.test(error.code));
  const third = await setup(), finished = await third.executor.run(third.task.id, context, STRATEGIES.researchCandidate);
  const forged = { ...finished, result: { ...finished.result, changePp: 500 }, events: [...finished.events] }; forged.resultHash = digest(forged.result);
  const event = { sequence: finished.sequence + 1, at: new Date().toISOString(), type: 'forged-update', status: 'finished', previousHash: finished.events.at(-1).hash }; forged.sequence++; forged.events.push({ ...event, hash: digest(event) });
  await assert.rejects(third.executor.store.exclusive(finished.id, () => third.executor.store.save(forged, finished.sequence)), error => /RESULT_UNCONFIRMED|HISTORY/.test(error.code));
});

test('Observation excludes task labels/identity and future documents; counterfeit split aliases are detected', async () => {
  const { data } = await corpus();
  for (const task of data.cases) { const text = stable(observation(task)); assert.ok(!/caseId|sourceFamily|templateFamily|semanticFamily|split|seed|Hash|acceptable|forbidden|truth|criterion/.test(text)); assert.ok(!Object.hasOwn(observation(task), 'documents')); }
  const fake = structuredClone(data), alias = structuredClone(fake.cases[0]); alias.id = 'alias'; alias.family = 'different'; alias.entity = 'different'; alias.sourceFamily = 'different'; alias.templateFamily = 'different'; alias.semanticFamily = 'different'; alias.split = 'eval';
  fake.cases.push(alias); assert.ok(splitAudit(fake).conflicts.some(c => c.semantic));
});

test('real SIGKILL after action-started requires lock recovery and leaves unknown; no retry or positive result', async t => {
  const s = await setup(), handoff = join(s.path, 'handoff.private'); await writeFile(handoff, JSON.stringify({ root: s.path, id: s.task.id }), { flag: 'wx', mode: 0o600 });
  const child = fork(fileURLToPath(new URL('./crash-worker.mjs', import.meta.url)), [handoff], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const msg = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error('worker early exit: ' + stderr); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('worker timeout')), 15000); timer.unref(); })]);
  assert.equal(msg[0].phase, 'action-started'); const end = once(child, 'exit'); child.kill('SIGKILL'); await end; assert.equal(child.signalCode, 'SIGKILL');
  const restart = new BenchmarkExecutor(s.path); await assert.rejects(restart.run(s.task.id, context, STRATEGIES.researchCandidate), { code: 'TASK_BUSY' }); await restart.store.recoverLock(s.task.id);
  const unknown = await restart.run(s.task.id, context, STRATEGIES.researchCandidate); assert.equal(unknown.status, 'unknown'); assert.equal(unknown.actionRef, null); assert.equal(restart.calls, 0); assert.equal(restart.executions, 0);
  await assert.rejects(restart.reconcile(s.task.id, context, { kind: 'action', receiptRef: 'e'.repeat(64) }), { code: 'T2_RECEIPT_MISMATCH' }); evidence.push({ experiment: 'SIGKILL', signal: child.signalCode, unknown });
});

test.after(async () => { await writeFile(new URL('../../../validation/t2-cases.json', import.meta.url), JSON.stringify({ version: 'flowcredit.t2-evidence/v1', evidence, realModelCalls: 0, trainingRuns: 0 }, null, 2), { flag: 'wx', mode: 0o600 }); });
