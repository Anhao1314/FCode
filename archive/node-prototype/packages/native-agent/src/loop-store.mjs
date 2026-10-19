import { DurableTaskStore } from './durable-store.mjs';
import { LOOP_VERSION, validId, hash, childId, terminal, contextFor, validateLoopPolicy } from './loop-contract.mjs';
import { exactKeys, fail } from './contracts.mjs';
import { digest, stable } from './baseline.mjs';

export class LoopStore extends DurableTaskStore {
  validateTask(loop, current = null) {
    validateLoopPolicy(loop?.policy);
    if (!exactKeys(loop, ['id', 'version', 'sequence', 'status', 'principalHash', 'objective', 'binding', 'allowedTools', 'modelGrant', 'authorizationHash', 'policy', 'policyHash', 'rounds', 'events', 'failure', 'result']) || !validId(loop.id) || loop.version !== LOOP_VERSION || !['created', 'active', 'paused', 'recovery-required', 'completed', 'insufficient-evidence', 'failed', 'denied'].includes(loop.status) || !Number.isSafeInteger(loop.sequence) || loop.sequence !== loop.events?.length || !Array.isArray(loop.rounds) || loop.rounds.length > loop.policy.maxRounds || loop.policyHash !== digest(loop.policy) || !hash(loop.authorizationHash) || !hash(loop.principalHash) || Buffer.byteLength(JSON.stringify(loop)) > 1024 * 1024) fail('M4_LOOP_INTEGRITY');
    let previousHash = null;
    for (const [index, event] of loop.events.entries()) { const { hash: eventHash, ...data } = event; if (data.sequence !== index + 1 || data.previousHash !== previousHash || digest(data) !== eventHash) fail('M4_LOOP_INTEGRITY'); previousHash = eventHash; }
    for (const [index, round] of loop.rounds.entries()) {
      if (!exactKeys(round, ['index', 'childId', 'context', 'contextHash', 'authorizationHash', 'status', 'requestId', 'receiptRef', 'planHash', 'observation']) || round.index !== index + 1 || !['reserved', 'linked', 'unknown', 'observed', 'failed'].includes(round.status) || round.contextHash !== digest(round.context) || round.childId !== childId(loop.id, round.index, round.contextHash) || round.authorizationHash !== loop.authorizationHash || round.requestId !== `${round.childId}:plan:1` || index > 0 && loop.rounds[index - 1].status !== 'observed') fail('M4_LOOP_INTEGRITY');
      if (round.status === 'observed' && (!hash(round.receiptRef) || !hash(round.planHash) || !exactKeys(round.observation, ['tool', 'stepId', 'result', 'resultHash']) || round.observation.resultHash !== digest(round.observation.result))) fail('M4_LOOP_INTEGRITY');
      if (round.status !== 'observed' && (round.observation !== null || round.receiptRef !== null || round.planHash !== null)) fail('M4_LOOP_INTEGRITY');
      if (stable(round.context) !== stable(contextFor(loop, round.index))) fail('M4_CONTEXT_MISMATCH');
    }
    if (['completed', 'insufficient-evidence'].includes(loop.status) && (!loop.result || loop.rounds.length !== 2 || loop.rounds.some(round => round.status !== 'observed')) || loop.status === 'recovery-required' && loop.rounds.at(-1)?.status !== 'unknown') fail('M4_LOOP_INTEGRITY');
    if (!current) return;
    if (loop.sequence !== current.sequence + 1 || stable(loop.events.slice(0, current.events.length)) !== stable(current.events) || loop.rounds.length < current.rounds.length || loop.rounds.length > current.rounds.length + 1) fail('M4_HISTORY_REWRITE');
    for (const key of ['id', 'version', 'principalHash', 'objective', 'binding', 'allowedTools', 'modelGrant', 'authorizationHash', 'policy', 'policyHash']) if (stable(loop[key]) !== stable(current[key])) fail('M4_HISTORY_REWRITE');
    if (terminal(current.status) && stable({ ...loop, sequence: 0, events: [] }) !== stable({ ...current, sequence: 0, events: [] })) fail('M4_HISTORY_REWRITE');
    const states = { created: ['created', 'active'], active: ['active', 'paused', 'recovery-required', 'completed', 'insufficient-evidence', 'failed', 'denied'], paused: ['paused', 'active', 'completed', 'insufficient-evidence', 'failed'], 'recovery-required': ['recovery-required', 'active'] };
    if (!terminal(current.status) && !states[current.status].includes(loop.status)) fail('M4_HISTORY_REWRITE');
    const transitions = { reserved: ['reserved', 'linked'], linked: ['linked', 'unknown', 'observed', 'failed'], unknown: ['unknown', 'linked', 'failed'], observed: ['observed'], failed: ['failed'] };
    for (const before of current.rounds) {
      const after = loop.rounds[before.index - 1];
      if (!transitions[before.status].includes(after.status) || ['index', 'childId', 'context', 'contextHash', 'authorizationHash', 'requestId'].some(key => stable(after[key]) !== stable(before[key])) || ['observed', 'failed'].includes(before.status) && stable(after) !== stable(before)) fail('M4_HISTORY_REWRITE');
    }
  }
}
