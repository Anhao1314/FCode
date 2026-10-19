import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DurableModelApi } from './durable-model-api.mjs';
import { digest, stable } from './baseline.mjs';
import { PLAN_VERSION, RuntimeError, fail, exactKeys, validatePlan } from './contracts.mjs';
import { publishBytes, privateBytes } from './durable-io.mjs';
import { estimateCost } from './provider-adapters.mjs';
import { TOOL_NAMES } from './tools.mjs';
import { DurableHarness } from './durable-harness.mjs';
import { PROVIDER_LEDGER_VERSION } from './provider-call-store.mjs';

export const M2_AUTHORIZATION_VERSION = 'flowcredit.model-authorization/m2-v1';
export const M2_INTENT_VERSION = 'flowcredit.model-intent/m2-v1';
export const M2_RECEIPT_VERSION = 'flowcredit.model-result/m2-v1';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const names = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(value);
const GRANT_KEYS = ['allowedRoutes', 'allowedTools', 'maxCalls', 'maxInputBytes', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxCostMicrousd', 'maxConcurrent'];

export function validateProviderGrant(grant) {
  if (!exactKeys(grant, GRANT_KEYS) || !Array.isArray(grant.allowedRoutes) || grant.allowedRoutes.some(id => !names(id)) || !Array.isArray(grant.allowedTools) || grant.allowedTools.some(tool => !TOOL_NAMES.includes(tool)) || !integer(grant.maxCalls, 0, 1000) || !integer(grant.maxInputBytes, 1, 100 * 1024) || !integer(grant.maxInputTokens, 1, 200000) || !integer(grant.maxOutputTokens, 1, 4096) || !integer(grant.maxTotalTokens, 0, 1e9) || !integer(grant.maxCostMicrousd, 0, Number.MAX_SAFE_INTEGER) || !integer(grant.maxConcurrent, 1, 2)) fail('MODEL_CURRENT_AUTHORIZATION_DENIED');
  return structuredClone(grant);
}
export function validateProviderAuthorization(value) {
  if (!exactKeys(value, ['version', 'grantId', 'revision', 'routeId', 'grant']) || value.version !== M2_AUTHORIZATION_VERSION || !names(value.grantId) || !names(value.routeId) || !integer(value.revision, 1, 1e9)) fail('MODEL_CURRENT_AUTHORIZATION_DENIED');
  return { ...structuredClone(value), grant: validateProviderGrant(value.grant) };
}
export function providerContract({ registry, budgets }) {
  const makeIntent = (task, prompt, auth) => {
    const adapter = registry.route(auth.routeId), route = adapter.descriptor, bounds = adapter.prepare(prompt);
    return { version: M2_INTENT_VERSION, requestId: `${task.id}:plan:1`, taskId: task.id, principalHash: task.principalHash, purpose: 'plan', contractVersion: PLAN_VERSION, adapter: route.adapter, model: route.model, provider: route.provider, routeId: route.id, configHash: route.configHash, pricingHash: route.pricingHash, boundsHash: digest(bounds), hostPolicyHash: digest([budgets.hostScope, budgets.maxConcurrent]), promptHash: digest(prompt), bindingHash: digest(task.binding), toolPolicyHash: digest([task.allowedTools, task.toolVersion]), authorizationHash: digest(auth), grantId: auth.grantId, grantHash: digest(auth.grant), quotaScope: `${task.principalHash}:${task.id}:${auth.grantId}` };
  };
  return Object.freeze({
    validateAuthorization: validateProviderAuthorization, makeIntent,
    allowed: auth => auth.grant.allowedRoutes.includes(auth.routeId),
    isNotDispatched: error => error instanceof RuntimeError && error.notDispatched === true,
    validateCreateInput(input) {
      if (!exactKeys(input, ['assessmentId', 'objective', 'context', 'modelGrant']) || !exactKeys(input.context, ['principal', 'authorization', 'accessToken', 'allowedTools'])) fail('MODEL_CLIENT_CONFIGURATION_DENIED');
    },
    validateToolScope(task, context, auth) {
      if (!Array.isArray(context.allowedTools) || !Array.isArray(task.allowedTools) || task.allowedTools.some(tool => !auth.grant.allowedTools.includes(tool)) || context.allowedTools.some(tool => !auth.grant.allowedTools.includes(tool))) fail('TOOL_PERMISSION_DENIED');
    },
    validateBinding(task, auth) {
      const route = registry.route(auth.routeId).descriptor;
      if (task.model.intent && (task.model.intent.routeId !== route.id || task.model.intent.configHash !== route.configHash || task.model.intent.pricingHash !== route.pricingHash || task.model.intent.hostPolicyHash !== digest([budgets.hostScope, budgets.maxConcurrent]))) fail('MODEL_ROUTE_CHANGED');
    }
  });
}

// Keep M1's execute/reconcile lifecycle and signed immutable storage. Override
// only provider-neutral contracts, dispatch, receipt and resource hooks.
export class ProviderModelApi extends DurableModelApi {
  constructor({ registry, budgets, toolCatalog, ...options }) {
    super({ ...options, adapter: registry, validateAdapter: value => value?.descriptor?.adapter === 'provider-registry' });
    this.registry = registry; this.budgets = budgets; this.contract = providerContract({ registry, budgets });
    this.toolCatalog = Object.freeze(structuredClone(toolCatalog));
  }
  promptForTask(task) { return DurableHarness.prototype.promptFor.call({ tools: { catalog: this.toolCatalog } }, task); }
  get receiptVersion() { return M2_RECEIPT_VERSION; }
  get transportMode() { return 'injected-http-test'; }
  async execute(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['intent', 'prompt', 'signal'].includes(key))) fail('MODEL_CLIENT_CONFIGURATION_DENIED');
    if (input.signal?.aborted) fail('MODEL_ABORTED');
    return super.execute(input);
  }
  newLedger(intent, id) { return { ...super.newLedger(intent, id), version: PROVIDER_LEDGER_VERSION }; }
  callReservation(intent, prompt) { return { reservedCalls: 1, reservedCostMicrousd: this.registry.route(intent.routeId).prepare(prompt).costReservationMicrousd }; }
  async preflight(task, prompt, authorization, signal) {
    if (signal?.aborted) fail('MODEL_ABORTED');
    const route = this.registry.route(authorization.routeId);
    const bounds = route.prepare(prompt), grant = authorization.grant;
    if (!grant.allowedRoutes.includes(authorization.routeId)) fail('MODEL_ROUTE_DENIED');
    if (bounds.inputBytes > grant.maxInputBytes || bounds.inputTokenBound > grant.maxInputTokens || bounds.outputTokenBound > grant.maxOutputTokens) fail('MODEL_TOKEN_BUDGET_DENIED');
    const intent = this.contract.makeIntent(task, prompt, authorization);
    await this.budgets.preflight(intent, authorization, bounds);
    return { intent, bounds };
  }
  async validateIntent(intent, prompt) {
    if (!intent || intent.version !== M2_INTENT_VERSION || !/^task-[a-f0-9]{32}$/.test(intent.taskId || '') || intent.requestId !== `${intent.taskId}:plan:1` || intent.contractVersion !== PLAN_VERSION || intent.purpose !== 'plan' || !['principalHash', 'configHash', 'pricingHash', 'boundsHash', 'hostPolicyHash', 'promptHash', 'bindingHash', 'toolPolicyHash', 'authorizationHash', 'grantHash'].every(key => hash(intent[key]))) fail('MODEL_INTENT_MISMATCH');
    const task = await this.taskStore.load(intent.taskId);
    const authorization = validateProviderAuthorization(await this.authorizer({ taskId: task.id, principalHash: task.principalHash, binding: task.binding }));
    if (!authorization.grant.allowedRoutes.includes(authorization.routeId) || authorization.grant.maxCalls < task.model.attempts || digest(authorization) !== intent.authorizationHash || digest(task.modelGrant) !== intent.grantHash || stable(task.model.intent) !== stable(intent) || task.principalHash !== intent.principalHash || task.model.attempts !== 1) fail('MODEL_CURRENT_AUTHORIZATION_DENIED');
    this.contract.validateBinding(task, authorization);
    // Prompt is recomputed from the same Harness-owned input, never supplied by
    // a provider receipt. Status/reconcile verify every intent field as well.
    const expectedPrompt = this.promptForTask(task);
    if (prompt !== undefined && prompt !== expectedPrompt || stable(intent) !== stable(this.contract.makeIntent(task, expectedPrompt, authorization))) fail('MODEL_INTENT_MISMATCH');
    return { task, authorization };
  }
  async reserveResources(intent, prompt, authorization) {
    const bounds = this.registry.route(intent.routeId).prepare(prompt);
    if (digest(bounds) !== intent.boundsHash) fail('MODEL_INTENT_MISMATCH');
    if (bounds.inputBytes > authorization.grant.maxInputBytes || bounds.inputTokenBound > authorization.grant.maxInputTokens || bounds.outputTokenBound > authorization.grant.maxOutputTokens) fail('MODEL_TOKEN_BUDGET_DENIED');
    await this.budgets.reserve(intent, authorization, bounds);
  }
  async markDispatched(intent) { await this.budgets.update(intent, 'dispatched'); }
  async dispatch(intent, prompt, authorization, signal) {
    try {
      await this.validateIntent(intent, prompt); // Recheck after all async publication hooks.
      return await this.registry.route(intent.routeId).plan({ requestId: intent.requestId, taskId: intent.taskId, principalHash: intent.principalHash, prompt, signal });
    } catch (error) {
      if (!(error.receipt?.responseHash && ['MODEL_OUTPUT_INVALID', 'MODEL_SCHEMA_INVALID'].includes(error.code))) await this.budgets.update(intent, 'unknown');
      throw error;
    }
  }
  async writeReceipt(intent, generated, invalid) {
    const adapterReceipt = generated.receipt;
    const task = await this.taskStore.load(intent.taskId);
    const prompt = this.promptForTask(task);
    const route = this.registry.route(intent.routeId), bounds = route.prepare(prompt);
    if (adapterReceipt?.requestId !== intent.requestId || adapterReceipt?.taskId !== intent.taskId || adapterReceipt?.principalHash !== intent.principalHash || adapterReceipt?.promptHash !== intent.promptHash || adapterReceipt?.contractVersion !== intent.contractVersion || adapterReceipt?.routeId !== intent.routeId || adapterReceipt?.configHash !== intent.configHash || adapterReceipt?.pricingHash !== intent.pricingHash || !hash(adapterReceipt?.responseHash) || !hash(adapterReceipt?.envelopeHash) || !['inner-text', 'wire-envelope'].includes(adapterReceipt.responseHashKind) || !invalid && adapterReceipt.responseHashKind !== 'inner-text' || adapterReceipt.status !== (invalid ? 'failed' : 'validated')) fail('MODEL_ADAPTER_RECEIPT_INVALID');
    const reported = adapterReceipt.usageStatus === 'reported' && adapterReceipt.usage;
    const charge = { kind: 'provider-estimate', usageStatus: adapterReceipt.usageStatus, usage: reported || null, estimatedCostMicrousd: reported ? estimateCost(route.descriptor.pricing, reported.inputTokens, reported.outputTokens) : null, actualCostMicrousd: null, reservedCostMicrousd: bounds.costReservationMicrousd, pricingHash: intent.pricingHash, externalBilling: 'not-verified', transportMode: this.transportMode };
    const receipt = { version: this.receiptVersion, issuer: await this.ledgerStore.storeId(), intent, intentHash: digest(intent), status: invalid ? 'confirmed-invalid' : 'confirmed-valid', plan: invalid ? null : validatePlan(generated.plan), planHash: invalid ? null : digest(generated.plan), adapterReceipt, charge };
    const receiptRef = await this.receiptRef(intent), directory = join(this.ledgerStore.root, 'receipts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await publishBytes(join(directory, `${receiptRef}.json`), JSON.stringify(await this.ledgerStore.seal(receipt)), { immutable: true });
    await this.afterPhase('receipt_persisted', { intent, receiptRef }); return { receipt, receiptRef };
  }
  async readReceipt(ref, intent) {
    if (!hash(ref)) fail('MODEL_RECEIPT_REQUIRED'); if (ref !== await this.receiptRef(intent)) fail('MODEL_RECEIPT_MISMATCH');
    let receipt;
    try { receipt = await this.ledgerStore.unseal(await privateBytes(join(this.ledgerStore.root, 'receipts', `${ref}.json`))); }
    catch (error) { fail(error.code === 'M1_RECORD_MISSING' ? 'MODEL_RECEIPT_REQUIRED' : 'MODEL_RECEIPT_UNTRUSTED'); }
    if (!exactKeys(receipt, ['version', 'issuer', 'intent', 'intentHash', 'status', 'plan', 'planHash', 'adapterReceipt', 'charge']) || receipt.version !== this.receiptVersion || receipt.issuer !== await this.ledgerStore.storeId() || receipt.intentHash !== digest(intent) || stable(receipt.intent) !== stable(intent) || !['confirmed-valid', 'confirmed-invalid'].includes(receipt.status)) fail('MODEL_RECEIPT_MISMATCH');
    const ar = receipt.adapterReceipt;
    if (ar?.requestId !== intent.requestId || ar?.taskId !== intent.taskId || ar?.principalHash !== intent.principalHash || ar?.promptHash !== intent.promptHash || ar?.contractVersion !== intent.contractVersion || ar?.adapter !== intent.adapter || ar?.provider !== intent.provider || ar?.model !== intent.model || ar?.routeId !== intent.routeId || ar?.configHash !== intent.configHash || ar?.pricingHash !== intent.pricingHash || !hash(ar?.responseHash) || !hash(ar?.envelopeHash) || !['inner-text', 'wire-envelope'].includes(ar.responseHashKind) || ar.responseHashKind === 'wire-envelope' && ar.responseHash !== ar.envelopeHash || receipt.status === 'confirmed-valid' && ar.responseHashKind !== 'inner-text') fail('MODEL_RECEIPT_MISMATCH');
    if (receipt.status === 'confirmed-valid') { validatePlan(receipt.plan); if (ar.status !== 'validated' || receipt.planHash !== digest(receipt.plan)) fail('MODEL_RECEIPT_MISMATCH'); }
    else if (receipt.plan !== null || receipt.planHash !== null || ar.status !== 'failed' || !['MODEL_SCHEMA_INVALID', 'MODEL_OUTPUT_INVALID'].includes(ar.errorCode)) fail('MODEL_RECEIPT_MISMATCH');
    const charge = receipt.charge;
    if (!exactKeys(charge, ['kind', 'usageStatus', 'usage', 'estimatedCostMicrousd', 'actualCostMicrousd', 'reservedCostMicrousd', 'pricingHash', 'externalBilling', 'transportMode']) || charge.kind !== 'provider-estimate' || charge.actualCostMicrousd !== null || charge.externalBilling !== 'not-verified' || charge.transportMode !== this.transportMode || charge.pricingHash !== intent.pricingHash || charge.usageStatus !== ar.usageStatus || stable(charge.usage) !== stable(ar.usage)) fail('MODEL_RECEIPT_MISMATCH');
    const task = await this.taskStore.load(intent.taskId);
    const prompt = this.promptForTask(task);
    const route = this.registry.route(intent.routeId), bounds = route.prepare(prompt);
    if (receipt.status === 'confirmed-valid' && !route.descriptor.acceptedReportedModels.includes(ar.providerReportedModel)) fail('MODEL_RECEIPT_MISMATCH');
    if (charge.reservedCostMicrousd !== bounds.costReservationMicrousd || charge.usageStatus === 'reported' && (!exactKeys(charge.usage, ['inputTokens', 'outputTokens', 'totalTokens']) || !['inputTokens', 'outputTokens', 'totalTokens'].every(key => integer(charge.usage[key], 0, 1e9)) || charge.usage.inputTokens + charge.usage.outputTokens !== charge.usage.totalTokens || charge.usage.inputTokens > bounds.inputTokenBound || charge.usage.outputTokens > bounds.outputTokenBound || charge.estimatedCostMicrousd !== estimateCost(route.descriptor.pricing, charge.usage.inputTokens, charge.usage.outputTokens)) || charge.usageStatus !== 'reported' && (!['missing', 'invalid', 'over-budget'].includes(charge.usageStatus) || charge.usage !== null || charge.estimatedCostMicrousd !== null)) fail('MODEL_RECEIPT_MISMATCH');
    return receipt;
  }
  async confirmResources(intent, ref) {
    const receipt = await this.readReceipt(ref, intent);
    await this.budgets.update(intent, 'confirmed', ref, receipt.charge);
  }
}
