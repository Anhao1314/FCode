import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import { linkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { DurableTaskStore } from './durable-store.mjs';
import { digest, stable } from './baseline.mjs';
import { exactKeys, fail } from './contracts.mjs';
import { privateBytes, publishBytes, syncDir } from './durable-io.mjs';

export const TRAJECTORY_VERSION = 'flowcredit.trajectory/t0-v1';
export const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) fail('T0_PRIVATE_DIRECTORY_REQUIRED');
}
export async function publishApprovedArtifact(path, bytes, approve) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
    const expiresAt = await approve();
    // No asynchronous gap between the final time check and atomic publication.
    if (expiresAt <= Date.now()) fail('T0_EXPORT_RIGHTS_DENIED');
    linkSync(temporary, path); await syncDir(dirname(path));
  } finally { if (handle) await handle.close(); await unlink(temporary).catch(() => {}); }
}
export class TrajectoryStore extends DurableTaskStore {
  constructor(root, { afterPhase } = {}) { super(join(root, 'records'), { witnessRoot: join(root, 'witness'), afterPhase }); this.localRoot = root; this.blobs = join(root, 'blobs'); }
  async initialize() {
    for (const path of [this.localRoot, this.root, this.witnessRoot, this.blobs]) await privateDirectory(path);
    await super.initialize();
    for (const path of [this.checkpoints, this.locks, this.history]) await privateDirectory(path);
  }
  validateTask(record, current = null) {
    if (!exactKeys(record, ['id', 'version', 'sequence', 'originHash', 'captures', 'events']) || !/^task-[a-f0-9]{32}$/.test(record.id) || record.version !== TRAJECTORY_VERSION || !hash(record.originHash) || !Number.isSafeInteger(record.sequence) || !Array.isArray(record.events) || !Array.isArray(record.captures) || record.sequence !== record.events.length || record.captures.length !== record.sequence || record.captures.length > 64 || Buffer.byteLength(stable(record)) > 1024 * 1024) fail('T0_RECORD_INTEGRITY');
    let previous = null;
    for (const [index, event] of record.events.entries()) {
      const { hash: eventHash, ...data } = event;
      if (data.sequence !== index + 1 || data.previousHash !== previous || digest(data) !== eventHash || !Number.isFinite(Date.parse(data.at))) fail('T0_RECORD_INTEGRITY');
      previous = eventHash;
    }
    const refs = new Set();
    for (const capture of record.captures) {
      if (!exactKeys(capture, ['ref', 'loopSequence', 'quality', 'at']) || !hash(capture.ref) || !Number.isSafeInteger(capture.loopSequence) || capture.loopSequence < 0 || !Number.isFinite(Date.parse(capture.at)) || refs.has(capture.ref)) fail('T0_RECORD_INTEGRITY');
      refs.add(capture.ref);
    }
    if (current && (record.sequence !== current.sequence + 1 || record.originHash !== current.originHash || record.id !== current.id || stable(record.captures.slice(0, -1)) !== stable(current.captures) || stable(record.events.slice(0, -1)) !== stable(current.events) || record.captures.at(-1).loopSequence < current.captures.at(-1)?.loopSequence)) fail('T0_HISTORY_REWRITE');
  }
  async blob(ref) {
    if (!hash(ref)) fail('T0_BLOB_REQUIRED');
    const blob = await this.unseal(await privateBytes(join(this.blobs, `${ref}.json`), 2 * 1024 * 1024));
    if (!exactKeys(blob, ['version', 'ref', 'payload']) || blob.version !== TRAJECTORY_VERSION || blob.ref !== ref || digest(blob.payload) !== ref) fail('T0_BLOB_INTEGRITY');
    return blob.payload;
  }
  async publishBlob(payload) {
    const ref = digest(payload), path = join(this.blobs, `${ref}.json`);
    if (Buffer.byteLength(stable(payload)) > 1900 * 1024) fail('T0_CAPTURE_LIMIT');
    try { await lstat(path); if (stable(await this.blob(ref)) !== stable(payload)) fail('T0_BLOB_INTEGRITY'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await publishBytes(path, JSON.stringify(await this.seal({ version: TRAJECTORY_VERSION, ref, payload })), { immutable: true }); }
    return ref;
  }
}
