import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { sha256 } from '../src/lib/hash.mjs';
import { PACKAGE_MANIFEST_NAME } from '../src/lib/manifest.mjs';

/** Build a minimal kit fixture on disk: writes the listed files + a package
 * manifest describing them. `files` = { 'relpath': 'content', ... }. Returns the
 * kit root dir. */
export async function makeKit(files, kitVersion = '0.1.0') {
  const root = await mkdtemp(join(tmpdir(), 'awk-kit-'));
  const manifestFiles = [];
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    manifestFiles.push({
      path, kind: path.includes('/skills/') ? 'skill' : 'doc',
      sha256: sha256(content), mode: 0o644, origin: 'kit',
    });
  }
  await writeFile(
    join(root, PACKAGE_MANIFEST_NAME),
    JSON.stringify({ kitVersion, files: manifestFiles }, null, 2) + '\n'
  );
  return root;
}

export async function makeEmptyDir() {
  return mkdtemp(join(tmpdir(), 'awk-consumer-'));
}

export async function cleanup(...dirs) {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}
