import { createM2Runtime } from './m2-runtime.mjs';
import { assembleLoopRuntime } from './loop-runtime.mjs';
import { OfflineLoopModelApi } from './offline-loop-model.mjs';
import { ProviderModelApi } from './provider-model-api.mjs';
import { createProviderAdapter } from './provider-adapters.mjs';
import { createDeepSeekTransport, APPROVAL_VERSION } from './deepseek-transport.mjs';
import { deepSeekProfile, DEEPSEEK_MODEL, DEEPSEEK_ROUTE } from './deepseek-profile.mjs';
import { digest } from './baseline.mjs';
import { fail } from './contracts.mjs';
import { notDispatched } from './model-budgets.mjs';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function gatedApi(Base) {
  return class extends Base {
    constructor({ transport, ...options }) { super(options); this.transport = transport; }
    get receiptVersion() { return 'flowcredit.model-result/m3-a-v1'; }
    get transportMode() { return this.registry.route(DEEPSEEK_ROUTE).descriptor.mode; }
    async execute(input) { const { task } = await this.validateIntent(input?.intent, input?.prompt); if (task.status === 'planning' && task.model.status === 'started') this.transport.assertRuntime(task); return super.execute(input); }
    async preflight(task, prompt, authorization, signal) { await super.preflight(task, prompt, authorization, signal); await this.transport.check(this.contract.makeIntent(task, prompt, authorization), authorization); }
    async reserveResources(intent, prompt, authorization) { try { await this.transport.check(intent, authorization); } catch (error) { notDispatched(error.code || 'DEEPSEEK_LIVE_AUTHORIZATION_DENIED'); } return super.reserveResources(intent, prompt, authorization); }
    async dispatch(intent, prompt, authorization, signal) {
      try {
        const current = await this.validateIntent(intent, prompt); this.transport.assertRuntime(current.task);
        const approval = await this.transport.check(intent, current.authorization);
        return await this.transport.inDispatch(intent, prompt, approval, () => super.dispatch(intent, prompt, authorization, signal));
      } catch (error) {
        if (!(error.receipt?.responseHash && ['MODEL_OUTPUT_INVALID', 'MODEL_SCHEMA_INVALID'].includes(error.code))) await this.budgets.update(intent, 'unknown');
        throw error;
      }
    }
    async readReceipt(ref, intent) {
      const receipt = await super.readReceipt(ref, intent), ar = receipt.adapterReceipt, transmission = ar.transmission;
      if (transmission?.version !== APPROVAL_VERSION || transmission.mode !== this.transport.mode || !hash(transmission.approvalHash) || !hash(transmission.approvalIdHash) || transmission.tokenAndBillingGuarantee !== 'NOT_PROVEN') fail('MODEL_RECEIPT_MISMATCH');
      const details = ar.providerDetails;
      if (receipt.status === 'confirmed-valid' && (!details || details.inputTokenGuarantee !== 'NOT_PROVEN' || details.externalBilling !== 'NOT_PROVEN' || details.providerRequestId === null || details.systemFingerprint === null || !Number.isSafeInteger(details.created) || details.reasoningTokens !== null && details.reasoningTokens !== 0 || receipt.charge.usageStatus === 'reported' && (!details.usageDetailsValid || !Number.isSafeInteger(details.cacheHitTokens) || details.cacheHitTokens < 0 || !Number.isSafeInteger(details.cacheMissTokens) || details.cacheMissTokens < 0 || details.cacheHitTokens + details.cacheMissTokens !== receipt.charge.usage.inputTokens || details.cachedTokens !== null && details.cachedTokens !== details.cacheHitTokens))) fail('MODEL_RECEIPT_MISMATCH');
      return receipt;
    }
  };
}
function provider({ mode = 'disabled', purpose, limits = {}, pricing, credentialRef = 'deepseek-host-key', http, authorizeTransmission, credentialProvider }) {
  const profile = deepSeekProfile(mode, purpose), transport = createDeepSeekTransport({ mode, purpose, http, authorizeTransmission, credentialProvider, credentialRef });
  const route = { id: DEEPSEEK_ROUTE, backend: 'deepseek', model: DEEPSEEK_MODEL, baseUrl: null, credentialRef, apiKey: 'transport-placeholder-not-a-real-key', timeoutMs: 1000, maxInputBytes: 20000, maxInputTokens: 25000, maxOutputTokens: 512, ...limits, acceptedReportedModels: [DEEPSEEK_MODEL], pricing: pricing || { version: 'm3-offline-artificial-v1', kind: 'synthetic', currency: 'USD', inputMicrousdPerMillion: 1000000, outputMicrousdPerMillion: 1000000 } };
  if (Object.keys(limits).some(key => !['timeoutMs', 'maxInputBytes', 'maxInputTokens', 'maxOutputTokens'].includes(key))) fail('DEEPSEEK_CONFIGURATION');
  const adapter = createProviderAdapter({ route, profile, http: (endpoint, options) => transport.send(endpoint, options) });
  const guarded = Object.freeze({ descriptor: adapter.descriptor, prepare: adapter.prepare, get activeHttp() { return adapter.activeHttp; }, async plan(input) {
    transport.assertDispatch(input.requestId);
    try { const result = await adapter.plan(input); transport.annotate(result.receipt, input.requestId); return result; }
    catch (error) { if (error.receipt) transport.annotate(error.receipt, input.requestId); throw error; }
  } });
  const registry = Object.freeze({ descriptor: Object.freeze({ adapter: 'provider-registry', mode: profile.mode }), get calls() { return adapter.calls; }, route(id) { if (id !== DEEPSEEK_ROUTE) fail('MODEL_ROUTE_DENIED'); return guarded; } });
  return { registry, transport };
}

// Internal assembly for host-owned integrations and offline tests. Package
// exports expose only the limited facade in public-api, never these handles.
export function createDeepSeekInternalRuntime(root, { loop = false, ...options } = {}) {
  options = { ...options, hostScope: options.hostScope || 'flowcredit-deepseek-host' };
  const { registry, transport } = provider({ ...options, purpose: loop ? 'loop-action' : 'static-plan' });
  let runtime;
  if (loop) {
    const Api = gatedApi(OfflineLoopModelApi);
    runtime = assembleLoopRuntime(root, { ...options, registry, callDirectory: 'model-calls', modelApiFactory: args => new Api({ ...args, transport }) });
  } else {
    runtime = createM2Runtime(root, { ...options, registry });
    const Api = gatedApi(ProviderModelApi);
    runtime.modelApi = new Api({ registry, transport, budgets: runtime.budgets, taskStore: runtime.store, ledgerStore: runtime.ledgerStore, authorizer: options.authorizer, toolCatalog: runtime.tools.catalog, afterPhase: options.afterApiPhase });
    runtime.harness.modelApi = runtime.modelApi;
  }
  transport.bind(runtime.modelApi);
  const original = runtime.harness.run.bind(runtime.harness);
  runtime.harness.run = (id, context, opts) => transport.inRuntime(id, () => original(id, context, opts));
  return { ...runtime, transport };
}
