import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sha256File } from './hash.mjs';
import {
  CONSUMER_INSTALL_ROLE, CONSUMER_MANIFEST_NAME, CONSUMER_ORIGIN, KIT_ORIGIN,
  emptyConsumerManifest, filesForInstallRole,
} from './manifest.mjs';
import { validateCandidateManifestPath } from './updateCandidate.mjs';
import {
  verifyCandidateMembership, verifyChangedSyntax,
} from './verifyUpdateCandidateArtifacts.mjs';
import { verifyCandidateProtocol } from './verifyUpdateCandidateProtocol.mjs';
import {
  verifyDeletionState, verifyDerivedArtifacts, verifyTransactionPreview,
} from './verifyUpdateCandidateTransaction.mjs';

const HASH = /^[a-f0-9]{64}$/;
const PACKAGE_KINDS = new Set(['skill', 'hook', 'doc', 'template', 'script']);

/**
 * Verify the Kit-owned staged end state without executing Consumer behavior.
 *
 * The trusted package manifest and transaction preview are supplied by the
 * updater; candidate-owned metadata never establishes its own authority.
 */
export async function verifyUpdateCandidate(candidateRoot, context) {
  await verifyCandidateMetadata(candidateRoot, context);
  await verifyChangedSyntax(candidateRoot, context.preview);
}

export async function verifyCandidateMetadata(candidateRoot, context) {
  if (!candidateRoot || !context?.pkg) {
    throw new Error('candidate invariant transaction: trusted package manifest is required');
  }
  const { installable, installed, ledger } = await verifyCandidateSchema(candidateRoot, context);
  if (!Array.isArray(context.priorConsumerManifest?.installed)) {
    throw new Error('candidate invariant ownership: trusted prior Consumer ledger is required');
  }
  verifyLedgerMetadata(ledger, context);
  const priorInstalled = uniqueEntries(context.priorConsumerManifest.installed, 'prior ledger');
  verifyTransactionPreview(context.preview, installable, installed);
  verifyDeletionState(installed, context.pkg, installable, context.preview);
  await verifyCandidateMembership(candidateRoot, context);
  for (const entry of installable) {
    const tracked = installed.get(entry.path);
    if (!tracked) {
      throw new Error(`candidate invariant ownership: untracked package path ${entry.path}`);
    }
    validateInstalledEntry(tracked, entry, expectedOrigin(entry.path, priorInstalled, context.preview));
    let state;
    try {
      state = await lstat(join(candidateRoot, entry.path));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`candidate invariant artifact: missing ${entry.path}`);
      }
      throw error;
    }
    if (!state.isFile()) {
      throw new Error(`candidate invariant artifact: not a regular file ${entry.path}`);
    }
    if (tracked.origin === KIT_ORIGIN && (state.mode & 0o777) !== entry.mode) {
      throw new Error(`candidate invariant artifact: mode mismatch ${entry.path}`);
    }
    const expectedHash = tracked.origin === CONSUMER_ORIGIN
      ? tracked.installedSha256 : entry.sha256;
    if (await sha256File(join(candidateRoot, entry.path)) !== expectedHash) {
      throw new Error(`candidate invariant artifact: hash mismatch ${entry.path}`);
    }
  }
  await verifyDerivedArtifacts(candidateRoot, installed, context.preview);
}

export async function verifyCandidateSchema(candidateRoot, context) {
  if (!candidateRoot || !context?.pkg) {
    throw new Error('candidate invariant transaction: trusted package manifest is required');
  }
  const installable = packageArtifacts(context.pkg);
  const ledger = await candidateLedger(candidateRoot, context);
  const installed = uniqueEntries(ledger.installed, 'ledger');
  await verifyCandidateProtocol(candidateRoot, context.pkg, installed);
  return { installable, installed, ledger };
}

export { verifyUpdateCandidate as verifyCandidate };

function packageArtifacts(pkg) {
  if (typeof pkg.kitVersion !== 'string' || !pkg.kitVersion) {
    throw new Error('candidate invariant manifest: package kitVersion is required');
  }
  if (!Array.isArray(pkg.files)) {
    throw new Error('candidate invariant manifest: package files must be an array');
  }
  const seen = new Set();
  for (const entry of pkg.files) {
    if (!entry || typeof entry.path !== 'string') {
      throw new Error('candidate invariant manifest: package entry path is required');
    }
    try {
      validateCandidateManifestPath(entry.path);
    } catch {
      throw new Error(`candidate invariant manifest: unsafe path ${entry.path}`);
    }
    if (seen.has(entry.path)) {
      throw new Error(`candidate invariant manifest: duplicate path ${entry.path}`);
    }
    if (!HASH.test(entry.sha256 ?? '')) {
      throw new Error(`candidate invariant manifest: invalid hash ${entry.path}`);
    }
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
      throw new Error(`candidate invariant manifest: invalid mode ${entry.path}`);
    }
    if (!PACKAGE_KINDS.has(entry.kind)) {
      throw new Error(`candidate invariant manifest: invalid kind ${entry.path}`);
    }
    if ((entry.origin ?? KIT_ORIGIN) !== KIT_ORIGIN) {
      throw new Error(`candidate invariant manifest: invalid origin ${entry.path}`);
    }
    if (![CONSUMER_INSTALL_ROLE, 'maintainer'].includes(
      entry.installRole ?? CONSUMER_INSTALL_ROLE,
    )) {
      throw new Error(`candidate invariant manifest: invalid role ${entry.path}`);
    }
    seen.add(entry.path);
  }
  return filesForInstallRole(pkg);
}

async function candidateLedger(candidateRoot, context) {
  const { pkg, nextReadinessManifest } = context;
  let ledger;
  try {
    ledger = JSON.parse(await readFile(join(candidateRoot, CONSUMER_MANIFEST_NAME), 'utf8'));
  } catch {
    throw new Error('candidate invariant schema: Consumer ledger is missing or invalid JSON');
  }
  if (!ledger || ledger.kitVersion !== pkg.kitVersion
      || ledger.installRole !== CONSUMER_INSTALL_ROLE
      || !Array.isArray(ledger.installed)
      || !Number.isInteger(ledger.readinessContractVersion)
      || !isRecord(ledger.readinessDecisions)
      || Object.values(ledger.readinessDecisions).some(
        (value) => !['pending', 'not-applicable'].includes(value),
      )) {
    throw new Error('candidate invariant schema: Consumer ledger identity is invalid');
  }
  const readiness = nextReadinessManifest?.readiness;
  if (readiness && (ledger.readinessContractVersion !== readiness.contractVersion
      || Object.entries(ledger.readinessDecisions).some(([name, value]) => (
        !readiness.capabilities?.[name]
        || (value === 'not-applicable' && !readiness.capabilities[name].allowNotApplicable)
      )))) {
    throw new Error('candidate invariant schema: Consumer ledger readiness references are invalid');
  }
  return ledger;
}

function uniqueEntries(entries, source) {
  const indexed = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string') {
      throw new Error(`candidate invariant schema: ${source} entry path is required`);
    }
    try {
      validateCandidateManifestPath(entry.path);
    } catch {
      throw new Error(`candidate invariant schema: unsafe ${source} path ${entry.path}`);
    }
    if (indexed.has(entry.path)) {
      throw new Error(`candidate invariant schema: duplicate ${source} path ${entry.path}`);
    }
    indexed.set(entry.path, entry);
  }
  return indexed;
}

function validateInstalledEntry(tracked, desired, origin) {
  if (tracked.origin !== origin
      || (tracked.installRole ?? CONSUMER_INSTALL_ROLE) !== CONSUMER_INSTALL_ROLE
      || !HASH.test(tracked.installedSha256 ?? '')) {
    throw new Error(`candidate invariant ownership: invalid ledger entry ${tracked.path}`);
  }
  for (const key of ['kind', 'ownerSkill', 'surface']) {
    if ((tracked[key] ?? null) !== (desired[key] ?? null)) {
      throw new Error(`candidate invariant ownership: ${key} mismatch ${tracked.path}`);
    }
  }
  if (tracked.origin === KIT_ORIGIN && tracked.installedSha256 !== desired.sha256) {
    throw new Error(`candidate invariant ownership: Kit hash identity mismatch ${tracked.path}`);
  }
  if (tracked.origin === KIT_ORIGIN && tracked.ownershipState !== undefined) {
    throw new Error(`candidate invariant ownership: Kit path has Consumer lifecycle ${tracked.path}`);
  }
  if (tracked.origin === CONSUMER_ORIGIN && ![
    undefined, 'project-extension', 'contribution-bridge', 'explicit-fork',
  ].includes(tracked.ownershipState)) {
    throw new Error(`candidate invariant ownership: invalid lifecycle ${tracked.path}`);
  }
}

function verifyLedgerMetadata(ledger, context) {
  const expected = emptyConsumerManifest(
    context.pkg.kitVersion,
    context.priorConsumerManifest,
    context.nextReadinessManifest?.readiness ?? null,
  );
  const { installed: _actualInstalled, ...actualMetadata } = ledger;
  const { installed: _expectedInstalled, ...expectedMetadata } = expected;
  if (!isDeepStrictEqual(actualMetadata, expectedMetadata)) {
    throw new Error(
      'candidate invariant schema: Consumer ledger metadata differs from trusted prior state',
    );
  }
}

function expectedOrigin(path, priorInstalled, preview) {
  const transferredToCore = (preview.migrations ?? []).some(
    (migration) => migration.path === path && migration.ownership === 'kit-core',
  );
  if (transferredToCore) return KIT_ORIGIN;
  const keptOwned = (preview.collisionResolutions ?? []).some(
    (resolution) => resolution.path === path && resolution.outcome !== 'replace',
  );
  return keptOwned || (priorInstalled.get(path)?.origin ?? KIT_ORIGIN) === CONSUMER_ORIGIN
    ? CONSUMER_ORIGIN
    : KIT_ORIGIN;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
