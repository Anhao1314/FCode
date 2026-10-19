// Closed, synthetic fixtures only. This is NOT a permission declaration for
// live issuer documents, nor a general-purpose source allowlist.
import { join } from 'node:path';
import { EvidenceAssessmentService, digest, minimaxHtml } from '../../packages/native-agent/src/baseline.mjs';
import { offlineService } from '../../packages/native-agent/src/fixtures.mjs';
import { createDeepSeekInternalRuntime } from '../../packages/native-agent/src/deepseek-runtime.mjs';
import { TrajectoryRecorder } from '../../packages/native-agent/src/trajectory-recorder.mjs';
import { fakeHttp, modelAuth } from '../../packages/native-agent/test/deepseek-fixtures.mjs';
import { fail } from '../../packages/native-agent/src/contracts.mjs';

export const CORPUS_VERSION = 'flowcredit.synthetic-policy-corpus/t1-v1';
export const FIXTURES = Object.freeze({
  financial: Object.freeze({ family: 'inherited-synthetic-financial-html', entity: 'hkex:00100', bodyHashes: Object.freeze([digest(minimaxHtml())]) }),
  empty: Object.freeze({ family: 'synthetic-empty-a', entity: 'synthetic-t1-empty-a', bodyHashes: Object.freeze([]) }),
  'empty-unseen': Object.freeze({ family: 'synthetic-empty-b', entity: 'synthetic-t1-empty-b', bodyHashes: Object.freeze([]) })
});
export function checkFixture(id, record) {
  const fixture = FIXTURES[id];
  if (!fixture || record.entity.id !== fixture.entity || digest(record.sources.map(s => s.contentHash).sort()) !== digest([...fixture.bodyHashes].sort()) || record.revision !== 1) fail('T1_SOURCE_NOT_CLEARED');
  // Empty records must be empty at the underlying observation level as well.
  if (!fixture.bodyHashes.length && (record.observations.length || record.assessment.facts.length)) fail('T1_SOURCE_NOT_CLEARED');
  return { corpus: CORPUS_VERSION, family: fixture.family, entity: fixture.entity, bodyHashes: [...fixture.bodyHashes], declaration: 'synthetic-offline-only' };
}
export async function scenario(root, { fixture = 'financial', scenarios = [], objective = 'Choose the next read-only evidence action.' } = {}) {
  if (!Object.hasOwn(FIXTURES, fixture)) fail('T1_SOURCE_NOT_CLEARED');
  const f = FIXTURES[fixture];
  const service = fixture === 'financial' ? offlineService(root) : new EvidenceAssessmentService({ root: join(root, 'evidence'), now: () => '2026-10-10T08:00:00.000Z', acquire: async () => ({ entity: { id: f.entity, name: 'Synthetic empty fixture', status: 'resolved', kind: 'company' }, sources: [], observations: [], acquisition: [], warnings: [], retainedUnmapped: [] }) });
  const created = await service.create({ target: fixture === 'financial' ? 'MiniMax' : 'Synthetic empty fixture', profile: 'public-context' }, { authorization: 'synthetic-t1-owner' });
  const context = { principal: 'synthetic-t1-researcher', authorization: 'synthetic-t1-owner', accessToken: created.assessmentAccessToken, allowedTools: ['evidence.read', 'evidence.assess'] };
  let policy = modelAuth();
  const fake = fakeHttp({ loop: true, scenarios });
  const assemble = () => {
    const runtime = createDeepSeekInternalRuntime(root, { loop: true, mode: 'injected-http-test', http: fake.http, service, authorizer: async () => structuredClone(policy) });
    const recorder = new TrajectoryRecorder({ runtime, root: join(root, 'trajectory') });
    return { runtime, recorder };
  };
  const handles = assemble();
  const loop = await handles.runtime.harness.create({ assessmentId: created.id, objective, context, modelGrant: policy.grant });
  return { root, fixture, context, loop, fake, service, ...handles, restart: assemble, setPolicy(value) { policy = value; } };
}
