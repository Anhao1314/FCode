import { join } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EvidenceAssessmentService } from '../src/baseline.mjs';
import { offlineService, GOOD_PLAN } from '../src/fixtures.mjs';
import { createLoopRuntime } from '../src/loop-runtime.mjs';
import { createM2Runtime } from '../src/m2-runtime.mjs';
import { ProviderModelApi } from '../src/provider-model-api.mjs';
import { createEvidenceTools } from '../src/tools.mjs';
import { createOfflineRegistry, offlineAuthorization } from '../src/offline-loop-model.mjs';
export const scratch = fileURLToPath(new URL('../../../work/m4-l0/', import.meta.url));
export const cases = [];
export async function saveCases() { await writeFile(new URL('../validation/loop-cases.json', import.meta.url), JSON.stringify({ version: 'flowcredit.m4-l0-cases/v1', generatedAt: new Date().toISOString(), cases, externalRequests: 0, paidCalls: 0, realModelCredentialsRead: false, runtimeEvidenceRetained: true }, null, 2) + '\n'); }
export async function setup(t, options = {}) {
  await mkdir(scratch, { recursive: true }); const root = await mkdtemp(join(scratch, 'case-'));
  const service = options.empty ? new EvidenceAssessmentService({ root: join(root, 'evidence'), now: () => '2026-10-10T08:00:00.000Z', acquire: async () => ({ entity: { id: 'synthetic-empty-minimax', name: 'Synthetic empty MiniMax', status: 'resolved', kind: 'public-company' }, sources: [], observations: [], acquisition: [], warnings: ['Synthetic empty fixture'], retainedUnmapped: [] }) }) : offlineService(root);
  const auth = 'synthetic-loop-evidence-owner'; const created = await service.create({ target: 'MiniMax', profile: 'public-context' }, { authorization: auth });
  const context = { principal: 'offline-loop-researcher', authorization: auth, accessToken: created.assessmentAccessToken, allowedTools: ['evidence.read', 'evidence.assess'] };
  let policy = options.authorization || offlineAuthorization();
  const registry = createOfflineRegistry({ decide: options.decide });
  const runtime = createLoopRuntime(root, { service, authorizer: async () => structuredClone(policy), registry, policy: options.loopPolicy, afterCheckpoint: options.afterCheckpoint, afterApiPhase: options.afterApiPhase, afterChildCheckpoint: options.afterChildCheckpoint, beforeExecute: options.beforeExecute });
  const loop = await runtime.harness.create({ assessmentId: created.id, objective: options.objective || 'Read and verify synthetic contextual evidence; never produce credit authority.', context, modelGrant: policy.grant });
  t.after(async () => {
    let latest; try { latest = await runtime.store.load(loop.id); } catch (error) { latest = { errorCode: error.code }; }
    cases.push({ test: t.name, root, loopId: loop.id, fixture: options.empty ? 'empty' : 'rich', calls: registry.calls, trace: registry.trace, latest });
  });
  return { root, service, context, loop, ...runtime, policy: () => structuredClone(policy), setPolicy: value => { policy = structuredClone(value); } };
}
export function fresh(s, options = {}) {
  const registry = createOfflineRegistry({ decide: options.decide });
  return createLoopRuntime(s.root, { service: offlineService(s.root), authorizer: async () => options.authorization || s.policy(), registry, policy: options.loopPolicy, afterCheckpoint: options.afterCheckpoint, afterApiPhase: options.afterApiPhase, beforeExecute: options.beforeExecute });
}
export async function staticControl(s) {
  const registry = createOfflineRegistry({ decide: () => GOOD_PLAN }); const auth = s.policy(); auth.grantId = 'static-plan-control';
  const runtime = createM2Runtime(join(s.root, 'static-control'), { registry, authorizer: async () => auth, hostScope: 'static-plan-control' });
  runtime.tools = createEvidenceTools({ service: s.service }); runtime.harness.tools = runtime.tools;
  class OfflineStaticApi extends ProviderModelApi { get transportMode() { return 'offline-mock'; } get receiptVersion() { return 'flowcredit.model-result/m4-l0-offline-static-v1'; } }
  runtime.modelApi = new OfflineStaticApi({ registry, budgets: runtime.budgets, taskStore: runtime.store, ledgerStore: runtime.ledgerStore, authorizer: async () => auth, toolCatalog: runtime.tools.catalog }); runtime.harness.modelApi = runtime.modelApi;
  const task = await runtime.harness.create({ assessmentId: s.loop.binding.assessmentId, objective: JSON.stringify({ version: 'static-plan-control/v1', observations: [] }), context: s.context, modelGrant: auth.grant });
  const result = await runtime.harness.run(task.id, s.context);
  return { status: result.status, modelCalls: registry.calls, toolCounts: runtime.tools.counts, plan: result.plan, result: result.result, goalHasFacts: result.result.assessment.facts.length > 0 };
}
