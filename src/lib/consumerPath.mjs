import { lstat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

/** Resolve a normalized repo-relative path and require a regular, non-symlink file. */
export async function validateConsumerFile(consumerRoot, path) {
  if (typeof path !== 'string' || !path || path === '.' || isAbsolute(path) || normalize(path) !== path) {
    throw new Error(`unsafe consumer path: ${path}`);
  }
  const root = resolve(consumerRoot);
  const absolute = resolve(join(root, path));
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot.startsWith(`..${separator()}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error(`unsafe consumer path: ${path}`);
  }
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`unsafe consumer path (not a regular file): ${path}`);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`unsafe consumer path (not a regular file): ${path}`);
  }
  return absolute;
}

function separator() {
  return process.platform === 'win32' ? '\\' : '/';
}
