import { createProviderRegistry } from '../src/provider-adapters.mjs';
import { M2_AUTHORIZATION_VERSION } from '../src/provider-model-api.mjs';
import { GOOD_PLAN } from '../src/fixtures.mjs';

export const SYNTHETIC_KEY = 'm2-injected-http-only-not-a-real-key';
export function routes() {
  const common = { credentialRef: 'synthetic-http-test', apiKey: SYNTHETIC_KEY, timeoutMs: 100, maxInputBytes: 20000, maxInputTokens: 25000, maxOutputTokens: 128, pricing: { version: 'synthetic-price-v1', kind: 'synthetic', currency: 'USD', inputMicrousdPerMillion: 1000000, outputMicrousdPerMillion: 2000000 } };
  return [
    { ...structuredClone(common), id: 'deepseek-candidate', backend: 'deepseek', model: 'deepseek-flash', baseUrl: null, acceptedReportedModels: ['deepseek-flash'] },
    { ...structuredClone(common), id: 'compatible-candidate', backend: 'compatible', model: 'compatible-model-v1', baseUrl: 'https://compatible.invalid/v1', acceptedReportedModels: ['compatible-model-v1', 'compatible-model-v1-alias'] }
  ];
}
export const GRANT = Object.freeze({ allowedRoutes: ['deepseek-candidate', 'compatible-candidate'], allowedTools: ['evidence.read', 'evidence.assess'], maxCalls: 8, maxInputBytes: 20000, maxInputTokens: 25000, maxOutputTokens: 512, maxTotalTokens: 200000, maxCostMicrousd: 500000, maxConcurrent: 1 });
export function authorization(routeId = 'deepseek-candidate', grant = GRANT) { return { version: M2_AUTHORIZATION_VERSION, grantId: 'm2-test-research', revision: 1, routeId, grant: structuredClone(grant) }; }
export function envelope(model, plan = GOOD_PLAN, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) {
  return { id: 'injected-response', model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: typeof plan === 'string' ? plan : JSON.stringify(plan) } }], ...(usage === undefined ? {} : { usage }) };
}
export function fixtureRegistry({ definitions = routes(), responses = {} } = {}) {
  const wire = [], pending = []; const counters = Object.fromEntries(definitions.map(route => [route.id, 0]));
  const httpByRoute = Object.fromEntries(definitions.map(route => [route.id, async (url, options) => {
    const request = JSON.parse(options.body); wire.push({ routeId: route.id, url, model: request.model, maxTokens: request.max_tokens, responseFormat: request.response_format, stream: request.stream, messageRoles: request.messages.map(item => item.role), hasTools: Object.hasOwn(request, 'tools') });
    const scenario = responses[route.id]?.[counters[route.id]++] || {};
    if (scenario.kind === 'timeout') return new Promise((_, reject) => {
      const aborted = () => reject(new DOMException('Injected abort', 'AbortError'));
      if (options.signal.aborted) aborted(); else options.signal.addEventListener('abort', aborted, { once: true });
    });
    if (scenario.kind === 'ignore-abort') return new Promise(resolve => pending.push(() => resolve(new Response(JSON.stringify(envelope(route.model))))));
    if (scenario.kind === 'http-error') return new Response('Injected provider error never logged', { status: 503 });
    if (scenario.kind === 'redirect') return new Response('', { status: 302 });
    if (scenario.kind === 'bad-utf8') return new Response(new Uint8Array([0xc3, 0x28]));
    if (scenario.kind === 'invalid-status') return { status: scenario.status, body: new Response(JSON.stringify(envelope(route.model))).body };
    if (scenario.kind === 'oversize') return new Response('x'.repeat(33 * 1024));
    const value = scenario.envelope || envelope(route.model, scenario.plan || GOOD_PLAN, Object.hasOwn(scenario, 'usage') ? scenario.usage : { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    return new Response(Object.hasOwn(scenario, 'rawText') ? scenario.rawText : JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  }]));
  return { registry: createProviderRegistry({ routes: definitions, httpByRoute }), wire, releaseIgnored: () => pending.splice(0).forEach(release => release()) };
}
