import { ProviderModelApi } from './provider-model-api.mjs';
import { digest, stable } from './baseline.mjs';
import { PLAN_VERSION, RuntimeError, fail } from './contracts.mjs';
import { strictPlan } from './model-api.mjs';
import { matchChild, CONTEXT_VERSION } from './loop-contract.mjs';

export const OFFLINE_ROUTE = 'offline-loop';
export const OFFLINE_GRANT = Object.freeze({ allowedRoutes: [OFFLINE_ROUTE], allowedTools: ['evidence.read', 'evidence.assess'], maxCalls: 6, maxInputBytes: 20000, maxInputTokens: 25000, maxOutputTokens: 128, maxTotalTokens: 150000, maxCostMicrousd: 150000, maxConcurrent: 1 });
export function offlineAuthorization(grant = OFFLINE_GRANT) { return { version: 'flowcredit.model-authorization/m2-v1', grantId: 'offline-loop-grant', revision: 1, routeId: OFFLINE_ROUTE, grant: structuredClone(grant) }; }

// Pure local Mock. No HTTP function, environment lookup or model credential.
// The small synthetic tariff exercises durable reservations; it is not billing.
export function createOfflineRegistry({ decide = conditionalDecision, afterGenerated = async () => {} } = {}) {
  const pricing = Object.freeze({ version: 'offline-artificial-reserve-v1', kind: 'synthetic', currency: 'USD', inputMicrousdPerMillion: 1000000, outputMicrousdPerMillion: 1000000 });
  const descriptor = Object.freeze({ id: OFFLINE_ROUTE, adapter: 'offline-mock', model: 'flowcredit-offline-loop', provider: 'offline-mock', mode: 'offline-mock', pricing, pricingHash: digest(pricing), configHash: digest(['offline-loop-codec/v1', pricing, CONTEXT_VERSION]), acceptedReportedModels: Object.freeze(['flowcredit-offline-loop']) });
  let calls = 0; const trace = [];
  const route = Object.freeze({ descriptor, prepare(prompt) { const inputBytes = Buffer.byteLength(prompt); if (!prompt || inputBytes > 20000) fail('MODEL_INPUT_BUDGET_DENIED'); return { inputBytes, inputTokenBound: inputBytes + 512, outputTokenBound: 128, totalTokenReservation: inputBytes + 640, costReservationMicrousd: inputBytes + 640 }; },
    async plan({ requestId, taskId, principalHash, prompt, signal }) {
      if (signal?.aborted) fail('MODEL_ABORTED');
      calls += 1;
      const receipt = { requestId, taskId, principalHash, adapter: descriptor.adapter, provider: descriptor.provider, model: descriptor.model, routeId: descriptor.id, configHash: descriptor.configHash, pricingHash: descriptor.pricingHash, contractVersion: PLAN_VERSION, promptHash: digest(prompt), responseHash: null, responseHashKind: null, envelopeHash: null, status: 'failed', usage: null, usageStatus: 'missing', providerReportedModel: descriptor.model, errorCode: null, latencyMs: 0 };
      const input = JSON.parse(prompt), context = JSON.parse(input.objective);
      trace.push({ requestId, taskId, context: structuredClone(context), promptHash: digest(prompt) });
      let text;
      try {
        const output = await decide(structuredClone(context), signal);
        text = typeof output === 'string' ? output : JSON.stringify(output);
        if (Buffer.byteLength(text) > 16 * 1024) fail('MODEL_OUTPUT_TOO_LARGE');
        receipt.responseHash = digest(text); receipt.responseHashKind = 'inner-text'; receipt.envelopeHash = digest({ text });
        const plan = strictPlan(text); receipt.status = 'validated';
        trace.at(-1).proposal = structuredClone(plan);
        await afterGenerated({ requestId, context, plan }); return { plan, receipt };
      } catch (error) {
        const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'MODEL_UNAVAILABLE';
        receipt.errorCode = code; throw new RuntimeError(code, { receipt });
      }
    }
  });
  return Object.freeze({ descriptor: Object.freeze({ adapter: 'provider-registry', mode: 'offline-mock' }), get calls() { return calls; }, get trace() { return structuredClone(trace); }, route(id) { if (id !== OFFLINE_ROUTE) fail('MODEL_ROUTE_DENIED'); return route; } });
}
export function conditionalDecision(context) {
  // Select using the actual preceding tool observation, not fixture names,
  // task IDs, invocation counters or a predetermined list of answers.
  const last = context.observations.at(-1);
  const tool = !last || last.factCount === 0 ? 'evidence.read' : 'evidence.assess';
  return { version: PLAN_VERSION, steps: [{ id: 'observe', tool, arguments: {} }] };
}
export class OfflineLoopModelApi extends ProviderModelApi {
  constructor({ loopStore, assertFreshDispatch, currentPolicyHash, ...options }) { super(options); this.loopStore = loopStore; this.assertFreshDispatch = assertFreshDispatch; this.currentPolicyHash = currentPolicyHash; }
  get receiptVersion() { return 'flowcredit.model-result/m4-l0-offline-v1'; }
  get transportMode() { return 'offline-mock'; }
  async execute(input = {}) {
    if (Object.keys(input).some(key => !['intent', 'prompt', 'signal'].includes(key))) return super.execute(input);
    const { task } = await this.validateIntent(input.intent, input.prompt);
    if (task.status === 'planning' && task.model.status === 'started') this.assertFreshDispatch(input.intent);
    return super.execute(input);
  }
  async reserveResources(intent, prompt, authorization) { this.assertFreshDispatch(intent); return super.reserveResources(intent, prompt, authorization); }
  async dispatch(intent, prompt, authorization, signal) { this.assertFreshDispatch(intent); return super.dispatch(intent, prompt, authorization, signal); }
  async validateIntent(intent, prompt) {
    const validated = await super.validateIntent(intent, prompt);
    let context; try { context = JSON.parse(validated.task.objective); } catch { fail('M4_CONTEXT_MISMATCH'); }
    const loop = await this.loopStore.load(context.loopId), round = loop.rounds[context.round - 1];
    if (loop.policyHash !== this.currentPolicyHash) fail('M4_POLICY_CHANGED');
    if (!round || round.status === 'reserved' || loop.authorizationHash !== digest(validated.authorization)) fail('M4_CHILD_BINDING_MISMATCH');
    matchChild(loop, round, validated.task);
    if (stable(round.context) !== stable(context)) fail('M4_CONTEXT_MISMATCH');
    return validated;
  }
}
