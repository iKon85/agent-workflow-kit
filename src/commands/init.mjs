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
  readReadinessContract,
  READINESS_MANIFEST_PATH,
  CONSUMER_ORIGIN,
  PACKAGE_MANIFEST_NAME, CONSUMER_MANIFEST_NAME,
} from '../lib/manifest.mjs';
import {
  PROJECT_SKILL_REGISTRY_PATH, emptyProjectSkillRegistry,
} from '../lib/skillRegistry.mjs';
import {
  inspectRoutingProfile, reconcileRoutingProfile, setupRoutingProfile,
} from '../lib/routingProfile.mjs';

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
export async function init({ kitRoot, consumerRoot, force = false, routingProfile }) {
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  if (!pkg) throw new Error('kit package manifest not found');
  const prior = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  const readiness = await readReadinessContract(kitRoot);
  const tracked = new Set((prior?.installed ?? []).map((e) => e.path));
  const consumerOwned = new Set(
    (prior?.installed ?? []).filter((e) => e.origin === CONSUMER_ORIGIN).map((e) => e.path),
  );
  const packageIdx = indexByPath(pkg, 'files');

  const result = { copied: [], skipped: [], seeded: [] };
  const installed = [];

  for (const entry of prior?.installed ?? []) {
    if (entry.origin === CONSUMER_ORIGIN) {
      installed.push(entry);
      continue;
    }
    const packageEntry = packageIdx.get(entry.path);
    if (packageEntry?.installRole === CONSUMER_INSTALL_ROLE || !packageEntry?.installRole) continue;
    if (!await exists(join(consumerRoot, entry.path))) continue;
    installed.push({ ...entry, installRole: packageEntry.installRole });
  }

  for (const f of filesForInstallRole(pkg)) {
    const dest = join(consumerRoot, f.path);
    if (consumerOwned.has(f.path)) {
      result.skipped.push(f.path);
      continue;
    }
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

  if (packageIdx.has(READINESS_MANIFEST_PATH)
      && !installed.some(({ path }) => path === PROJECT_SKILL_REGISTRY_PATH)) {
    const projectRegistryPath = join(consumerRoot, PROJECT_SKILL_REGISTRY_PATH);
    if (!await exists(projectRegistryPath)) {
      const core = await readManifest(join(kitRoot, READINESS_MANIFEST_PATH));
      await writeAtomic(
        projectRegistryPath,
        `${JSON.stringify(emptyProjectSkillRegistry(core), null, 2)}\n`,
      );
      result.seeded.push(PROJECT_SKILL_REGISTRY_PATH);
    }
    installed.push({
      path: PROJECT_SKILL_REGISTRY_PATH,
      kind: 'doc',
      installedSha256: await sha256File(projectRegistryPath),
      origin: CONSUMER_ORIGIN,
      installRole: CONSUMER_INSTALL_ROLE,
    });
  }

  await writeManifest(
    join(consumerRoot, CONSUMER_MANIFEST_NAME),
    { ...emptyConsumerManifest(pkg.kitVersion, prior, readiness), installed }
  );

  for (const stub of STUB_TARGETS) {
    const dest = join(consumerRoot, stub);
    if (await exists(dest)) continue; // already present (stub or filled) → leave it
    await writeAtomic(dest, stubSentinel() + '\n');
    result.seeded.push(stub);
  }

  if (routingProfile) {
    const options = { consumerRoot, ...routingProfile };
    const inspection = await inspectRoutingProfile(options);
    result.routingProfile = prior
      ? await reconcileRoutingProfile(options, inspection)
      : (inspection.status === 'still valid'
        ? { status: 'still valid' }
        : await setupRoutingProfile({
          ...options,
          expectedFingerprint: inspection.fingerprint,
        }));
  }

  return result;
}
