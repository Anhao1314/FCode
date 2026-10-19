import { createM1Runtime } from '../src/m1-runtime.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const args = JSON.parse(input);
globalThis.fetch = () => { throw new Error('Network forbidden'); };
const stop = async (phase, detail = {}) => {
  setInterval(() => {}, 1000); // Keep the worker alive until the parent's real SIGKILL.
  process.stdout.write(`${JSON.stringify({ stoppedAt: phase, ...detail })}\n`);
  await new Promise(() => {});
};
const options = {
  afterApiPhase: async (phase, detail) => {
    if (args.mode === 'api-crash' && phase === args.phase) await stop(phase, { receiptRef: detail.receiptRef || null, calls: runtime.modelApi.calls });
  },
  afterCheckpoint: async ({ type }) => {
    if (args.mode === 'task-intent' && type === 'model_started') await stop(type);
  },
  afterTaskPhase: async (phase, detail) => {
    if (args.mode.startsWith('store-') && phase === args.phase && detail.sequence === args.sequence) await stop(phase, detail);
  }
};
const runtime = createM1Runtime(args.root, options);
try {
  let result;
  if (args.mode === 'execute') {
    const task = await runtime.store.load(args.id);
    result = await runtime.modelApi.execute({ intent: task.model.intent, prompt: runtime.harness.promptFor(task), priorCalls: 0 });
  } else if (args.mode === 'store-save') {
    const task = await runtime.store.load(args.id);
    await runtime.store.exclusive(args.id, () => runtime.harness.checkpoint(task, 'window_test'));
  } else if (args.mode === 'store-create') await runtime.store.create(args.task);
  else result = await runtime.harness.run(args.id, args.context);
  process.stdout.write(`${JSON.stringify({ finished: true, status: result?.status || null, calls: runtime.modelApi.calls })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ finished: true, errorCode: error.code || 'WORKER_FAILED', calls: runtime.modelApi.calls })}\n`);
}
