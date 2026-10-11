import { join } from 'node:path';
import { DurableTaskStore } from './durable-store.mjs';
import { DurableHarness } from './durable-harness.mjs';
import { ProviderModelApi, providerContract, validateProviderGrant } from './provider-model-api.mjs';
import { BudgetStore, ModelBudgets } from './model-budgets.mjs';
import { createEvidenceTools } from './tools.mjs';
import { offlineService } from './fixtures.mjs';
import { ProviderCallStore } from './provider-call-store.mjs';

export function createM2Runtime(root, {
  registry, authorizer, hostScope = 'flowcredit-m2-injected-host', maxConcurrent = 1,
  afterApiPhase, afterBudgetPhase, afterTaskPhase, afterLedgerPhase, afterBudgetStorePhase,
  afterCheckpoint, beforeExecute, service = offlineService(root)
} = {}) {
  const store = new DurableTaskStore(join(root, 'tasks'), { witnessRoot: join(root, 'task-witness'), afterPhase: afterTaskPhase });
  const ledgerStore = new ProviderCallStore(join(root, 'model-calls'), { witnessRoot: join(root, 'call-witness'), kind: 'model-ledger', afterPhase: afterLedgerPhase });
  const budgetStore = new BudgetStore(join(root, 'budgets'), { witnessRoot: join(root, 'budget-witness'), kind: 'model-ledger', afterPhase: afterBudgetStorePhase });
  const budgets = new ModelBudgets({ store: budgetStore, hostScope, maxConcurrent, afterPhase: afterBudgetPhase });
  const tools = createEvidenceTools({ service, beforeExecute });
  const modelApi = new ProviderModelApi({ registry, budgets, taskStore: store, ledgerStore, authorizer, toolCatalog: tools.catalog, afterPhase: afterApiPhase });
  const contract = providerContract({ registry, budgets });
  const harness = new DurableHarness({ store, modelApi, tools, authorizer, afterCheckpoint, modelContract: contract, validateModelGrant: validateProviderGrant });
  return { store, ledgerStore, budgetStore, budgets, tools, registry, modelApi, harness };
}
