import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditEntries, auditRepository, inspectEntry, publicEntries, git } from '../scripts/repository.mjs';
import { selectTests, testEnvironment, privateDirectory } from '../scripts/verify.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = await publicEntries(root);
const mutate = (path, f) => entries.map(e => e.path === path ? { ...e, bytes: Buffer.from(f(e.bytes.toString())) } : e);
const secret = ['sk', '-', 'r0syntheticcanary12345678901234567890'].join('');
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'r0-repository-')); for (const e of entries) { await mkdir(dirname(join(dir, e.path)), { recursive: true }); await writeFile(join(dir, e.path), e.bytes); } git(dir, ['init', '--initial-branch=main']); return dir; }
const commit = dir => git(dir, ['-c', 'user.name=R0 synthetic test', '-c', 'user.email=r0-test@local.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Synthetic local publication attack fixture']);

test('R0 accepted T0 modules, publication list and complete original suite are preserved', () => {
  assert.equal(auditEntries(entries).inheritedModules, 76);
  const all = selectTests(entries.map(e => e.path), 'all');
  assert.equal(all.length, 17); assert.equal(all.filter(p => p.startsWith('vendor/')).length, 6);
  assert.equal(selectTests(entries.map(e => e.path), 'legacy').length, 8);
  assert.throws(() => selectTests([], 'unknown'), { code: 'R0_UNKNOWN_TEST_GROUP' });
});
test('R0 rejects private key/token/state patterns in otherwise public file paths', () => {
  for (const body of [secret, ['-----BEGIN ', 'PRIVATE KEY-----'].join(''), JSON.stringify({ accessToken: '0'.repeat(64) })]) assert.throws(() => inspectEntry({ path: 'docs/note.md', bytes: Buffer.from(body) }), /R0_(SECRET|PRIVATE_STATE)_PATTERN/);
});
test('R0 rejects private paths, links, submodules, traversal and binary artifacts', () => {
  for (const path of ['.env', 'work/run.json', 'validation/log.txt', 'foo/receipts/a.json', 'secret.pem', '../escape', '/tmp/escape']) assert.throws(() => inspectEntry({ path, bytes: Buffer.from('safe') }), { code: 'R0_PRIVATE_OR_INVALID_PATH' });
  for (const mode of ['120000', '160000']) assert.throws(() => inspectEntry({ path: 'docs/link', mode, bytes: Buffer.from('safe') }), { code: 'R0_NON_REGULAR_FILE' });
  assert.throws(() => inspectEntry({ path: 'docs/binary', bytes: Buffer.from([0]) }), { code: 'R0_UNREVIEWED_BINARY_OR_SIZE' });
});
test('R0 refuses changed inherited Runtime or test bytes', () => {
  for (const path of ['packages/native-agent/src/durable-harness.mjs', 'packages/native-agent/test/trajectory.test.mjs']) assert.throws(() => auditEntries(mutate(path, text => text + '\n// altered\n')), { code: 'R0_T0_BASELINE_CHANGED' });
});
test('R0 refuses missing/unreviewed files even when gitignore would be insufficient', () => {
  assert.throws(() => auditEntries(entries.slice(1)), /R0_(PUBLICATION_FILE_SET|REQUIRED_FILE)/);
  assert.throws(() => auditEntries([...entries, { path: 'docs/unreviewed.json', bytes: Buffer.from('{}') }]), { code: 'R0_PUBLICATION_FILE_SET' });
});
test('R0 refuses new dependencies and public package publishing', () => {
  for (const changes of [{ private: false }, { dependencies: { external: '1' } }]) assert.throws(() => auditEntries(mutate('package.json', text => JSON.stringify({ ...JSON.parse(text), ...changes }))), { code: 'R0_DEPENDENCY_OR_PUBLISH_POLICY' });
});
test('R0 test child environment contains no inherited model variables or injection flags', () => {
  const env = testEnvironment('/tmp/r0-synthetic');
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'NODE_ENV', 'FC_COPILOT_BACKEND', 'TMPDIR', 'TMP', 'TEMP', 'TZ', 'LANG', 'LC_ALL'].sort());
  assert.equal(env.FC_COPILOT_BACKEND, 'disabled'); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.DEEPSEEK_API_KEY, undefined);
});
test('R0 rejects insecure or symlinked artifact roots without repairing their permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r0-private-')), unsafe = join(dir, 'unsafe');
  await mkdir(unsafe); await chmod(unsafe, 0o755); await assert.rejects(privateDirectory(unsafe), { code: 'R0_PRIVATE_DIRECTORY_REQUIRED' });
  const link = join(dir, 'link'); await symlink(unsafe, link); await assert.rejects(privateDirectory(link), { code: 'R0_PRIVATE_DIRECTORY_REQUIRED' });
});
test('R0 scans actual staged bytes, not merely the sanitized working copy', async () => {
  const dir = await fixture(), original = entries.find(e => e.path === 'README.md').bytes;
  await writeFile(join(dir, 'README.md'), secret); git(dir, ['add', 'README.md']); await writeFile(join(dir, 'README.md'), original);
  await assert.rejects(auditRepository(dir), { code: 'R0_SECRET_PATTERN' });
});
test('R0 rejects a removed secret still reachable in Git history', async () => {
  const dir = await fixture(), original = entries.find(e => e.path === 'README.md').bytes;
  await writeFile(join(dir, 'README.md'), secret); git(dir, ['add', '.']); commit(dir);
  await writeFile(join(dir, 'README.md'), original); git(dir, ['add', 'README.md']); commit(dir);
  await assert.rejects(auditRepository(dir), { code: 'R0_SECRET_PATTERN' });
});
test('R0 rejects staged deletion even while the full original file remains in the worktree', async () => {
  const dir = await fixture(); git(dir, ['add', '.']);
  git(dir, ['rm', '--cached', 'packages/native-agent/src/durable-harness.mjs']);
  await assert.rejects(auditRepository(dir), { code: 'R0_PUBLICATION_FILE_SET' });
});
