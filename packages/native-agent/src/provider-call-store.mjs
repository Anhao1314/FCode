import { DurableTaskStore, LEDGER_VERSION } from './durable-store.mjs';
import { fail } from './contracts.mjs';

export const PROVIDER_LEDGER_VERSION = 'flowcredit.provider-call-ledger/m2-v1';
export class ProviderCallStore extends DurableTaskStore {
  validateTask(record, current = null) {
    if (record.version !== PROVIDER_LEDGER_VERSION || current && current.version !== PROVIDER_LEDGER_VERSION || !Array.isArray(record.calls)) fail('MODEL_CALL_LEDGER_VERSION');
    for (const call of record.calls) {
      if (!Number.isSafeInteger(call.reservedCostMicrousd) || call.reservedCostMicrousd < 0) fail('MODEL_CALL_LEDGER_INTEGRITY');
      const before = current?.calls.find(item => item.intent.requestId === call.intent.requestId);
      if (before && before.reservedCostMicrousd !== call.reservedCostMicrousd) fail('M1_HISTORY_REWRITE');
    }
    // Reuse M1's event, intent and transition validation. Only its mock-specific
    // version/cost fields are projected; persisted/signed records remain M2.
    const project = value => {
      if (!value) return null;
      const copy = structuredClone(value); copy.version = LEDGER_VERSION;
      for (const call of copy.calls) call.reservedCostMicrousd = 0;
      return copy;
    };
    super.validateTask(project(record), project(current));
  }
}
