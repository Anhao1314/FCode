import { readFile, readdir, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 16 * 1024 * 1024 });
export function fail(code, path = '') { throw Object.assign(new Error(`${code}${path ? ': ' + path : ''}`), { code }); }
const forbidden = /(?:^|\/)(?:work|validation|node_modules|\.git|\.env(?:\.[^/]*)?|receipts|checkpoints|blobs|witness|identities)(?:\/|$)|\.(?:key|pem|p12|pfx|log|sqlite|db|tgz|zip)$|(?:^|\/)(?:history-identity|store-identity|owner)\.json$/i;
export function inspectEntry({ path, mode = '100644', bytes }) {
  if (!path || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || isAbsolute(path) || forbidden.test(path)) fail('R0_PRIVATE_OR_INVALID_PATH', path);
  if (!['100644', '100755'].includes(mode)) fail('R0_NON_REGULAR_FILE', path);
  if (bytes.length > 1024 * 1024 || bytes.includes(0)) fail('R0_UNREVIEWED_BINARY_OR_SIZE', path);
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text) || /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(text)) fail('R0_SECRET_PATTERN', path);
  if (/"(?:privateKey|privateKeyPem|assessmentAccessToken|accessToken)"\s*:\s*"[^"\n]{24,}"/.test(text)) fail('R0_PRIVATE_STATE_PATTERN', path);
  // The exact inherited negative fixture is checked separately by its T0 digest.
  if (/\/(?:Users|home)\//.test(text) && path !== 'packages/native-agent/test/trajectory.test.mjs' && path !== 'scripts/repository.mjs' && path !== 'test/repository.test.mjs') fail('R0_MACHINE_PATH', path);
}
export async function readRegular(root, path) {
  let cursor = root;
  for (const part of path.split('/')) { cursor = join(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) fail('R0_NON_REGULAR_FILE', path); }
  const info = await lstat(cursor); if (!info.isFile()) fail('R0_NON_REGULAR_FILE', path);
  return { path, mode: info.mode & 0o111 ? '100755' : '100644', bytes: await readFile(cursor) };
}
export async function publicEntries(root) {
  let files;
  try { await lstat(join(root, '.git')); files = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    files = [];
    const walk = async (dir = '') => { for (const item of await readdir(join(root, dir), { withFileTypes: true })) { const p = dir ? `${dir}/${item.name}` : item.name; if (['work', 'validation', 'packages/native-agent/validation', '.git', 'node_modules'].includes(p)) continue; if (item.isDirectory()) await walk(p); else files.push(p); } };
    await walk();
  }
  return Promise.all([...new Set(files)].sort().map(p => readRegular(root, p)));
}
export function auditEntries(entries) {
  const tree = new Map(entries.map(e => [e.path, e]));
  for (const e of entries) inspectEntry(e);
  const json = path => { if (!tree.has(path)) fail('R0_REQUIRED_FILE', path); return JSON.parse(tree.get(path).bytes); };
  const manifest = json('publication-files.json');
  if (manifest.version !== 'flowcredit.publication-files/r0-v1' || JSON.stringify([...new Set(manifest.files)].sort()) !== JSON.stringify([...tree.keys()].sort())) fail('R0_PUBLICATION_FILE_SET');
  const base = json('history/t0-source-hashes.json');
  for (const [path, digest] of Object.entries(base.files)) {
    const currentPath = base.archivedOriginals[path] || path;
    if (!tree.has(currentPath) || sha256(tree.get(currentPath).bytes) !== digest) fail('R0_T0_BASELINE_CHANGED', currentPath);
  }
  const pkg = json('package.json');
  if (!pkg.private || [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some(x => Object.keys(x || {}).length) || pkg.bin) fail('R0_DEPENDENCY_OR_PUBLISH_POLICY');
  let imports = 0, modules = 0;
  for (const { path, bytes } of entries) if (/\.(?:js|mjs)$/.test(path)) {
    modules++;
    for (const match of bytes.toString().matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g)) {
      const specifier = match[2]; imports++; if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith('.')) fail('R0_EXTERNAL_IMPORT', path);
      const target = relative('/candidate', resolve('/candidate', dirname(path), specifier));
      if (!tree.has(target)) fail('R0_MISSING_OR_ESCAPING_IMPORT', path);
    }
  }
  const example = tree.get('examples/offline-structural-candidates.jsonl').bytes;
  if (sha256(example) !== json('examples/manifest.json').sha256) fail('R0_SAMPLE_HASH');
  if (/Bearer|accessToken|authorization|https:\/\/|@/.test(example.toString())) fail('R0_SAMPLE_PRIVACY');
  return { files: entries.length, modules, imports, inheritedModules: Object.keys(base.files).filter(p => /\.(js|mjs)$/.test(p)).length, sourceTreeHash: sha256(JSON.stringify(entries.map(e => [e.path, sha256(e.bytes)]).sort())) };
}
export async function auditRepository(root, { history = true } = {}) {
  const result = auditEntries(await publicEntries(root));
  try { await lstat(join(root, '.git')); } catch (error) { if (error.code === 'ENOENT') return { ...result, gitTreesChecked: 0 }; throw error; }
  const indexed = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  const revisions = git(root, ['rev-list', '--all']).trim().split('\n').filter(Boolean);
  // Inspect the actual index bytes; a sanitized worktree must not hide a staged secret.
  for (const row of indexed) { const [header, path] = row.split('\t'); const [mode, object, stage] = header.split(' '); if (stage !== '0') fail('R0_UNMERGED_INDEX'); inspectEntry({ path, mode, bytes: Buffer.from(git(root, ['cat-file', 'blob', object])) }); }
  // An unborn empty index is allowed for preflight. Every commit candidate must
  // contain the complete reviewed file set, including after staged deletions.
  if (indexed.length || revisions.length) {
    auditEntries(indexed.map(row => { const [header, path] = row.split('\t'); const [mode, object] = header.split(' '); return { path, mode, bytes: Buffer.from(git(root, ['cat-file', 'blob', object])) }; }));
    const worktree = new Map((await publicEntries(root)).map(e => [e.path, sha256(e.bytes)]));
    for (const row of indexed) { const [header, path] = row.split('\t'); const object = header.split(' ')[1]; if (sha256(Buffer.from(git(root, ['cat-file', 'blob', object]))) !== worktree.get(path)) fail('R0_STAGED_WORKTREE_MISMATCH', path); }
  }
  let gitTreesChecked = 0;
  if (history) for (const revision of revisions) {
    const entries = git(root, ['ls-tree', '-r', '-z', revision]).split('\0').filter(Boolean).map(row => { const [header, path] = row.split('\t'); const [mode, type, object] = header.split(' '); if (type !== 'blob') fail('R0_NON_REGULAR_FILE', path); return { path, mode, bytes: Buffer.from(git(root, ['cat-file', 'blob', object])) }; });
    auditEntries(entries); gitTreesChecked++;
  }
  return { ...result, gitTreesChecked };
}
