import { readFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { writeAtomic } from './atomicWrite.mjs';

// Two manifests (Codex R1#9 / R3#1):
//  - package manifest (shipped with the kit): the desired-state file list.
//  - consumer manifest (agent-workflow-kit.json in the target repo root): installed state.
// Package entries model every file kind and install role:
//   { path, kind: 'skill'|'script'|'hook'|'template'|'doc', ownerSkill?, surface?,
//     installRole: 'consumer'|'maintainer', sha256, mode, origin: 'kit' }
// Consumer manifests record their top-level installRole and retain the role on
// every installed entry, including edited legacy maintainer files kept in place.

export const CONSUMER_MANIFEST_NAME = 'agent-workflow-kit.json';
export const PACKAGE_MANIFEST_NAME = 'agent-workflow-kit.package.json';
export const CONSUMER_INSTALL_ROLE = 'consumer';
export const KIT_ORIGIN = 'kit';
export const CONSUMER_ORIGIN = 'consumer';
export const READINESS_CONTRACT_VERSION = 1;
export const READINESS_MANIFEST_PATH = '.claude/skills/skill-manifest.json';
export { PROJECT_SKILL_REGISTRY_PATH } from './skillRegistry.mjs';

const HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(['skill', 'script', 'hook', 'template', 'doc']);
const SURFACES = new Set(['claude', 'codex']);
const INSTALL_ROLES = new Set([CONSUMER_INSTALL_ROLE, 'maintainer']);
const ORIGINS = new Set([KIT_ORIGIN, CONSUMER_ORIGIN]);
const OWNERSHIP_STATES = new Set([
  'project-extension', 'contribution-bridge', 'explicit-fork',
]);
const READINESS_DECISIONS = new Set(['pending', 'not-applicable']);

/**
 * Parse a JSON manifest, or null if the file does not exist. A corrupt file
 * (invalid JSON — e.g. from an aborted write before writeManifest went atomic)
 * throws a clear, recovery-hinting error instead of a raw JSON.parse stack;
 * every command reads this file on startup, so an unreadable manifest bricks
 * init/update/diff/uninstall until the user is told how to recover.
 */
export async function readManifest(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} is corrupt (invalid JSON) and can't be read. ` +
        'Restore it from a nearby ".bak" backup, or delete it and re-run `init` to re-track the kit files.',
      { cause: err }
    );
  }
  const name = basename(path);
  if (name === PACKAGE_MANIFEST_NAME) {
    return validateManifest(manifest, { kind: 'package', path });
  }
  if (name === CONSUMER_MANIFEST_NAME) {
    return validateManifest(manifest, { kind: 'consumer', path });
  }
  return manifest;
}

/**
 * Validate the two persisted lifecycle manifests before their entries are
 * indexed or trusted. Unknown extension keys remain untouched; known fields
 * are deliberately strict. Compatibility is explicit:
 * - package manifests before role-aware installs may omit `installRole`;
 * - consumer ledgers before role-aware installs may omit `installRole`;
 * - readiness fields introduced after the first consumer ledger are optional.
 */
export function validateManifest(manifest, { kind, path }) {
  if (kind !== 'package' && kind !== 'consumer') {
    throw new Error(`unknown manifest class: ${kind}`);
  }
  const recovery = kind === 'package'
    ? 'Reinstall the Kit or regenerate its package manifest from a trusted checkout.'
    : 'Restore the consumer manifest from its ".bak" backup, or delete it and re-run `init`.';
  const fail = (detail) => {
    throw new Error(`${path} is an invalid ${kind} manifest: ${detail} ${recovery}`);
  };
  if (!plainObject(manifest)) fail('the root must be a JSON object.');
  if (typeof manifest.kitVersion !== 'string' || manifest.kitVersion.length === 0) {
    fail('kitVersion must be a non-empty string.');
  }
  const key = kind === 'package' ? 'files' : 'installed';
  if (!Array.isArray(manifest[key])) fail(`${key} must be an array.`);
  if (kind === 'consumer') validateConsumerRoot(manifest, fail);

  const seen = new Set();
  for (const [offset, entry] of manifest[key].entries()) {
    const ordinal = `entry #${offset + 1}`;
    if (!plainObject(entry)) fail(`${ordinal} must be a JSON object.`);
    if (!safeManifestPath(entry.path)) {
      fail(`${ordinal} has an unsafe consumer path (${display(entry.path)}); use a relative POSIX path without "." or ".." segments.`);
    }
    const label = `${ordinal} (${entry.path})`;
    if (seen.has(entry.path)) fail(`${label} duplicates path ${entry.path}.`);
    seen.add(entry.path);
    validateEnum(entry, 'kind', KINDS, label, fail, true);
    validateOptionalString(entry, 'ownerSkill', label, fail);
    validateEnum(entry, 'surface', SURFACES, label, fail);
    validateEnum(entry, 'installRole', INSTALL_ROLES, label, fail);
    validateEnum(entry, 'origin', ORIGINS, label, fail, true);
    if (kind === 'package') {
      validateHash(entry.sha256, `${label} sha256`, fail);
      if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) {
        fail(`${label} mode must be an integer from 0 through 511.`);
      }
      if (entry.origin !== KIT_ORIGIN) fail(`${label} origin must be "kit".`);
    } else {
      validateHash(entry.installedSha256, `${label} installedSha256`, fail);
      if ('sha256' in entry) validateHash(entry.sha256, `${label} sha256`, fail);
      if ('mode' in entry
          && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) {
        fail(`${label} mode must be an integer from 0 through 511.`);
      }
      validateConsumerEntry(entry, label, fail);
    }
  }
  return manifest;
}

function validateConsumerRoot(manifest, fail) {
  if ('installRole' in manifest && manifest.installRole !== CONSUMER_INSTALL_ROLE) {
    fail('installRole must be "consumer".');
  }
  if ('readinessContractVersion' in manifest
      && (!Number.isInteger(manifest.readinessContractVersion)
        || manifest.readinessContractVersion < 1)) {
    fail('readinessContractVersion must be a positive integer.');
  }
  if ('readinessDecisions' in manifest) {
    if (!plainObject(manifest.readinessDecisions)) {
      fail('readinessDecisions must be a JSON object.');
    }
    for (const [capability, decision] of Object.entries(manifest.readinessDecisions)) {
      if (!capability || !READINESS_DECISIONS.has(decision)) {
        fail(`readinessDecisions.${capability || '<empty>'} has unsupported value ${display(decision)}.`);
      }
    }
  }
}

function validateConsumerEntry(entry, label, fail) {
  if ('orphanedByUninstall' in entry && typeof entry.orphanedByUninstall !== 'boolean') {
    fail(`${label} orphanedByUninstall must be a boolean.`);
  }
  validateEnum(entry, 'ownershipState', OWNERSHIP_STATES, label, fail);
  if ('ownershipState' in entry && entry.origin !== CONSUMER_ORIGIN) {
    fail(`${label} ownershipState requires origin "consumer".`);
  }
  if (!('contributionBridge' in entry)) return;
  const bridge = entry.contributionBridge;
  if (!plainObject(bridge)
      || bridge.schemaVersion !== 1
      || typeof bridge.baseKitVersion !== 'string'
      || bridge.baseKitVersion.length === 0) {
    fail(`${label} contributionBridge must be a schemaVersion 1 object with baseKitVersion.`);
  }
  validateHash(bridge.baseSha256, `${label} contributionBridge.baseSha256`, fail);
  validateHash(bridge.localSha256, `${label} contributionBridge.localSha256`, fail);
  if (entry.origin !== CONSUMER_ORIGIN
      || entry.ownershipState !== 'contribution-bridge'
      || entry.installedSha256 !== bridge.localSha256) {
    fail(`${label} contributionBridge must match consumer ownership and installedSha256.`);
  }
}

function validateEnum(entry, field, values, label, fail, required = false) {
  if (!(field in entry)) {
    if (required) fail(`${label} ${field} is required.`);
    return;
  }
  if (typeof entry[field] !== 'string' || !values.has(entry[field])) {
    fail(`${label} ${field} has unsupported value ${display(entry[field])}.`);
  }
}

function validateOptionalString(entry, field, label, fail) {
  if (field in entry && (typeof entry[field] !== 'string' || entry[field].length === 0)) {
    fail(`${label} ${field} must be a non-empty string when present.`);
  }
}

function validateHash(value, field, fail) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    fail(`${field} must be a lowercase 64-hex SHA-256.`);
  }
}

function safeManifestPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && path !== '.'
    && !path.includes('\\')
    && !path.includes('//')
    && !path.split('/').some((part) => part === '' || part === '.' || part === '..')
    && !posix.isAbsolute(path)
    && !/^[a-zA-Z]:/.test(path)
    && posix.normalize(path) === path;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function display(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * Write a manifest as pretty JSON with a trailing newline, atomically
 * (temp file + rename via writeAtomic) — an abort mid-write must never leave a
 * truncated/corrupt manifest, since every command reads it on startup.
 */
export async function writeManifest(path, obj) {
  await writeAtomic(path, JSON.stringify(obj, null, 2) + '\n');
}

export async function readReadinessContract(root) {
  const manifest = await readManifest(join(root, READINESS_MANIFEST_PATH));
  return manifest?.readiness ?? null;
}

function retainedDecisions(prior, readiness) {
  const allowed = readiness?.capabilities ? new Set(Object.keys(readiness.capabilities)) : null;
  return Object.fromEntries(Object.entries(prior.readinessDecisions ?? {}).filter(
    ([name, value]) => (!allowed || allowed.has(name)) && (value === 'pending'
      || (value === 'not-applicable' && readiness?.capabilities?.[name]?.allowNotApplicable)),
  ));
}

export function emptyConsumerManifest(kitVersion, prior = {}, readiness = null) {
  prior ??= {};
  return {
    ...prior,
    kitVersion,
    installRole: CONSUMER_INSTALL_ROLE,
    readinessContractVersion: readiness?.contractVersion ?? READINESS_CONTRACT_VERSION,
    readinessDecisions: retainedDecisions(prior, readiness),
    installed: [],
  };
}

/** Package entries without a role predate role-aware installs and remain consumer-owned. */
export function filesForInstallRole(manifest, installRole = CONSUMER_INSTALL_ROLE) {
  return (manifest?.files ?? []).filter(
    (entry) => (entry.installRole ?? CONSUMER_INSTALL_ROLE) === installRole,
  );
}

/** Map a manifest's file list (under `key`) by `path` for quick lookup. */
export function indexByPath(manifest, key) {
  const idx = new Map();
  for (const entry of (manifest?.[key] ?? [])) {
    if (idx.has(entry.path)) throw new Error(`duplicate manifest path: ${entry.path}`);
    idx.set(entry.path, entry);
  }
  return idx;
}

/** Return a manifest with one tracked entry moved to the requested ownership state. */
export function withOrigin(
  manifest, path, origin, ownershipState = 'explicit-fork', installedSha256,
) {
  if (![KIT_ORIGIN, CONSUMER_ORIGIN].includes(origin)) {
    throw new Error(`invalid manifest origin: ${origin}`);
  }
  const current = (manifest?.installed ?? []).find((entry) => entry.path === path);
  if (!current) throw new Error(`unknown tracked path: ${path}`);
  if ((current.origin ?? KIT_ORIGIN) === origin) {
    throw new Error(`${path} is already ${origin}-owned`);
  }
  return {
    ...manifest,
    installed: manifest.installed.map((entry) => {
      if (entry.path !== path) return entry;
      if (origin === KIT_ORIGIN) {
        const {
          ownershipState: _removed,
          contributionBridge: _removedBridge,
          ...core
        } = entry;
        return { ...core, origin };
      }
      if (ownershipState !== 'explicit-fork') {
        throw new Error(`invalid consumer ownership state: ${ownershipState}`);
      }
      return {
        ...entry,
        ...(installedSha256 ? { installedSha256 } : {}),
        origin,
        ownershipState,
      };
    }),
  };
}
