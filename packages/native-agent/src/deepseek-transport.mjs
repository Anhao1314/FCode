import { AsyncLocalStorage } from 'node:async_hooks';
import { digest } from './baseline.mjs';
import { fail, exactKeys } from './contracts.mjs';
import { DEEPSEEK_ENDPOINT, DEEPSEEK_MODEL } from './deepseek-profile.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const APPROVAL_VERSION = 'flowcredit.deepseek-transmission/m3-a-v1';
const APPROVAL_KEYS = ['version', 'enabled', 'approvalId', 'requestId', 'principalHash', 'grantId', 'authorizationHash', 'configHash', 'pricingHash', 'promptHash', 'expiresAt', 'acceptUnprovenTokenAndBillingBounds', 'pricingReviewHash'];

// All callbacks and injected HTTP are trusted host infrastructure. No key/env
// lookup or network occurs during construction or disabled/injected execution.
export function createDeepSeekTransport({ mode = 'disabled', http, authorizeTransmission, credentialProvider, credentialRef, purpose }) {
  if (!['disabled', 'injected-http-test', 'live'].includes(mode) || mode === 'injected-http-test' && typeof http !== 'function' || mode === 'live' && http !== undefined) fail('DEEPSEEK_CONFIGURATION');
  const network = mode === 'live' ? globalThis.fetch.bind(globalThis) : http;
  const dispatchScope = new AsyncLocalStorage(), runtimeScope = new AsyncLocalStorage();
  let validateCurrent, budgets, transmissions = 0, credentialReads = 0;
  const check = async (intent, authorization) => {
    if (mode === 'disabled') fail('DEEPSEEK_DISABLED');
    if (mode === 'injected-http-test') return { version: APPROVAL_VERSION, enabled: true, approvalId: 'explicit-injected-host-test', requestId: intent.requestId, principalHash: intent.principalHash, grantId: intent.grantId, authorizationHash: digest(authorization), configHash: intent.configHash, pricingHash: intent.pricingHash, promptHash: intent.promptHash, expiresAt: null, acceptUnprovenTokenAndBillingBounds: false, pricingReviewHash: null };
    if (typeof authorizeTransmission !== 'function' || typeof credentialProvider !== 'function') fail('DEEPSEEK_LIVE_AUTHORIZATION_REQUIRED');
    const request = { version: APPROVAL_VERSION, model: DEEPSEEK_MODEL, endpoint: DEEPSEEK_ENDPOINT, requestId: intent.requestId, principalHash: intent.principalHash, grantId: intent.grantId, authorizationHash: digest(authorization), configHash: intent.configHash, pricingHash: intent.pricingHash, promptHash: intent.promptHash, inputTokenGuarantee: 'NOT_PROVEN', externalBilling: 'NOT_PROVEN' };
    const approval = await authorizeTransmission(Object.freeze(request));
    if (!exactKeys(approval, APPROVAL_KEYS) || approval.version !== APPROVAL_VERSION || approval.enabled !== true || typeof approval.approvalId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(approval.approvalId) || ['requestId', 'principalHash', 'grantId', 'authorizationHash', 'configHash', 'pricingHash', 'promptHash'].some(key => approval[key] !== request[key]) || !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= Date.now() || approval.expiresAt > Date.now() + 3600000 || !hash(approval.pricingReviewHash)) fail('DEEPSEEK_LIVE_AUTHORIZATION_DENIED');
    if (approval.acceptUnprovenTokenAndBillingBounds !== true) fail('DEEPSEEK_BUDGET_GUARANTEE_NOT_PROVEN');
    return structuredClone(approval);
  };
  const assertRuntime = task => {
    const scope = runtimeScope.getStore(); let owner = task.id;
    if (purpose === 'loop-action') { try { owner = JSON.parse(task.objective).loopId; } catch { fail('DEEPSEEK_RUNTIME_REQUIRED'); } }
    if (!scope?.held || scope.id !== owner) fail('DEEPSEEK_RUNTIME_REQUIRED');
  };
  const assertDispatch = requestId => { const scope = dispatchScope.getStore(); if (!scope?.held || scope.intent.requestId !== requestId) fail('DEEPSEEK_DISPATCH_REQUIRED'); return scope; };
  return Object.freeze({
    mode, check, assertRuntime, assertDispatch,
    bind(api) { if (validateCurrent) fail('DEEPSEEK_CONFIGURATION'); validateCurrent = (intent, prompt) => api.validateIntent(intent, prompt); budgets = api.budgets; },
    get transmissions() { return transmissions; }, get credentialReads() { return credentialReads; },
    async inRuntime(id, operation) { const scope = { id, held: true }; try { return await runtimeScope.run(scope, operation); } finally { scope.held = false; } },
    async inDispatch(intent, prompt, approval, operation) {
      const scope = { intent, prompt, approval, held: true };
      try { return await dispatchScope.run(scope, operation); } finally { scope.held = false; }
    },
    annotate(receipt, requestId) {
      const scope = assertDispatch(requestId);
      receipt.transmission = { version: APPROVAL_VERSION, mode, approvalHash: digest(scope.approval), approvalIdHash: digest(scope.approval.approvalId), tokenAndBillingGuarantee: 'NOT_PROVEN' };
    },
    async send(endpoint, options) {
      const scope = dispatchScope.getStore();
      if (!scope?.held || endpoint !== DEEPSEEK_ENDPOINT || options.method !== 'POST' || options.redirect !== 'error') fail('DEEPSEEK_DISPATCH_REQUIRED');
      const wire = JSON.parse(options.body);
      if (wire.model !== DEEPSEEK_MODEL || wire.stream !== false || wire.thinking?.type !== 'disabled' || wire.tools || wire.tool_choice) fail('DEEPSEEK_WIRE_DENIED');
      if (options.signal?.aborted) fail('MODEL_ABORTED');
      let current = await validateCurrent(scope.intent, scope.prompt);
      scope.approval = await check(scope.intent, current.authorization);
      const snapshot = await budgets.snapshot(scope.intent), reservation = snapshot.group?.reservations.find(item => item.requestId === scope.intent.requestId), lease = snapshot.pool?.leases.find(item => item.requestId === scope.intent.requestId);
      if (!reservation || reservation.status !== 'dispatched' || reservation.intentHash !== digest(scope.intent) || lease?.status !== 'held' || lease.intentHash !== digest(scope.intent)) fail('DEEPSEEK_DURABLE_RESERVATION_REQUIRED');
      let headers = { ...options.headers };
      if (mode === 'live') {
        credentialReads += 1;
        const key = await credentialProvider(credentialRef);
        if (typeof key !== 'string' || !key || key.length > 4096 || /[\r\n]/.test(key)) fail('DEEPSEEK_CREDENTIAL_INVALID');
        // Revalidate after asynchronous credential acquisition, before HTTP.
        current = await validateCurrent(scope.intent, scope.prompt); scope.approval = await check(scope.intent, current.authorization);
        if (options.signal?.aborted || !scope.held) fail('MODEL_ABORTED');
        headers = new Headers(headers); headers.set('Authorization', `Bearer ${key}`);
      }
      assertDispatch(scope.intent.requestId); transmissions += 1;
      return network(endpoint, { ...options, headers });
    }
  });
}
