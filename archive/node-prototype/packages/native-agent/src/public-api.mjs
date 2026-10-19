import { createDeepSeekInternalRuntime } from './deepseek-runtime.mjs';
import { createLoopRuntime } from './loop-runtime.mjs';
function facade(runtime, loop) {
  return Object.freeze({
    create: input => runtime.harness.create(input),
    run: (id, context, options) => runtime.harness.run(id, context, options),
    reconcile: (id, context, receipt) => runtime.harness.reconcile(id, context, receipt),
    async status(id, context) { const task = await runtime.store.load(id); if (loop) await runtime.harness.authorize(task, context); else await runtime.harness.authorizeTask(task, context); return structuredClone(task); }
  });
}
export function createDeepSeekHarness(root, options = {}) { return facade(createDeepSeekInternalRuntime(root, options), false); }
export function createDeepSeekLoop(root, options = {}) { return facade(createDeepSeekInternalRuntime(root, { ...options, loop: true }), true); }
export function createOfflineLoop(root, options) { return facade(createLoopRuntime(root, options), true); }
