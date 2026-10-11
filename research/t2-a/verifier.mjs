import { readFile } from 'node:fs/promises';
import { digest, stable } from '../../packages/native-agent/src/baseline.mjs';
import { fail } from '../../packages/native-agent/src/contracts.mjs';

// Independent manual label data. No strategy/diagnostic function is imported.
export async function gold() { return JSON.parse(await readFile(new URL('./gold.json', import.meta.url))); }
export function score(task, proposal, execution, labels) {
  const g = labels.labels[task.id]; if (!g) fail('T2_GOLD_MISSING');
  const reading = ['inspect.comparability', 'read.supplement', 'inspect.revisions'].includes(proposal?.tool);
  const shape = proposal && Object.keys(proposal).sort().join(',') === 'arguments,tool' && proposal.arguments && typeof proposal.arguments === 'object' && !Array.isArray(proposal.arguments) && !Object.keys(proposal.arguments).length;
  const legality = !!shape && task.observation.permissions.allowedActions.includes(proposal.tool) && (!reading || task.observation.permissions.remainingReads > 0);
  const strategy = g.acceptable.includes(proposal?.tool);
  const complete = execution.status === 'finished' && execution.result && execution.resultHash === digest(execution.result);
  const expected = g.financialGold.calculation;
  const supportedCalculation = complete && expected !== null && proposal.tool === 'calculate.margin' && stable({ margins: execution.result.margins, changePp: execution.result.changePp }) === stable(expected);
  return { legality, strategyAcceptable: strategy, executionComplete: !!complete, syntheticCalculationVerified: !!supportedCalculation, researchGoalComplete: !!supportedCalculation, financialFactTruth: 'NOT_PROVEN', labelScope: 'hand-authored-synthetic-next-action-only', criterion: g.criterion, prematureCalculation: proposal?.tool === 'calculate.margin' && !strategy };
}
