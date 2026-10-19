import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { newTaskId, TaskStore } from '../src/task-store.mjs';

const fixture = () => ({ id: newTaskId(), sequence: 0, state: 'created', events: [], policy: { toolScope: ['evidence.read'] } });
const code = expected => error => error.code === expected && error.message === expected;

async function storeFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'fc-native-task-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new TaskStore(root) };
}

async function retainedLock(root, id, pid) {
  const path = join(root, 'locks', id);
  await mkdir(path, { mode: 0o700 });
  const owner = JSON.stringify({ pid, token: 'd'.repeat(32) });
  await writeFile(join(path, 'owner.json'), owner, { mode: 0o600 });
  return { path, owner };
}

test('a fresh instance verifies and loads complete checkpoints with a private key', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture();
  assert.deepEqual(await store.create(task), task);
  assert.equal((await lstat(join(root, 'integrity.key'))).mode & 0o777, 0o600);
  const updated = { ...task, sequence: 1, state: 'running', events: [{ type: 'started', step: 'read' }] };
  await store.save(updated, 0);
  assert.deepEqual(await new TaskStore(root).load(task.id), updated);
  const envelope = JSON.parse(await readFile(join(root, 'checkpoints', `${task.id}.json`), 'utf8'));
  assert.equal(envelope.algorithm, 'HMAC-SHA256');
  assert.equal(envelope.signature.length, 64);
});

test('CAS rejects stale saves and create never overwrites an existing task', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  await store.save({ ...task, sequence: 1, state: 'running' }, 0);
  await assert.rejects(new TaskStore(root).save({ ...task, sequence: 1, state: 'succeeded' }, 0), code('TASK_SEQUENCE_CONFLICT'));
  await assert.rejects(store.create(task), code('TASK_SEQUENCE_CONFLICT'));
  assert.equal((await store.load(task.id)).state, 'running');
});

test('same-process concurrent saves have one winner and exclusive calls are reentrant', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  const outcomes = await Promise.allSettled([
    store.exclusive(task.id, () => store.save({ ...task, sequence: 1, state: 'running' }, 0)),
    new TaskStore(root).save({ ...task, sequence: 1, state: 'succeeded' }, 0)
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'TASK_SEQUENCE_CONFLICT');
});

test('tampered task fields or signatures and invalid JSON fail integrity validation', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  const path = join(root, 'checkpoints', `${task.id}.json`);
  const original = await readFile(path, 'utf8');
  const envelope = JSON.parse(original); envelope.task.state = 'succeeded';
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(store.load(task.id), code('TASK_INTEGRITY_FAILURE'));
  await assert.rejects(store.save({ ...task, sequence: 1 }, 0), code('TASK_INTEGRITY_FAILURE'));
  envelope.task.state = 'created'; envelope.signature = 'f'.repeat(64);
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(store.load(task.id), code('TASK_INTEGRITY_FAILURE'));
  await writeFile(path, '{broken JSON');
  await assert.rejects(store.load(task.id), code('TASK_INTEGRITY_FAILURE'));
});

test('a missing or unsafe key cannot be regenerated for existing tasks', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  const keyPath = join(root, 'integrity.key');
  await chmod(keyPath, 0o644);
  await assert.rejects(store.load(task.id), code('TASK_STORE_KEY_UNAVAILABLE'));
  await chmod(keyPath, 0o600); await unlink(keyPath);
  await assert.rejects(store.load(task.id), code('TASK_STORE_KEY_UNAVAILABLE'));
  await assert.rejects(store.save({ ...task, sequence: 1 }, 0), code('TASK_STORE_KEY_UNAVAILABLE'));
  await assert.rejects(store.create(fixture()), code('TASK_STORE_KEY_UNAVAILABLE'));
  await assert.rejects(lstat(keyPath), error => error.code === 'ENOENT');
});

test('path traversal is rejected before filesystem operations', async t => {
  const { store } = await storeFor(t);
  for (const id of ['../../secret', 'task-' + 'a'.repeat(33), 'task-' + 'A'.repeat(32), null]) {
    await assert.rejects(store.load(id), code('TASK_ID_INVALID'));
    await assert.rejects(store.exclusive(id, () => {}), code('TASK_ID_INVALID'));
    await assert.rejects(store.recoverLock(id), code('TASK_ID_INVALID'));
  }
});

test('a live PID prevents lock recovery and its owner receipt is retained', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  const { path, owner } = await retainedLock(root, task.id, process.pid);
  await assert.rejects(store.recoverLock(task.id), code('TASK_BUSY'));
  await assert.rejects(store.save({ ...task, sequence: 1 }, 0), code('TASK_BUSY'));
  assert.equal(await readFile(join(path, 'owner.json'), 'utf8'), owner);
});

test('a verified dead child PID can be reclaimed explicitly before saving', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid; await once(child, 'exit');
  await retainedLock(root, task.id, pid);
  await assert.rejects(store.save({ ...task, sequence: 1 }, 0), code('TASK_BUSY'));
  assert.deepEqual(await store.recoverLock(task.id), { recovered: true });
  await store.save({ ...task, sequence: 1, state: 'running' }, 0);
  assert.equal((await store.load(task.id)).sequence, 1);
  assert.deepEqual(await store.recoverLock(task.id), { recovered: false });
});

test('untrusted or incomplete lock ownership is retained and fails closed', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  const { path } = await retainedLock(root, task.id, process.pid);
  await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: -1, token: 'bad' }));
  await assert.rejects(store.recoverLock(task.id), code('TASK_LOCK_RECOVERY_UNCERTAIN'));
  assert.ok((await lstat(path)).isDirectory());
});

test('another real process cannot save through a retained live lock', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  const moduleUrl = new URL('../src/task-store.mjs', import.meta.url).href;
  const script = `import { TaskStore } from ${JSON.stringify(moduleUrl)}; const store = new TaskStore(process.argv[1]); await store.exclusive(process.argv[2], async () => { process.stdout.write('locked\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, task.id], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('child exited before its lock'); })]);
  await assert.rejects(store.save({ ...task, sequence: 1 }, 0), code('TASK_BUSY'));
  await assert.rejects(store.recoverLock(task.id), code('TASK_BUSY'));
  const exited = once(child, 'exit'); child.stdin.end('release'); await exited;
  await store.save({ ...task, sequence: 1 }, 0);
});

test('a filesystem write failure cannot be reported as successful creation', async t => {
  const { root } = await storeFor(t);
  const invalidRoot = join(root, 'not-a-directory'); await writeFile(invalidRoot, 'fixture');
  await assert.rejects(new TaskStore(invalidRoot).create(fixture()), code('TASK_CHECKPOINT_WRITE_FAILED'));
  assert.equal(await readFile(invalidRoot, 'utf8'), 'fixture');
});

test('a real checkpoint publication I/O failure is surfaced and preserves the preceding checkpoint', async t => {
  const { root, store } = await storeFor(t);
  const task = fixture(); await store.create(task);
  const checkpoints = join(root, 'checkpoints');
  const retained = join(root, 'retained-checkpoints');
  const originalKey = store.key.bind(store);
  let calls = 0;
  // The trusted test hook changes the filesystem after load/CAS and before the
  // publication write. The failure comes from the actual Node filesystem call.
  store.key = async options => {
    const key = await originalKey(options);
    if (++calls === 2) {
      await rename(checkpoints, retained);
      await writeFile(checkpoints, 'not a directory', { mode: 0o600 });
    }
    return key;
  };
  await assert.rejects(store.save({ ...task, sequence: 1, state: 'succeeded' }, 0), code('TASK_CHECKPOINT_WRITE_FAILED'));
  await unlink(checkpoints); await rename(retained, checkpoints);
  assert.deepEqual(await new TaskStore(root).load(task.id), task);
});
