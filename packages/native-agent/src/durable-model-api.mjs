import { mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { digest, stable } from './baseline.mjs';
import { PLAN_VERSION, RuntimeError, fail, exactKeys, validatePlan } from './contracts.mjs';
import { LEDGER_VERSION } from './durable-store.mjs';
import { publishBytes, privateBytes } from './durable-io.mjs';

export const INTENT_VERSION = 'flowcredit.model-intent/m1-v1';
export const RECEIPT_VERSION = 'flowcredit.model-result/m1-v1';
export const AUTHORIZATION_VERSION = 'flowcredit.model-authorization/m1-v1';
const INTENT_KEYS = ['version', 'requestId', 'taskId', 'principalHash', 'purpose', 'contractVersion', 'adapter', 'model', 'promptHash', 'bindingHash', 'toolPolicyHash', 'authorizationHash', 'grantId', 'grantHash', 'quotaScope'];
const VALID_HASH = /^[a-f0-9]{64}$/;
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);

export function validateAuthorization(value) {
  if (!exactKeys(value, ['version', 'grantId', 'revision', 'grant']) || value.version !== AUTHORIZATION_VERSION || !validId(value.grantId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !exactKeys(value.grant, ['allowedAdapters', 'maxCalls', 'allowPaid', 'maxCostMicrousd']) || !Array.isArray(value.grant.allowedAdapters) || value.grant.allowedAdapters.some(item => item !== 'mock') || value.grant.allowPaid !== false || value.grant.maxCostMicrousd !== 0 || !Number.isSafeInteger(value.grant.maxCalls) || value.grant.maxCalls < 0 || value.grant.maxCalls > 2) fail('MODEL_CURRENT_AUTHORIZATION_DENIED');
  return structuredClone(value);
}
export function makeIntent(task, prompt, authorization) {
  return {
    version: INTENT_VERSION, requestId: `${task.id}:plan:1`, taskId: task.id,
    principalHash: task.principalHash, purpose: 'plan', contractVersion: PLAN_VERSION,
    adapter: 'mock', model: 'flowcredit-native-mock', promptHash: digest(prompt),
    bindingHash: digest(task.binding), toolPolicyHash: digest([task.allowedTools, task.toolVersion]),
    authorizationHash: digest(authorization), grantId: authorization.grantId,
    grantHash: digest(authorization.grant),
    quotaScope: `${task.principalHash}:${task.id}:${authorization.grantId}`
  };
}

// This interface is trusted in-process infrastructure. Current authorization is
// supplied by an operator-owned callback; caller priorCalls is never a budget.
export class DurableModelApi {
  constructor({ taskStore, ledgerStore, adapter, authorizer, afterPhase = async () => {}, validateAdapter = value => value?.descriptor?.adapter === 'mock' }) {
    if (ledgerStore.kind !== 'model-ledger' || typeof authorizer !== 'function' || !validateAdapter(adapter)) fail('M1_CONFIGURATION');
    this.taskStore = taskStore; this.ledgerStore = ledgerStore;
    this.adapter = adapter; this.authorizer = authorizer; this.afterPhase = afterPhase;
  }
  get calls() { return this.adapter.calls; }
  async reserveResources() {}
  async markDispatched() {}
  async dispatch(intent, prompt, authorization, signal, priorCalls) {
    return this.adapter.plan({ requestId: intent.requestId, taskId: intent.taskId, principalHash: intent.principalHash, prompt, grant: authorization.grant, priorCalls, signal });
  }
  async confirmResources() {}
  newLedger(intent, id) { return { id, sequence: 0, version: LEDGER_VERSION, scope: intent.quotaScope, principalHash: intent.principalHash, grantHash: intent.grantHash, calls: [], events: [] }; }
  callReservation() { return { reservedCalls: 1, reservedCostMicrousd: 0 }; }
  scopeId(intent) { return `task-${digest(intent.quotaScope).slice(0, 32)}`; }
  async validateIntent(intent, prompt) {
    if (!exactKeys(intent, INTENT_KEYS) || intent.version !== INTENT_VERSION || !/^task-[a-f0-9]{32}$/.test(intent.taskId) || intent.requestId !== `${intent.taskId}:plan:1` || intent.purpose !== 'plan' || intent.contractVersion !== PLAN_VERSION || intent.adapter !== 'mock' || intent.model !== this.adapter.descriptor.model || !['principalHash', 'promptHash', 'bindingHash', 'toolPolicyHash', 'authorizationHash', 'grantHash'].every(key => typeof intent[key] === 'string' && VALID_HASH.test(intent[key]))) fail('MODEL_INTENT_MISMATCH');
    const task = await this.taskStore.load(intent.taskId);
    const authorization = validateAuthorization(await this.authorizer({ taskId: task.id, principalHash: task.principalHash, binding: task.binding }));
    if (!authorization.grant.allowedAdapters.includes('mock') || authorization.grant.maxCalls < task.model.attempts || digest(authorization) !== intent.authorizationHash || digest(task.modelGrant) !== intent.grantHash || digest(authorization.grant) !== intent.grantHash || task.principalHash !== intent.principalHash || stable(task.model.intent) !== stable(intent) || task.model.attempts !== 1 || digest(task.binding) !== intent.bindingHash || digest([task.allowedTools, task.toolVersion]) !== intent.toolPolicyHash || authorization.grantId !== intent.grantId || intent.quotaScope !== `${task.principalHash}:${task.id}:${authorization.grantId}`) fail('MODEL_CURRENT_AUTHORIZATION_DENIED');
    if (prompt !== undefined && (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 100 * 1024 || digest(prompt) !== intent.promptHash)) fail('MODEL_INTENT_MISMATCH');
    return { task, authorization };
  }
  async event(ledger, type, detail) {
    const data = { sequence: ledger.events.length + 1, type, detail, at: new Date().toISOString(), previousHash: ledger.events.at(-1)?.hash || null };
    ledger.events.push({ ...data, hash: digest(data) });
    const previous = ledger.sequence; ledger.sequence += 1;
    await this.ledgerStore.save(ledger, previous);
  }
  async receiptRef(intent) { return digest([await this.ledgerStore.storeId(), intent]); }
  async readReceipt(ref, intent) {
    if (typeof ref !== 'string' || !VALID_HASH.test(ref)) fail('MODEL_RECEIPT_REQUIRED');
    if (ref !== await this.receiptRef(intent)) fail('MODEL_RECEIPT_MISMATCH');
    let receipt;
    try { receipt = await this.ledgerStore.unseal(await privateBytes(join(this.ledgerStore.root, 'receipts', `${ref}.json`))); }
    catch (error) { fail(error.code === 'M1_RECORD_MISSING' ? 'MODEL_RECEIPT_REQUIRED' : 'MODEL_RECEIPT_UNTRUSTED'); }
    if (!exactKeys(receipt, ['version', 'issuer', 'intent', 'intentHash', 'status', 'plan', 'planHash', 'adapterReceipt', 'charge']) || receipt.version !== RECEIPT_VERSION || receipt.issuer !== await this.ledgerStore.storeId() || receipt.intentHash !== digest(intent) || stable(receipt.intent) !== stable(intent) || !['confirmed-valid', 'confirmed-invalid'].includes(receipt.status) || !exactKeys(receipt.charge, ['kind', 'costMicrousd', 'usage', 'externalBilling']) || receipt.charge.kind !== 'mock' || receipt.charge.costMicrousd !== 0 || receipt.charge.externalBilling !== 'not-verified') fail('MODEL_RECEIPT_MISMATCH');
    if (receipt.adapterReceipt?.requestId !== intent.requestId || receipt.adapterReceipt?.taskId !== intent.taskId || receipt.adapterReceipt?.principalHash !== intent.principalHash || receipt.adapterReceipt?.promptHash !== intent.promptHash || receipt.adapterReceipt?.contractVersion !== intent.contractVersion || receipt.adapterReceipt?.adapter !== intent.adapter || receipt.adapterReceipt?.model !== intent.model || !VALID_HASH.test(receipt.adapterReceipt?.responseHash || '')) fail('MODEL_RECEIPT_MISMATCH');
    if (receipt.status === 'confirmed-valid') {
      validatePlan(receipt.plan);
      if (receipt.adapterReceipt.status !== 'validated' || receipt.planHash !== digest(receipt.plan)) fail('MODEL_RECEIPT_MISMATCH');
    } else if (receipt.plan !== null || receipt.planHash !== null || receipt.adapterReceipt.status !== 'failed' || !['MODEL_SCHEMA_INVALID', 'MODEL_OUTPUT_INVALID'].includes(receipt.adapterReceipt.errorCode)) fail('MODEL_RECEIPT_MISMATCH');
    return receipt;
  }
  async writeReceipt(intent, generated, invalid) {
    const adapterReceipt = generated.receipt;
    if (adapterReceipt?.requestId !== intent.requestId || adapterReceipt?.taskId !== intent.taskId || adapterReceipt?.principalHash !== intent.principalHash || adapterReceipt?.promptHash !== intent.promptHash || adapterReceipt?.contractVersion !== intent.contractVersion || adapterReceipt?.adapter !== intent.adapter || adapterReceipt?.model !== intent.model || !VALID_HASH.test(adapterReceipt?.responseHash || '') || adapterReceipt.status !== (invalid ? 'failed' : 'validated')) fail('MODEL_ADAPTER_RECEIPT_INVALID');
    const receipt = {
      version: RECEIPT_VERSION, issuer: await this.ledgerStore.storeId(), intent,
      intentHash: digest(intent), status: invalid ? 'confirmed-invalid' : 'confirmed-valid',
      plan: invalid ? null : validatePlan(generated.plan), planHash: invalid ? null : digest(generated.plan),
      adapterReceipt: generated.receipt,
      charge: { kind: 'mock', costMicrousd: 0, usage: generated.receipt.usage, externalBilling: 'not-verified' }
    };
    const ref = await this.receiptRef(intent);
    const directory = join(this.ledgerStore.root, 'receipts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await publishBytes(join(directory, `${ref}.json`), JSON.stringify(await this.ledgerStore.seal(receipt)), { immutable: true });
    await this.afterPhase('receipt_persisted', { intent, receiptRef: ref });
    return { receipt, receiptRef: ref };
  }
  async execute({ intent, prompt, signal } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) fail('MODEL_INTENT_MISMATCH');
    return this.taskStore.exclusive(intent?.taskId, async () => {
    const { task, authorization } = await this.validateIntent(intent, prompt);
    const freshDispatch = task.status === 'planning' && task.model.status === 'started';
    const id = this.scopeId(intent);
    return this.ledgerStore.exclusive(id, async () => {
      let ledger;
      try { ledger = await this.ledgerStore.load(id); }
      catch (error) {
        if (error.code !== 'TASK_NOT_FOUND') throw error;
        if (!freshDispatch) fail('MODEL_RECONCILIATION_BLOCKED');
        ledger = this.newLedger(intent, id);
        await this.ledgerStore.create(ledger);
      }
      if (ledger.scope !== intent.quotaScope || ledger.principalHash !== intent.principalHash || ledger.grantHash !== intent.grantHash) fail('MODEL_INTENT_MISMATCH');
      let call = ledger.calls.find(item => item.intent.requestId === intent.requestId);
      if (call) {
        if (stable(call.intent) !== stable(intent)) fail('MODEL_INTENT_MISMATCH');
        if (call.status === 'confirmed') {
          const cached = await this.readReceipt(call.receiptRef, intent);
          await this.confirmResources(intent, call.receiptRef, cached);
          return { ...cached, receiptRef: call.receiptRef };
        }
        // Even a reserved-but-not-dispatched recovered intent is not resent.
        // Repeating the same request never starts another provider invocation.
        if (call.status !== 'unknown') {
          call.status = 'unknown'; call.errorCode = 'MODEL_OUTCOME_UNKNOWN';
          await this.event(ledger, 'call_unknown', { requestId: intent.requestId, errorCode: call.errorCode });
        }
        throw new RuntimeError('MODEL_OUTCOME_UNKNOWN');
      }
      if (ledger.calls.length >= authorization.grant.maxCalls) fail('MODEL_CALL_QUOTA');
      if (!freshDispatch) fail('MODEL_RECONCILIATION_BLOCKED');
      await this.reserveResources(intent, prompt, authorization);
      call = { intent: structuredClone(intent), status: 'reserved', ...this.callReservation(intent, prompt, authorization), receiptRef: null, errorCode: null };
      ledger.calls.push(call);
      await this.event(ledger, 'call_reserved', { requestId: intent.requestId, intentHash: digest(intent), reservedCalls: ledger.calls.length });
      await this.afterPhase('intent_persisted', { intent });
      call.status = 'dispatched';
      await this.event(ledger, 'call_dispatched', { requestId: intent.requestId });
      await this.markDispatched(intent);
      await this.afterPhase('dispatch_persisted', { intent });
      let generated, invalid = false;
      try {
        generated = await this.dispatch(intent, prompt, authorization, signal, ledger.calls.length - 1);
      } catch (error) {
        // Only a fully received, hashed inner response establishes a confirmed
        // invalid result. Timeout/abort/HTTP/opaque transport failures do not.
        if (error.receipt?.responseHash && ['MODEL_OUTPUT_INVALID', 'MODEL_SCHEMA_INVALID'].includes(error.code)) { generated = { receipt: error.receipt, plan: null }; invalid = true; }
        else {
          call.status = 'unknown'; call.errorCode = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'MODEL_TRANSPORT_UNCERTAIN';
          await this.event(ledger, 'call_unknown', { requestId: intent.requestId, errorCode: call.errorCode });
          throw new RuntimeError('MODEL_OUTCOME_UNKNOWN');
        }
      }
      // Local publication errors are outside the transport catch: no confirmed
      // response is reclassified as a safely retryable model failure.
      await this.afterPhase('adapter_returned', { intent });
      const result = await this.writeReceipt(intent, generated, invalid);
      await this.confirmResources(intent, result.receiptRef, result.receipt);
      call.status = 'confirmed'; call.receiptRef = result.receiptRef;
      await this.event(ledger, 'call_confirmed', { requestId: intent.requestId, receiptRef: result.receiptRef, outcome: result.receipt.status });
      await this.afterPhase('ledger_confirmed', { intent, receiptRef: result.receiptRef });
      return { ...result.receipt, receiptRef: result.receiptRef };
    });
    });
  }
  async status(intent) {
    await this.validateIntent(intent);
    const id = this.scopeId(intent);
    let ledger;
    try { ledger = await this.ledgerStore.load(id); }
    catch (error) { if (error.code === 'TASK_NOT_FOUND') return { status: 'unknown', receiptRef: null, reservedCalls: 0 }; throw error; }
    const call = ledger.calls.find(item => stable(item.intent) === stable(intent));
    if (!call) fail('MODEL_INTENT_MISMATCH');
    const ref = await this.receiptRef(intent);
    const present = await lstat(join(this.ledgerStore.root, 'receipts', `${ref}.json`)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (present) await this.readReceipt(ref, intent);
    return { status: call.status, receiptRef: present ? ref : null, reservedCalls: ledger.calls.length };
  }
  async reconcile(intent, ref) {
    return this.taskStore.exclusive(intent?.taskId, async () => {
    await this.validateIntent(intent);
    const receipt = await this.readReceipt(ref, intent);
    const id = this.scopeId(intent);
    return this.ledgerStore.exclusive(id, async () => {
      const ledger = await this.ledgerStore.load(id);
      const call = ledger.calls.find(item => stable(item.intent) === stable(intent));
      if (!call || !['dispatched', 'unknown', 'confirmed'].includes(call.status)) fail('MODEL_RECONCILIATION_BLOCKED');
      if (call.status === 'confirmed') {
        if (call.receiptRef !== ref) fail('MODEL_RECEIPT_MISMATCH');
        await this.confirmResources(intent, ref, receipt);
        return { ...receipt, receiptRef: ref };
      }
      await this.confirmResources(intent, ref, receipt);
      call.status = 'confirmed'; call.receiptRef = ref;
      await this.event(ledger, 'call_reconciled', { requestId: intent.requestId, receiptRef: ref, outcome: receipt.status });
      return { ...receipt, receiptRef: ref };
    });
    });
  }
}
