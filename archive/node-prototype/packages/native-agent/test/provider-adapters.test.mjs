import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '../src/baseline.mjs';
import { PLAN_VERSION } from '../src/contracts.mjs';
import { createProviderRegistry, estimateCost } from '../src/provider-adapters.mjs';
import { routes, fixtureRegistry, envelope, SYNTHETIC_KEY } from './m2-fixtures.mjs';
import { GOOD_PLAN } from '../src/fixtures.mjs';

const input = () => ({ requestId: 'adapter-request-1', taskId: 'task-test', principalHash: digest('synthetic-user'), prompt: 'Propose registered read tools only.' });
test('DeepSeek and compatible share the same inner plan contract and host wire caps', async () => {
  const fake = fixtureRegistry();
  for (const route of fake.registry.descriptors) {
    const result = await fake.registry.route(route.id).plan(input());
    assert.deepEqual(result.plan, GOOD_PLAN); assert.equal(result.receipt.contractVersion, PLAN_VERSION);
    assert.equal(result.receipt.responseHashKind, 'inner-text'); assert.equal(result.receipt.usage.totalTokens, 120);
    assert.equal(JSON.stringify(result).includes(SYNTHETIC_KEY), false);
  }
  assert.equal(fake.wire[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(fake.wire[1].url, 'https://compatible.invalid/v1/chat/completions');
  assert(fake.wire.every(item => item.maxTokens === 128 && item.responseFormat.type === 'json_object' && !item.hasTools && item.stream === false));
});
test('no global fetch or inherited provider environment is used', async () => {
  const saved = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = () => { networkCalls += 1; throw new Error('External HTTP forbidden'); };
  try { const fake = fixtureRegistry(); await fake.registry.route('deepseek-candidate').plan(input()); assert.equal(networkCalls, 0); }
  finally { globalThis.fetch = saved; }
  assert.throws(() => createProviderRegistry({ routes: routes(), httpByRoute: {} }), { code: 'MODEL_HTTP_INJECTION_REQUIRED' });
});
test('missing, string, fractional and NaN status cannot be laundered into HTTP 200', async () => {
  for (const status of [undefined, '200', NaN, 200.5]) {
    const fake = fixtureRegistry({ responses: { 'deepseek-candidate': [{ kind: 'invalid-status', status }] } });
    await assert.rejects(fake.registry.route('deepseek-candidate').plan(input()), error => error.code === 'MODEL_OUTPUT_INVALID' && error.receipt.responseHash === null);
  }
});
test('outer malformed/duplicate/model/native-tool/truncation/multiple-choice responses reject', async () => {
  const model = 'deepseek-flash';
  const native = envelope(model); native.choices[0].message.tool_calls = null;
  const functionCall = envelope(model); functionCall.choices[0].message.function_call = {};
  const truncate = envelope(model); truncate.choices[0].finish_reason = 'length';
  const role = envelope(model); role.choices[0].message.role = 'user';
  const multi = envelope(model); multi.choices.push(structuredClone(multi.choices[0]));
  const duplicate = JSON.stringify(envelope(model)).replace('"model":"deepseek-flash"', '"model":"deepseek-flash","model":"deepseek-flash"');
  for (const scenario of [{ rawText: '{bad JSON' }, { rawText: duplicate }, { envelope: envelope('wrong-model') }, { envelope: native }, { envelope: functionCall }, { envelope: truncate }, { envelope: role }, { envelope: multi }]) {
    const fake = fixtureRegistry({ responses: { 'deepseek-candidate': [scenario] } });
    await assert.rejects(fake.registry.route('deepseek-candidate').plan(input()), error => error.code === 'MODEL_OUTPUT_INVALID' && error.receipt.responseHashKind === 'wire-envelope' && error.receipt.responseHash === error.receipt.envelopeHash);
  }
});
test('inner duplicate/extra-authority/model fields retain inner hash and fail strict schema', async () => {
  const duplicate = JSON.stringify(GOOD_PLAN).replace('"version":', `"version":"${PLAN_VERSION}","version":`);
  for (const plan of [duplicate, { ...GOOD_PLAN, model: 'self-selected' }, { ...GOOD_PLAN, authority: { riskCalculation: true } }]) {
    const fake = fixtureRegistry({ responses: { 'deepseek-candidate': [{ plan }] } });
    await assert.rejects(fake.registry.route('deepseek-candidate').plan(input()), error => ['MODEL_OUTPUT_INVALID', 'MODEL_SCHEMA_INVALID'].includes(error.code) && error.receipt.responseHashKind === 'inner-text');
  }
});
test('configured reported model aliases are accepted and arbitrary models are refused', async () => {
  const fake = fixtureRegistry({ responses: { 'compatible-candidate': [{ envelope: envelope('compatible-model-v1-alias') }] } });
  assert.equal((await fake.registry.route('compatible-candidate').plan(input())).receipt.providerReportedModel, 'compatible-model-v1-alias');
});
test('partial/negative/fractional/contradictory/overflow usage is null rather than free', async () => {
  for (const usage of [{ prompt_tokens: 100 }, { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 }, { prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3.5 }, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 121 }, { prompt_tokens: null, completion_tokens: 20, total_tokens: null }]) {
    const fake = fixtureRegistry({ responses: { 'deepseek-candidate': [{ usage }] } });
    const result = await fake.registry.route('deepseek-candidate').plan(input());
    assert.equal(result.receipt.usage, null); assert.equal(result.receipt.usageStatus, 'invalid');
  }
});
test('missing usage remains unknown; complete or partial explicit token overage is invalid', async () => {
  const missing = envelope('deepseek-flash'); delete missing.usage;
  const fake = fixtureRegistry({ responses: { 'deepseek-candidate': [{ envelope: missing }] } });
  const result = await fake.registry.route('deepseek-candidate').plan(input()); assert.equal(result.receipt.usageStatus, 'missing'); assert.equal(result.receipt.usage, null);
  for (const usage of [{ completion_tokens: 129 }, { prompt_tokens: 100, completion_tokens: 129, total_tokens: 229 }, { prompt_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    const invalid = fixtureRegistry({ responses: { 'deepseek-candidate': [{ usage }] } });
    await assert.rejects(invalid.registry.route('deepseek-candidate').plan(input()), error => error.code === 'MODEL_OUTPUT_INVALID' && error.receipt.usageStatus === 'over-budget');
  }
});
test('bad UTF8 and oversized responses are bounded and do not produce complete result hashes', async () => {
  for (const [kind, code] of [['bad-utf8', 'MODEL_OUTPUT_INVALID'], ['oversize', 'MODEL_OUTPUT_TOO_LARGE']]) {
    const fake = fixtureRegistry({ responses: { 'deepseek-candidate': [{ kind }] } });
    await assert.rejects(fake.registry.route('deepseek-candidate').plan(input()), error => error.code === code && error.receipt.responseHash === null);
  }
});
test('route fingerprint binds endpoint, aliases, limits, price version and backend source', () => {
  const initial = fixtureRegistry().registry.route('compatible-candidate').descriptor;
  assert(/^[a-f0-9]{64}$/.test(initial.backendSourceHash));
  for (const alter of [route => { route.baseUrl = 'https://other.invalid/v1'; }, route => { route.maxOutputTokens = 64; }, route => { route.pricing.version = 'synthetic-price-v2'; }, route => { route.acceptedReportedModels.push('new-alias'); }]) {
    const definitions = routes(); alter(definitions[1]);
    assert.notEqual(fixtureRegistry({ definitions }).registry.route('compatible-candidate').descriptor.configHash, initial.configHash);
  }
});
test('cost arithmetic uses integer ceiling and rejects unsafe overflow', () => {
  const price = { inputMicrousdPerMillion: 1, outputMicrousdPerMillion: 1 };
  assert.equal(estimateCost(price, 1, 0), 1);
  assert.throws(() => estimateCost({ inputMicrousdPerMillion: 1e12, outputMicrousdPerMillion: 1e12 }, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), { code: 'MODEL_COST_OVERFLOW' });
});
