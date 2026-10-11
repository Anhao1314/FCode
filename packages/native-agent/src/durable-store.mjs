import { mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { TaskStore } from './task-store.mjs';
import { digest, stable } from './baseline.mjs';
import { TASK_VERSION, RuntimeError, fail, exactKeys } from './contracts.mjs';
import { privateBytes, publishBytes } from './durable-io.mjs';

export const HISTORY_VERSION = 'flowcredit.durable-history/m1-v1';
export const LEDGER_VERSION = 'flowcredit.model-ledger/m1-v1';
const IDENTITY_VERSION = 'flowcredit.durable-identity/m1-v1';
const WITNESS_VERSION = 'flowcredit.durable-witness/m1-v1';
const validId = id => typeof id === 'string' && /^task-[a-f0-9]{32}$/.test(id);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const contained = (parent, child) => { const r = relative(parent, child); return r === '' || !r.startsWith('..') && !isAbsolute(r); };
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

// V1 remains available unchanged. M1 is a separate opt-in storage contract.
// Witness storage is an independent trusted freshness boundary, not an external
// provider or a guarantee against rollback of the entire machine.
export class DurableTaskStore extends TaskStore {
  constructor(root, { witnessRoot, kind = 'task', afterPhase = async () => {} } = {}) {
    super(root);
    if (typeof witnessRoot !== 'string' || !['task', 'model-ledger'].includes(kind)) fail('M1_CONFIGURATION');
    this.witnessRoot = resolve(witnessRoot); this.kind = kind; this.afterPhase = afterPhase;
    if (contained(this.root, this.witnessRoot) || contained(this.witnessRoot, this.root)) fail('M1_CONFIGURATION');
    this.history = join(this.root, 'history');
  }
  async initialize() {
    await super.initialize();
    await mkdir(this.history, { recursive: true, mode: 0o700 });
  }
  async authority({ create = false } = {}) {
    const localIdentity = join(this.root, 'history-identity.json');
    const remoteIdentity = join(this.witnessRoot, 'identity.json');
    const secretPath = join(this.witnessRoot, 'witness.key');
    if (create) await mkdir(this.witnessRoot, { recursive: true, mode: 0o700 });
    try {
      if (!(await lstat(this.root)).isDirectory() || !(await lstat(this.witnessRoot)).isDirectory()) fail('M1_CONFIGURATION');
      const canonicalRoot = await realpath(this.root), canonicalWitness = await realpath(this.witnessRoot);
      if (contained(canonicalRoot, canonicalWitness) || contained(canonicalWitness, canonicalRoot)) fail('M1_CONFIGURATION');
    } catch (error) { if (error instanceof RuntimeError) throw error; fail('M1_IDENTITY_REQUIRED'); }
    if (!await exists(localIdentity)) {
      if (!create || (await readdir(this.checkpoints)).some(name => name.endsWith('.json')) || (await readdir(this.history)).length || await exists(remoteIdentity) || await exists(secretPath)) fail('M1_IDENTITY_REQUIRED');
      await mkdir(this.witnessRoot, { recursive: true, mode: 0o700 });
      const key = randomBytes(32);
      // A concurrent/partly initialized identity is deliberately blocked rather
      // than guessed or silently replaced. The host must inspect that state.
      await publishBytes(secretPath, key, { immutable: true });
      const identity = { version: IDENTITY_VERSION, storeId: randomBytes(16).toString('hex'), kind: this.kind, rootHash: digest(this.root), witnessRootHash: digest(this.witnessRoot) };
      const sealed = this.sealWith(identity, key);
      await publishBytes(remoteIdentity, JSON.stringify(sealed), { immutable: true });
      await publishBytes(localIdentity, JSON.stringify(sealed), { immutable: true });
    }
    const key = await privateBytes(secretPath, 32);
    if (key.length !== 32) fail('M1_INTEGRITY_FAILURE');
    const local = this.parseVerified(await privateBytes(localIdentity), key);
    const remote = this.parseVerified(await privateBytes(remoteIdentity), key);
    if (stable(local) !== stable(remote) || !exactKeys(local, ['version', 'storeId', 'kind', 'rootHash', 'witnessRootHash']) || local.version !== IDENTITY_VERSION || !/^[a-f0-9]{32}$/.test(local.storeId) || local.kind !== this.kind || local.rootHash !== digest(this.root) || local.witnessRootHash !== digest(this.witnessRoot)) fail('M1_IDENTITY_MISMATCH');
    return { key, identity: local };
  }
  sealWith(payload, key) {
    return { payload, signature: createHmac('sha256', key).update(stable(payload)).digest('hex') };
  }
  parseVerified(bytes, key) {
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('M1_INTEGRITY_FAILURE'); }
    if (!exactKeys(value, ['payload', 'signature']) || !hash(value.signature)) fail('M1_INTEGRITY_FAILURE');
    const expected = this.sealWith(value.payload, key).signature;
    if (!timingSafeEqual(Buffer.from(value.signature, 'hex'), Buffer.from(expected, 'hex'))) fail('M1_INTEGRITY_FAILURE');
    return value.payload;
  }
  async seal(payload) { const { key } = await this.authority(); return this.sealWith(payload, key); }
  async unseal(bytes) { const { key } = await this.authority(); return this.parseVerified(bytes, key); }
  async storeId() { return (await this.authority()).identity.storeId; }
  validateTask(task, current = null) {
    if (!validId(task?.id) || !Number.isSafeInteger(task.sequence) || task.sequence < 0 || !Array.isArray(task.events) || task.events.length !== task.sequence || task.version !== (this.kind === 'task' ? TASK_VERSION : LEDGER_VERSION) || Buffer.byteLength(JSON.stringify(task)) > 1024 * 1024) fail('M1_TASK_VERSION_OR_STATE');
    let previousHash = null;
    for (const [index, event] of task.events.entries()) {
      const { hash: eventHash, ...data } = event;
      if (data.sequence !== index + 1 || data.previousHash !== previousHash || digest(data) !== eventHash) fail('M1_EVENT_INTEGRITY');
      previousHash = eventHash;
    }
    if (this.kind === 'task') {
      const states = ['created', 'planning', 'planned', 'running', 'verifying', 'succeeded', 'paused', 'failed', 'denied', 'recovery-required'];
      const modelStates = ['not-started', 'started', 'unknown', 'validated', 'failed'];
      if (!states.includes(task.status) || !modelStates.includes(task.model?.status) || !Number.isSafeInteger(task.model.attempts) || task.model.attempts < 0 || task.model.attempts > 1) fail('M1_TASK_VERSION_OR_STATE');
      if (current) {
        const nextStates = {
          created: ['created', 'planning'], planning: ['planning', 'planned', 'failed', 'recovery-required'],
          planned: ['planned', 'running', 'denied'], running: ['running', 'paused', 'verifying', 'failed', 'denied'],
          paused: ['paused', 'running', 'denied'], verifying: ['verifying', 'succeeded', 'failed', 'denied'],
          failed: ['failed', 'running', 'denied'], denied: ['denied'], succeeded: ['succeeded'],
          'recovery-required': ['recovery-required', 'planned', 'failed']
        };
        const nextModel = { 'not-started': ['not-started', 'started'], started: ['started', 'unknown', 'validated', 'failed'], unknown: ['unknown', 'validated', 'failed'], validated: ['validated'], failed: ['failed'] };
        if (!nextStates[current.status]?.includes(task.status) || !nextModel[current.model.status]?.includes(task.model.status)) fail('M1_HISTORY_REWRITE');
      }
    } else {
      if (!Array.isArray(task.calls) || task.sequence === 0 && task.calls.length !== 0 || new Set(task.calls.map(call => call.intent.requestId)).size !== task.calls.length) fail('M1_TASK_VERSION_OR_STATE');
      for (const call of task.calls) if (!['reserved', 'dispatched', 'unknown', 'confirmed'].includes(call.status) || call.reservedCalls !== 1 || call.reservedCostMicrousd !== 0 || call.status === 'confirmed' && !hash(call.receiptRef) || call.status !== 'confirmed' && call.receiptRef !== null) fail(current ? 'M1_HISTORY_REWRITE' : 'M1_TASK_VERSION_OR_STATE');
    }
    if (current) {
      if (task.sequence !== current.sequence + 1 || stable(task.events.slice(0, current.events.length)) !== stable(current.events)) fail('M1_HISTORY_REWRITE');
      if (this.kind === 'task') {
        for (const field of ['id', 'version', 'principalHash', 'objective', 'binding', 'allowedTools', 'modelGrant', 'toolVersion', 'planVersion']) if (stable(task[field]) !== stable(current[field])) fail('M1_HISTORY_REWRITE');
        if (!Number.isSafeInteger(task.model.attempts) || task.model.attempts < current.model.attempts || task.model.attempts > 1 || current.model.intent && stable(task.model.intent) !== stable(current.model.intent) || current.plan && stable(task.plan) !== stable(current.plan) || current.model.receipt && stable(task.model.receipt) !== stable(current.model.receipt) || current.model.receiptRef && task.model.receiptRef !== current.model.receiptRef || current.model.outcome && task.model.outcome !== current.model.outcome) fail('M1_HISTORY_REWRITE');
        for (const original of current.steps) {
          const next = task.steps.find(step => step.id === original.id);
          if (!next || next.attempts < original.attempts || original.status === 'succeeded' && stable(next) !== stable(original)) fail('M1_HISTORY_REWRITE');
        }
      } else {
        for (const field of ['id', 'version', 'scope', 'principalHash', 'grantHash']) if (stable(task[field]) !== stable(current[field])) fail('M1_HISTORY_REWRITE');
        for (const original of current.calls) {
          const next = task.calls.find(call => call.intent.requestId === original.intent.requestId);
          const transitions = { reserved: ['reserved', 'dispatched', 'unknown'], dispatched: ['dispatched', 'unknown', 'confirmed'], unknown: ['unknown', 'confirmed'], confirmed: ['confirmed'] };
          if (!next || !transitions[original.status]?.includes(next.status) || stable(next.intent) !== stable(original.intent) || next.reservedCalls !== original.reservedCalls || next.reservedCostMicrousd !== original.reservedCostMicrousd || original.receiptRef && next.receiptRef !== original.receiptRef || original.status === 'confirmed' && stable(next) !== stable(original)) fail('M1_HISTORY_REWRITE');
        }
      }
    }
  }
  async anchored(id) {
    if (!validId(id)) fail('TASK_ID_INVALID');
    const { key, identity } = await this.authority();
    const witness = this.parseVerified(await privateBytes(join(this.witnessRoot, `${id}.json`)), key);
    if (!exactKeys(witness, ['version', 'storeId', 'id', 'sequence', 'historyHash', 'taskHash']) || witness.version !== WITNESS_VERSION || witness.storeId !== identity.storeId || witness.id !== id || !Number.isSafeInteger(witness.sequence) || witness.sequence < 0 || !hash(witness.historyHash) || !hash(witness.taskHash)) fail('M1_WITNESS_MISMATCH');
    let previousHash = null, task = null, latestHash;
    const directory = join(this.history, id);
    const files = await readdir(directory).catch(() => fail('M1_RECORD_MISSING'));
    const numeric = files.filter(name => /^\d+\.json$/.test(name));
    if (numeric.some(name => Number.parseInt(name, 10) > witness.sequence)) fail('M1_HISTORY_AHEAD');
    if (numeric.length !== witness.sequence + 1) fail('M1_HISTORY_GAP');
    for (let sequence = 0; sequence <= witness.sequence; sequence += 1) {
      const bytes = await privateBytes(join(directory, `${sequence}.json`), 2 * 1024 * 1024);
      const entry = this.parseVerified(bytes, key);
      if (!exactKeys(entry, ['version', 'storeId', 'id', 'sequence', 'previousHash', 'taskHash', 'task']) || entry.version !== HISTORY_VERSION || entry.storeId !== identity.storeId || entry.id !== id || entry.sequence !== sequence || entry.previousHash !== previousHash || entry.taskHash !== digest(entry.task) || entry.task.sequence !== sequence) fail('M1_HISTORY_INTEGRITY');
      this.validateTask(entry.task, task);
      latestHash = digest(bytes.toString('utf8')); previousHash = latestHash; task = entry.task;
    }
    if (latestHash !== witness.historyHash || digest(task) !== witness.taskHash) fail('M1_WITNESS_MISMATCH');
    return { task, witness, historyHash: latestHash };
  }
  async load(id) {
    // Validate V1 file bytes before classifying a signed stale checkpoint.
    const latest = await super.load(id);
    const anchored = await this.anchored(id);
    if (latest.sequence < anchored.task.sequence) fail('M1_CHECKPOINT_ROLLBACK');
    if (latest.sequence !== anchored.task.sequence || digest(latest) !== digest(anchored.task)) fail('M1_CHECKPOINT_DIVERGENCE');
    return latest;
  }
  async commit(task, current) {
    const { key, identity } = await this.authority({ create: current === null });
    const publishedBefore = (await readdir(this.history)).length > 0 || (await readdir(this.checkpoints)).some(name => name.endsWith('.json'));
    const checkpointKey = await super.key({ create: current === null && !publishedBefore });
    const directory = join(this.history, task.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const previous = current ? await this.anchored(task.id) : null;
    const entry = { version: HISTORY_VERSION, storeId: identity.storeId, id: task.id, sequence: task.sequence, previousHash: previous?.historyHash || null, taskHash: digest(task), task };
    const bytes = JSON.stringify(this.sealWith(entry, key));
    await publishBytes(join(directory, `${task.sequence}.json`), bytes, { immutable: true });
    await this.afterPhase('history_published', { id: task.id, sequence: task.sequence });
    const witness = { version: WITNESS_VERSION, storeId: identity.storeId, id: task.id, sequence: task.sequence, historyHash: digest(bytes), taskHash: digest(task) };
    await publishBytes(join(this.witnessRoot, `${task.id}.json`), JSON.stringify(this.sealWith(witness, key)), { immutable: !current });
    await this.afterPhase('witness_published', { id: task.id, sequence: task.sequence });
    // The base publisher still signs the latest checkpoint, but M1 additionally
    // checks immutable history and a witness on every load/CAS.
    await super.publish(task, checkpointKey);
    await this.afterPhase('latest_published', { id: task.id, sequence: task.sequence });
  }
  async create(task) {
    this.validateTask(task);
    if (task.sequence !== 0) fail('TASK_SEQUENCE_CONFLICT');
    await this.initialize();
    return this.exclusive(task.id, async () => {
      if (await exists(join(this.checkpoints, `${task.id}.json`)) || await exists(join(this.history, task.id))) fail('TASK_SEQUENCE_CONFLICT');
      await this.commit(structuredClone(task), null); return structuredClone(task);
    });
  }
  async save(task, expectedSequence) {
    if (task.sequence !== expectedSequence + 1) fail('TASK_SEQUENCE_CONFLICT');
    return this.exclusive(task.id, async () => {
      const current = await this.load(task.id);
      if (current.sequence !== expectedSequence) fail('TASK_SEQUENCE_CONFLICT');
      this.validateTask(task, current);
      await this.commit(structuredClone(task), current); return structuredClone(task);
    });
  }
  async recoverLatest(id) {
    return this.exclusive(id, async () => {
      const anchored = await this.anchored(id);
      let current;
      try { current = await super.load(id); }
      catch (error) { if (error.code !== 'TASK_NOT_FOUND') throw error; }
      if (current && (current.sequence > anchored.task.sequence || current.sequence === anchored.task.sequence && digest(current) !== digest(anchored.task))) fail('M1_CHECKPOINT_DIVERGENCE');
      if (current && digest(current) === digest(anchored.task)) return { recovered: false, sequence: current.sequence };
      const directory = join(this.root, 'recovery-evidence');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const previousCheckpointBytes = current ? (await privateBytes(join(this.checkpoints, `${id}.json`), 2 * 1024 * 1024)).toString('utf8') : null;
      const record = { version: HISTORY_VERSION, id, fromSequence: current?.sequence ?? null, toSequence: anchored.task.sequence, fromTaskHash: current ? digest(current) : null, previousCheckpointBytes, anchoredHash: anchored.historyHash, reason: 'explicit-witness-matched-recovery' };
      await publishBytes(join(directory, `${id}-${randomBytes(8).toString('hex')}.json`), JSON.stringify(await this.seal(record)), { immutable: true });
      await super.publish(anchored.task, await super.key());
      return { recovered: true, sequence: anchored.task.sequence };
    });
  }
}
