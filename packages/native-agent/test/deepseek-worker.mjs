import { createDeepSeekInternalRuntime } from '../src/deepseek-runtime.mjs';
import { fakeHttp, modelAuth } from './deepseek-fixtures.mjs';
import { offlineService } from '../src/fixtures.mjs';
let text = ''; for await (const chunk of process.stdin) text += chunk;
const args = JSON.parse(text); globalThis.fetch = () => { throw new Error('External model requests forbidden'); };
const fake = fakeHttp({ loop: args.loop }); let runtime;
async function stop(phase, detail) { process.stdout.write(JSON.stringify({ stoppedAt: phase, transmissions: runtime.transport.transmissions, calls: runtime.modelApi.calls, ...(detail?.receiptRef ? { receiptRef: detail.receiptRef } : {}) }) + '\n'); setInterval(() => {}, 1000); await new Promise(() => {}); }
runtime = createDeepSeekInternalRuntime(args.root, { mode: 'injected-http-test', loop: args.loop, service: offlineService(args.root), http: fake.http, authorizer: async () => args.authorization || modelAuth(),
  afterCheckpoint: async data => { if (args.phase === data.type) await stop(data.type, data); },
  afterChildCheckpoint: async data => { if (args.phase === data.type) await stop(data.type, data); },
  afterApiPhase: async (phase, detail) => { if (args.phase === phase) await stop(phase, detail); }
});
try { const result = await runtime.harness.run(args.id, args.context); process.stdout.write(JSON.stringify({ status: result.status, calls: runtime.modelApi.calls, transmissions: runtime.transport.transmissions }) + '\n'); }
catch (error) { process.stdout.write(JSON.stringify({ errorCode: error.code || 'WORKER_FAILED', calls: runtime.modelApi.calls }) + '\n'); }
