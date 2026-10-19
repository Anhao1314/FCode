import { digest, stable } from './baseline.mjs';
import { fail, exactKeys, validatePlan, PLAN_VERSION } from './contracts.mjs';
export const LOOP_VERSION = 'flowcredit.offline-loop/m4-l0-v1';
export const CONTEXT_VERSION = 'flowcredit.loop-context/m4-l0-v1';
export const LOOP_POLICY = Object.freeze({ version: 'flowcredit.loop-policy/m4-l0-v1', maxRounds: 4, maxContextBytes: 2000, goal: 'verified-context-or-confirmed-empty/v1' });
export const validId = id => /^task-[a-f0-9]{32}$/.test(id || '');
export const hash = value => /^[a-f0-9]{64}$/.test(value || '');
export const terminal = status => ['completed', 'insufficient-evidence', 'failed', 'denied'].includes(status);
export function validateLoopPolicy(value) {
  if (!exactKeys(value, ['version', 'maxRounds', 'maxContextBytes', 'goal']) || value.version !== LOOP_POLICY.version || value.goal !== LOOP_POLICY.goal || !Number.isInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > 6 || !Number.isInteger(value.maxContextBytes) || value.maxContextBytes < 256 || value.maxContextBytes > 2000) fail('M4_POLICY_CONFIGURATION');
  return Object.freeze(structuredClone(value));
}
export function contextFor(loop, index) {
  const observations = loop.rounds.slice(0, index - 1).map(round => {
    if (!round.observation) fail('M4_OBSERVATION_GAP');
    const { tool, result, resultHash } = round.observation;
    return { round: round.index, tool, resultHash, factCount: tool === 'evidence.read' ? result.factIds.length : result.assessment.facts.length, calculationCount: tool === 'evidence.assess' ? result.assessment.calculations.length : null };
  });
  const context = { version: CONTEXT_VERSION, loopId: loop.id, round: index, policyHash: loop.policyHash, objective: loop.objective, bindingHash: digest(loop.binding), previousObservationHash: digest(observations), observations };
  if (Buffer.byteLength(JSON.stringify(context)) > loop.policy.maxContextBytes) fail('M4_CONTEXT_LIMIT');
  return context;
}
export function childId(loopId, index, contextHash) { return `task-${digest([LOOP_VERSION, loopId, index, contextHash]).slice(0, 32)}`; }
export function expectedAction(context) {
  if (context.observations.length === 0) return 'evidence.read';
  const first = context.observations[0];
  if (context.observations.length !== 1 || first.tool !== 'evidence.read') fail('M4_NO_PROGRESS');
  return first.factCount === 0 ? 'evidence.read' : 'evidence.assess';
}
export function gateDecision(task, proposedStep) {
  // Original M1 reconciliation gates a receipt's steps before installing plan.
  // The full one-action plan is checked again before run executes any tool.
  const plan = validatePlan(task.plan === null && proposedStep ? { version: PLAN_VERSION, steps: [proposedStep] } : task.plan);
  if (plan.steps.length !== 1) fail('M4_SINGLE_ACTION_REQUIRED');
  let context; try { context = JSON.parse(task.objective); } catch { fail('M4_CONTEXT_MISMATCH'); }
  if (context.version !== CONTEXT_VERSION || task.id !== childId(context.loopId, context.round, digest(context))) fail('M4_CONTEXT_MISMATCH');
  if (plan.steps[0].tool !== expectedAction(context)) fail('M4_NO_PROGRESS');
  return plan.steps[0];
}
export function matchChild(loop, round, task) {
  const expected = contextFor(loop, round.index);
  if (round.contextHash !== digest(expected) || stable(round.context) !== stable(expected) || round.childId !== childId(loop.id, round.index, round.contextHash) || task.id !== round.childId || task.objective !== JSON.stringify(expected) || task.principalHash !== loop.principalHash || stable(task.binding) !== stable(loop.binding) || stable(task.allowedTools) !== stable(loop.allowedTools) || stable(task.modelGrant) !== stable(loop.modelGrant)) fail('M4_CHILD_BINDING_MISMATCH');
}
