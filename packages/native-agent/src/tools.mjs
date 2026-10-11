import { digest } from './baseline.mjs';
import { TOOL_VERSION, fail, exactKeys } from './contracts.mjs';

const definitions = Object.freeze({
  'evidence.read': { effect: 'read', replaySafe: true },
  'evidence.assess': { effect: 'read', replaySafe: true }
});
export const TOOL_NAMES = Object.freeze(Object.keys(definitions));

export function bindingFor(record) {
  return {
    assessmentId: record.id, revision: record.revision,
    sourcesHash: digest(record.sources.map(({ id, contentHash }) => ({ id, contentHash })).sort((a, b) => a.id.localeCompare(b.id))),
    assessmentHash: digest(record.assessment)
  };
}
function project(tool, record) {
  const base = { assessmentId: record.id, revision: record.revision };
  if (tool === 'evidence.read') return {
    ...base, entity: record.entity,
    sources: record.sources.map(({ id, contentHash, kind }) => ({ id, contentHash, kind })),
    factIds: record.assessment.facts.map(fact => fact.id)
  };
  return { ...base, assessment: record.assessment };
}
export { project as projectEvidenceObservation };

export function createEvidenceTools({ service, beforeExecute = async () => {} }) {
  const counts = Object.fromEntries(TOOL_NAMES.map(name => [name, 0]));
  return Object.freeze({
    version: TOOL_VERSION,
    catalog: TOOL_NAMES.map(name => ({ name, version: TOOL_VERSION, arguments: {}, ...definitions[name] })),
    get counts() { return { ...counts }; },
    async inspect(assessmentId, context, expectedBinding) {
      // Never use the store's optionally authorized internal load interface.
      const record = await service.read(assessmentId, context.authorization, context.accessToken);
      const binding = bindingFor(record);
      if (expectedBinding && digest(binding) !== digest(expectedBinding)) fail('EVIDENCE_CONTEXT_CHANGED');
      return { record, binding };
    },
    gate(step, context, task) {
      if (!Object.hasOwn(definitions, step.tool)) fail('TOOL_NOT_REGISTERED');
      if (!Array.isArray(context.allowedTools) || !task.allowedTools.includes(step.tool) || !context.allowedTools.includes(step.tool)) fail('TOOL_PERMISSION_DENIED');
      // No capability, URL, assessment ID, facts, policy or filesystem path is
      // accepted from the model. The task binds all tools to one assessment.
      if (!exactKeys(step.arguments, [])) fail('TOOL_ARGUMENTS_DENIED');
      return definitions[step.tool];
    },
    async execute(step, context, task, signal) {
      this.gate(step, context, task);
      if (signal?.aborted) fail('TASK_ABORTED', { retryable: true });
      const { record } = await this.inspect(task.binding.assessmentId, context, task.binding);
      counts[step.tool] += 1;
      await beforeExecute({ step: structuredClone(step), taskId: task.id });
      if (signal?.aborted) fail('TASK_ABORTED', { retryable: true });
      return project(step.tool, record);
    },
    async verify(task, context) {
      const { record } = await this.inspect(task.binding.assessmentId, context, task.binding);
      if (!TOOL_NAMES.every(name => task.steps.some(step => step.tool === name && step.status === 'succeeded'))) fail('RESULT_INCOMPLETE');
      for (const step of task.steps) {
        this.gate(step, context, task);
        if (step.status !== 'succeeded' || step.resultHash !== digest(step.result) || step.resultHash !== digest(project(step.tool, record))) fail('RESULT_VERIFICATION_FAILED');
      }
      const assessment = record.assessment;
      if (assessment.TAI !== null || assessment.CCI !== null || assessment.riskGrade !== null || assessment.vetoApplied !== false || assessment.deterministicRisk !== null || assessment.authorityPolicy.riskEligibleFactIds.length !== 0) fail('RESULT_AUTHORITY_VIOLATION');
      return {
        assessmentId: record.id, revision: record.revision,
        assessment, assessmentHash: digest(assessment),
        verification: 'runtime-recomputed',
        dataKind: 'synthetic-offline-fixture'
      };
    }
  });
}
