import { digest } from './baseline.mjs';
import { TOOL_VERSION, fail } from './contracts.mjs';
import { TOOL_NAMES, createEvidenceTools } from './tools.mjs';

export const OBSERVABLE_PROJECTION = 'flowcredit.observation-projection/m5-v1';

// The accepted M1 projection returns factIds only, so a model can count facts but
// cannot read one. These fields are the smallest set that still supports a
// conclusion: what was measured, how much, in what unit, over what period, under
// what scope and basis, whether it is supported, and which sources back it.
// The nested authority / binding / observationDecisions blocks are deliberately
// excluded: they are audit material for the Runtime, not reasoning material for
// the model, and they made a single fact roughly 2 KB.
const FACT_FIELDS = Object.freeze(['id', 'metric', 'value', 'unit', 'period', 'scope', 'basis', 'status', 'sourceIds']);
const factValue = (fact, field) => field === 'sourceIds' ? [...(fact.sourceIds || [])] : field === 'period' ? structuredClone(fact.period ?? null) : fact[field] ?? null;
export const summarizeFact = fact => Object.fromEntries(FACT_FIELDS.map(field => [field, factValue(fact, field)]));

export function projectObservable(tool, record) {
  const base = { assessmentId: record.id, revision: record.revision };
  if (tool === 'evidence.read') return {
    ...base, entity: record.entity,
    sources: record.sources.map(({ id, contentHash, kind }) => ({ id, contentHash, kind })),
    factIds: record.assessment.facts.map(fact => fact.id),
    facts: record.assessment.facts.map(summarizeFact)
  };
  return { ...base, assessment: record.assessment };
}

// Same gates, same verification and same authority assertions as the accepted
// tools. Only the observation payload differs, so M1/M2/M4 keep their contracts
// and the frozen research gates keep using the original module unchanged.
export function createObservableEvidenceTools({ service, beforeExecute = async () => {} }) {
  const base = createEvidenceTools({ service, beforeExecute });
  const counts = Object.fromEntries(TOOL_NAMES.map(name => [name, 0]));
  return Object.freeze({
    version: TOOL_VERSION,
    projection: OBSERVABLE_PROJECTION,
    catalog: base.catalog.map(entry => ({ ...entry, projection: OBSERVABLE_PROJECTION })),
    get counts() { return { ...counts }; },
    inspect: (assessmentId, context, binding) => base.inspect(assessmentId, context, binding),
    gate: (step, context, task) => base.gate(step, context, task),
    async execute(step, context, task, signal) {
      base.gate(step, context, task);
      if (signal?.aborted) fail('TASK_ABORTED', { retryable: true });
      const { record } = await base.inspect(task.binding.assessmentId, context, task.binding);
      counts[step.tool] += 1;
      await beforeExecute({ step: structuredClone(step), taskId: task.id });
      if (signal?.aborted) fail('TASK_ABORTED', { retryable: true });
      return projectObservable(step.tool, record);
    },
    async verify(task, context) {
      const { record } = await base.inspect(task.binding.assessmentId, context, task.binding);
      if (!TOOL_NAMES.every(name => task.steps.some(step => step.tool === name && step.status === 'succeeded'))) fail('RESULT_INCOMPLETE');
      for (const step of task.steps) {
        base.gate(step, context, task);
        if (step.status !== 'succeeded' || step.resultHash !== digest(step.result) || step.resultHash !== digest(projectObservable(step.tool, record))) fail('RESULT_VERIFICATION_FAILED');
      }
      const assessment = record.assessment;
      if (assessment.TAI !== null || assessment.CCI !== null || assessment.riskGrade !== null || assessment.vetoApplied !== false || assessment.deterministicRisk !== null || assessment.authorityPolicy.riskEligibleFactIds.length !== 0) fail('RESULT_AUTHORITY_VIOLATION');
      return { assessmentId: record.id, revision: record.revision, assessment, assessmentHash: digest(assessment), verification: 'runtime-recomputed', dataKind: 'synthetic-offline-fixture' };
    }
  });
}
