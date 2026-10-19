import test from "node:test";
import assert from "node:assert/strict";
import { createModelBackend, ModelBackendError } from "../src/model-backend.js";

const call = { task: "extract", contractVersion: "flowcredit.copilot/v1", prompt: "Read this source and propose JSON." };
const localEnv = { FC_COPILOT_BACKEND: "local", FC_COPILOT_BASE_URL: "http://127.0.0.1:11434/v1", FC_COPILOT_MODEL: "local-model:small" };
const envelope = (content = '{"proposals":[]}', extra = {}) => JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], ...extra });
const ok = text => new Response(envelope(text), { status: 200 });
const code = expected => error => error instanceof ModelBackendError && error.code === expected && error.message === expected;

test("disabled is the default even when an unrelated DeepSeek credential exists", async () => {
  let calls = 0;
  const backend = createModelBackend({ env: { DEEPSEEK_API_KEY: "unused-test-secret" }, fetchImpl: async () => { calls += 1; return ok(); } });
  assert.deepEqual(backend.descriptor, { backend: "disabled", model: null, enabled: false });
  assert.ok(Object.isFrozen(backend.descriptor));
  await assert.rejects(backend.generate(call), code("MODEL_DISABLED"));
  assert.equal(calls, 0);
});

test("DeepSeek uses only its fixed official endpoint and configured credential", async () => {
  let seen;
  const backend = createModelBackend({ env: { FC_COPILOT_BACKEND: "deepseek", DEEPSEEK_API_KEY: "test-deepseek-secret", FC_COPILOT_API_KEY: "must-not-be-used", FC_COPILOT_BASE_URL: "https://malicious.invalid" }, fetchImpl: async (...args) => { seen = args; return new Response(envelope('{"plan":[]}', { usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10, api_key: "provider-secret" }, model: "untrusted-provider-echo" })); } });
  const result = await backend.generate({ ...call, task: "plan" });
  assert.equal(seen[0], "https://api.deepseek.com/chat/completions");
  assert.equal(seen[1].headers.Authorization, "Bearer test-deepseek-secret");
  assert.equal(seen[1].redirect, "error");
  const body = JSON.parse(seen[1].body);
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[1].content, call.prompt);
  assert.equal(body.stream, false);
  assert.equal("tools" in body, false);
  assert.equal("tool_choice" in body, false);
  assert.equal(body.max_tokens, 4096);
  assert.match(body.messages[0].content, /non-authoritative proposal/);
  assert.deepEqual(result.usage, { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 });
  assert.equal(result.model, "deepseek-flash");
  assert.equal(result.backend, "deepseek");
  assert.equal(result.text, '{"plan":[]}');
  assert.match(result.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(backend).includes("secret"), false);
});

test("local and explicitly configured compatible transports bind one operator endpoint", async () => {
  const configs = [localEnv, { ...localEnv, FC_COPILOT_BASE_URL: "http://[::1]:11434/v1/" }, { FC_COPILOT_BACKEND: "compatible", FC_COPILOT_BASE_URL: "https://model.operator.invalid/v1", FC_COPILOT_MODEL: "configured-model", FC_COPILOT_API_KEY: "test-compatible-secret" }];
  for (const env of configs) {
    let seen;
    const backend = createModelBackend({ env, fetchImpl: async (...args) => { seen = args; return ok(); } });
    await backend.generate({ ...call, endpoint: "https://caller.invalid", task: "explain" });
    assert.equal(seen[0], `${env.FC_COPILOT_BASE_URL.replace(/\/$/, "")}/chat/completions`);
    assert.equal(seen[1].headers.Authorization, env.FC_COPILOT_API_KEY ? "Bearer test-compatible-secret" : undefined);
  }
});

test("invalid operator configurations fail without exposing their values", () => {
  const bad = [
    { FC_COPILOT_BACKEND: "unknown" },
    { FC_COPILOT_BACKEND: "deepseek" },
    { ...localEnv, FC_COPILOT_MODEL: "private\nvalue" },
    { ...localEnv, FC_COPILOT_BASE_URL: "http://external.invalid/v1" },
    { ...localEnv, FC_COPILOT_BASE_URL: "file:///tmp/model" },
    { ...localEnv, FC_COPILOT_BASE_URL: "http://user:password@127.0.0.1/v1" },
    { ...localEnv, FC_COPILOT_BASE_URL: "http://127.0.0.1/v1?token=secret" },
    { ...localEnv, FC_COPILOT_BASE_URL: "http://127.0.0.1/v1#secret" },
    { ...localEnv, FC_COPILOT_BACKEND: "compatible", FC_COPILOT_BASE_URL: "http://external.invalid/v1" },
    { ...localEnv, FC_COPILOT_API_KEY: "secret\r\nInjected: yes" },
    { ...localEnv, FC_COPILOT_TIMEOUT_MS: "30001" },
    { ...localEnv, FC_COPILOT_TIMEOUT_MS: "NaN" }
  ];
  for (const env of bad) assert.throws(() => createModelBackend({ env }), code("MODEL_CONFIGURATION"));
});

test("closed tasks and UTF-8 input bound are checked before transport", async () => {
  let calls = 0;
  const backend = createModelBackend({ env: localEnv, fetchImpl: async () => { calls += 1; return ok(); } });
  await assert.rejects(backend.generate({ ...call, task: "risk" }), code("MODEL_TASK_INVALID"));
  for (const input of [{ ...call, prompt: {} }, { ...call, prompt: " " }, { ...call, contractVersion: "bad\nversion" }, { ...call, signal: {} }, { ...call, prompt: "财".repeat(35 * 1024) }]) await assert.rejects(backend.generate(input), code("MODEL_INPUT_INVALID"));
  assert.equal(calls, 0);
});

test("provider exceptions and HTTP bodies never escape sanitized transport errors", async () => {
  const unavailable = createModelBackend({ env: localEnv, fetchImpl: async () => { throw new Error("api_key=test-secret private-source=secret"); } });
  await assert.rejects(unavailable.generate(call), code("MODEL_UNAVAILABLE"));
  const http = createModelBackend({ env: localEnv, fetchImpl: async () => new Response("api_key=test-secret provider rejected source", { status: 401 }) });
  await assert.rejects(http.generate(call), code("MODEL_HTTP_ERROR"));
});

test("redirects cannot send credentials or sources to another endpoint", async () => {
  let calls = 0;
  const redirected = createModelBackend({ env: localEnv, fetchImpl: async () => { calls += 1; return new Response("", { status: 302, headers: { Location: "https://untrusted.invalid" } }); } });
  await assert.rejects(redirected.generate(call), code("MODEL_REDIRECT"));
  assert.equal(calls, 1);
  const inconsistentUrl = createModelBackend({ env: localEnv, fetchImpl: async () => {
    const response = ok();
    Object.defineProperty(response, "url", { value: "https://untrusted.invalid" });
    return response;
  } });
  await assert.rejects(inconsistentUrl.generate(call), code("MODEL_REDIRECT"));
});

test("timeout aborts a compliant fetch and retains a slot for an abort-ignoring transport", async () => {
  let signal;
  const backend = createModelBackend({ env: { ...localEnv, FC_COPILOT_TIMEOUT_MS: "5" }, fetchImpl: async (_, options) => {
    signal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("secret provider state", "AbortError")), { once: true }));
  } });
  await assert.rejects(backend.generate(call), code("MODEL_TIMEOUT"));
  assert.equal(signal.aborted, true);
  const ignoring = createModelBackend({ env: { ...localEnv, FC_COPILOT_TIMEOUT_MS: "5" }, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(ignoring.generate(call), code("MODEL_TIMEOUT"));
  await assert.rejects(ignoring.generate(call), code("MODEL_TIMEOUT"));
  await assert.rejects(ignoring.generate(call), code("MODEL_BUSY"));
});

test("caller cancellation does not use the transport and cancellation during a call is bounded", async () => {
  let calls = 0;
  const backend = createModelBackend({ env: localEnv, fetchImpl: async () => { calls += 1; return new Promise(() => {}); } });
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(backend.generate({ ...call, signal: stopped.signal }), code("MODEL_ABORTED"));
  assert.equal(calls, 0);
  const running = new AbortController();
  const result = backend.generate({ ...call, signal: running.signal });
  running.abort();
  await assert.rejects(result, code("MODEL_ABORTED"));
  assert.equal(calls, 1);
});

test("max concurrency is two and no queue or background retries are created", async () => {
  const resolves = [];
  let calls = 0;
  const backend = createModelBackend({ env: localEnv, fetchImpl: async () => { calls += 1; return new Promise(resolve => resolves.push(resolve)); } });
  const first = backend.generate(call);
  const second = backend.generate(call);
  await assert.rejects(backend.generate(call), code("MODEL_BUSY"));
  assert.equal(calls, 2);
  for (const resolve of resolves) resolve(ok());
  await Promise.all([first, second]);
  const next = backend.generate(call);
  resolves.at(-1)(ok());
  await next;
  assert.equal(calls, 3);
});

test("oversized responses are rejected by advertised size and by streamed bytes", async () => {
  const advertised = createModelBackend({ env: localEnv, fetchImpl: async () => new Response("{}", { headers: { "Content-Length": "32769" } }) });
  await assert.rejects(advertised.generate(call), code("MODEL_OUTPUT_TOO_LARGE"));
  const streamed = createModelBackend({ env: localEnv, fetchImpl: async () => new Response(envelope("财".repeat(12000))) });
  await assert.rejects(streamed.generate(call), code("MODEL_OUTPUT_TOO_LARGE"));
});

test("the deadline also bounds an otherwise successful response whose body stalls", async () => {
  let requestSignal;
  const backend = createModelBackend({ env: { ...localEnv, FC_COPILOT_TIMEOUT_MS: "5" }, fetchImpl: async (_, options) => {
    requestSignal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"choices":['));
      options.signal.addEventListener("abort", () => controller.error(new DOMException("private-source=secret", "AbortError")), { once: true });
    } }));
  } });
  await assert.rejects(backend.generate(call), code("MODEL_TIMEOUT"));
  assert.equal(requestSignal.aborted, true);
});

test("response envelope validation rejects malformed, truncated, tool-calling or empty output", async () => {
  const bodies = ["not-json secret", "null", "{}", JSON.stringify({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "{}" } }] }), JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "tool", content: "{}" } }] }), JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", tool_calls: [] } }] }), JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: {} } }] }), envelope(" ")];
  for (const body of bodies) {
    const backend = createModelBackend({ env: localEnv, fetchImpl: async () => new Response(body) });
    await assert.rejects(backend.generate(call), code("MODEL_OUTPUT_INVALID"));
  }
});

test("UTF-8 output decoding is strict and valid multibyte content remains intact", async () => {
  const invalid = createModelBackend({ env: localEnv, fetchImpl: async () => new Response(new Uint8Array([0xc3, 0x28])) });
  await assert.rejects(invalid.generate(call), code("MODEL_OUTPUT_INVALID"));
  const backend = createModelBackend({ env: localEnv, fetchImpl: async () => ok('{"explanation":"公开事实与权限分开。"}') });
  assert.equal((await backend.generate({ ...call, task: "explain" })).text, '{"explanation":"公开事实与权限分开。"}');
});

test("transport leaves inner contract validation to the caller and grants no state writes", async () => {
  const malicious = '{"riskGrade":"A","cross_verified":true,"confidence":1,"tools":["writeCanonicalFact"]}';
  const backend = createModelBackend({ env: localEnv, fetchImpl: async () => ok(malicious) });
  const result = await backend.generate({ ...call, writeCanonicalFact() { assert.fail("A model transport cannot access callback state"); } });
  assert.equal(result.text, malicious);
  assert.deepEqual(Object.keys(result).sort(), ["backend", "generatedAt", "model", "text"]);
});
