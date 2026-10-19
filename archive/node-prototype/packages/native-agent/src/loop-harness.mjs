import { NativeHarness } from './harness.mjs';
import { newTaskId } from './task-store.mjs';
import { digest, stable } from './baseline.mjs';
import { fail, exactKeys, RuntimeError } from './contracts.mjs';
import { validateProviderAuthorization } from './provider-model-api.mjs';
import { projectEvidenceObservation } from './tools.mjs';
import { LOOP_VERSION, contextFor, childId, matchChild, gateDecision, terminal } from './loop-contract.mjs';
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'M4_EXECUTION_UNCERTAIN';

// A single sequential loop, not subagent orchestration. Each decision is an
// ordinary M2 durable task; M2 alone owns dispatch, receipts and tool replay.
export class OfflineLoopHarness extends NativeHarness {
  constructor({ childHarnessFor, childStore, policy, authorizer, runWithPermit, ...options }) {
    super(options); this.childHarnessFor = childHarnessFor; this.childStore = childStore; this.policy = policy; this.authorizer = authorizer; this.runWithPermit = runWithPermit;
  }
  async create(input) {
    if (!exactKeys(input, ['assessmentId', 'objective', 'context', 'modelGrant']) || !exactKeys(input.context, ['principal', 'authorization', 'accessToken', 'allowedTools']) || typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 500 || typeof input.context.principal !== 'string' || !input.context.principal.trim()) fail('M4_INPUT_DENIED');
    const authorization = validateProviderAuthorization(await this.authorizer({ taskId: null, principalHash: digest(input.context.principal) }));
    if (stable(authorization.grant) !== stable(input.modelGrant) || !authorization.grant.allowedRoutes.includes(authorization.routeId) || !Array.isArray(input.context.allowedTools) || input.context.allowedTools.some(tool => !authorization.grant.allowedTools.includes(tool))) fail('MODEL_CURRENT_AUTHORIZATION_DENIED');
    const { binding } = await this.tools.inspect(input.assessmentId, input.context);
    const loop = { id: newTaskId(), version: LOOP_VERSION, sequence: 0, status: 'created', principalHash: digest(input.context.principal), objective: input.objective, binding, allowedTools: [...input.context.allowedTools], modelGrant: structuredClone(input.modelGrant), authorizationHash: digest(authorization), policy: structuredClone(this.policy), policyHash: digest(this.policy), rounds: [], events: [], failure: null, result: null };
    await this.store.create(loop);
    await this.store.exclusive(loop.id, () => this.checkpoint(loop, 'loop_created'));
    return structuredClone(loop);
  }
  async authorize(loop, context) {
    if (loop.principalHash !== digest(String(context?.principal || ''))) fail('TASK_OWNER_DENIED');
    this.verifyEvents(loop);
    if (loop.policyHash !== digest(this.policy)) fail('M4_POLICY_CHANGED');
    const authorization = validateProviderAuthorization(await this.authorizer({ taskId: loop.id, principalHash: loop.principalHash, binding: loop.binding }));
    if (loop.authorizationHash !== digest(authorization) || stable(loop.modelGrant) !== stable(authorization.grant)) fail('MODEL_CURRENT_AUTHORIZATION_DENIED');
    if (!Array.isArray(context.allowedTools) || loop.allowedTools.some(tool => !authorization.grant.allowedTools.includes(tool) || !context.allowedTools.includes(tool)) || context.allowedTools.some(tool => !authorization.grant.allowedTools.includes(tool))) fail('TOOL_PERMISSION_DENIED');
    return this.tools.inspect(loop.binding.assessmentId, context, loop.binding);
  }
  async checkObservation(loop, round, context, record) {
    const child = await this.childStore.load(round.childId); matchChild(loop, round, child);
    await this.childHarnessFor(round.childId).authorizeTask(child, context);
    if (!child.model.intent || child.model.intent.requestId !== round.requestId || child.model.outcome !== 'confirmed-valid') fail('M4_OBSERVATION_UNCONFIRMED');
    await this.modelApi.validateIntent(child.model.intent);
    const receipt = await this.modelApi.readReceipt(child.model.receiptRef, child.model.intent);
    const step = gateDecision(child);
    const actual = child.steps[0];
    if (receipt.status !== 'confirmed-valid' || receipt.planHash !== digest(child.plan) || actual?.status !== 'succeeded' || actual.resultHash !== digest(actual.result) || actual.id !== step.id || actual.tool !== step.tool || stable(actual.arguments) !== stable(step.arguments) || actual.resultHash !== digest(projectEvidenceObservation(step.tool, record))) fail('M4_OBSERVATION_MISMATCH');
    const observation = { tool: actual.tool, stepId: actual.id, result: structuredClone(actual.result), resultHash: actual.resultHash };
    if (round.status === 'observed' && (round.receiptRef !== child.model.receiptRef || round.planHash !== receipt.planHash || stable(round.observation) !== stable(observation))) fail('M4_OBSERVATION_MISMATCH');
    return { observation, receiptRef: child.model.receiptRef, planHash: receipt.planHash };
  }
  async verifyPrefix(loop, context, record) { for (const round of loop.rounds) if (round.status === 'observed') await this.checkObservation(loop, round, context, record); }
  async terminalResult(loop, context, record) {
    const observed = loop.rounds.filter(round => round.status === 'observed');
    if (observed.length !== loop.rounds.length) return null;
    const tools = observed.map(round => round.observation.tool);
    if (tools.includes('evidence.read') && tools.includes('evidence.assess')) {
      if (record.assessment.facts.length === 0) fail('M4_GOAL_NOT_MET');
      const steps = await Promise.all(observed.map(async round => (await this.childStore.load(round.childId)).steps[0]));
      const verified = await this.tools.verify({ binding: loop.binding, allowedTools: loop.allowedTools, steps }, context);
      return { status: 'completed', result: { ...verified, loopVerification: 'runtime-recomputed', observationHashes: observed.map(round => round.observation.resultHash) } };
    }
    if (tools.length === 2 && tools.every(tool => tool === 'evidence.read') && record.assessment.facts.length === 0 && observed.every(round => round.observation.result.factIds.length === 0)) return { status: 'insufficient-evidence', result: { assessmentId: loop.binding.assessmentId, revision: loop.binding.revision, verification: 'two-runtime-verified-empty-reads', observationHashes: observed.map(round => round.observation.resultHash), researchCompleted: false, riskResult: null } };
    return null;
  }
  async childFor(loop, round, context) {
    const harness = this.childHarnessFor(round.childId); let child;
    try { child = await this.childStore.load(round.childId); }
    catch (error) {
      if (error.code !== 'TASK_NOT_FOUND' || round.status !== 'reserved') throw error;
      child = await harness.create({ assessmentId: loop.binding.assessmentId, objective: JSON.stringify(round.context), context: { ...context, allowedTools: [...loop.allowedTools] }, modelGrant: loop.modelGrant });
    }
    matchChild(loop, round, child);
    if (round.status === 'reserved') {
      if (child.model.attempts !== 0 || child.status !== 'created') fail('M4_UNLINKED_DISPATCH');
      round.status = 'linked'; await this.checkpoint(loop, 'round_linked', { index: round.index, childId: round.childId });
    }
    return { harness, child };
  }
  async run(id, context, { pauseAfterRounds = null, signal } = {}) {
    return this.store.exclusive(id, async () => {
      const loop = await this.store.load(id); let record;
      try { ({ record } = await this.authorize(loop, context)); await this.verifyPrefix(loop, context, record); }
      catch (error) { return this.reject(id, context || {}, error); }
      if (terminal(loop.status)) {
        if (['completed', 'insufficient-evidence'].includes(loop.status)) { const verified = await this.terminalResult(loop, context, record); if (!verified || verified.status !== loop.status || stable(verified.result) !== stable(loop.result)) fail('M4_TERMINAL_MISMATCH'); }
        return loop;
      }
      if (loop.status === 'recovery-required') return loop;
      let executed = 0;
      while (true) {
        if (signal?.aborted) fail('TASK_ABORTED');
        ({ record } = await this.authorize(loop, context)); await this.verifyPrefix(loop, context, record);
        const result = await this.terminalResult(loop, context, record);
        if (result) { loop.status = result.status; loop.result = result.result; loop.failure = null; await this.checkpoint(loop, 'loop_terminated', { status: loop.status, resultHash: digest(loop.result) }); return structuredClone(loop); }
        let round = loop.rounds.at(-1);
        if (!round || round.status === 'observed') {
          if (loop.rounds.length >= loop.policy.maxRounds) { loop.status = 'failed'; loop.failure = { code: 'M4_ROUND_LIMIT', retryable: false }; await this.checkpoint(loop, 'loop_limit', loop.failure); return loop; }
          const index = loop.rounds.length + 1, decisionContext = contextFor(loop, index), contextHash = digest(decisionContext);
          round = { index, childId: childId(loop.id, index, contextHash), context: decisionContext, contextHash, authorizationHash: loop.authorizationHash, status: 'reserved', requestId: `${childId(loop.id, index, contextHash)}:plan:1`, receiptRef: null, planHash: null, observation: null };
          loop.rounds.push(round); loop.status = 'active'; await this.checkpoint(loop, 'round_reserved', { index, childId: round.childId, contextHash });
        }
        const linked = await this.childFor(loop, round, context); let child = linked.child;
        if (child.status === 'running' && child.steps.length === 1 && child.steps[0].status === 'succeeded') {
          // A crash after tool_succeeded but before task_paused must not fall
          // through the original full-task verifier or repeat the model call.
          child = await this.childStore.exclusive(child.id, async () => {
            const latest = await this.childStore.load(child.id);
            ({ record } = await this.authorize(loop, context)); await this.checkObservation(loop, round, context, record);
            latest.status = 'paused'; await linked.harness.checkpoint(latest, 'task_paused', { recoveredSingleObservation: true }); return latest;
          });
        }
        if (child.status !== 'paused') {
          try {
            const invoke = () => linked.harness.run(child.id, context, { resume: ['running', 'planned', 'paused', 'failed'].includes(child.status), pauseAfterSteps: 1, signal });
            child = child.model.attempts === 0 ? await this.runWithPermit(loop, round, invoke) : await invoke();
          }
          catch (error) {
            if (!['MODEL_CALL_QUOTA', 'MODEL_COST_BUDGET_DENIED', 'MODEL_TOKEN_BUDGET_DENIED', 'MODEL_CONCURRENCY_DENIED'].includes(error.code)) throw error;
            round.status = 'failed'; loop.status = 'failed'; loop.failure = { code: error.code, round: round.index, retryable: false }; await this.checkpoint(loop, 'round_budget_denied', loop.failure); return loop;
          }
        }
        if (child.status === 'recovery-required') { round.status = 'unknown'; loop.status = 'recovery-required'; loop.failure = { code: 'MODEL_OUTCOME_UNKNOWN', childId: child.id, round: round.index, retryable: false }; await this.checkpoint(loop, 'round_unknown', loop.failure); return loop; }
        if (child.status !== 'paused') { round.status = 'failed'; loop.status = child.status === 'denied' ? 'denied' : 'failed'; loop.failure = { code: child.failure?.code || 'M4_ACTION_FAILED', childId: child.id, round: round.index, retryable: false }; await this.checkpoint(loop, 'round_failed', loop.failure); return loop; }
        ({ record } = await this.authorize(loop, context));
        Object.assign(round, await this.checkObservation(loop, round, context, record), { status: 'observed' });
        loop.status = 'active'; await this.checkpoint(loop, 'round_observed', { index: round.index, requestId: round.requestId, resultHash: round.observation.resultHash });
        executed += 1;
        if (pauseAfterRounds !== null && executed >= pauseAfterRounds) { loop.status = 'paused'; await this.checkpoint(loop, 'loop_paused'); return structuredClone(loop); }
      }
    });
  }
  async reconcile(id, context, { roundIndex, receiptRef } = {}) {
    return this.store.exclusive(id, async () => {
      const loop = await this.store.load(id);
      try {
        const { record } = await this.authorize(loop, context); await this.verifyPrefix(loop, context, record);
        const round = loop.rounds.at(-1);
        if (!round || round.index !== roundIndex) fail('MODEL_RECONCILIATION_BLOCKED');
        const child = await this.childStore.load(round.childId); matchChild(loop, round, child);
        if (['linked', 'observed'].includes(round.status) && child.model.receiptRef === receiptRef) { await this.childHarnessFor(round.childId).reconcile(child.id, context, { receiptRef }); return loop; }
        if (round.status !== 'unknown' || loop.status !== 'recovery-required') fail('MODEL_RECONCILIATION_BLOCKED');
        await this.childHarnessFor(round.childId).reconcile(child.id, context, { receiptRef });
        round.status = 'linked'; loop.status = 'active'; loop.failure = null;
        await this.checkpoint(loop, 'round_reconciled', { roundIndex, childId: child.id, receiptRef });
        return structuredClone(loop);
      } catch (error) { return this.reject(id, context || {}, error); }
    });
  }
}
