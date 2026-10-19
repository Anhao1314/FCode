import { join } from 'node:path';
import { NativeHarness } from '../src/harness.mjs';
import { TaskStore } from '../src/task-store.mjs';
import { createModelApi } from '../src/model-api.mjs';
import { createEvidenceTools } from '../src/tools.mjs';
import { offlineService } from '../src/fixtures.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { root, id, context, crashAt = 'tool_started' } = JSON.parse(input);
globalThis.fetch = () => { throw new Error('Network forbidden'); };
const harness = new NativeHarness({
  store: new TaskStore(join(root, 'tasks')),
  modelApi: createModelApi({ responses: [] }),
  tools: createEvidenceTools({ service: offlineService(root) }),
  afterCheckpoint: ({ type, detail }) => {
    if (type === crashAt && (crashAt === 'model_started' || detail.tool === 'evidence.assess')) process.exit(86);
  }
});
await harness.run(id, context, { resume: true });
process.exit(87); // The requested crash boundary was not reached.
