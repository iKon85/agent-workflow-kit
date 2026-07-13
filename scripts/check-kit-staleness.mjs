/** Verify that the checked-in install manifest matches a fresh public-SSOT build. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKit } from './build-kit.mjs';

const index = (manifest) => new Map(manifest.files.map((file) => [file.path, file.sha256]));

export function diffManifests(checked, built) {
  const before = index(checked);
  const after = index(built);
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const changed = [...after.keys()].filter(
    (path) => before.has(path) && before.get(path) !== after.get(path),
  ).sort();
  return { added, removed, changed };
}

export async function checkKitStaleness({ repoRoot } = {}) {
  repoRoot ??= join(dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = await mkdtemp(join(tmpdir(), 'awkit-staleness-'));
  try {
    await buildKit({ repoRoot, distDir });
    const checked = JSON.parse(await readFile(join(repoRoot, 'agent-workflow-kit.package.json'), 'utf8'));
    const built = JSON.parse(await readFile(join(distDir, 'agent-workflow-kit.package.json'), 'utf8'));
    const diff = diffManifests(checked, built);
    const drift = Object.values(diff).some((paths) => paths.length);
    return { status: drift ? 'drift' : 'ok', ...diff };
  } finally {
    await rm(distDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkKitStaleness().then((result) => {
    if (result.status === 'ok') return console.log('kit:staleness — OK');
    console.error('kit:staleness — DRIFT');
    for (const key of ['added', 'removed', 'changed']) {
      if (result[key].length) console.error(`  ${key}: ${result[key].join(', ')}`);
    }
    process.exitCode = 1;
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
