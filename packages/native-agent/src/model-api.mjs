import { performance } from 'node:perf_hooks';
import { createModelBackend, digest } from './baseline.mjs';
import { PLAN_VERSION, RuntimeError, fail, validatePlan } from './contracts.mjs';
import { duplicateJsonKey } from '../../../vendor/flowcredit-finance/src/evidence-input.js';

const MOCK_MODEL = 'flowcredit-native-mock';
const identifiers = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const retryable = new Set(['MODEL_TIMEOUT', 'MODEL_HTTP_ERROR', 'MODEL_UNAVAILABLE', 'MODEL_BUSY']);
const transportCodes = new Set(['MODEL_DISABLED', 'MODEL_CONFIGURATION', 'MODEL_TASK_INVALID', 'MODEL_INPUT_INVALID', 'MODEL_ABORTED', 'MODEL_BUSY', 'MODEL_OUTPUT_TOO_LARGE', 'MODEL_OUTPUT_INVALID', 'MODEL_REDIRECT', 'MODEL_HTTP_ERROR', 'MODEL_TIMEOUT', 'MODEL_UNAVAILABLE']);

export function strictPlan(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 32 * 1024) fail('MODEL_OUTPUT_INVALID');
  let value;
  try { value = JSON.parse(text); } catch { fail('MODEL_OUTPUT_INVALID'); }
  if (duplicateJsonKey(text) !== null) fail('MODEL_OUTPUT_INVALID');
  // JSON accepts overflowing numbers. Bound nesting before trusting plan arguments.
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop();
    if (item.depth > 10 || typeof item.value === 'number' && !Number.isFinite(item.value)) fail('MODEL_SCHEMA_INVALID');
    if (item.value && typeof item.value === 'object') {
      const values = Object.values(item.value);
      if (values.length > 32) fail('MODEL_SCHEMA_INVALID');
      for (const child of values) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return validatePlan(value);
}

/**
 * This experimental API offers only mock and disabled adapters. The existing
 * ModelBackend validates its actual wire envelope through an injected fetch.
 * No environment credentials, network fetch, paid provider or tool executor is used.
 * Harness persists the attempt reservation and supplies the previous call count.
 */
export function createModelApi({ responses = [], backend = 'mock', timeoutMs = 100 } = {}) {
  if (!Array.isArray(responses) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('MODEL_CONFIGURATION');
  const adapter = backend === 'mock' || backend === 'disabled' ? backend : 'unsupported';
  const descriptor = Object.freeze({ backend: adapter, adapter, provider: adapter, model: adapter === 'mock' ? MOCK_MODEL : null, enabled: adapter === 'mock', simulated: adapter === 'mock' });
  const fixtures = structuredClone(responses);
  let calls = 0;
  const transport = createModelBackend({
    env: adapter === 'mock' ? {
      FC_COPILOT_BACKEND: 'local', FC_COPILOT_BASE_URL: 'http://127.0.0.1:1/v1',
      FC_COPILOT_MODEL: MOCK_MODEL, FC_COPILOT_TIMEOUT_MS: String(timeoutMs)
    } : { FC_COPILOT_BACKEND: 'disabled' },
    fetchImpl: async (_endpoint, options) => {
      const fixture = fixtures[calls++];
      if (fixture?.transportError === 'MODEL_TIMEOUT') {
        // Settle when the existing transport's deadline or caller cancellation fires.
        return new Promise((_, reject) => {
          const aborted = () => reject(new DOMException('Mock transport aborted', 'AbortError'));
          if (options.signal.aborted) aborted();
          else options.signal.addEventListener('abort', aborted, { once: true });
        });
      }
      if (fixture?.transportError === 'MODEL_HTTP_ERROR') return new Response('', { status: 503 });
      if (fixture?.transportError === 'MODEL_OUTPUT_INVALID') {
        // A provider-native tool request is refused by the real transport validator.
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [{ id: 'mock-call', type: 'function', function: { name: 'write_authority', arguments: '{}' } }] } }] }));
      }
      if (fixture?.transportError) throw new Error('Mock transport unavailable');
      const content = typeof fixture === 'string' ? fixture : JSON.stringify(fixture);
      return new Response(JSON.stringify({ model: MOCK_MODEL, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
    }
  });

  return Object.freeze({
    descriptor,
    get calls() { return calls; },
    async plan({ requestId, taskId, principalHash, prompt, grant, priorCalls = 0, signal } = {}) {
      const started = performance.now();
      const receipt = {
        requestId: identifiers(requestId) ? requestId : null,
        taskId: identifiers(taskId) ? taskId : null,
        principalHash: typeof principalHash === 'string' && /^[a-f0-9]{64}$/.test(principalHash) ? principalHash : null,
        adapter, provider: descriptor.provider, model: descriptor.model,
        contractVersion: PLAN_VERSION, status: 'failed',
        promptHash: typeof prompt === 'string' ? digest(prompt) : null,
        responseHash: null, latencyMs: 0, usage: null, costMicrousd: 0, errorCode: null
      };
      try {
        if (!receipt.requestId || !receipt.taskId || !receipt.principalHash || typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 100 * 1024 || signal !== undefined && !(signal instanceof AbortSignal)) fail('MODEL_INPUT_INVALID');
        if (signal?.aborted) fail('MODEL_ABORTED');
        if (adapter === 'unsupported') fail('MODEL_POLICY_DENIED');
        if (adapter !== 'disabled') {
          if (!isObject(grant) || !Array.isArray(grant.allowedAdapters) || !grant.allowedAdapters.includes(adapter) || typeof grant.allowPaid !== 'boolean' || !Number.isSafeInteger(grant.maxCalls) || grant.maxCalls < 0 || !Number.isSafeInteger(grant.maxCostMicrousd) || grant.maxCostMicrousd < 0) fail('MODEL_POLICY_DENIED');
          if (!Number.isSafeInteger(priorCalls) || priorCalls < 0) fail('MODEL_INPUT_INVALID');
          if (priorCalls >= grant.maxCalls) fail('MODEL_CALL_QUOTA');
        }
        const result = await transport.generate({ task: 'plan', contractVersion: PLAN_VERSION, prompt, signal });
        receipt.responseHash = digest(result.text);
        // Missing provider usage remains unknown; mock monetary cost is exactly zero.
        receipt.usage = result.usage ?? null;
        const plan = strictPlan(result.text);
        receipt.status = 'validated';
        receipt.latencyMs = Math.max(0, Math.round(performance.now() - started));
        return { plan, receipt };
      } catch (error) {
        const code = error instanceof RuntimeError ? error.code : transportCodes.has(error?.code) ? error.code : 'MODEL_UNAVAILABLE';
        receipt.status = ['MODEL_POLICY_DENIED', 'MODEL_CALL_QUOTA'].includes(code) ? 'denied' : 'failed';
        receipt.errorCode = code;
        receipt.latencyMs = Math.max(0, Math.round(performance.now() - started));
        throw new RuntimeError(code, { retryable: retryable.has(code), receipt });
      }
    }
  });
}
