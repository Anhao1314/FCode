import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { createModelBackend, digest } from './baseline.mjs';
import { ModelBackendError } from '../../../vendor/flowcredit-finance/src/model-backend.js';
import { duplicateJsonKey } from '../../../vendor/flowcredit-finance/src/evidence-input.js';
import { PLAN_VERSION, RuntimeError, fail, exactKeys } from './contracts.mjs';
import { strictPlan } from './model-api.mjs';
import { readFileSync } from 'node:fs';

export const WIRE_VERSION = 'flowcredit.chat-completions-candidate/m2-v1';
const BACKEND_SOURCE_HASH = digest(readFileSync(new URL('../../../vendor/flowcredit-finance/src/model-backend.js', import.meta.url), 'utf8'));
const names = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const freeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); return Object.freeze(value); };

export function estimateCost(pricing, inputTokens, outputTokens) {
  const numerator = BigInt(inputTokens) * BigInt(pricing.inputMicrousdPerMillion) + BigInt(outputTokens) * BigInt(pricing.outputMicrousdPerMillion);
  const result = (numerator + 999999n) / 1000000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) fail('MODEL_COST_OVERFLOW');
  return Number(result);
}
function validateRoute(raw, pricingKinds = ['synthetic']) {
  if (!exactKeys(raw, ['id', 'backend', 'model', 'baseUrl', 'credentialRef', 'apiKey', 'timeoutMs', 'maxInputBytes', 'maxInputTokens', 'maxOutputTokens', 'acceptedReportedModels', 'pricing']) || !names(raw.id) || !['deepseek', 'compatible'].includes(raw.backend) || !names(raw.model) || !names(raw.credentialRef) || typeof raw.apiKey !== 'string' || !raw.apiKey || /[\r\n]/.test(raw.apiKey) || !integer(raw.timeoutMs, 1, 30000) || !integer(raw.maxInputBytes, 1, 100 * 1024) || !integer(raw.maxInputTokens, 1, 200000) || !integer(raw.maxOutputTokens, 1, 4096) || !Array.isArray(raw.acceptedReportedModels) || raw.acceptedReportedModels.length < 1 || raw.acceptedReportedModels.length > 8 || raw.acceptedReportedModels.some(value => !names(value))) fail('MODEL_ROUTE_CONFIGURATION');
  if (raw.backend === 'deepseek' && raw.baseUrl !== null) fail('MODEL_ROUTE_CONFIGURATION');
  if (raw.backend === 'compatible') {
    let url;
    try { url = new URL(raw.baseUrl); } catch { fail('MODEL_ROUTE_CONFIGURATION'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('MODEL_ROUTE_CONFIGURATION');
  }
  if (!exactKeys(raw.pricing, ['version', 'kind', 'currency', 'inputMicrousdPerMillion', 'outputMicrousdPerMillion']) || !names(raw.pricing.version) || !pricingKinds.includes(raw.pricing.kind) || raw.pricing.currency !== 'USD' || !integer(raw.pricing.inputMicrousdPerMillion, 0, 1e12) || !integer(raw.pricing.outputMicrousdPerMillion, 0, 1e12)) fail('MODEL_PRICING_CONFIGURATION');
  return structuredClone(raw);
}
function normalizedUsage(raw, bound, outputCap) {
  if (raw === undefined || raw === null) return { usage: null, usageStatus: 'missing' };
  if (raw && typeof raw === 'object' && (typeof raw.prompt_tokens === 'number' && Number.isFinite(raw.prompt_tokens) && raw.prompt_tokens > bound || typeof raw.completion_tokens === 'number' && Number.isFinite(raw.completion_tokens) && raw.completion_tokens > outputCap)) return { usage: null, usageStatus: 'over-budget' };
  if (!raw || typeof raw !== 'object' || !['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => integer(raw[key], 0, 1e9)) || raw.prompt_tokens + raw.completion_tokens !== raw.total_tokens) return { usage: null, usageStatus: 'invalid' };
  if (raw.prompt_tokens > bound || raw.completion_tokens > outputCap) return { usage: null, usageStatus: 'over-budget' };
  return { usage: { inputTokens: raw.prompt_tokens, outputTokens: raw.completion_tokens, totalTokens: raw.total_tokens }, usageStatus: 'reported' };
}
async function boundedText(response, state, signal) {
  if (!response.body?.getReader) throw new ModelBackendError('MODEL_OUTPUT_INVALID');
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, text = '';
  try {
    while (true) {
      if (signal.aborted) throw new ModelBackendError('MODEL_ABORTED');
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 32 * 1024) throw new ModelBackendError('MODEL_OUTPUT_TOO_LARGE');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode(); state.envelopeHash = digest(text); return text;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ModelBackendError) throw error;
    throw new ModelBackendError('MODEL_OUTPUT_INVALID');
  } finally { reader.releaseLock(); }
}

// A configurable real wire candidate. In M2 an injected HTTP function is
// mandatory: no global fetch default, environment key, retry or fallback exists.
export function createProviderAdapter({ route: raw, http, profile = null }) {
  const route = validateRoute(raw, profile?.pricingKinds);
  if (typeof http !== 'function' || http === globalThis.fetch) fail('MODEL_HTTP_INJECTION_REQUIRED');
  const { apiKey, ...safeRoute } = route;
  const descriptor = freeze({ ...safeRoute, adapter: 'chat-completions', provider: route.backend === 'deepseek' ? 'deepseek' : 'openai-compatible', mode: profile?.mode || 'injected-http-test', wireVersion: WIRE_VERSION, backendSourceHash: BACKEND_SOURCE_HASH, planVersion: PLAN_VERSION, pricingHash: digest(route.pricing), configHash: digest(profile ? [safeRoute, WIRE_VERSION, PLAN_VERSION, BACKEND_SOURCE_HASH, profile.contract] : [safeRoute, WIRE_VERSION, PLAN_VERSION, BACKEND_SOURCE_HASH]), inputAccounting: 'utf8-bytes-plus-512-experimental' });
  const context = new AsyncLocalStorage(); let calls = 0, activeHttp = 0;
  const backend = createModelBackend({
    env: { FC_COPILOT_BACKEND: route.backend, FC_COPILOT_MODEL: route.model, FC_COPILOT_BASE_URL: route.baseUrl || '', FC_COPILOT_TIMEOUT_MS: String(route.timeoutMs), ...(route.backend === 'deepseek' ? { DEEPSEEK_API_KEY: apiKey } : { FC_COPILOT_API_KEY: apiKey }) },
    fetchImpl: async (endpoint, options) => {
      const state = context.getStore();
      const wire = JSON.parse(options.body);
      if (!state || wire.model !== route.model || wire.stream !== false || wire.response_format?.type !== 'json_object' || wire.tools || wire.tool_choice || wire.messages.some(message => !['system', 'user'].includes(message.role))) throw new ModelBackendError('MODEL_INPUT_INVALID');
      const messageBytes = wire.messages.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
      if (messageBytes > state.inputTokenBound) throw new ModelBackendError('MODEL_INPUT_INVALID');
      wire.max_tokens = route.maxOutputTokens;
      profile?.configureWire(wire);
      if (profile && wire.messages.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0) > state.inputTokenBound) throw new ModelBackendError('MODEL_INPUT_INVALID');
      calls += 1; activeHttp += 1;
      try {
        const response = await http(endpoint, { ...options, body: JSON.stringify(wire) });
        if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new ModelBackendError('MODEL_OUTPUT_INVALID');
        // Keep the existing transport's status/redirect/error behavior intact.
        if (!response || response.redirected || response.status < 200 || response.status >= 300 || response.url && response.url !== endpoint) return response;
        const rawText = await boundedText(response, state, options.signal);
        let envelope;
        try { envelope = JSON.parse(rawText); } catch { state.reason = 'OUTER_JSON_INVALID'; throw new ModelBackendError('MODEL_OUTPUT_INVALID'); }
        if (duplicateJsonKey(rawText) !== null) { state.reason = 'OUTER_DUPLICATE_KEY'; throw new ModelBackendError('MODEL_OUTPUT_INVALID'); }
        if (!Array.isArray(envelope?.choices) || envelope.choices.length !== 1 || envelope.choices[0]?.finish_reason !== 'stop' || envelope.choices[0]?.message?.role !== 'assistant' || typeof envelope.choices[0]?.message?.content !== 'string' || !envelope.choices[0].message.content.trim() || Object.hasOwn(envelope.choices[0].message, 'tool_calls') || Object.hasOwn(envelope.choices[0].message, 'function_call')) { state.reason = 'PROVIDER_ENVELOPE_INVALID'; throw new ModelBackendError('MODEL_OUTPUT_INVALID'); }
        if (!route.acceptedReportedModels.includes(envelope.model)) { state.reason = 'PROVIDER_MODEL_MISMATCH'; throw new ModelBackendError('MODEL_OUTPUT_INVALID'); }
        state.providerReportedModel = envelope.model;
        Object.assign(state, normalizedUsage(envelope.usage, state.inputTokenBound, route.maxOutputTokens));
        state.responseHash = digest(envelope.choices[0].message.content);
        if (profile) {
          const details = profile.inspectEnvelope(envelope);
          state.providerDetails = details.metadata;
          if (!details.usageValid && state.usageStatus !== 'over-budget') { state.usage = null; state.usageStatus = 'invalid'; }
          if (!details.outputValid) { state.reason = details.reason; throw new ModelBackendError('MODEL_OUTPUT_INVALID'); }
        }
        if (state.usageStatus === 'over-budget') { state.reason = 'PROVIDER_TOKEN_BUDGET_EXCEEDED'; throw new ModelBackendError('MODEL_OUTPUT_INVALID'); }
        return new Response(rawText, { status: response.status, headers: { 'content-type': 'application/json' } });
      } finally { activeHttp -= 1; }
    }
  });
  const prepare = prompt => {
    if (typeof prompt !== 'string' || !prompt.trim()) fail('MODEL_INPUT_BUDGET_DENIED');
    const inputBytes = Buffer.byteLength(prompt) + (profile?.systemBytes || 0);
    if (inputBytes > route.maxInputBytes) fail('MODEL_INPUT_BUDGET_DENIED');
    const inputTokenBound = inputBytes + 512;
    if (inputTokenBound > route.maxInputTokens) fail('MODEL_TOKEN_BUDGET_DENIED');
    return { inputBytes, inputTokenBound, outputTokenBound: route.maxOutputTokens, totalTokenReservation: inputTokenBound + route.maxOutputTokens, costReservationMicrousd: estimateCost(route.pricing, inputTokenBound, route.maxOutputTokens) };
  };
  return Object.freeze({
    descriptor, prepare,
    get calls() { return calls; }, get activeHttp() { return activeHttp; },
    async plan({ requestId, taskId, principalHash, prompt, signal }) {
      const bounds = prepare(prompt); const started = performance.now();
      const state = { ...bounds, usage: null, usageStatus: 'missing', responseHash: null, envelopeHash: null, providerReportedModel: null, reason: null };
      const receipt = { requestId, taskId, principalHash, adapter: 'chat-completions', provider: descriptor.provider, routeId: route.id, model: route.model, configHash: descriptor.configHash, pricingHash: descriptor.pricingHash, contractVersion: PLAN_VERSION, promptHash: digest(prompt), responseHash: null, responseHashKind: null, envelopeHash: null, status: 'failed', usage: null, usageStatus: 'missing', providerReportedModel: null, errorCode: null, failureReason: null, latencyMs: 0 };
      return context.run(state, async () => {
        try {
          const output = await backend.generate({ task: 'plan', contractVersion: PLAN_VERSION, prompt, signal });
          const plan = strictPlan(output.text);
          Object.assign(receipt, { status: 'validated', responseHash: state.responseHash, responseHashKind: 'inner-text', envelopeHash: state.envelopeHash, usage: state.usage, usageStatus: state.usageStatus, providerReportedModel: state.providerReportedModel, latencyMs: Math.round(performance.now() - started), ...(profile ? { providerDetails: state.providerDetails || null } : {}) });
          return { plan, receipt };
        } catch (error) {
          const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code || '') ? error.code : 'MODEL_UNAVAILABLE';
          Object.assign(receipt, { responseHash: state.responseHash || state.envelopeHash, responseHashKind: state.responseHash ? 'inner-text' : state.envelopeHash ? 'wire-envelope' : null, envelopeHash: state.envelopeHash, usage: state.usage, usageStatus: state.usageStatus, providerReportedModel: state.providerReportedModel, errorCode: code, failureReason: state.reason, latencyMs: Math.round(performance.now() - started), ...(profile ? { providerDetails: state.providerDetails || null } : {}) });
          throw new RuntimeError(code, { receipt });
        }
      });
    }
  });
}

export function createProviderRegistry({ routes, httpByRoute }) {
  if (!Array.isArray(routes) || !routes.length || new Set(routes.map(route => route.id)).size !== routes.length) fail('MODEL_ROUTE_CONFIGURATION');
  const adapters = new Map(routes.map(route => [route.id, createProviderAdapter({ route, http: httpByRoute[route.id] })]));
  return Object.freeze({
    descriptor: Object.freeze({ adapter: 'provider-registry', mode: 'injected-http-test' }),
    get calls() { return [...adapters.values()].reduce((sum, adapter) => sum + adapter.calls, 0); },
    descriptors: Object.freeze([...adapters.values()].map(adapter => adapter.descriptor)),
    route(id) { const adapter = adapters.get(id); if (!adapter) fail('MODEL_ROUTE_DENIED'); return adapter; }
  });
}
