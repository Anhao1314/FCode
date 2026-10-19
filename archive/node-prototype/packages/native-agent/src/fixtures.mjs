import { join } from 'node:path';
import { EvidenceAssessmentService, acquirePublicEvidence, minimaxHtml } from './baseline.mjs';
import { PLAN_VERSION } from './contracts.mjs';
import { TOOL_NAMES } from './tools.mjs';

export const MODEL_GRANT = Object.freeze({ allowedAdapters: ['mock'], maxCalls: 1, allowPaid: false, maxCostMicrousd: 0 });
export const GOOD_PLAN = Object.freeze({ version: PLAN_VERSION, steps: [
  { id: 'inspect', tool: 'evidence.read', arguments: {} },
  { id: 'calculate', tool: 'evidence.assess', arguments: {} }
] });

// Existing registered extractor and deterministic arithmetic are exercised
// against explicitly synthetic HTML. Neither this fixture nor its results
// assert that a live public or private source was acquired in this round.
export function offlineService(root) {
  return new EvidenceAssessmentService({
    root: join(root, 'evidence'), now: () => '2026-10-10T08:00:00.000Z',
    acquire: target => acquirePublicEvidence(target, {
      now: () => new Date('2026-10-10T08:00:00.000Z'),
      fetchImpl: async () => new Response(minimaxHtml(), { headers: { 'content-type': 'text/html' } })
    })
  });
}
export async function seedFixture(root) {
  const service = offlineService(root);
  const authorization = 'synthetic-offline-owner-credential';
  const created = await service.create({ target: 'MiniMax', profile: 'public-context' }, { authorization });
  return {
    service, assessmentId: created.id,
    context: { principal: 'offline-researcher', authorization, accessToken: created.assessmentAccessToken, allowedTools: [...TOOL_NAMES] }
  };
}
