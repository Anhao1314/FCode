import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelApi } from '../src/model-api.mjs';
import { PLAN_VERSION, RuntimeError } from '../src/contracts.mjs';
import { digest } from '../src/baseline.mjs';

const plan = () => ({ version: PLAN_VERSION, steps: [{ id: 'inspect', tool: 'evidence.read', arguments: {} }] });
const grant = { allowedAdapters: ['mock'], maxCalls: 1, allowPaid: false, maxCostMicrousd: 0 };
const input = overrides => ({ requestId: 'request-1', taskId: 'task-1', principalHash: digest('test-principal'), prompt: 'Private test prompt. Propose a bounded plan.', grant, ...overrides });
const denied = expected => error => {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  assert.equal(error.receipt.errorCode, expected);
  return true;
};

test('mock reuses the bounded transport, validates a plan and retains unknown usage', async () => {
  const api = createModelApi({ responses: [plan()] });
  const result = await api.plan(input());
  assert.deepEqual(result.plan, plan());
  assert.equal(api.calls, 1);
  assert.equal(result.receipt.adapter, 'mock');
  assert.equal(result.receipt.provider, 'mock');
  assert.equal(result.receipt.status, 'validated');
  assert.equal(result.receipt.contractVersion, PLAN_VERSION);
  assert.equal(result.receipt.promptHash, digest(input().prompt));
  assert.equal(result.receipt.responseHash, digest(JSON.stringify(plan())));
  assert.equal(result.receipt.usage, null);
  assert.equal(result.receipt.costMicrousd, 0);
  assert.equal(result.receipt.errorCode, null);
  assert.ok(Object.isFrozen(api.descriptor));
  const retained = JSON.stringify(result.receipt);
  assert.equal(retained.includes(input().prompt), false);
  assert.equal(/https?:\/\/|credential|authorization|api_key/i.test(retained), false);
});

test('mock ignores paid environment configuration and never invokes global fetch', async () => {
  const savedFetch = globalThis.fetch;
  const keys = ['FC_COPILOT_BACKEND', 'FC_COPILOT_BASE_URL', 'DEEPSEEK_API_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let networkCalls = 0;
  try {
    process.env.FC_COPILOT_BACKEND = 'deepseek';
    process.env.FC_COPILOT_BASE_URL = 'https://private.invalid';
    process.env.DEEPSEEK_API_KEY = 'private-test-credential';
    globalThis.fetch = async () => { networkCalls += 1; throw new Error('Network is forbidden'); };
    const api = createModelApi({ responses: [plan()] });
    const result = await api.plan(input());
    assert.equal(result.receipt.adapter, 'mock');
    assert.equal(JSON.stringify(result).includes('private-test-credential'), false);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('only one fixture is consumed per invocation and prior reservations enforce quota', async () => {
  const first = plan(), second = plan(); second.steps[0].id = 'next';
  const api = createModelApi({ responses: [first, second] });
  const largerGrant = { ...grant, maxCalls: 2 };
  assert.deepEqual((await api.plan(input({ grant: largerGrant }))).plan, first);
  assert.deepEqual((await api.plan(input({ requestId: 'request-2', grant: largerGrant, priorCalls: 1 }))).plan, second);
  await assert.rejects(api.plan(input({ grant: largerGrant, priorCalls: 2 })), denied('MODEL_CALL_QUOTA'));
  assert.equal(api.calls, 2);
});

test('paid or unapproved adapters cannot execute even when a grant permits payment', async () => {
  for (const backend of ['deepseek', 'compatible', 'paid', 'https://private.invalid']) {
    const api = createModelApi({ backend, responses: [plan()] });
    await assert.rejects(api.plan(input({ grant: { ...grant, allowedAdapters: [backend], allowPaid: true, maxCostMicrousd: 1000 } })), error => {
      denied('MODEL_POLICY_DENIED')(error);
      assert.equal(error.receipt.status, 'denied');
      assert.equal(JSON.stringify(error.receipt).includes('private.invalid'), false);
      return true;
    });
    assert.equal(api.calls, 0);
  }
});

test('adapter permission and invalid grants fail before transport', async () => {
  for (const policy of [undefined, { ...grant, allowedAdapters: [] }, { ...grant, maxCostMicrousd: -1 }, { ...grant, allowPaid: 'yes' }]) {
    const api = createModelApi({ responses: [plan()] });
    await assert.rejects(api.plan(input({ grant: policy })), denied('MODEL_POLICY_DENIED'));
    assert.equal(api.calls, 0);
  }
  const api = createModelApi({ responses: [plan()] });
  await assert.rejects(api.plan(input({ grant: { ...grant, maxCalls: 0 } })), denied('MODEL_CALL_QUOTA'));
  assert.equal(api.calls, 0);
});

test('malformed, wrapped and repeated JSON keys are rejected with retained failure hashes', async () => {
  const duplicate = `{"version":"${PLAN_VERSION}","steps":[],"steps":${JSON.stringify(plan().steps)}}`;
  const nestedDuplicate = `{"version":"${PLAN_VERSION}","steps":[{"id":"inspect","tool":"evidence.read","arguments":{"value":1,"value":2}}]}`;
  for (const text of ['not JSON', '```json\n{}\n```', duplicate, nestedDuplicate]) {
    const api = createModelApi({ responses: [text] });
    await assert.rejects(api.plan(input()), error => {
      denied('MODEL_OUTPUT_INVALID')(error);
      assert.equal(error.receipt.responseHash, digest(text));
      assert.equal(error.receipt.status, 'failed');
      return true;
    });
    assert.equal(api.calls, 1);
  }
});

test('model schema rejects authority, extra fields, duplicate step identities and nonfinite numbers', async () => {
  const extra = plan(); extra.authority = 'risk';
  const repeated = plan(); repeated.steps.push(repeated.steps[0]);
  const forgedStep = plan(); forgedStep.steps[0].permissions = ['write'];
  const infinite = JSON.stringify(plan()).replace('"arguments":{}', '"arguments":{"value":1e309}');
  for (const response of [extra, repeated, forgedStep, infinite, { version: PLAN_VERSION, steps: [] }]) {
    const api = createModelApi({ responses: [response] });
    await assert.rejects(api.plan(input()), denied('MODEL_SCHEMA_INVALID'));
    assert.equal(api.calls, 1);
  }
});

test('oversized transport output and deeply nested arguments remain bounded', async () => {
  const oversized = createModelApi({ responses: ['x'.repeat(33 * 1024)] });
  await assert.rejects(oversized.plan(input()), denied('MODEL_OUTPUT_TOO_LARGE'));
  const nested = plan();
  let current = nested.steps[0].arguments;
  for (let i = 0; i < 12; i += 1) { current.next = {}; current = current.next; }
  const api = createModelApi({ responses: [nested] });
  await assert.rejects(api.plan(input()), denied('MODEL_SCHEMA_INVALID'));
  assert.equal(api.calls, 1);
});

test('unknown proposed tools receive no execution capability from Model API', async () => {
  const proposed = plan(); proposed.steps[0].tool = 'authority.write';
  const api = createModelApi({ responses: [proposed] });
  const result = await api.plan(input());
  assert.equal(result.plan.steps[0].tool, 'authority.write');
  assert.equal(Object.hasOwn(result, 'permissions'), false);
  assert.equal(Object.hasOwn(api, 'execute'), false);
});

test('disabled uses the existing disabled backend without consuming a mock response', async () => {
  const api = createModelApi({ backend: 'disabled', responses: [plan()] });
  await assert.rejects(api.plan(input()), denied('MODEL_DISABLED'));
  assert.equal(api.calls, 0);
  assert.equal(api.descriptor.enabled, false);
});

test('provider-native tool_calls are rejected by ModelBackend before inner plan parsing', async () => {
  const api = createModelApi({ responses: [{ transportError: 'MODEL_OUTPUT_INVALID' }] });
  await assert.rejects(api.plan(input()), error => {
    denied('MODEL_OUTPUT_INVALID')(error);
    assert.equal(error.receipt.responseHash, null);
    return true;
  });
  assert.equal(api.calls, 1);
});

test('HTTP and timeout simulations settle and expose only bounded receipt codes', async () => {
  for (const code of ['MODEL_HTTP_ERROR', 'MODEL_TIMEOUT']) {
    const api = createModelApi({ responses: [{ transportError: code }], timeoutMs: 5 });
    await assert.rejects(api.plan(input()), error => {
      denied(code)(error);
      assert.equal(error.retryable, true);
      assert.equal(error.receipt.responseHash, null);
      assert.equal(error.receipt.usage, null);
      return true;
    });
    assert.equal(api.calls, 1);
  }
});

test('pre-aborted requests consume no response and in-flight abort releases the mock transport', async () => {
  const before = new AbortController(); before.abort();
  const api = createModelApi({ responses: [plan()] });
  await assert.rejects(api.plan(input({ signal: before.signal })), denied('MODEL_ABORTED'));
  assert.equal(api.calls, 0);
  const running = createModelApi({ responses: [{ transportError: 'MODEL_TIMEOUT' }, plan()], timeoutMs: 50 });
  const controller = new AbortController();
  const result = running.plan(input({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(result, denied('MODEL_ABORTED'));
  const retried = await running.plan(input({ requestId: 'retry-1', grant: { ...grant, maxCalls: 2 }, priorCalls: 1 }));
  assert.deepEqual(retried.plan, plan());
  assert.equal(running.calls, 2);
});

test('invalid metadata, prompt, signal and prior counts fail without any transport', async () => {
  for (const override of [{ taskId: '../private' }, { requestId: 'private\nvalue' }, { principalHash: 'forged' }, { prompt: ' ' }, { prompt: 'x'.repeat(100 * 1024 + 1) }, { signal: {} }, { priorCalls: -1 }, { priorCalls: 0.5 }]) {
    const api = createModelApi({ responses: [plan()] });
    await assert.rejects(api.plan(input(override)), denied('MODEL_INPUT_INVALID'));
    assert.equal(api.calls, 0);
  }
});
