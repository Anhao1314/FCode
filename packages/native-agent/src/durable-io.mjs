import { open, link, unlink, rename, readFile, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { RuntimeError, fail } from './contracts.mjs';
import { dirname } from 'node:path';

export async function syncDir(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function publishBytes(path, content, { immutable = false } = {}) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
    if (immutable) await link(temporary, path);
    else await rename(temporary, path);
    await syncDir(dirname(path));
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    fail(error.code === 'EEXIST' ? 'M1_IMMUTABLE_CONFLICT' : 'M1_STORAGE_FAILURE');
  } finally { if (handle) await handle.close(); await unlink(temporary).catch(() => {}); }
}
export async function privateBytes(path, limit = 1024 * 1024) {
  let metadata, bytes;
  try {
    metadata = await lstat(path);
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size > limit) fail('M1_INTEGRITY_FAILURE');
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    fail(error.code === 'ENOENT' ? 'M1_RECORD_MISSING' : 'M1_INTEGRITY_FAILURE');
  }
  return bytes;
}
