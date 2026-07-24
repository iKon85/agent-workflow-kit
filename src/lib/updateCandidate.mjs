import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access, lstat, mkdtemp, open, readFile, realpath, rm, stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  isAbsolute, join, normalize, posix, relative, sep,
} from 'node:path';
import { promisify } from 'node:util';
import { writeAtomic } from './atomicWrite.mjs';
import { validateConsumerFile } from './consumerPath.mjs';
import { sha256File } from './hash.mjs';
import { stubSentinel } from './sentinel.mjs';
import { STUB_TARGETS } from './bundle.mjs';
import {
  CONSUMER_MANIFEST_NAME, CONSUMER_ORIGIN, READINESS_MANIFEST_PATH,
  filesForInstallRole, indexByPath, readManifest, writeManifest,
} from './manifest.mjs';
import { checkSkill, evaluateCapability, inspectProdSections } from '../../scripts/readiness.mjs';

const run = promisify(execFile);
const exists = (path) => access(path).then(() => true, () => false);
const pathEntryExists = (path) => lstat(path).then(() => true, (error) => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const MIGRATABLE_INSTRUCTION_PATHS = new Set(['CLAUDE.md', 'AGENTS.md']);
const INTEGRATION_INPUTS = [
  'package.json', '.claude/settings.json', '.claude/settings.local.json',
];
const FORBIDDEN_CANDIDATE_ROOTS = new Set(['.git', '.worktrees', 'node_modules']);
const PLATFORM_PATH_SEMANTICS = { isAbsolute, normalize, sep };

/** Materialize only manifest state and declared Consumer inputs for verification. */
export async function materializeUpdateCandidate({
  consumerRoot, pkg, priorReadinessManifest, nextReadinessManifest,
  afterInputValidation = async () => {},
}) {
  const candidateRoot = await mkdtemp(join(tmpdir(), 'agent-workflow-kit-stage-'));
  try {
    const paths = candidateInputPaths({
      pkg, manifests: [priorReadinessManifest, nextReadinessManifest],
    });
    for (const path of paths) {
      await copyCandidateInput(consumerRoot, candidateRoot, path, afterInputValidation);
    }
    await copyDeclaredRunbooks({
      consumerRoot, candidateRoot, manifests: [priorReadinessManifest, nextReadinessManifest],
      afterInputValidation,
    });
    return candidateRoot;
  } catch (error) {
    await rm(candidateRoot, { recursive: true, force: true });
    throw error;
  }
}

function candidateInputPaths({ pkg, manifests }) {
  const candidates = [
    CONSUMER_MANIFEST_NAME,
    ...INTEGRATION_INPUTS,
    ...filesForInstallRole(pkg).map(({ path }) => path),
  ];
  for (const manifest of manifests) {
    for (const capability of Object.values(manifest?.readiness?.capabilities ?? {})) {
      candidates.push(...(capability.evidence?.paths ?? []));
    }
  }
  const paths = new Set(candidates.filter((path) => !isForbiddenCandidatePath(path)));
  return [...paths].sort();
}

async function copyDeclaredRunbooks({
  consumerRoot, candidateRoot, manifests, afterInputValidation,
}) {
  const runbooks = new Set();
  for (const manifest of manifests) {
    for (const capability of Object.values(manifest?.readiness?.capabilities ?? {})) {
      const evidence = capability.evidence;
      if (evidence?.type !== 'runbook-reference') continue;
      const declaration = await readCandidateText(candidateRoot, evidence.paths?.[0]);
      for (const match of declaration?.matchAll(/`([^`\n]+\.md)`/g) ?? []) {
        if (!match[1].includes('template')) runbooks.add(match[1]);
      }
    }
  }
  for (const path of [...runbooks].sort()) {
    await copyCandidateInput(consumerRoot, candidateRoot, path, afterInputValidation);
  }
}

async function readCandidateText(candidateRoot, path) {
  if (!path) return null;
  try {
    return await readFile(join(candidateRoot, path), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function copyCandidateInput(consumerRoot, candidateRoot, path, afterInputValidation) {
  if (isForbiddenCandidatePath(path)) return;
  const consumerPath = validateCandidateManifestPath(path);
  let source;
  try {
    source = await validateConsumerFile(consumerRoot, consumerPath);
  } catch (error) {
    if (!error.message.startsWith('unsafe consumer path (not a regular file):')) throw error;
    if (!await pathEntryExists(join(consumerRoot, path))) return;
    throw error;
  }
  const root = await realpath(consumerRoot);
  const resolved = await realpath(source);
  assertResolvedConsumerPath(root, resolved, path);
  const validated = await stat(resolved, { bigint: true });
  const pathname = await lstat(source, { bigint: true });
  if (!sameFile(validated, pathname)) {
    throw new Error(`consumer input changed while staging: ${path}`);
  }
  await afterInputValidation(path);

  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(validated, opened)) {
      throw new Error(`consumer input changed while staging: ${path}`);
    }
    const bytes = await handle.readFile();
    const finished = await handle.stat({ bigint: true });
    if (!sameFileSnapshot(opened, finished)) {
      throw new Error(`consumer input changed while staging: ${path}`);
    }
    const resolvedAfter = await realpath(source);
    assertResolvedConsumerPath(root, resolvedAfter, path);
    const current = await stat(resolvedAfter, { bigint: true });
    if (!sameFile(opened, current)) {
      throw new Error(`consumer input changed while staging: ${path}`);
    }
    await writeAtomic(join(candidateRoot, path), bytes, Number(opened.mode));
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new Error(`unsafe consumer path (not a regular file): ${path}`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Accept the package manifest's canonical slash-separated path and translate it
 * only after platform-independent lexical validation.
 */
export function validateCandidateManifestPath(path, pathSemantics = PLATFORM_PATH_SEMANTICS) {
  if (typeof path !== 'string' || !path || path === '.' || path.includes('\\')
      || path.split('/').includes('..')
      || posix.isAbsolute(path) || posix.normalize(path) !== path) {
    throw new Error(`unsafe candidate manifest path: ${path}`);
  }
  const platformPath = path.split('/').join(pathSemantics.sep);
  if (pathSemantics.isAbsolute(platformPath)
      || pathSemantics.normalize(platformPath) !== platformPath) {
    throw new Error(`unsafe candidate manifest path: ${path}`);
  }
  return platformPath;
}

function isForbiddenCandidatePath(path) {
  if (typeof path !== 'string') return false;
  const [root] = path.split(/[\\/]/);
  return FORBIDDEN_CANDIDATE_ROOTS.has(root);
}

function assertResolvedConsumerPath(root, resolved, path) {
  const fromRoot = relative(root, resolved);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${pathSeparator()}`)
      || isAbsolute(fromRoot)) {
    throw new Error(`unsafe consumer path (resolved outside root): ${path}`);
  }
}

function pathSeparator() {
  return process.platform === 'win32' ? '\\' : '/';
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameFile(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Activate only verified kit-owned deltas, rolling every touched path back on failure. */
export async function activateCandidate({
  candidateRoot, consumerRoot, pkg, preview, consumerManifestBefore,
  afterSnapshot = async () => {}, afterGenerated = async () => {},
  beforeTargetRevalidation = async () => {},
}) {
  const changed = [...preview.added, ...preview.updated];
  const generated = preview.generated ?? [];
  const migrations = preview.migrations ?? [];
  const touched = [
    ...changed, ...generated, ...migrations.map(({ path }) => path),
    ...preview.deleted, CONSUMER_MANIFEST_NAME,
  ];
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
  const manifestBeforeSnapshot = await readFile(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  if (!manifestBeforeSnapshot.equals(consumerManifestBefore)) {
    throw new Error('consumer manifest changed during verification');
  }
  await assertConsumerStillMatchesPreview(consumerRoot, preview);
  const rollback = new Map();
  for (const path of touched) {
    rollback.set(path, await snapshot(join(consumerRoot, path), path));
  }
  await afterSnapshot();
  const currentManifest = await readFile(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  if (!currentManifest.equals(consumerManifestBefore)) {
    throw new Error('consumer manifest changed during verification');
  }
  await assertConsumerStillMatchesPreview(consumerRoot, preview);
  const applied = [];
  const applyTarget = async (path, action) => {
    await beforeTargetRevalidation(path);
    await assertTargetStillMatchesSnapshot(
      join(consumerRoot, path), rollback.get(path), path,
    );
    // Optimistic revalidation cannot remove the filesystem check-to-rename
    // micro-window; it does keep every later destination behind a fresh check.
    await action();
    const record = { path, snapshot: null, captured: false };
    applied.push(record);
    record.snapshot = await snapshot(join(consumerRoot, path), path);
    record.captured = true;
  };
  try {
    for (const path of changed) {
      const bytes = await readFile(join(candidateRoot, path));
      await applyTarget(path, () => writeAtomic(
        join(consumerRoot, path), bytes, pkgIdx.get(path)?.mode,
      ));
    }
    for (const path of generated) {
      const bytes = await readFile(join(candidateRoot, path));
      await applyTarget(path, () => writeAtomic(join(consumerRoot, path), bytes));
    }
    for (const { path } of migrations) {
      const bytes = await readFile(join(candidateRoot, path));
      await applyTarget(path, () => writeAtomic(join(consumerRoot, path), bytes));
    }
    await afterGenerated();
    for (const path of preview.deleted) {
      await applyTarget(path, () => rm(join(consumerRoot, path), { force: true }));
    }
    const manifestBytes = await readFile(join(candidateRoot, CONSUMER_MANIFEST_NAME));
    await applyTarget(CONSUMER_MANIFEST_NAME, () => writeAtomic(
      join(consumerRoot, CONSUMER_MANIFEST_NAME), manifestBytes,
    ));
  } catch (error) {
    const rollbackConflicts = [];
    for (const record of applied.reverse()) {
      const target = join(consumerRoot, record.path);
      if (!record.captured
          || !await targetStillMatchesSnapshot(target, record.snapshot, record.path)) {
        rollbackConflicts.push(record.path);
        continue;
      }
      await restore(target, rollback.get(record.path));
    }
    if (rollbackConflicts.length) {
      rollbackConflicts.sort();
      error.message = `${error.message}; rollback preserved concurrent edits: ` +
        rollbackConflicts.join(', ');
    }
    error.consumerState = rollbackConflicts.length
      ? 'rollback-conflicted'
      : (applied.length ? 'rolled-back' : 'unchanged');
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

async function snapshot(path, displayPath = path) {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile()) {
    throw new Error(`unsafe consumer activation path: ${displayPath}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path, { bigint: true });
  if (!sameFileSnapshot(before, after)) {
    throw new Error(`consumer changed during activation: ${displayPath}`);
  }
  return { bytes, mode: Number(before.mode), identity: before };
}

async function assertTargetStillMatchesSnapshot(path, expected, displayPath) {
  if (!await targetStillMatchesSnapshot(path, expected, displayPath)) {
    throw new Error(`consumer changed during activation: ${displayPath}`);
  }
}

async function targetStillMatchesSnapshot(path, expected, displayPath) {
  let current;
  try {
    current = await snapshot(path, displayPath);
  } catch (error) {
    return false;
  }
  return sameActivationSnapshot(expected, current);
}

function sameActivationSnapshot(expected, current) {
  if (!expected || !current) return expected === current;
  return expected.mode === current.mode
    && expected.bytes.equals(current.bytes)
    && sameFileSnapshot(expected.identity, current.identity);
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
