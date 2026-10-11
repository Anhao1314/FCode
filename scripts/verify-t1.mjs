import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepository, publicEntries, fail, sha256 } from './repository.mjs';
import { privateDirectory, repositoryRoot, testEnvironment, verify } from './verify.mjs';

export async function verifyT1(root = repositoryRoot, all = false) {
  if (Number(process.versions.node.split('.')[0]) !== 24 || process.platform === 'win32') fail('R0_REQUIRES_NODE_24_POSIX');
  process.umask(0o077);
  if (all) await verify(root, 'all'); // Preserve the original, independent 291-test gate.
  const audit = await auditRepository(root), entries = await publicEntries(root);
  const r0 = JSON.parse(await readFile(join(root, 'research/t1/r0-module-hashes.json')));
  for (const [path, hash] of Object.entries(r0.modules)) if (sha256(await readFile(join(root, path))) !== hash) fail('T1_R0_MODULE_CHANGED', path);
  for (const p of ['work', 'validation', 'work/t1-runs', 'validation/t1']) await privateDirectory(join(root, p));
  const runRoot = await mkdtemp(join(root, 'work/t1-runs/run-')), runId = runRoot.split('/').at(-1), copy = join(runRoot, 'repository'), tmp = join(runRoot, 'tmp'), logs = join(root, 'validation/t1', runId);
  for (const p of [copy, tmp, logs]) await privateDirectory(p);
  for (const { path, bytes } of entries) { await mkdir(dirname(join(copy, path)), { recursive: true, mode: 0o700 }); await writeFile(join(copy, path), bytes, { flag: 'wx', mode: 0o600 }); }
  const out = await open(join(logs, 'tests.tap'), 'wx', 0o600), err = await open(join(logs, 'stderr.log'), 'wx', 0o600);
  const start = Date.now(); console.log(JSON.stringify({ event: 'T1_TEST_START', runId }));
  const mask = process.umask(0o022); let child;
  try { child = spawn(process.execPath, ['--import', './test/t0-setup.mjs', '--test', '--test-concurrency=1', '--test-reporter=tap', 'research/t1/test/dataset.test.mjs'], { cwd: copy, env: testEnvironment(tmp), stdio: ['ignore', out.fd, err.fd] }); } finally { process.umask(mask); }
  const result = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })); });
  await out.close(); await err.close();
  const tap = await readFile(join(logs, 'tests.tap'), 'utf8'), totals = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) totals[key] = Number(tap.match(new RegExp(`^# ${key} ([0-9.]+)$`, 'm'))?.[1] ?? NaN);
  const summary = { version: 'flowcredit.t1-validation/v1', runId, audit, elapsedMs: Date.now() - start, ...result, totals, privateRunRoot: runRoot, inheritedModuleCount: Object.keys(r0.modules).length, environmentAllowlisted: true, osNetworkSandbox: false };
  await writeFile(join(logs, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ event: 'T1_TEST_RESULT', runId, ...result, totals }));
  if (result.code !== 0 || result.signal || totals.tests !== 14 || totals.pass !== 14 || totals.fail || totals.skipped || totals.cancelled || totals.todo) fail('T1_TEST_GATE_FAILED', runId);
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== 'all') fail('T1_UNKNOWN_ARGUMENT'); await verifyT1(repositoryRoot, process.argv[2] === 'all'); }
  catch (error) { console.error(error.code || 'T1_VERIFY_ERROR', error.code ? error.message : 'See retained local evidence'); process.exitCode = 1; }
}
