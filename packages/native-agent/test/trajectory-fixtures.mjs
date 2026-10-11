import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvidenceAssessmentService } from '../src/baseline.mjs';
import { offlineService } from '../src/fixtures.mjs';
import { createDeepSeekInternalRuntime } from '../src/deepseek-runtime.mjs';
import { TrajectoryRecorder } from '../src/trajectory-recorder.mjs';
import { fakeHttp, modelAuth, GRANT } from './deepseek-fixtures.mjs';

export const scratch = fileURLToPath(new URL('../../../work/t0/', import.meta.url));
export const cases = [];
export function rights(request, changes = {}) { return { ...request, clearances: request.sources.map(source => ({ source, use: request.use, decision: 'allow', basis: 'synthetic-fixture-consent', evidenceHash: '3'.repeat(64) })), allow: true, expiresAt: Date.now() + 60000, reviewerHash: '2'.repeat(64), rightsEvidenceHash: '3'.repeat(64), privacyReviewHash: '4'.repeat(64), ...changes }; }
export async function setup(t, options = {}) {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(scratch, 'case-'));
  const service = options.empty ? new EvidenceAssessmentService({ root: join(root, 'evidence'), now: () => '2026-10-10T08:00:00.000Z', acquire: async () => ({ entity: { id: 'synthetic-empty', name: 'Empty fixture', status: 'resolved', kind: 'public-company' }, sources: [], observations: [], acquisition: [], warnings: [], retainedUnmapped: [] }) }) : offlineService(root);
  const created = await service.create({ target: 'MiniMax', profile: 'public-context' }, { authorization: 'synthetic-t0-owner' });
  const context = { principal: 't0-offline-researcher', authorization: 'synthetic-t0-owner', accessToken: created.assessmentAccessToken, allowedTools: ['evidence.read', 'evidence.assess'] };
  let auth = modelAuth(options.grant || GRANT);
  const fake = fakeHttp({ loop: true, scenarios: options.scenarios });
  const runtime = createDeepSeekInternalRuntime(root, { loop: true, mode: 'injected-http-test', http: fake.http, service, authorizer: async () => structuredClone(auth), afterApiPhase: options.afterApiPhase, afterCheckpoint: options.afterCheckpoint, beforeExecute: options.beforeExecute });
  const loop = await runtime.harness.create({ assessmentId: created.id, objective: options.objective || 'Offline T0 read and independently verify contextual evidence.', context, modelGrant: auth.grant });
  const recorder = new TrajectoryRecorder({ runtime, root: join(root, 'trajectory'), authorizeExport: Object.hasOwn(options, 'authorizeExport') ? options.authorizeExport : request => rights(request), afterPhase: options.afterRecordingPhase, afterStorePhase: options.afterRecordingStorePhase });
  t.after(async () => { let latest; try { latest = await runtime.store.load(loop.id); } catch (error) { latest = { errorCode: error.code }; } cases.push({ test: t.name, root, loopId: loop.id, status: latest.status, calls: runtime.modelApi.calls, actualExternalModelRequests: 0 }); });
  return { root, service, context, loop, fake, runtime, recorder, policy: () => structuredClone(auth), setPolicy: value => { auth = structuredClone(value); } };
}
export async function saveCases() { await writeFile(new URL('../../../validation/trajectory-cases.json', import.meta.url), JSON.stringify({ version: 'flowcredit.t0-cases/v1', generatedAt: new Date().toISOString(), cases, realCredentialsRead: false, externalModelRequests: 0, paidCalls: 0 }, null, 2) + '\n'); }
