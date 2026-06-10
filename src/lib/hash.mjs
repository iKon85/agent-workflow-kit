import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** sha256 hex digest of a file's raw bytes. */
export async function sha256File(path) {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

/** sha256 hex digest of an in-memory string/buffer. */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
