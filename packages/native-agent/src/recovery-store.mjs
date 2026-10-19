import { mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DurableTaskStore } from './durable-store.mjs';
import { digest } from './baseline.mjs';
import { fail } from './contracts.mjs';
import { privateBytes, publishBytes, syncDir } from './durable-io.mjs';

export const RECOVERY_VERSION = 'flowcredit.durable-recovery/m5-v1';

const validId = id => typeof id === 'string' && /^task-[a-f0-9]{32}$/.test(id);
const historyEntry = name => /^\d+\.json$/.test(name);
const sequenceOf = name => Number.parseInt(name, 10);
const CACHE_LIMIT = 32;

// M5 is additive: the accepted M1 store stays byte-identical. This subclass adds
// exactly two behaviours and changes no storage format.
//
// 1. repairHistory() closes the history-before-witness window. A crash between
//    publishing an immutable history entry and publishing its witness left the
//    task permanently unreadable: anchored() raised M1_HISTORY_AHEAD and
//    recoverLatest() raised it again, because recovery also starts from anchored().
//    Entries beyond the witness were never attested, so they are neither trusted
//    nor deleted: they are moved byte-for-byte into quarantine/ and the repair is
//    sealed into recovery-evidence/. The witness stays the only source of truth.
//
// 2. anchored() keeps a process-local verified cache keyed by the witness bytes.
//    Without it every load() replayed and re-HMAC'd the entire history, and
//    commit() replayed it twice, so a task with N checkpoints cost O(N^2) reads.
//    The witness is still re-read and re-verified on every call, so a changed
//    anchor always misses the cache. The cache is deliberately process-local: a
//    restart re-verifies the full chain, and an attacker able to rewrite history
//    while the process lives is already outside this store's stated threat model.
export class RecoveringDurableTaskStore extends DurableTaskStore {
  constructor(root, options) {
    super(root, options);
    this.verified = new Map();
  }
  remember(id, entry) {
    this.verified.delete(id);
    this.verified.set(id, entry);
    while (this.verified.size > CACHE_LIMIT) this.verified.delete(this.verified.keys().next().value);
  }
  forget(id) { this.verified.delete(id); }
  async witnessOf(id) {
    const { key } = await this.authority();
    const bytes = await privateBytes(join(this.witnessRoot, `${id}.json`));
    return { witness: this.parseVerified(bytes, key), hash: digest(bytes.toString('utf8')) };
  }
  async anchored(id) {
    if (!validId(id)) fail('TASK_ID_INVALID');
    const { witness, hash } = await this.witnessOf(id);
    const cached = this.verified.get(id);
    if (cached && cached.witnessHash === hash) return { task: structuredClone(cached.task), witness: structuredClone(witness), historyHash: cached.historyHash };
    const result = await super.anchored(id);
    this.remember(id, { witnessHash: hash, task: structuredClone(result.task), historyHash: result.historyHash });
    return result;
  }
  async commit(task, current) {
    await super.commit(task, current);
    const { hash } = await this.witnessOf(task.id);
    const entry = await privateBytes(join(this.history, task.id, `${task.sequence}.json`), 2 * 1024 * 1024);
    this.remember(task.id, { witnessHash: hash, task: structuredClone(task), historyHash: digest(entry.toString('utf8')) });
  }
  // Explicit, operator-initiated repair. Never called from load(): reads stay
  // strictly fail-closed, and only a deliberate recovery may move bytes.
  async repairHistory(id) {
    if (!validId(id)) fail('TASK_ID_INVALID');
    try {
      await super.anchored(id);
      return { repaired: false, quarantined: [], sequence: null };
    } catch (error) {
      if (error.code !== 'M1_HISTORY_AHEAD') throw error;
    }
    const { witness } = await this.witnessOf(id);
    if (!Number.isSafeInteger(witness?.sequence) || witness.sequence < 0) fail('M1_WITNESS_MISMATCH');
    const directory = join(this.history, id);
    const orphans = (await readdir(directory).catch(() => fail('M1_RECORD_MISSING')))
      .filter(historyEntry).filter(name => sequenceOf(name) > witness.sequence).sort((a, b) => sequenceOf(a) - sequenceOf(b));
    // A gap below the witness means attested bytes are missing. That is data loss,
    // not an interrupted commit, and it must never be "repaired" by deletion.
    if (!orphans.length) fail('M1_HISTORY_AHEAD');
    const quarantine = join(this.root, 'quarantine', id);
    await mkdir(quarantine, { recursive: true, mode: 0o700 });
    const moved = [];
    for (const name of orphans) {
      const source = join(directory, name);
      const bytes = await privateBytes(source, 2 * 1024 * 1024);
      await rename(source, join(quarantine, name));
      moved.push({ name, hash: digest(bytes.toString('utf8')) });
    }
    await syncDir(directory);
    await syncDir(quarantine);
    this.forget(id);
    const evidence = join(this.root, 'recovery-evidence');
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    const record = { version: RECOVERY_VERSION, id, witnessSequence: witness.sequence, witnessHash: witness.historyHash, quarantined: moved, reason: 'unattested-history-quarantined' };
    await publishBytes(join(evidence, `${id}-${randomBytes(8).toString('hex')}.json`), JSON.stringify(await this.seal(record)), { immutable: true });
    await super.anchored(id);
    return { repaired: true, quarantined: moved, sequence: witness.sequence };
  }
  async recoverLatest(id) {
    return this.exclusive(id, async () => {
      const repair = await this.repairHistory(id);
      const anchored = await this.anchored(id);
      let current;
      try { current = await super.load(id); } catch (error) { if (error.code !== 'TASK_NOT_FOUND') throw error; }
      if (current && (current.sequence > anchored.task.sequence || current.sequence === anchored.task.sequence && digest(current) !== digest(anchored.task))) fail('M1_CHECKPOINT_DIVERGENCE');
      if (current && digest(current) === digest(anchored.task)) return { recovered: false, repaired: repair.repaired, quarantined: repair.quarantined.length, sequence: current.sequence };
      const directory = join(this.root, 'recovery-evidence');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const previousCheckpointBytes = current ? (await privateBytes(join(this.checkpoints, `${id}.json`), 2 * 1024 * 1024)).toString('utf8') : null;
      const record = { version: RECOVERY_VERSION, id, fromSequence: current?.sequence ?? null, toSequence: anchored.task.sequence, fromTaskHash: current ? digest(current) : null, previousCheckpointBytes, anchoredHash: anchored.historyHash, repair: repair.repaired ? repair.quarantined : null, reason: 'explicit-witness-matched-recovery' };
      await publishBytes(join(directory, `${id}-${randomBytes(8).toString('hex')}.json`), JSON.stringify(await this.seal(record)), { immutable: true });
      await super.publish(anchored.task, await super.key());
      this.forget(id);
      return { recovered: true, repaired: repair.repaired, quarantined: repair.quarantined.length, sequence: anchored.task.sequence };
    });
  }
}
