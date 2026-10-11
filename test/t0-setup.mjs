import { mkdir, lstat } from 'node:fs/promises';
for (const relative of ['../work/', '../validation/', '../packages/native-agent/validation/']) {
  const path = new URL(relative, import.meta.url); await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path); if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw Error('T0 protected test artifact directory required');
}
await import('./setup.mjs');
