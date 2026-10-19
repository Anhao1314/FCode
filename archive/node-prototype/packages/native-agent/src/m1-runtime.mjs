import { join } from 'node:path';
import { DurableTaskStore } from './durable-store.mjs';
import { DurableModelApi, AUTHORIZATION_VERSION } from './durable-model-api.mjs';
import { DurableHarness } from './durable-harness.mjs';
import { createModelApi } from './model-api.mjs';
import { createEvidenceTools } from './tools.mjs';
import { offlineService, MODEL_GRANT, GOOD_PLAN } from './fixtures.mjs';

export const MOCK_AUTHORIZATION = Object.freeze({ version: AUTHORIZATION_VERSION, grantId: 'mock-research-m1', revision: 1, grant: MODEL_GRANT });
// Explicit trusted operator-owned policy, always mock-only. This fixture does
// not read, discover or migrate any real model or Evidence credentials.
export function createM1Runtime(root, {
  responses = [GOOD_PLAN], authorizer = async () => structuredClone(MOCK_AUTHORIZATION),
  afterApiPhase, afterTaskPhase, afterLedgerPhase, afterCheckpoint, beforeExecute
} = {}) {
  const store = new DurableTaskStore(join(root, 'tasks'), { witnessRoot: join(root, 'task-witness'), afterPhase: afterTaskPhase });
  const ledgerStore = new DurableTaskStore(join(root, 'model-calls'), { witnessRoot: join(root, 'call-witness'), kind: 'model-ledger', afterPhase: afterLedgerPhase });
  const adapter = createModelApi({ responses });
  const modelApi = new DurableModelApi({ taskStore: store, ledgerStore, adapter, authorizer, afterPhase: afterApiPhase });
  const tools = createEvidenceTools({ service: offlineService(root), beforeExecute });
  return { store, ledgerStore, modelApi, adapter, tools, harness: new DurableHarness({ store, modelApi, tools, authorizer, afterCheckpoint }) };
}
