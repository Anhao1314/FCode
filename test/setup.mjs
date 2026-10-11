import { mkdir } from 'node:fs/promises';

// Test artifact directories are generated locally and ignored by Git. Existing
// accepted test bodies and assertions remain byte-for-byte unchanged.
await Promise.all([
  mkdir(new URL('../validation/', import.meta.url), { recursive: true }),
  mkdir(new URL('../packages/native-agent/validation/', import.meta.url), { recursive: true })
]);
