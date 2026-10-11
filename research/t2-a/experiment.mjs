import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BenchmarkExecutor } from './executor.mjs';
import { corpus, observation, splitAudit } from './environment.mjs';
import { STRATEGIES } from './strategies.mjs';
import { gold, score } from './verifier.mjs';
import { fail } from '../../packages/native-agent/src/contracts.mjs';
import { digest } from '../../packages/native-agent/src/baseline.mjs';

export async function runExperiment(root) {
  const freeze = JSON.parse(await readFile(new URL('./strategy-freeze.json', import.meta.url)));
  for (const [name, hash] of Object.entries(freeze.sha256)) {
    const current = await readFile(new URL(name, import.meta.url)), currentHash = createHash('sha256').update(current).digest('hex');
    if (currentHash === hash) continue;
    if (name !== 'environment.mjs') fail('T2_STRATEGY_FREEZE_CHANGED');
    // Explicit engineering correction, never a replacement of frozen policy or
    // labels. Keep the old source and prove the candidate's diagnostic unchanged.
    const repair = JSON.parse(await readFile(new URL('./engineering-repair.json', import.meta.url))), old = await readFile(new URL(repair.originalSource, import.meta.url));
    const diagnostic = text => text.toString().split('export function diagnose(o) {')[1]?.split('export function permitted')[0];
    if (repair.originalHash !== hash || repair.correctedHash !== currentHash || createHash('sha256').update(old).digest('hex') !== hash || diagnostic(old) !== diagnostic(current)) fail('T2_STRATEGY_FREEZE_CHANGED');
  }
  const { data, fingerprint } = await corpus(), labels = await gold(), isolation = splitAudit(data);
  if (isolation.conflicts.length) fail('T2_SPLIT_LEAKAGE');
  const executor = new BenchmarkExecutor(root), context = { principal: 't2-local-researcher' }, rows = [], records = [];
  for (const task of data.cases) for (const [name, propose] of Object.entries(STRATEGIES)) {
    const created = await executor.create(task.id, name, context), record = await executor.run(created.id, context, propose);
    const action = record.proposalRef ? (await executor.readReceipt(record, 'proposal', record.proposalRef, task)).action : null;
    const assessment = score(task, action, record, labels);
    rows.push({ caseId: task.id, family: task.family, split: task.split, strategy: name, inputHash: digest(observation(task)), action: action?.tool || null, recordId: record.id, proposalRef: record.proposalRef, actionRef: record.actionRef, status: record.status, error: record.error, score: assessment }); records.push(record);
  }
  const metrics = [];
  for (const strategy of Object.keys(STRATEGIES)) for (const split of ['all', 'train', 'dev', 'eval']) {
    const selection = rows.filter(r => r.strategy === strategy && (split === 'all' || r.split === split));
    metrics.push({ strategy, split, n: selection.length, legal: selection.filter(r => r.score.legality).length, acceptable: selection.filter(r => r.score.strategyAcceptable).length, executionComplete: selection.filter(r => r.score.executionComplete).length, syntheticCalculationVerified: selection.filter(r => r.score.syntheticCalculationVerified).length, prematureCalculations: selection.filter(r => r.score.prematureCalculation).length });
  }
  const counterfactuals = data.counterfactualPairs.map(([a, b]) => ({ pair: [a, b], strategies: Object.fromEntries(Object.keys(STRATEGIES).map(s => { const x = rows.find(r => r.caseId === a && r.strategy === s), y = rows.find(r => r.caseId === b && r.strategy === s); return [s, { changedAction: x.action !== y.action, bothAcceptable: x.score.strategyAcceptable && y.score.strategyAcceptable }]; })) }));
  return { version: 'flowcredit.t2-experiment/v1', corpusHash: fingerprint, metrics, counterfactuals, isolation, rows, records, proposalCalls: executor.calls, actionExecutions: executor.executions, realModelCalls: 0, trainedModels: 0, T1_TRAINING_READY: 'BLOCKED', nextResearchDecision: 'NO_TEACHER_OR_STUDENT_JUSTIFICATION_FROM_THIS_CEILING' };
}
