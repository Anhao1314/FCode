// Research-only ONE-decision executor. No production Harness/Model API override.
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { DurableTaskStore } from '../../packages/native-agent/src/durable-store.mjs';
import { BudgetStore, ModelBudgets } from '../../packages/native-agent/src/model-budgets.mjs';
import { privateBytes, publishBytes } from '../../packages/native-agent/src/durable-io.mjs';
import { privateDirectory } from '../../packages/native-agent/src/trajectory-store.mjs';
import { digest, stable } from '../../packages/native-agent/src/baseline.mjs';
import { exactKeys, fail } from '../../packages/native-agent/src/contracts.mjs';
import { corpus, observation, gate, validateAction, execute, ACTIONS, READING, VERSION } from './environment.mjs';

const hash = h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
const STATES = ['created', 'pending', 'ready', 'action-started', 'unknown', 'finished', 'denied'];
const keys = ['id', 'version', 'sequence', 'events', 'caseId', 'strategy', 'caseHash', 'corpusHash', 'observationHash', 'principalHash', 'authorizationHash', 'hostPolicy', 'status', 'intent', 'proposalRef', 'actionRef', 'result', 'resultHash', 'error'];
class ResearchStore extends DurableTaskStore {
  validateTask(r, current = null) {
    if (!exactKeys(r, keys) || r.version !== VERSION || !/^task-[a-f0-9]{32}$/.test(r.id) || !STATES.includes(r.status) || r.sequence !== r.events?.length || !['caseHash', 'corpusHash', 'observationHash', 'principalHash', 'authorizationHash'].every(k => hash(r[k]))) fail('T2_RECORD_INTEGRITY');
    let previous = null;
    for (const [index, event] of r.events.entries()) { const { hash: h, ...e } = event; if (e.sequence !== index + 1 || e.previousHash !== previous || digest(e) !== h) fail('T2_EVENT_INTEGRITY'); previous = h; }
    if (digest(r.hostPolicy) !== r.authorizationHash || r.result !== null && digest(r.result) !== r.resultHash || r.status === 'finished' && (!r.proposalRef || !r.actionRef || !r.result)) fail('T2_RESULT_UNCONFIRMED');
    if (current) {
      for (const k of ['id', 'version', 'caseId', 'strategy', 'caseHash', 'corpusHash', 'observationHash', 'principalHash', 'authorizationHash', 'hostPolicy']) if (stable(r[k]) !== stable(current[k])) fail('T2_BINDING_REWRITE');
      for (const k of ['intent', 'proposalRef', 'actionRef', 'result', 'resultHash']) if (current[k] !== null && stable(r[k]) !== stable(current[k])) fail('T2_HISTORY_REWRITE');
      if (r.sequence !== current.sequence + 1 || stable(r.events.slice(0, -1)) !== stable(current.events) || ['finished', 'denied'].includes(current.status)) fail('T2_HISTORY_REWRITE');
      const transitions = { created: ['pending'], pending: ['unknown', 'ready', 'denied'], ready: ['action-started', 'denied'], 'action-started': ['unknown', 'finished', 'denied'], unknown: ['ready', 'finished', 'denied'] };
      if (!transitions[current.status]?.includes(r.status)) fail('T2_STATE_TRANSITION');
    }
  }
}
const safeCode = e => /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code || '') ? e.code : 'T2_EXECUTION_UNCERTAIN';
export class BenchmarkExecutor {
  constructor(root, { host = {}, afterPhase = async () => {} } = {}) {
    this.root = root; this.afterPhase = afterPhase;
    this.host = { principal: 't2-local-researcher', revision: 1, enabled: true, allowedActions: [...ACTIONS], maxCalls: 48, maxReads: 48, ...structuredClone(host) };
    this.store = new ResearchStore(join(root, 'research-records'), { witnessRoot: join(root, 'research-witness'), kind: 'model-ledger' });
    const budgetStore = new BudgetStore(join(root, 'budgets'), { witnessRoot: join(root, 'budget-witness'), kind: 'model-ledger' });
    this.budgets = new ModelBudgets({ store: budgetStore, hostScope: 't2-offline-proposals', maxConcurrent: 1 });
    this.readBudgets = new ModelBudgets({ store: budgetStore, hostScope: 't2-offline-document-reads', maxConcurrent: 1 });
    this.calls = 0; this.executions = 0;
  }
  policy() {
    const h = structuredClone(this.host);
    if (!h.enabled || !Number.isSafeInteger(h.maxCalls) || h.maxCalls < 1 || h.maxCalls > 1000 || !Number.isSafeInteger(h.maxReads) || h.maxReads < 0 || h.maxReads > 1000 || !Number.isInteger(h.revision) || h.revision < 1 || !Array.isArray(h.allowedActions) || h.allowedActions.some(a => !ACTIONS.includes(a))) fail('T2_HOST_DENIED');
    return h;
  }
  async authorize(record, context) {
    const host = this.policy(), { data, fingerprint } = await corpus(), task = data.cases.find(t => t.id === record.caseId);
    if (context?.principal !== host.principal || digest(context?.principal) !== record.principalHash) fail('T2_OWNER_DENIED');
    if (digest(host) !== record.authorizationHash) fail('T2_AUTHORIZATION_CHANGED');
    if (!task || record.corpusHash !== fingerprint || record.caseHash !== digest(task) || record.observationHash !== digest(observation(task, host))) fail('T2_EVIDENCE_CHANGED');
    if (record.intent && stable(record.intent) !== stable(this.makeIntent(record, host, task))) fail('T2_INTENT_MISMATCH');
    if (digest(this.policy()) !== record.authorizationHash) fail('T2_AUTHORIZATION_CHANGED');
    return { host, task };
  }
  async create(caseId, strategy, context) {
    const host = this.policy(), { data, fingerprint } = await corpus(), task = data.cases.find(t => t.id === caseId);
    if (!task || !/^[a-z][a-zA-Z0-9-]{0,40}$/.test(strategy) || context?.principal !== host.principal) fail('T2_CREATE_DENIED');
    await privateDirectory(this.root); await this.store.initialize();
    const id = `task-${digest([VERSION, fingerprint, caseId, strategy, host.principal]).slice(0, 32)}`;
    return this.store.exclusive(id, async () => {
      try { const old = await this.store.load(id); await this.authorize(old, context); return old; } catch (e) { if (e.code !== 'TASK_NOT_FOUND') throw e; }
      const record = { id, version: VERSION, sequence: 0, events: [], caseId, strategy, caseHash: digest(task), corpusHash: fingerprint, observationHash: digest(observation(task, host)), principalHash: digest(host.principal), authorizationHash: digest(host), hostPolicy: host, status: 'created', intent: null, proposalRef: null, actionRef: null, result: null, resultHash: null, error: null };
      await this.store.create(record); return record;
    });
  }
  async checkpoint(r, type) {
    const e = { sequence: r.sequence + 1, at: new Date().toISOString(), type, status: r.status, previousHash: r.events.at(-1)?.hash || null };
    const previous = r.sequence; r.sequence++; r.events.push({ ...e, hash: digest(e) }); await this.store.save(r, previous);
  }
  grant(host, read = false) {
    const n = read ? host.maxReads : host.maxCalls;
    return { grant: { maxCalls: n, maxTotalTokens: n * 13000, maxCostMicrousd: 0, maxConcurrent: 1 } };
  }
  bounds(o, read = false) { return { totalTokenReservation: read ? 1 : Buffer.byteLength(stable(o)) + 128, costReservationMicrousd: 0 }; }
  makeIntent(r, host, task) { return { version: 'flowcredit.benchmark-intent/t2-a-v1', requestId: `${r.id}:decision:1`, taskId: r.id, principalHash: r.principalHash, grantId: 't2-synthetic-proposals', grantHash: digest(this.grant(host).grant), routeId: 'offline-scripted-strategy', pricingHash: digest('synthetic-zero-charge'), observationHash: r.observationHash, bindingHash: r.caseHash, authorizationHash: r.authorizationHash, toolPolicyHash: digest([ACTIONS, observation(task, host).permissions]), hostPolicyHash: digest(host), boundsHash: digest(this.bounds(observation(task, host))), contractVersion: VERSION }; }
  readIntent(r, action) { return { ...r.intent, requestId: `${r.id}:read:1`, grantId: 't2-synthetic-reads', grantHash: digest(this.grant(r.hostPolicy, true).grant), boundsHash: digest(this.bounds(null, true)), actionHash: digest(action) }; }
  ref(r, kind) { return digest([VERSION, r.intent, kind]); }
  async receipt(r, kind, value) {
    const directory = join(this.root, 'research-receipts'); await privateDirectory(directory);
    const ref = this.ref(r, kind), payload = { version: `flowcredit.benchmark-${kind}-receipt/t2-a-v1`, issuer: await this.store.storeId(), intent: r.intent, intentHash: digest(r.intent), ...value };
    await publishBytes(join(directory, `${ref}.json`), stable(await this.store.seal(payload)), { immutable: true }); return ref;
  }
  async readReceipt(r, kind, ref, task) {
    if (!hash(ref) || ref !== this.ref(r, kind)) fail('T2_RECEIPT_MISMATCH');
    const value = await this.store.unseal(await privateBytes(join(this.root, 'research-receipts', `${ref}.json`)));
    const fields = ['version', 'issuer', 'intent', 'intentHash', ...(kind === 'proposal' ? ['action', 'responseHash', 'error'] : ['proposalRef', 'action', 'result', 'resultHash'])];
    if (!exactKeys(value, fields) || value.version !== `flowcredit.benchmark-${kind}-receipt/t2-a-v1` || value.issuer !== await this.store.storeId() || stable(value.intent) !== stable(r.intent) || value.intentHash !== digest(r.intent)) fail('T2_RECEIPT_MISMATCH');
    if (kind === 'proposal') { if (!hash(value.responseHash)) fail('T2_RECEIPT_MISMATCH'); if (!value.error) { validateAction(value.action); if (value.responseHash !== digest(value.action)) fail('T2_RECEIPT_MISMATCH'); } }
    else {
      const proposal = await this.readReceipt(r, 'proposal', r.proposalRef, task);
      if (value.proposalRef !== r.proposalRef || stable(value.action) !== stable(proposal.action) || value.resultHash !== digest(value.result) || stable(value.result) !== stable(execute(task, value.action, r.hostPolicy))) fail('T2_RESULT_UNCONFIRMED');
    }
    return value;
  }
  charge() { return { usageStatus: 'reported', estimatedCostMicrousd: 0, scope: 'synthetic-local-units; no-provider-billing' }; }
  async checkBudget(r, action = null) {
    const intent = action ? this.readIntent(r, action) : r.intent, ref = action ? r.actionRef : r.proposalRef, api = action ? this.readBudgets : this.budgets;
    const b = await api.snapshot(intent), reservation = b.group?.reservations.find(x => x.requestId === intent.requestId), lease = b.pool?.leases.find(x => x.requestId === intent.requestId);
    if (reservation?.status !== 'confirmed' || lease?.status !== 'released' || reservation.receiptRef !== ref || lease.receiptRef !== ref) fail('T2_BUDGET_UNCONFIRMED');
  }
  async installProposal(r, ref, task) {
    const receipt = await this.readReceipt(r, 'proposal', ref, task);
    await this.budgets.update(r.intent, 'confirmed', ref, this.charge());
    r.proposalRef = ref; r.status = receipt.error ? 'denied' : 'ready'; r.error = receipt.error;
    await this.checkpoint(r, 'proposal-reconciled'); return receipt;
  }
  async installAction(r, ref, task) {
    const receipt = await this.readReceipt(r, 'action', ref, task);
    if (READING.includes(receipt.action.tool)) await this.readBudgets.update(this.readIntent(r, receipt.action), 'confirmed', ref, this.charge());
    r.actionRef = ref; r.result = receipt.result; r.resultHash = receipt.resultHash; r.status = 'finished'; r.error = null;
    await this.checkpoint(r, 'action-confirmed');
  }
  async markUnknown(r, task, error) {
    r.status = 'unknown'; r.error = safeCode(error);
    const budget = await this.budgets.snapshot(r.intent);
    if (budget.group?.reservations.some(v => v.requestId === r.intent.requestId && v.status !== 'confirmed')) await this.budgets.update(r.intent, 'unknown');
    if (r.proposalRef) { const p = await this.readReceipt(r, 'proposal', r.proposalRef, task); const snapshot = await this.readBudgets.snapshot(this.readIntent(r, p.action)); if (snapshot.group?.reservations.some(v => v.requestId === `${r.id}:read:1` && v.status !== 'confirmed')) await this.readBudgets.update(this.readIntent(r, p.action), 'unknown'); }
    await this.checkpoint(r, 'outcome-unknown'); return r;
  }
  async reconcile(id, context, { kind, receiptRef } = {}) {
    return this.store.exclusive(id, async () => {
      const r = await this.store.load(id), { task } = await this.authorize(r, context);
      if (r.status !== 'unknown' || !['proposal', 'action'].includes(kind) || kind === 'action' && !r.proposalRef || kind === 'proposal' && r.proposalRef) fail('T2_RECONCILIATION_BLOCKED');
      if (kind === 'proposal') await this.installProposal(r, receiptRef, task); else await this.installAction(r, receiptRef, task);
      await this.authorize(r, context); return r;
    });
  }
  async run(id, context, propose) {
    return this.store.exclusive(id, async () => {
      const r = await this.store.load(id); let { host, task } = await this.authorize(r, context);
      if (r.status === 'finished') { const receipt = await this.readReceipt(r, 'action', r.actionRef, task); if (stable(receipt.result) !== stable(r.result)) fail('T2_RESULT_UNCONFIRMED'); await this.checkBudget(r); if (READING.includes(receipt.action.tool)) await this.checkBudget(r, receipt.action); await this.authorize(r, context); return r; }
      if (['pending', 'action-started'].includes(r.status)) return this.markUnknown(r, task, { code: 'T2_INTERRUPTED_OUTCOME' });
      if (['unknown', 'denied'].includes(r.status)) return r;
      try {
        if (r.status === 'created') {
          const o = observation(task, host), bounds = this.bounds(o);
          if (bounds.totalTokenReservation > 13000) fail('T2_INPUT_BUDGET_DENIED');
          r.intent = this.makeIntent(r, host, task);
          // Preflight before durable intent; reserve atomically again afterwards.
          await this.budgets.preflight(r.intent, this.grant(host), bounds);
          r.status = 'pending'; await this.checkpoint(r, 'intent-saved'); await this.afterPhase('intent-saved', r);
          await this.budgets.reserve(r.intent, this.grant(host), bounds); await this.afterPhase('reserved', r);
          await this.authorize(r, context); await this.budgets.update(r.intent, 'dispatched');
          this.calls++; const proposed = await propose(structuredClone(o));
          let action = null, error = null; try { action = validateAction(proposed); } catch (e) { error = safeCode(e); }
          const ref = await this.receipt(r, 'proposal', { action, responseHash: digest(proposed ?? null), error });
          await this.afterPhase('proposal-receipt', { ...r, receiptRef: ref });
          await this.installProposal(r, ref, task);
          if (r.status === 'denied') return r;
        }
        ({ host, task } = await this.authorize(r, context));
        const receipt = await this.readReceipt(r, 'proposal', r.proposalRef, task), a = gate(observation(task, host), receipt.action);
        if (!host.allowedActions.includes(a.tool)) fail('T2_PERMISSION_DENIED');
        r.status = 'action-started'; await this.checkpoint(r, 'action-started'); await this.afterPhase('action-started', r);
        if (READING.includes(a.tool)) { await this.readBudgets.reserve(this.readIntent(r, a), this.grant(host, true), this.bounds(null, true)); await this.readBudgets.update(this.readIntent(r, a), 'dispatched'); }
        await this.authorize(r, context);
        this.executions++; const result = execute(task, a, host); await this.afterPhase('action-executed', r);
        const ref = await this.receipt(r, 'action', { proposalRef: r.proposalRef, action: a, result, resultHash: digest(result) });
        await this.afterPhase('action-receipt', { ...r, receiptRef: ref });
        await this.authorize(r, context); await this.installAction(r, ref, task); await this.authorize(r, context); return r;
      } catch (e) {
        if (['created', 'finished', 'denied'].includes(r.status)) throw e;
        if (r.status === 'ready') { r.status = 'denied'; r.error = safeCode(e); await this.checkpoint(r, 'action-denied'); return r; }
        return this.markUnknown(r, task, e);
      }
    });
  }
}
