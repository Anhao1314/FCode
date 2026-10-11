import { createLoopRuntime } from '../src/loop-runtime.mjs';
import { createOfflineRegistry, offlineAuthorization } from '../src/offline-loop-model.mjs';
import { offlineService } from '../src/fixtures.mjs';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const args = JSON.parse(raw); globalThis.fetch = () => { throw new Error('External requests forbidden'); };
const registry = createOfflineRegistry();
async function stop(phase, detail) { process.stdout.write(JSON.stringify({ stoppedAt: phase, calls: registry.calls, ...(detail?.intent ? { requestId: detail.intent.requestId } : {}), ...(detail?.receiptRef ? { receiptRef: detail.receiptRef } : {}) }) + '\n'); setInterval(() => {}, 1000); await new Promise(() => {}); }
const runtime = createLoopRuntime(args.root, { registry, service: offlineService(args.root), authorizer: async () => args.authorization || offlineAuthorization(),
  afterCheckpoint: async data => { if (args.crashPhase === data.type) await stop(data.type, data); },
  afterApiPhase: async (phase, detail) => { if (args.crashPhase === phase) await stop(phase, detail); },
  afterChildCheckpoint: async data => { if (args.crashPhase === data.type) await stop(data.type, data); }
});
try { const result = await runtime.harness.run(args.id, args.context); process.stdout.write(JSON.stringify({ status: result.status, calls: registry.calls, failure: result.failure }) + '\n'); }
catch (error) { process.stdout.write(JSON.stringify({ errorCode: error.code || 'WORKER_FAILURE', calls: registry.calls }) + '\n'); }
