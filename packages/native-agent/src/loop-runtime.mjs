import { join } from 'node:path';
import { DurableTaskStore } from './durable-store.mjs';
import { DurableHarness } from './durable-harness.mjs';
import { providerContract, validateProviderGrant } from './provider-model-api.mjs';
import { ProviderCallStore } from './provider-call-store.mjs';
import { BudgetStore, ModelBudgets } from './model-budgets.mjs';
import { createEvidenceTools } from './tools.mjs';
import { LoopStore } from './loop-store.mjs';
import { LOOP_POLICY, validateLoopPolicy, gateDecision } from './loop-contract.mjs';
import { OfflineLoopModelApi, createOfflineRegistry } from './offline-loop-model.mjs';
import { OfflineLoopHarness } from './loop-harness.mjs';
import { fail } from './contracts.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { digest } from './baseline.mjs';

export function createLoopRuntime(root, options = {}) {
  const registry = options.registry || createOfflineRegistry();
  if (registry.descriptor?.mode !== 'offline-mock' || registry.route('offline-loop').descriptor.mode !== 'offline-mock') fail('M4_OFFLINE_ONLY');
  return assembleLoopRuntime(root, { ...options, registry });
}
export function assembleLoopRuntime(root, { service, authorizer, registry, policy = LOOP_POLICY, hostScope = 'flowcredit-offline-loop', maxConcurrent = 1, afterCheckpoint, afterApiPhase, afterChildCheckpoint, afterBudgetPhase, beforeExecute, modelApiFactory = options => new OfflineLoopModelApi(options), callDirectory = 'calls' } = {}) {
  const trustedPolicy = validateLoopPolicy(policy);
  const store = new LoopStore(join(root, 'loops'), { witnessRoot: join(root, 'loop-witness') });
  const childStore = new DurableTaskStore(join(root, 'decisions'), { witnessRoot: join(root, 'decision-witness') });
  const ledgerStore = new ProviderCallStore(join(root, callDirectory), { witnessRoot: join(root, 'call-witness'), kind: 'model-ledger' });
  const budgetStore = new BudgetStore(join(root, 'budgets'), { witnessRoot: join(root, 'budget-witness'), kind: 'model-ledger' });
  const budgets = new ModelBudgets({ store: budgetStore, hostScope, maxConcurrent, afterPhase: afterBudgetPhase });
  const tools = createEvidenceTools({ service, beforeExecute });
  const decisionTools = Object.freeze({ ...tools, get counts() { return tools.counts; }, gate(step, context, task) { tools.gate(step, context, task); gateDecision(task, step); return tools.gate(step, context, task); } });
  const dispatchContext = new AsyncLocalStorage();
  const assertFreshDispatch = intent => { const scope = dispatchContext.getStore(); if (!scope?.held || scope.childId !== intent.taskId || scope.requestId !== intent.requestId) fail('M4_DISPATCH_CONTEXT_REQUIRED'); };
  const runWithPermit = async (loop, round, operation) => {
    const scope = { loopId: loop.id, round: round.index, childId: round.childId, requestId: round.requestId, contextHash: round.contextHash, held: true };
    try { return await dispatchContext.run(scope, operation); } finally { scope.held = false; }
  };
  const modelApi = modelApiFactory({ loopStore: store, registry, budgets, taskStore: childStore, ledgerStore, authorizer, toolCatalog: tools.catalog, afterPhase: afterApiPhase, assertFreshDispatch, currentPolicyHash: digest(trustedPolicy) });
  const contract = providerContract({ registry, budgets });
  const childHarnessFor = id => new DurableHarness({ store: childStore, modelApi, tools: decisionTools, authorizer, modelContract: contract, validateModelGrant: validateProviderGrant, taskIdFactory: () => id, afterCheckpoint: afterChildCheckpoint });
  const harness = new OfflineLoopHarness({ store, modelApi, tools, childStore, childHarnessFor, policy: trustedPolicy, authorizer, afterCheckpoint, runWithPermit });
  return { harness, modelApi, registry, store, childStore, ledgerStore, budgetStore, budgets, tools, childHarnessFor };
}
