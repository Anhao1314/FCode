import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedFixture, GOOD_PLAN } from '../src/fixtures.mjs';
import { createDeepSeekInternalRuntime } from '../src/deepseek-runtime.mjs';
import { DEEPSEEK_ROUTE, DEEPSEEK_MODEL } from '../src/deepseek-profile.mjs';
import { conditionalDecision } from '../src/offline-loop-model.mjs';
import { APPROVAL_VERSION } from '../src/deepseek-transport.mjs';
export const scratch = fileURLToPath(new URL('../../../work/m3-a/', import.meta.url));
export const cases = [];
export const GRANT = Object.freeze({ allowedRoutes: [DEEPSEEK_ROUTE], allowedTools: ['evidence.read', 'evidence.assess'], maxCalls: 6, maxInputBytes: 20000, maxInputTokens: 25000, maxOutputTokens: 512, maxTotalTokens: 150000, maxCostMicrousd: 500000, maxConcurrent: 1 });
export function modelAuth(grant = GRANT) { return { version: 'flowcredit.model-authorization/m2-v1', grantId: 'm3-offline-grant', revision: 1, routeId: DEEPSEEK_ROUTE, grant: structuredClone(grant) }; }
export function approval(request, overrides = {}) { return { version: APPROVAL_VERSION, enabled: true, approvalId: 'offline-live-boundary-test', requestId: request.requestId, principalHash: request.principalHash, grantId: request.grantId, authorizationHash: request.authorizationHash, configHash: request.configHash, pricingHash: request.pricingHash, promptHash: request.promptHash, expiresAt: Date.now() + 60000, acceptUnprovenTokenAndBillingBounds: true, pricingReviewHash: '1'.repeat(64), ...overrides }; }
export function envelope(plan = GOOD_PLAN, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 0 } }) { return { id: 'test-deepseek-response', object: 'chat.completion', created: 1791670000, model: DEEPSEEK_MODEL, system_fingerprint: 'fp_injected', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: typeof plan === 'string' ? plan : JSON.stringify(plan) } }], ...(usage === undefined ? {} : { usage }) }; }
export function fakeHttp({ scenarios = [], loop = false } = {}) {
  const wire = [], pending = []; let count = 0;
  const http = async (url, options) => {
    const body = JSON.parse(options.body); const scenario = scenarios[count++] || {};
    const header = new Headers(options.headers).get('authorization');
    wire.push({ url, model: body.model, thinking: body.thinking, stream: body.stream, responseFormat: body.response_format, maxTokens: body.max_tokens, hasTools: Object.hasOwn(body, 'tools'), systemHasJsonExample: /JSON example/.test(body.messages[0].content), redirect: options.redirect, authorizationHeaderCount: [...new Headers(options.headers)].filter(([key]) => key === 'authorization').length, usesOnlyTestCredential: header === 'Bearer synthetic-lazy-test-secret', placeholder: header === 'Bearer transport-placeholder-not-a-real-key' });
    if (scenario.kind === 'timeout') return new Promise((_, reject) => { const abort = () => reject(new DOMException('Injected abort', 'AbortError')); if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true }); });
    if (scenario.kind === 'ignore-abort') return new Promise(resolve => pending.push(() => resolve(new Response(JSON.stringify(envelope())))));
    if (scenario.status) return new Response('Private provider error is never stored', { status: scenario.status });
    if (scenario.kind === 'bad-utf8') return new Response(new Uint8Array([0xc3, 0x28]));
    if (scenario.kind === 'oversize') return new Response('x'.repeat(33 * 1024));
    if (scenario.kind === 'bad-status') return { status: '200', body: new Response(JSON.stringify(envelope())).body };
    let proposed = GOOD_PLAN;
    if (loop) { const input = JSON.parse(body.messages[1].content); proposed = conditionalDecision(JSON.parse(input.objective)); }
    const value = scenario.envelope || envelope(scenario.plan || proposed, Object.hasOwn(scenario, 'usage') ? scenario.usage : undefined);
    if (!Object.hasOwn(scenario, 'usage') && !scenario.envelope) value.usage = envelope().usage;
    return new Response(Object.hasOwn(scenario, 'raw') ? scenario.raw : JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  return { http, wire, release: () => pending.splice(0).forEach(callback => callback()) };
}
export async function setup(t, options = {}) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(join(scratch, 'case-')); const fixture = await seedFixture(root);
  let auth = options.authorization || modelAuth(); const fake = fakeHttp({ scenarios: options.scenarios, loop: options.loop });
  const mode = options.mode || 'injected-http-test'; let keyCalls = 0;
  const originalFetch = globalThis.fetch;
  if (mode === 'live') { globalThis.fetch = fake.http; t.after(() => { globalThis.fetch = originalFetch; }); }
  const runtime = createDeepSeekInternalRuntime(root, { ...options, mode, service: fixture.service, authorizer: async () => structuredClone(auth), ...(mode === 'injected-http-test' ? { http: fake.http } : {}), ...(mode === 'live' ? { pricing: { version: 'synthetic-live-gate-fixture', kind: 'host-reviewed-snapshot', currency: 'USD', inputMicrousdPerMillion: 1000000, outputMicrousdPerMillion: 1000000 } } : {}), authorizeTransmission: options.authorizeTransmission || (async request => approval(request)), credentialProvider: options.credentialProvider || (async () => { keyCalls += 1; return 'synthetic-lazy-test-secret'; }) });
  const task = await runtime.harness.create({ assessmentId: fixture.assessmentId, objective: 'M3 synthetic research through the existing Runtime', context: fixture.context, modelGrant: auth.grant });
  t.after(async () => { let latest; try { latest = await runtime.store.load(task.id); } catch (error) { latest = { errorCode: error.code }; } cases.push({ test: t.name, root, id: task.id, mode, loop: !!options.loop, latest, wire: fake.wire, calls: runtime.modelApi.calls, transmissions: runtime.transport.transmissions, credentialReads: runtime.transport.credentialReads, actualExternalModelRequests: 0 }); });
  return { root, ...fixture, ...runtime, task, fake, keyCalls: () => keyCalls, policy: () => structuredClone(auth), setPolicy: value => { auth = structuredClone(value); } };
}
export function fresh(s, options = {}) { const fake = fakeHttp({ loop: options.loop }); return { ...createDeepSeekInternalRuntime(s.root, { mode: 'injected-http-test', service: s.service, authorizer: async () => options.authorization || s.policy(), http: fake.http, ...options }), fake }; }
export async function saveCases() { await writeFile(new URL('../../../validation/deepseek-cases.json', import.meta.url), JSON.stringify({ version: 'flowcredit.deepseek-cases/m3-a-v1', generatedAt: new Date().toISOString(), cases, externalModelRequests: 0, actualModelCredentialsRead: false, paidCalls: 0, liveBoundaryTestsUseReplacedFetchAndSyntheticCredential: true }, null, 2) + '\n'); }
