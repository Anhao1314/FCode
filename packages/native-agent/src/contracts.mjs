export const PLAN_VERSION = 'flowcredit.native-plan/experimental-v1';
export const TOOL_VERSION = 'flowcredit.native-tools/experimental-v1';
export const TASK_VERSION = 'flowcredit.native-task/experimental-v1';

export class RuntimeError extends Error {
  constructor(code, { retryable = false, receipt } = {}) {
    super(code); this.code = code; this.retryable = retryable;
    if (receipt) this.receipt = receipt;
  }
}
export const fail = (code, options) => { throw new RuntimeError(code, options); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// The model supplies a proposal. Unknown tools are deliberately left for the
// independently audited execution gate, where they produce denial receipts.
export function validatePlan(value) {
  if (!exactKeys(value, ['version', 'steps']) || value.version !== PLAN_VERSION || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 6) fail('MODEL_SCHEMA_INVALID');
  const ids = new Set();
  for (const step of value.steps) {
    if (!exactKeys(step, ['id', 'tool', 'arguments']) || typeof step.id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(step.id) || ids.has(step.id) || typeof step.tool !== 'string' || !/^[a-z][a-z0-9_.]{0,63}$/.test(step.tool) || !object(step.arguments) || Buffer.byteLength(JSON.stringify(step.arguments)) > 1024) fail('MODEL_SCHEMA_INVALID');
    ids.add(step.id);
  }
  return structuredClone(value);
}
