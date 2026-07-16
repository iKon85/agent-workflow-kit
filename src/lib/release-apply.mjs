import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomicWrite.mjs';

const sha256 = (body) => createHash('sha256').update(body).digest('hex');

async function readSnapshot(consumerRoot, snapshot) {
  return Promise.all(snapshot.map(async ({ path }) => {
    const body = await readFile(join(consumerRoot, path), 'utf8');
    return { path, body, version: JSON.parse(body).version, sha256: sha256(body) };
  }));
}

export async function applyProjectRelease(options) {
  const { consumerRoot, preview, confirmation } = options;
  const write = options.write ?? writeAtomic;
  if (preview.status !== 'ready') throw new Error('release preview is blocked');
  if (confirmation !== preview.confirmation) {
    throw new Error('release confirmation does not match preview');
  }
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
