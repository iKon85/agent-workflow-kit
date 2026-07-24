import { join } from 'node:path';
import { sha256File } from './hash.mjs';
import { CONSUMER_INSTALL_ROLE, CONSUMER_ORIGIN, KIT_ORIGIN } from './manifest.mjs';
import { validateCandidateManifestPath } from './updateCandidate.mjs';

const HASH = /^[a-f0-9]{64}$/;

export function verifyDeletionState(installed, pkg, installable, preview) {
  const installablePaths = new Set(installable.map(({ path }) => path));
  const packageEntries = new Map(pkg.files.map((entry) => [entry.path, entry]));
  const deleted = new Set(preview?.deleted ?? []);
  const preserved = new Set(preview?.keptDeleted ?? []);
  for (const [path, tracked] of installed) {
    if (installablePaths.has(path)) continue;
    if (deleted.has(path) && tracked.origin === KIT_ORIGIN) {
      throw new Error(`candidate invariant deletion: stale Kit ledger path ${path}`);
    }
    if (tracked.origin === CONSUMER_ORIGIN) continue;
    if (!preserved.has(path)) {
      throw new Error(`candidate invariant deletion: undeclared legacy Kit path ${path}`);
    }
    const packaged = packageEntries.get(path);
    const expectedRole = packaged?.installRole ?? tracked.installRole ?? CONSUMER_INSTALL_ROLE;
    if ((tracked.installRole ?? CONSUMER_INSTALL_ROLE) !== expectedRole) {
      throw new Error(`candidate invariant deletion: role mismatch ${path}`);
    }
  }
  for (const path of deleted) {
    if (installed.has(path)) {
      throw new Error(`candidate invariant deletion: stale Kit ledger path ${path}`);
    }
  }
  for (const path of preserved) {
    if (!installed.has(path)) {
      throw new Error(`candidate invariant deletion: missing preserved ledger path ${path}`);
    }
  }
}

export function verifyTransactionPreview(preview, installable, installed) {
  if (!preview || typeof preview !== 'object') {
    throw new Error('candidate invariant transaction: preview is required');
  }
  const installablePaths = new Set(installable.map(({ path }) => path));
  const owners = new Map();
  const actionSets = new Map();
  for (const key of ['added', 'updated', 'deleted', 'generated', 'keptDeleted']) {
    if (!Array.isArray(preview[key] ?? [])) {
      throw new Error(`candidate invariant transaction: ${key} must be an array`);
    }
    const local = new Set();
    for (const path of preview[key] ?? []) {
      claimTransactionPath(path, key, local, owners);
      if (['added', 'updated'].includes(key) && !installablePaths.has(path)) {
        throw new Error(`candidate invariant transaction: unmanaged ${key} path ${path}`);
      }
      if (key === 'deleted' && installablePaths.has(path)) {
        throw new Error(`candidate invariant transaction: deletes current package path ${path}`);
      }
    }
    actionSets.set(key, local);
  }
  if (!Array.isArray(preview.migrations ?? [])) {
    throw new Error('candidate invariant transaction: migrations must be an array');
  }
  const migrationPaths = new Set();
  for (const migration of preview.migrations ?? []) {
    claimTransactionPath(migration?.path, 'migrations', migrationPaths, owners);
  }
  verifyCollisionRecords(preview, installablePaths, installed, actionSets, owners);
}

export async function verifyDerivedArtifacts(candidateRoot, installed, preview) {
  for (const path of preview.generated ?? []) {
    const tracked = installed.get(path);
    if (!tracked || tracked.origin !== CONSUMER_ORIGIN
        || !HASH.test(tracked.installedSha256 ?? '')) {
      throw new Error(`candidate invariant transaction: invalid generated ledger ${path}`);
    }
    if (await transactionHash(candidateRoot, path) !== tracked.installedSha256) {
      throw new Error(`candidate invariant transaction: generated hash mismatch ${path}`);
    }
  }
  const migrations = new Set();
  for (const migration of preview.migrations ?? []) {
    const path = migration?.path;
    claimTransactionPath(path, 'migration', migrations);
    if (!(migration.beforeSha256 === null || HASH.test(migration.beforeSha256 ?? ''))
        || !HASH.test(migration.afterSha256 ?? '')
        || await transactionHash(candidateRoot, path) !== migration.afterSha256) {
      throw new Error(`candidate invariant transaction: migration hash mismatch ${path}`);
    }
  }
}

function verifyCollisionRecords(preview, installablePaths, installed, actionSets, owners) {
  if (!Array.isArray(preview.collisions ?? [])
      || !Array.isArray(preview.collisionResolutions ?? [])) {
    throw new Error('candidate invariant transaction: collision records must be arrays');
  }
  const unresolved = new Set();
  for (const path of preview.collisions ?? []) {
    claimTransactionPath(path, 'collisions', unresolved);
  }
  if (unresolved.size) {
    throw new Error('candidate invariant transaction: unresolved collision');
  }
  const resolutions = new Set();
  for (const resolution of preview.collisionResolutions ?? []) {
    const path = resolution?.path;
    claimTransactionPath(path, 'collision resolution', resolutions);
    if (!installablePaths.has(path)
        || !['keep-as-owned', 'replace'].includes(resolution?.outcome)
        || !HASH.test(resolution?.destinationSha256 ?? '')) {
      throw new Error(`candidate invariant transaction: invalid collision resolution ${path}`);
    }
    const expectedOrigin = resolution.outcome === 'keep-as-owned' ? CONSUMER_ORIGIN : KIT_ORIGIN;
    if (installed.get(path)?.origin !== expectedOrigin
        || (resolution.outcome === 'replace' && !actionSets.get('added').has(path))
        || (resolution.outcome === 'keep-as-owned' && owners.has(path))) {
      throw new Error(`candidate invariant transaction: incoherent collision resolution ${path}`);
    }
  }
}

function claimTransactionPath(path, key, local, owners = null) {
  try {
    validateCandidateManifestPath(path);
  } catch {
    throw new Error(`candidate invariant transaction: unsafe ${key} path ${path}`);
  }
  if (local.has(path)) {
    throw new Error(`candidate invariant transaction: duplicate ${key} path ${path}`);
  }
  local.add(path);
  const owner = owners?.get(path);
  if (owner && owner !== key) {
    throw new Error(`candidate invariant transaction: overlapping action ${path}`);
  }
  owners?.set(path, key);
}

async function transactionHash(candidateRoot, path) {
  try {
    return await sha256File(join(candidateRoot, path));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`candidate invariant transaction: missing derived artifact ${path}`);
    }
    throw error;
  }
}
