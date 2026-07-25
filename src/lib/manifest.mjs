import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} is corrupt (invalid JSON) and can't be read. ` +
        'Restore it from a nearby ".bak" backup, or delete it and re-run `init` to re-track the kit files.',
      { cause: err }
    );
  }
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
  for (const entry of (manifest?.[key] ?? [])) idx.set(entry.path, entry);
  return idx;
}

/** Return a manifest with one tracked entry moved to the requested ownership state. */
export function withOrigin(manifest, path, origin) {
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
    installed: manifest.installed.map((entry) => entry.path === path ? { ...entry, origin } : entry),
  };
}
