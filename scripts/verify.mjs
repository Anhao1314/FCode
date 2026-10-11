import { mkdir, lstat, mkdtemp, writeFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepository, publicEntries, fail } from './repository.mjs';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function testEnvironment(tmp) { return { PATH: process.env.PATH, NODE_ENV: 'test', FC_COPILOT_BACKEND: 'disabled', TMPDIR: tmp, TMP: tmp, TEMP: tmp, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' }; }
export async function privateDirectory(path) { await mkdir(path, { recursive: true, mode: 0o700 }); const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) fail('R0_PRIVATE_DIRECTORY_REQUIRED'); }
export function selectTests(files, group) {
  const original = files.filter(p => /^(packages\/native-agent\/test\/.*\.test\.mjs|vendor\/flowcredit-finance\/test\/.*\.test\.js)$/.test(p)).sort();
  const choices = {
    all: [...original, 'test/repository.test.mjs'],
    repository: ['test/repository.test.mjs'],
    legacy: original.filter(p => p.startsWith('packages/') && !/(deepseek|trajectory)\.test/.test(p)),
    finance: original.filter(p => p.startsWith('vendor/')),
    deepseek: original.filter(p => p.endsWith('/deepseek.test.mjs')),
    trajectory: original.filter(p => p.endsWith('/trajectory.test.mjs'))
  };
  if (!Object.hasOwn(choices, group)) fail('R0_UNKNOWN_TEST_GROUP');
  return choices[group];
}
export async function verify(root = repositoryRoot, group = 'all') {
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.platform === 'win32') fail('R0_REQUIRES_NODE_24_POSIX');
  process.umask(0o077);
  const audit = await auditRepository(root), entries = await publicEntries(root);
  await privateDirectory(join(root, 'work')); await privateDirectory(join(root, 'validation'));
  await privateDirectory(join(root, 'work/r0-runs')); await privateDirectory(join(root, 'validation/r0'));
  const runRoot = await mkdtemp(join(root, 'work/r0-runs/run-')), runId = runRoot.split('/').at(-1), copyRoot = join(runRoot, 'repository');
  await privateDirectory(copyRoot); const tmp = join(runRoot, 'tmp'); await privateDirectory(tmp);
  for (const { path, bytes } of entries) { await mkdir(dirname(join(copyRoot, path)), { recursive: true, mode: 0o700 }); await writeFile(join(copyRoot, path), bytes, { flag: 'wx', mode: 0o600 }); }
  const logRoot = join(root, 'validation/r0', runId); await privateDirectory(logRoot);
  const log = await open(join(logRoot, 'tests.tap'), 'wx', 0o600), errorLog = await open(join(logRoot, 'stderr.log'), 'wx', 0o600);
  const tests = selectTests(entries.map(e => e.path), group), startedAt = new Date().toISOString();
  console.log(JSON.stringify({ event: 'R0_TEST_START', runId, group, files: tests.length, inheritedModules: audit.inheritedModules }));
  const child = spawn(process.execPath, ['--import', './test/t0-setup.mjs', '--test', '--test-concurrency=1', '--test-reporter=tap', ...tests], { cwd: copyRoot, env: testEnvironment(tmp), stdio: ['ignore', log.fd, errorLog.fd] });
  const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })); });
  await log.close(); await errorLog.close();
  const { readFile } = await import('node:fs/promises');
  const tap = await readFile(join(logRoot, 'tests.tap'), 'utf8'), totals = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) totals[key] = Number(tap.match(new RegExp(`^# ${key} ([0-9.]+)$`, 'm'))?.[1] ?? NaN);
  const summary = { version: 'flowcredit.repository-validation/r0-v1', runId, group, startedAt, finishedAt: new Date().toISOString(), node: process.version, platform: process.platform, audit, ...result, totals, rawEvidence: 'private-local-only', environmentAllowlisted: true, osNetworkSandbox: false };
  await writeFile(join(logRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ event: 'R0_TEST_RESULT', runId, code: result.code, totals }));
  if (result.code !== 0 || result.signal || !totals.tests || totals.fail || totals.cancelled || totals.skipped || totals.todo || totals.pass !== totals.tests) fail('R0_TEST_GATE_FAILED', runId);
  if (group === 'all' && totals.tests !== 291) fail('R0_TEST_COUNT_CHANGED', runId);
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length > 3) fail('R0_UNKNOWN_ARGUMENT'); await verify(repositoryRoot, process.argv[2] || 'all'); }
  catch (error) { console.error(error.code || 'R0_VERIFY_ERROR', error.code ? error.message : 'See local failure and source; no environment values logged'); process.exitCode = 1; }
}
