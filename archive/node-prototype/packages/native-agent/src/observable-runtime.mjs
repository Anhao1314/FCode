import { join } from 'node:path';
import { RecoveringDurableTaskStore } from './recovery-store.mjs';
import { DurableModelApi } from './durable-model-api.mjs';
import { DurableHarness } from './durable-harness.mjs';
import { createModelApi } from './model-api.mjs';
import { createObservableEvidenceTools } from './observable-tools.mjs';
import { offlineService, GOOD_PLAN } from './fixtures.mjs';
import { MOCK_AUTHORIZATION } from './m1-runtime.mjs';

// Assembly only. Every contract it wires is an accepted M1/M5 module: the
// recovering store adds repair and a verified cache, the observable tools add a
// compact fact projection. Neither reimplements authority, budgets or receipts.
export function createObservableRuntime(root, {
  responses = [GOOD_PLAN], authorizer = async () => structuredClone(MOCK_AUTHORIZATION),
  service, afterApiPhase, afterTaskPhase, afterLedgerPhase, afterCheckpoint, beforeExecute
} = {}) {
  const store = new RecoveringDurableTaskStore(join(root, 'tasks'), { witnessRoot: join(root, 'task-witness'), afterPhase: afterTaskPhase });
  const ledgerStore = new RecoveringDurableTaskStore(join(root, 'model-calls'), { witnessRoot: join(root, 'call-witness'), kind: 'model-ledger', afterPhase: afterLedgerPhase });
  const adapter = createModelApi({ responses });
  const modelApi = new DurableModelApi({ taskStore: store, ledgerStore, adapter, authorizer, afterPhase: afterApiPhase });
  const tools = createObservableEvidenceTools({ service: service || offlineService(root), beforeExecute });
  return { store, ledgerStore, modelApi, adapter, tools, harness: new DurableHarness({ store, modelApi, tools, authorizer, afterCheckpoint }) };
}
