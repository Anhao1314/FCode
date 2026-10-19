import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicEntries, auditRepository, sha256, fail } from './repository.mjs';
import { privateDirectory, repositoryRoot, testEnvironment } from './verify.mjs';
import { verifyT1 } from './verify-t1.mjs';

export async function verifyT2(root = repositoryRoot, all = false, namePattern = null) {
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.platform === 'win32') fail('R0_REQUIRES_NODE_24_POSIX');
  process.umask(0o077);
  if (all) await verifyT1(root, true);
  const inherited = JSON.parse(await readFile(join(root, 'research/t2-a/t1-module-hashes.json')));
  for (const [path, hash] of Object.entries(inherited.modules)) if (sha256(await readFile(join(root, path))) !== hash) fail('T2_T1_MODULE_CHANGED', path);
  const audit = await auditRepository(root), entries = await publicEntries(root);
  for (const p of ['work', 'validation', 'work/t2-runs', 'validation/t2']) await privateDirectory(join(root, p));
  const runRoot = await mkdtemp(join(root, 'work/t2-runs/run-')), runId = runRoot.split('/').at(-1), copy = join(runRoot, 'repository'), tmp = join(runRoot, 'tmp'), logs = join(root, 'validation/t2', runId);
  for (const p of [copy, tmp, logs]) await privateDirectory(p);
  for (const { path, bytes } of entries) { await mkdir(dirname(join(copy, path)), { recursive: true, mode: 0o700 }); await writeFile(join(copy, path), bytes, { mode: 0o600, flag: 'wx' }); }
  const out = await open(join(logs, 'tests.tap'), 'wx', 0o600), err = await open(join(logs, 'stderr.log'), 'wx', 0o600), startedAt = new Date().toISOString();
  console.log(JSON.stringify({ event: 'T2_TEST_START', runId })); const mask = process.umask(0o022); let child;
  try { child = spawn(process.execPath, ['--import', './test/t0-setup.mjs', '--test', '--test-concurrency=1', '--test-reporter=tap', ...(namePattern ? [`--test-name-pattern=${namePattern}`] : []), 'research/t2-a/test/benchmark.test.mjs'], { cwd: copy, env: testEnvironment(tmp), stdio: ['ignore', out.fd, err.fd] }); } finally { process.umask(mask); }
  const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })); }); await out.close(); await err.close();
  const tap = await readFile(join(logs, 'tests.tap'), 'utf8'), totals = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) totals[key] = Number(tap.match(new RegExp(`^# ${key} ([0-9.]+)$`, 'm'))?.[1] ?? NaN);
  const summary = { version: 'flowcredit.t2-validation/v1', runId, startedAt, finishedAt: new Date().toISOString(), focusedPattern: namePattern, audit, ...result, totals, privateRunRoot: runRoot, inheritedModules: Object.keys(inherited.modules).length, realModelCalls: 0, trainingRuns: 0, osNetworkSandbox: false };
  await writeFile(join(logs, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 }); console.log(JSON.stringify({ event: 'T2_TEST_RESULT', runId, ...result, totals }));
  if (result.code !== 0 || result.signal || totals.fail || totals.cancelled || totals.todo || (!namePattern && (totals.tests !== 14 || totals.pass !== 14 || totals.skipped)) || namePattern && !totals.pass) fail('T2_TEST_GATE_FAILED', runId);
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== 'all') fail('T2_UNKNOWN_ARGUMENT'); await verifyT2(repositoryRoot, process.argv[2] === 'all'); }
  catch (e) { console.error(e.code || 'T2_VERIFY_ERROR', e.code ? e.message : 'See retained local evidence'); process.exitCode = 1; }
}
