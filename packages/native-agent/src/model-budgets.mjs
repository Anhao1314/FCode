import { DurableTaskStore } from './durable-store.mjs';
import { digest, stable } from './baseline.mjs';
import { fail, RuntimeError } from './contracts.mjs';

export const BUDGET_VERSION = 'flowcredit.model-budget/m2-v1';
const validId = value => /^task-[a-f0-9]{32}$/.test(value || '');
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function notDispatched(code) { const error = new RuntimeError(code); error.notDispatched = true; throw error; }

// Reuse M1's HMAC history, CAS, witness and filesystem locks with a new record
// schema. No M1 budget/receipt data is migrated or relabeled.
export class BudgetStore extends DurableTaskStore {
  validateTask(record, current = null) {
    if (!validId(record?.id) || record.version !== BUDGET_VERSION || !['pool', 'grant'].includes(record.kind) || !integer(record.sequence) || record.sequence !== record.events?.length || Buffer.byteLength(JSON.stringify(record)) > 1024 * 1024) fail('MODEL_BUDGET_INTEGRITY');
    let previousHash = null;
    for (const [index, event] of record.events.entries()) {
      const { hash, ...data } = event;
      if (data.sequence !== index + 1 || data.previousHash !== previousHash || digest(data) !== hash) fail('MODEL_BUDGET_INTEGRITY'); previousHash = hash;
    }
    if (record.kind === 'pool') {
      if (!integer(record.maxConcurrent) || record.maxConcurrent < 1 || !Array.isArray(record.leases) || new Set(record.leases.map(lease => lease.requestId)).size !== record.leases.length) fail('MODEL_BUDGET_INTEGRITY');
      for (const lease of record.leases) if (!['held', 'released'].includes(lease.status) || lease.status === 'released' && typeof lease.receiptRef !== 'string') fail('MODEL_BUDGET_INTEGRITY');
    } else if (!Array.isArray(record.reservations) || !integer(record.maxCalls) || !integer(record.maxTotalTokens) || !integer(record.maxCostMicrousd) || typeof record.blocked !== 'boolean' || new Set(record.reservations.map(item => item.requestId)).size !== record.reservations.length || record.reservations.some(item => !integer(item.tokenBound) || !integer(item.costBound) || !['reserved', 'dispatched', 'unknown', 'confirmed'].includes(item.status))) fail('MODEL_BUDGET_INTEGRITY');
    if (!current) return;
    if (record.sequence !== current.sequence + 1 || stable(record.events.slice(0, current.events.length)) !== stable(current.events)) fail('MODEL_BUDGET_REWRITE');
    const immutable = record.kind === 'pool' ? ['id', 'version', 'kind', 'hostScope', 'maxConcurrent'] : ['id', 'version', 'kind', 'principalHash', 'grantId', 'grantHash', 'maxCalls', 'maxTotalTokens', 'maxCostMicrousd'];
    for (const field of immutable) if (stable(record[field]) !== stable(current[field])) fail('MODEL_BUDGET_REWRITE');
    if (record.kind === 'pool') {
      for (const before of current.leases) {
        const after = record.leases.find(item => item.requestId === before.requestId);
        if (!after || before.status === 'released' && stable(before) !== stable(after) || ['requestId', 'intentHash', 'groupId'].some(key => before[key] !== after[key])) fail('MODEL_BUDGET_REWRITE');
      }
    } else {
      if (current.blocked && !record.blocked) fail('MODEL_BUDGET_REWRITE');
      const transitions = { reserved: ['reserved', 'dispatched', 'unknown'], dispatched: ['dispatched', 'unknown', 'confirmed'], unknown: ['unknown', 'confirmed'], confirmed: ['confirmed'] };
      for (const before of current.reservations) {
        const after = record.reservations.find(item => item.requestId === before.requestId);
        if (!after || !transitions[before.status].includes(after.status) || ['requestId', 'taskId', 'intentHash', 'routeId', 'pricingHash', 'tokenBound', 'costBound'].some(key => before[key] !== after[key]) || before.status === 'confirmed' && stable(before) !== stable(after)) fail('MODEL_BUDGET_REWRITE');
      }
    }
  }
}

export class ModelBudgets {
  constructor({ store, hostScope = 'flowcredit-m2-injected-host', maxConcurrent = 1, afterPhase = async () => {} }) {
    if (!integer(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2 || typeof hostScope !== 'string' || !hostScope.trim()) fail('MODEL_BUDGET_CONFIGURATION');
    this.store = store; this.hostScope = hostScope; this.maxConcurrent = maxConcurrent; this.afterPhase = afterPhase;
    this.poolId = `task-${digest(['pool', hostScope]).slice(0, 32)}`;
  }
  groupId(intent) { return `task-${digest([intent.principalHash, intent.grantId]).slice(0, 32)}`; }
  async event(record, type, detail) {
    const entry = { sequence: record.events.length + 1, type, detail, at: new Date().toISOString(), previousHash: record.events.at(-1)?.hash || null };
    record.events.push({ ...entry, hash: digest(entry) }); const prior = record.sequence; record.sequence += 1;
    await this.store.save(record, prior);
  }
  async maybe(id) { try { return await this.store.load(id); } catch (error) { if (error.code === 'TASK_NOT_FOUND') return null; throw error; } }
  check(group, pool, intent, authorization, bounds) {
    const grant = authorization.grant, groupId = this.groupId(intent);
    if (group && (group.grantHash !== digest(grant) || group.blocked)) notDispatched('MODEL_BUDGET_POLICY_CHANGED');
    if (pool && (pool.hostScope !== this.hostScope || pool.maxConcurrent !== this.maxConcurrent)) notDispatched('MODEL_CONCURRENCY_POLICY_CHANGED');
    if (group?.reservations.some(item => item.requestId === intent.requestId)) throw new RuntimeError('MODEL_OUTCOME_UNKNOWN');
    if ((group?.reservations.length || 0) >= grant.maxCalls) notDispatched('MODEL_CALL_QUOTA');
    const totalCost = (group?.reservations || []).reduce((sum, item) => sum + BigInt(item.costBound), 0n);
    const totalTokens = (group?.reservations || []).reduce((sum, item) => sum + BigInt(item.tokenBound), 0n);
    if (totalCost + BigInt(bounds.costReservationMicrousd) > BigInt(grant.maxCostMicrousd)) notDispatched('MODEL_COST_BUDGET_DENIED');
    if (totalTokens + BigInt(bounds.totalTokenReservation) > BigInt(grant.maxTotalTokens)) notDispatched('MODEL_TOKEN_BUDGET_DENIED');
    const held = (pool?.leases || []).filter(item => item.status === 'held');
    if (held.length >= this.maxConcurrent || held.filter(item => item.groupId === groupId).length >= grant.maxConcurrent) notDispatched('MODEL_CONCURRENCY_DENIED');
  }
  async preflight(intent, authorization, bounds) {
    this.check(await this.maybe(this.groupId(intent)), await this.maybe(this.poolId), intent, authorization, bounds);
  }
  async reserve(intent, authorization, bounds) {
    return this.store.exclusive(this.poolId, async () => {
      let pool = await this.maybe(this.poolId), group = await this.maybe(this.groupId(intent));
      this.check(group, pool, intent, authorization, bounds);
      if (!pool) { pool = { id: this.poolId, version: BUDGET_VERSION, kind: 'pool', sequence: 0, hostScope: this.hostScope, maxConcurrent: this.maxConcurrent, leases: [], events: [] }; await this.store.create(pool); }
      if (!group) {
        const grant = authorization.grant;
        group = { id: this.groupId(intent), version: BUDGET_VERSION, kind: 'grant', sequence: 0, principalHash: intent.principalHash, grantId: intent.grantId, grantHash: digest(grant), maxCalls: grant.maxCalls, maxTotalTokens: grant.maxTotalTokens, maxCostMicrousd: grant.maxCostMicrousd, blocked: false, reservations: [], events: [] };
        await this.store.create(group);
      }
      group.reservations.push({ requestId: intent.requestId, taskId: intent.taskId, intentHash: digest(intent), routeId: intent.routeId, pricingHash: intent.pricingHash, tokenBound: bounds.totalTokenReservation, costBound: bounds.costReservationMicrousd, status: 'reserved', receiptRef: null, billingStatus: 'reserved', estimatedCostMicrousd: null });
      await this.event(group, 'budget_reserved', { requestId: intent.requestId, tokenBound: bounds.totalTokenReservation, costBound: bounds.costReservationMicrousd });
      pool.leases.push({ requestId: intent.requestId, intentHash: digest(intent), groupId: group.id, status: 'held', receiptRef: null });
      await this.event(pool, 'concurrency_held', { requestId: intent.requestId, groupId: group.id });
      await this.afterPhase('budget_reserved', { intent });
    });
  }
  async update(intent, phase, receiptRef = null, charge = null) {
    return this.store.exclusive(this.poolId, async () => {
      const group = await this.store.load(this.groupId(intent)), pool = await this.store.load(this.poolId);
      const reservation = group.reservations.find(item => item.requestId === intent.requestId), lease = pool.leases.find(item => item.requestId === intent.requestId);
      if (!reservation || !lease || reservation.intentHash !== digest(intent) || lease.intentHash !== digest(intent)) fail('MODEL_BUDGET_BINDING_MISMATCH');
      if (phase === 'confirmed') {
        if (reservation.status !== 'confirmed') {
          if (!['dispatched', 'unknown'].includes(reservation.status)) fail('MODEL_BUDGET_RECONCILIATION_BLOCKED');
          reservation.status = 'confirmed'; reservation.receiptRef = receiptRef;
          reservation.billingStatus = charge.usageStatus === 'reported' ? 'reported-estimate' : 'unknown';
          reservation.estimatedCostMicrousd = charge.estimatedCostMicrousd;
          if (charge.usageStatus === 'over-budget') group.blocked = true;
          await this.event(group, 'budget_confirmed', { requestId: intent.requestId, receiptRef, billingStatus: reservation.billingStatus });
          await this.afterPhase('budget_confirmed', { intent, receiptRef });
        } else if (reservation.receiptRef !== receiptRef) fail('MODEL_BUDGET_BINDING_MISMATCH');
        if (lease.status !== 'released') {
          lease.status = 'released'; lease.receiptRef = receiptRef;
          await this.event(pool, 'concurrency_released', { requestId: intent.requestId, receiptRef });
        } else if (lease.receiptRef !== receiptRef) fail('MODEL_BUDGET_BINDING_MISMATCH');
      } else if (reservation.status !== phase && reservation.status !== 'confirmed') {
        reservation.status = phase;
        if (phase === 'unknown') reservation.billingStatus = 'unknown';
        await this.event(group, phase === 'dispatched' ? 'budget_dispatched' : 'budget_unknown', { requestId: intent.requestId });
      }
    });
  }
  async snapshot(intent) {
    const group = await this.maybe(this.groupId(intent)), pool = await this.maybe(this.poolId);
    return { group, pool, totalReservedCostMicrousd: (group?.reservations || []).reduce((sum, item) => sum + item.costBound, 0), totalReservedTokens: (group?.reservations || []).reduce((sum, item) => sum + item.tokenBound, 0), heldConcurrency: (pool?.leases || []).filter(item => item.status === 'held').length };
  }
}
