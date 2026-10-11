import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { RuntimeError, fail, object } from './contracts.mjs';

const ENVELOPE_VERSION = 'flowcredit.native-checkpoint/experimental-v1';
const contexts = new AsyncLocalStorage();
const queues = new Map();
const validId = id => typeof id === 'string' && /^task-[a-f0-9]{32}$/.test(id);
const validOwner = owner => object(owner) && Object.keys(owner).length === 2 && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string' && /^[a-f0-9]{32}$/.test(owner.token);
const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const safeError = (error, code) => { if (error instanceof RuntimeError) throw error; fail(code); };
const validateId = id => { if (!validId(id)) fail('TASK_ID_INVALID'); };
export const newTaskId = () => `task-${randomBytes(16).toString('hex')}`;

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeSynced(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function queued(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const waiting = new Promise(resolveWaiting => { release = resolveWaiting; });
  queues.set(key, waiting);
  await previous;
  try { return await operation(); }
  finally { release(); if (queues.get(key) === waiting) queues.delete(key); }
}

function copiedTask(task) {
  if (!object(task)) fail('TASK_INTEGRITY_FAILURE');
  validateId(task.id);
  if (!Number.isSafeInteger(task.sequence) || task.sequence < 0) fail('TASK_SEQUENCE_CONFLICT');
  let bytes, copy;
  try { bytes = JSON.stringify(task); copy = JSON.parse(bytes); }
  catch { fail('TASK_INTEGRITY_FAILURE'); }
  if (Buffer.byteLength(bytes) > 1024 * 1024 || copy.id !== task.id || copy.sequence !== task.sequence) fail('TASK_INTEGRITY_FAILURE');
  return copy;
}

// One trusted host, cooperating TaskStore processes, local filesystem semantics.
// No lease expiry, distributed-lock claim, or Evidence-lock recovery is provided.
export class TaskStore {
  constructor(root) {
    this.root = resolve(root);
    this.checkpoints = join(this.root, 'checkpoints');
    this.locks = join(this.root, 'locks');
    this.keyPath = join(this.root, 'integrity.key');
  }

  async initialize() {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      for (const path of [this.checkpoints, this.locks]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        if (!(await lstat(path)).isDirectory()) fail('TASK_CHECKPOINT_WRITE_FAILED');
      }
    } catch (error) { safeError(error, 'TASK_CHECKPOINT_WRITE_FAILED'); }
  }

  async key({ create = false } = {}) {
    try {
      let metadata;
      try { metadata = await lstat(this.keyPath); }
      catch (error) {
        if (error.code !== 'ENOENT' || !create) fail('TASK_STORE_KEY_UNAVAILABLE');
        // Losing the key after publication is an integrity failure, not a new store.
        if ((await readdir(this.checkpoints)).some(name => /^task-[a-f0-9]{32}\.json$/.test(name))) fail('TASK_STORE_KEY_UNAVAILABLE');
        const temporary = join(this.root, `.key-${randomBytes(8).toString('hex')}.tmp`);
        try {
          await writeSynced(temporary, randomBytes(32));
          try { await link(temporary, this.keyPath); }
          catch (publishError) { if (publishError.code !== 'EEXIST') throw publishError; }
          await syncDirectory(this.root);
        } finally { await unlink(temporary).catch(() => {}); }
        metadata = await lstat(this.keyPath);
      }
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) fail('TASK_STORE_KEY_UNAVAILABLE');
      const bytes = await readFile(this.keyPath);
      if (bytes.length !== 32) fail('TASK_STORE_KEY_UNAVAILABLE');
      return bytes;
    } catch (error) { safeError(error, 'TASK_STORE_KEY_UNAVAILABLE'); }
  }

  signature(payload, key) {
    return createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
  }

  async load(id) {
    validateId(id);
    let bytes;
    try {
      const path = join(this.checkpoints, `${id}.json`);
      if (!(await lstat(path)).isFile()) fail('TASK_INTEGRITY_FAILURE');
      bytes = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') fail('TASK_NOT_FOUND');
      safeError(error, 'TASK_INTEGRITY_FAILURE');
    }
    const key = await this.key();
    let envelope;
    try { envelope = JSON.parse(bytes); } catch { fail('TASK_INTEGRITY_FAILURE'); }
    if (!object(envelope) || Object.keys(envelope).length !== 4 || envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== 'HMAC-SHA256' || !object(envelope.task) || typeof envelope.signature !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.signature)) fail('TASK_INTEGRITY_FAILURE');
    const { signature, ...payload } = envelope;
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.signature(payload, key), 'hex'))) fail('TASK_INTEGRITY_FAILURE');
    if (envelope.task.id !== id) fail('TASK_INTEGRITY_FAILURE');
    return copiedTask(envelope.task);
  }

  async create(task) {
    const copy = copiedTask(task);
    if (copy.sequence !== 0) fail('TASK_SEQUENCE_CONFLICT');
    await this.initialize();
    return this.exclusive(copy.id, async () => {
      try { await lstat(join(this.checkpoints, `${copy.id}.json`)); fail('TASK_SEQUENCE_CONFLICT'); }
      catch (error) { if (error.code !== 'ENOENT') safeError(error, 'TASK_CHECKPOINT_WRITE_FAILED'); }
      const key = await this.key({ create: true });
      await this.publish(copy, key);
      return copy;
    });
  }

  async save(task, expectedSequence) {
    const copy = copiedTask(task);
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0 || copy.sequence !== expectedSequence + 1) fail('TASK_SEQUENCE_CONFLICT');
    return this.exclusive(copy.id, async () => {
      const current = await this.load(copy.id);
      if (current.sequence !== expectedSequence) fail('TASK_SEQUENCE_CONFLICT');
      await this.publish(copy, await this.key());
      return copy;
    });
  }

  async publish(task, key) {
    const payload = { version: ENVELOPE_VERSION, algorithm: 'HMAC-SHA256', task };
    const bytes = JSON.stringify({ ...payload, signature: this.signature(payload, key) });
    const temporary = join(this.checkpoints, `${task.id}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeSynced(temporary, bytes);
      await rename(temporary, join(this.checkpoints, `${task.id}.json`));
      await syncDirectory(this.checkpoints);
    } catch (error) { safeError(error, 'TASK_CHECKPOINT_WRITE_FAILED'); }
    finally { await unlink(temporary).catch(() => {}); }
  }

  async recoveryGuardAbsent(id) {
    try { await lstat(join(this.locks, `${id}.recovery`)); fail('TASK_BUSY', { retryable: true }); }
    catch (error) { if (error.code !== 'ENOENT') safeError(error, 'TASK_LOCK_RECOVERY_UNCERTAIN'); }
  }

  async exclusive(id, operation) {
    validateId(id);
    const active = contexts.getStore();
    if (active?.held && active.root === this.root && active.id === id) return operation();
    return queued(`${this.root}\n${id}`, async () => {
      await this.initialize();
      await this.recoveryGuardAbsent(id);
      const lockPath = join(this.locks, id);
      const owner = JSON.stringify({ pid: process.pid, token: randomBytes(16).toString('hex') });
      let lockMetadata, ownerWritten = false, context;
      try {
        try { await mkdir(lockPath, { mode: 0o700 }); }
        catch (error) { if (error.code === 'EEXIST') fail('TASK_BUSY', { retryable: true }); throw error; }
        lockMetadata = await lstat(lockPath);
        await writeSynced(join(lockPath, 'owner.json'), owner); ownerWritten = true;
        await syncDirectory(lockPath);
        await syncDirectory(this.locks);
        // A recovering process can appear after the first guard check. It cannot
        // run a task while recovery owns the guard, even if it wins mkdir.
        await this.recoveryGuardAbsent(id);
        context = { root: this.root, id, held: true };
        return await contexts.run(context, operation);
      } catch (error) { safeError(error, 'TASK_CHECKPOINT_WRITE_FAILED'); }
      finally {
        if (context) context.held = false;
        if (lockMetadata) {
          try {
            const retainedMetadata = await lstat(lockPath);
            if (!sameInode(lockMetadata, retainedMetadata) || !retainedMetadata.isDirectory()) fail('TASK_LOCK_RECOVERY_UNCERTAIN');
            if (ownerWritten) {
              if (await readFile(join(lockPath, 'owner.json'), 'utf8') !== owner) fail('TASK_LOCK_RECOVERY_UNCERTAIN');
              await unlink(join(lockPath, 'owner.json'));
            }
            await rmdir(lockPath);
            await syncDirectory(this.locks);
          } catch (error) { safeError(error, 'TASK_LOCK_RECOVERY_UNCERTAIN'); }
        }
      }
    });
  }

  async recoverLock(id) {
    validateId(id);
    if (contexts.getStore()?.held) fail('TASK_BUSY');
    const queueKey = `${this.root}\n${id}`;
    if (queues.has(queueKey)) fail('TASK_BUSY', { retryable: true });
    return queued(queueKey, async () => {
      await this.initialize();
      const guardPath = join(this.locks, `${id}.recovery`);
      try { await mkdir(guardPath, { mode: 0o700 }); }
      catch (error) { if (error.code === 'EEXIST') fail('TASK_LOCK_RECOVERY_UNCERTAIN'); safeError(error, 'TASK_LOCK_RECOVERY_UNCERTAIN'); }
      // The guard remains fail-closed after a recovery-process crash. Concurrent
      // operator filesystem edits are outside this experimental lock contract.
      let quarantine;
      try {
        await syncDirectory(this.locks);
        const lockPath = join(this.locks, id);
        let metadata;
        try { metadata = await lstat(lockPath); }
        catch (error) { if (error.code === 'ENOENT') return { recovered: false }; throw error; }
        if (!metadata.isDirectory()) fail('TASK_LOCK_RECOVERY_UNCERTAIN');
        const ownerPath = join(lockPath, 'owner.json');
        const ownerMetadata = await lstat(ownerPath);
        if (!ownerMetadata.isFile() || (ownerMetadata.mode & 0o777) !== 0o600) fail('TASK_LOCK_RECOVERY_UNCERTAIN');
        const rawOwner = await readFile(ownerPath, 'utf8');
        let owner;
        try { owner = JSON.parse(rawOwner); } catch { fail('TASK_LOCK_RECOVERY_UNCERTAIN'); }
        if (!validOwner(owner)) fail('TASK_LOCK_RECOVERY_UNCERTAIN');
        try { process.kill(owner.pid, 0); fail('TASK_BUSY', { retryable: true }); }
        catch (error) {
          if (error instanceof RuntimeError) throw error;
          if (error.code !== 'ESRCH') fail('TASK_LOCK_RECOVERY_UNCERTAIN');
        }
        if (!sameInode(metadata, await lstat(lockPath)) || !sameInode(ownerMetadata, await lstat(ownerPath)) || await readFile(ownerPath, 'utf8') !== rawOwner) fail('TASK_LOCK_RECOVERY_UNCERTAIN');
        quarantine = join(this.locks, `${id}.recovered-${randomBytes(8).toString('hex')}`);
        await rename(lockPath, quarantine);
        if (!sameInode(metadata, await lstat(quarantine)) || !sameInode(ownerMetadata, await lstat(join(quarantine, 'owner.json'))) || await readFile(join(quarantine, 'owner.json'), 'utf8') !== rawOwner) fail('TASK_LOCK_RECOVERY_UNCERTAIN');
        await unlink(join(quarantine, 'owner.json'));
        await rmdir(quarantine); quarantine = null;
        await syncDirectory(this.locks);
        return { recovered: true };
      } catch (error) { safeError(error, 'TASK_LOCK_RECOVERY_UNCERTAIN'); }
      finally {
        // An uncertain quarantine retains both its bytes and the recovery guard:
        // absence of the original pathname must not enable another execution.
        if (!quarantine) {
          try { await rmdir(guardPath); await syncDirectory(this.locks); }
          catch (error) { safeError(error, 'TASK_LOCK_RECOVERY_UNCERTAIN'); }
        }
      }
    });
  }
}
