import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from '../lib/hash.mjs';
import { writeAtomic } from '../lib/atomicWrite.mjs';
import { stubSentinel } from '../lib/sentinel.mjs';
import { STUB_TARGETS } from '../lib/bundle.mjs';
import {
  readManifest, writeManifest, emptyConsumerManifest,
  filesForInstallRole, CONSUMER_INSTALL_ROLE,
  indexByPath,
  PACKAGE_MANIFEST_NAME, CONSUMER_MANIFEST_NAME,
} from '../lib/manifest.mjs';

const exists = (p) => access(p).then(() => true, () => false);

/**
 * Install the kit into a consumer repo.
 *  - copies every package-manifest file (never-clobbering a pre-existing UNTRACKED
 *    file unless `force`),
 *  - writes the consumer manifest,
 *  - seeds the doc-layer stubs with the setup-workflow sentinel (skips any that
 *    already exist — idempotent),
 *  - never touches board-sync.md / CLAUDE.md / AGENTS.md.
 */
export async function init({ kitRoot, consumerRoot, force = false }) {
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  if (!pkg) throw new Error('kit package manifest not found');
  const prior = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  const tracked = new Set((prior?.installed ?? []).map((e) => e.path));
  const packageIdx = indexByPath(pkg, 'files');

  const result = { copied: [], skipped: [], seeded: [] };
  const installed = [];

  for (const entry of prior?.installed ?? []) {
    const packageEntry = packageIdx.get(entry.path);
    if (packageEntry?.installRole === CONSUMER_INSTALL_ROLE || !packageEntry?.installRole) continue;
    if (!await exists(join(consumerRoot, entry.path))) continue;
    installed.push({ ...entry, installRole: packageEntry.installRole });
  }

  for (const f of filesForInstallRole(pkg)) {
    const dest = join(consumerRoot, f.path);
    if (await exists(dest) && !tracked.has(f.path) && !force) {
      result.skipped.push(f.path); // pre-existing untracked → never-clobber
      continue;
    }
    await writeAtomic(dest, await readFile(join(kitRoot, f.path)), f.mode);
    installed.push({
      path: f.path, kind: f.kind, ownerSkill: f.ownerSkill, surface: f.surface,
      installedSha256: await sha256File(dest), origin: 'kit',
      installRole: CONSUMER_INSTALL_ROLE,
    });
    result.copied.push(f.path);
  }

  await writeManifest(
    join(consumerRoot, CONSUMER_MANIFEST_NAME),
    { ...emptyConsumerManifest(pkg.kitVersion), installed }
  );

  for (const stub of STUB_TARGETS) {
    const dest = join(consumerRoot, stub);
    if (await exists(dest)) continue; // already present (stub or filled) → leave it
    await writeAtomic(dest, stubSentinel() + '\n');
    result.seeded.push(stub);
  }

  return result;
}
