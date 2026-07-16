import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { writeAtomic } from './atomicWrite.mjs';

const sha256 = (body) => createHash('sha256').update(body).digest('hex');

async function readSnapshot(consumerRoot, snapshot) {
  return Promise.all(snapshot.map(async ({ path }) => {
    const body = await readFile(join(consumerRoot, path), 'utf8');
    return { path, body, version: JSON.parse(body).version, sha256: sha256(body) };
  }));
}

const escapes = (root, target) => {
  const path = relative(root, target);
  return path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(path);
};

export async function assertSafeReleaseTargets(consumerRoot, paths) {
  const canonicalRoot = await realpath(consumerRoot);
  for (const path of paths) {
    const target = resolve(consumerRoot, path);
    if (isAbsolute(path) || escapes(resolve(consumerRoot), target)) {
      throw new Error(`release target is outside consumer root: ${path}`);
    }
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`symlinked release target is not allowed: ${path}`);
    }
    if (escapes(canonicalRoot, await realpath(target))) {
      throw new Error(`release target resolves outside consumer root: ${path}`);
    }
  }
}

export async function applyProjectRelease(options) {
  const { consumerRoot, preview, confirmation } = options;
  const write = options.write ?? writeAtomic;
  if (preview.status !== 'ready') throw new Error('release preview is blocked');
  if (confirmation !== preview.confirmation) {
    throw new Error('release confirmation does not match preview');
  }
  await assertSafeReleaseTargets(
    consumerRoot, preview.snapshot.map(({ path }) => path),
  );
  const current = await readSnapshot(consumerRoot, preview.snapshot);
  if (current.every(({ version }) => version === preview.summary.targetVersion)) {
    throw new Error(`release already prepared at ${preview.summary.targetVersion}`);
  }
  for (const expected of preview.snapshot) {
    const actual = current.find(({ path }) => path === expected.path);
    if (actual.sha256 !== expected.sha256) {
      throw new Error(`release target changed after preview: ${expected.path}`);
    }
  }
  const version = preview.summary.targetVersion;
  const candidates = current.map((file) => {
    const body = JSON.parse(file.body);
    body.version = version;
    return { ...file, next: `${JSON.stringify(body, null, 2)}\n` };
  });
  const written = [];
  try {
    for (const file of candidates) {
      await write(join(consumerRoot, file.path), file.next);
      written.push(file);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      await writeAtomic(join(consumerRoot, file.path), file.body);
    }
    throw error;
  }
  return {
    status: 'prepared',
    version,
    updated: candidates.map(({ path }) => path),
    plannedTag: preview.actions.find(({ type }) => type === 'tag').name,
  };
}
