import { execFile } from 'node:child_process';
import { access, cp, lstat, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { writeAtomic } from './atomicWrite.mjs';
import { validateConsumerFile } from './consumerPath.mjs';
import { sha256File } from './hash.mjs';
import { stubSentinel } from './sentinel.mjs';
import { STUB_TARGETS } from './bundle.mjs';
import {
  CONSUMER_MANIFEST_NAME, CONSUMER_ORIGIN, READINESS_MANIFEST_PATH,
  indexByPath, readManifest, writeManifest,
} from './manifest.mjs';
import { checkSkill, evaluateCapability, inspectProdSections } from '../../scripts/readiness.mjs';

const run = promisify(execFile);
const exists = (path) => access(path).then(() => true, () => false);
const pathEntryExists = (path) => lstat(path).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const MIGRATABLE_INSTRUCTION_PATHS = new Set(['CLAUDE.md', 'AGENTS.md']);

/** Copy a verification candidate without duplicating git metadata or dependencies. */
export async function stageConsumer(consumerRoot) {
  const candidateRoot = await mkdtemp(join(tmpdir(), 'agent-workflow-kit-stage-'));
  const nodeModules = join(consumerRoot, 'node_modules');
  await cp(consumerRoot, candidateRoot, {
    recursive: true,
    filter: (source) => {
      const rel = relative(consumerRoot, source);
      return rel !== '.git' && !rel.startsWith('.git/') &&
        rel !== 'node_modules' && !rel.startsWith('node_modules/');
    },
  });
  if (await exists(nodeModules)) await symlink(nodeModules, join(candidateRoot, 'node_modules'), 'dir');
  return candidateRoot;
}

/** Activate only verified kit-owned deltas, rolling every touched path back on failure. */
export async function activateCandidate({
  candidateRoot, consumerRoot, pkg, preview, consumerManifestBefore,
  afterGenerated = async () => {},
}) {
  const changed = [...preview.added, ...preview.updated];
  const generated = preview.generated ?? [];
  const migrations = preview.migrations ?? [];
  const touched = [
    ...changed, ...generated, ...migrations.map(({ path }) => path),
    ...preview.deleted, CONSUMER_MANIFEST_NAME,
  ];
  const currentManifest = await readFile(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  if (!currentManifest.equals(consumerManifestBefore)) {
    throw new Error('consumer manifest changed during verification');
  }
  const pkgIdx = indexByPath(pkg, 'files');
  for (const path of changed) {
    if (await sha256File(join(candidateRoot, path)) !== pkgIdx.get(path)?.sha256) {
      throw new Error(`candidate hash mismatch: ${path}`);
    }
  }
  const candidateManifest = await readManifest(join(candidateRoot, CONSUMER_MANIFEST_NAME));
  const candidateInstalled = indexByPath(candidateManifest, 'installed');
  for (const path of generated) {
    if (await sha256File(join(candidateRoot, path)) !== candidateInstalled.get(path)?.installedSha256) {
      throw new Error(`generated candidate hash mismatch: ${path}`);
    }
  }
  for (const migration of migrations) {
    if (await sha256File(join(candidateRoot, migration.path)) !== migration.afterSha256) {
      throw new Error(`migrated candidate hash mismatch: ${migration.path}`);
    }
  }
  await assertConsumerStillMatchesPreview(consumerRoot, preview);
  const rollback = new Map();
  for (const path of touched) rollback.set(path, await snapshot(join(consumerRoot, path)));
  try {
    for (const path of changed) {
      await writeAtomic(join(consumerRoot, path), await readFile(join(candidateRoot, path)), pkgIdx.get(path)?.mode);
    }
    for (const path of generated) {
      await writeAtomic(join(consumerRoot, path), await readFile(join(candidateRoot, path)));
    }
    for (const { path } of migrations) {
      await writeAtomic(join(consumerRoot, path), await readFile(join(candidateRoot, path)));
    }
    await afterGenerated();
    for (const path of preview.deleted) await rm(join(consumerRoot, path), { force: true });
    await writeAtomic(
      join(consumerRoot, CONSUMER_MANIFEST_NAME),
      await readFile(join(candidateRoot, CONSUMER_MANIFEST_NAME)),
    );
  } catch (error) {
    for (const path of touched.reverse()) await restore(join(consumerRoot, path), rollback.get(path));
    error.consumerState = 'rolled-back';
    throw error;
  }
}

async function assertConsumerStillMatchesPreview(consumerRoot, preview) {
  const manifest = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  const installed = indexByPath(manifest, 'installed');
  const replacements = new Set(
    preview.collisionResolutions
      .filter(({ outcome }) => outcome === 'replace')
      .map(({ path }) => path),
  );
  for (const collision of preview.collisionResolutions) {
    await validateConsumerFile(consumerRoot, collision.path);
    const current = await sha256File(join(consumerRoot, collision.path));
    if (current !== collision.destinationSha256) {
      throw new Error(`consumer changed during verification: ${collision.path}`);
    }
  }
  for (const path of preview.added) {
    if (replacements.has(path)) continue;
    if (await exists(join(consumerRoot, path))) throw new Error(`consumer changed during verification: ${path}`);
  }
  for (const path of preview.generated ?? []) {
    if (await exists(join(consumerRoot, path))) {
      throw new Error(`consumer changed during verification: ${path}`);
    }
  }
  for (const migration of preview.migrations ?? []) {
    const present = await pathEntryExists(join(consumerRoot, migration.path));
    if (present) await validateConsumerFile(consumerRoot, migration.path);
    else if (!MIGRATABLE_INSTRUCTION_PATHS.has(migration.path)) {
      throw new Error(`unsafe consumer path: ${migration.path}`);
    }
    const current = present ? await sha256File(join(consumerRoot, migration.path)) : null;
    if (current !== migration.beforeSha256) {
      throw new Error(`consumer changed during verification: ${migration.path}`);
    }
  }
  for (const path of [...preview.updated, ...preview.deleted]) {
    const prior = installed.get(path);
    const current = await exists(join(consumerRoot, path))
      ? await sha256File(join(consumerRoot, path)) : null;
    if (!prior || current !== prior.installedSha256) {
      throw new Error(`consumer changed during verification: ${path}`);
    }
  }
}

/** Seed only newly declared, decision-free project-layer stubs in a staged candidate. */
export async function adoptReadinessCandidate({ candidateRoot, consumerRoot, priorManifest, nextManifest }) {
  const priorPaths = readinessStubPaths(priorManifest);
  const manifestPath = join(candidateRoot, CONSUMER_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  const candidateInstalled = indexByPath(manifest, 'installed');
  const generated = [];
  for (const path of readinessStubPaths(nextManifest)) {
    if (priorPaths.has(path)) continue;
    if (await exists(join(candidateRoot, path))) {
      if (candidateInstalled.get(path)?.origin === CONSUMER_ORIGIN
          && !await exists(join(consumerRoot, path))) generated.push(path);
      continue;
    }
    if (await exists(join(consumerRoot, path))) continue;
    await writeAtomic(join(candidateRoot, path), `${stubSentinel()}\n`);
    generated.push(path);
  }
  if (generated.length) {
    const installed = [...manifest.installed];
    for (const generatedPath of generated) {
      if (candidateInstalled.has(generatedPath)) continue;
      installed.push({
        path: generatedPath, kind: 'doc', installedSha256: await sha256File(join(candidateRoot, generatedPath)),
        origin: CONSUMER_ORIGIN, installRole: 'consumer',
      });
    }
    await writeManifest(manifestPath, { ...manifest, installed });
  }
  const { migrations, migrationConflicts } = await migrateProdSections({
    candidateRoot, consumerRoot, nextManifest,
  });
  const before = await readinessSnapshot(consumerRoot, priorManifest);
  const after = await readinessSnapshot(candidateRoot, nextManifest);
  const incompatible = Object.entries(after.skills)
    .filter(([skill, current]) => before.skills[skill]?.verdict !== 'blocked'
      && before.skills[skill] && current.verdict === 'blocked')
    .map(([skill]) => skill)
    .sort();
  return {
    generated,
    migrations,
    migrated: migrations.map(({ path }) => path),
    migrationConflicts,
    availability: readinessDiff(before, after),
    incompatible,
  };
}

async function migrateProdSections({ candidateRoot, consumerRoot, nextManifest }) {
  const paths = [...new Set(Object.values(nextManifest?.readiness?.capabilities ?? {})
    .flatMap(({ evidence }) => evidence?.type === 'prod-section' ? evidence.paths ?? [] : []))];
  if (paths.length < 2) return { migrations: [], migrationConflicts: [] };
  if (paths.some((path) => !MIGRATABLE_INSTRUCTION_PATHS.has(path))) {
    return { migrations: [], migrationConflicts: paths };
  }
  const sections = await inspectProdSections(candidateRoot, paths);
  const invalid = sections.filter(({ state }) => state === 'invalid');
  const validBodies = [...new Set(
    sections.filter(({ state }) => state === 'valid').map(({ body }) => body),
  )];
  if (invalid.length || validBodies.length > 1) {
    return { migrations: [], migrationConflicts: paths };
  }
  if (validBodies.length !== 1) return { migrations: [], migrationConflicts: [] };

  const body = validBodies[0];
  const migrations = [];
  for (const entry of sections.filter(({ state }) => state === 'missing')) {
    const candidatePath = join(candidateRoot, entry.path);
    const present = await pathEntryExists(candidatePath);
    if (present) await validateConsumerFile(candidateRoot, entry.path);
    const before = present ? await readFile(candidatePath, 'utf8') : '';
    const separator = before && !before.endsWith('\n') ? '\n\n' : (before ? '\n' : '');
    await writeAtomic(candidatePath, `${before}${separator}## Prod\n\n${body}\n`);
    migrations.push({
      path: entry.path,
      beforeSha256: await exists(join(consumerRoot, entry.path))
        ? await sha256File(join(consumerRoot, entry.path)) : null,
      afterSha256: await sha256File(candidatePath),
    });
  }
  return { migrations, migrationConflicts: [] };
}

function readinessStubPaths(manifest) {
  const safe = new Set(STUB_TARGETS);
  return new Set(Object.values(manifest?.readiness?.capabilities ?? {}).flatMap((capability) => {
    if (capability.evidence?.type !== 'sentinel') return [];
    return (capability.evidence.paths ?? []).filter((path) => safe.has(path));
  }));
}

async function readinessSnapshot(root, manifest) {
  const skills = {};
  for (const [name, declaration] of Object.entries(manifest?.skills ?? {})) {
    if (!declaration.readiness) continue;
    skills[name] = await checkSkill({ root, skill: name, manifest });
  }
  const consumer = await readManifest(join(root, CONSUMER_MANIFEST_NAME));
  const capabilities = {};
  for (const [name, capability] of Object.entries(manifest?.readiness?.capabilities ?? {})) {
    capabilities[name] = await evaluateCapability({
      root, capability, decision: consumer?.readinessDecisions?.[name],
    });
  }
  return { skills, capabilities };
}

function readinessDiff(before, after) {
  const newlyAvailable = [];
  const newlyDegraded = [];
  const newlyBlocked = [];
  const unresolved = new Set();
  for (const [skill, current] of Object.entries(after.skills)) {
    const prior = before.skills[skill];
    if (current.verdict === 'blocked' && prior?.verdict !== 'blocked') newlyBlocked.push(skill);
    if (current.verdict !== 'blocked' && (!prior || prior.verdict === 'blocked')) newlyAvailable.push(skill);
    for (const block of current.inactiveBlocks) {
      if (!prior || !prior.inactiveBlocks.includes(block)) newlyDegraded.push(`${skill}.${block}`);
    }
  }
  for (const [capability, result] of Object.entries(after.capabilities)) {
    if (result.state !== 'ready') unresolved.add(`${capability}:${result.state}`);
  }
  return {
    newlyAvailable: newlyAvailable.sort(), newlyDegraded: newlyDegraded.sort(),
    newlyBlocked: newlyBlocked.sort(), stillUnresolved: [...unresolved].sort(),
  };
}

export async function readReadinessManifest(root) {
  return readManifest(join(root, READINESS_MANIFEST_PATH));
}

async function snapshot(path) {
  if (!await exists(path)) return null;
  const info = await stat(path);
  return { bytes: await readFile(path), mode: info.mode };
}

async function restore(path, saved) {
  if (!saved) return rm(path, { force: true });
  await writeAtomic(path, saved.bytes, saved.mode);
}

/** Default candidate gate: run the consumer's existing npm test command. */
export async function verifyCandidate(candidateRoot) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(candidateRoot, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('candidate has no package.json test command');
    throw error;
  }
  if (!pkg.scripts?.test) throw new Error('candidate has no package.json test command');
  await run('npm', ['test'], { cwd: candidateRoot });
}
