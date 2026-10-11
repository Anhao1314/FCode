import { createM2Runtime } from '../src/m2-runtime.mjs';
import { fixtureRegistry, authorization } from './m2-fixtures.mjs';

let input = ''; for await (const chunk of process.stdin) input += chunk;
const args = JSON.parse(input); globalThis.fetch = () => { throw new Error('External network forbidden'); };
const fake = fixtureRegistry({ definitions: args.definitions, responses: args.responses });
const stop = async (phase, detail) => {
  setInterval(() => {}, 1000);
  process.stdout.write(`${JSON.stringify({ stoppedAt: phase, calls: fake.registry.calls, ...(detail?.receiptRef ? { receiptRef: detail.receiptRef } : {}) })}\n`);
  await new Promise(() => {});
};
const pause = async phase => {
  const continued = new Promise(resolve => process.once('message', message => { if (message === 'continue') resolve(); }));
  process.stdout.write(`${JSON.stringify({ pausedAt: phase, calls: fake.registry.calls })}\n`);
  await continued;
};
const current = createM2Runtime(args.root, {
  registry: fake.registry, authorizer: async () => args.authorization || authorization(),
  maxConcurrent: args.maxConcurrent || 1,
  afterApiPhase: async (phase, detail) => {
    if (args.crashPhase === phase) await stop(phase, detail);
    if (args.pausePhase === phase) await pause(phase);
  },
  afterBudgetPhase: async (phase, detail) => { if (args.crashPhase === phase) await stop(phase, detail); }
});
try {
  const result = await current.harness.run(args.id, args.context);
  process.stdout.write(`${JSON.stringify({ finished: true, status: result.status, failure: result.failure, calls: current.modelApi.calls })}\n`);
} catch (error) { process.stdout.write(`${JSON.stringify({ finished: true, errorCode: error.code || 'WORKER_FAILURE', calls: current.modelApi.calls })}\n`); }
