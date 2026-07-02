import { readFile } from 'node:fs/promises';
import { writeAtomic } from './atomicWrite.mjs';

// Two manifests (Codex R1#9 / R3#1):
//  - package manifest (shipped with the kit): the desired-state file list.
//  - consumer manifest (agent-workflow-kit.json in the target repo root): installed state.
// Both model every file kind:
//   { path, kind: 'skill'|'script'|'hook'|'template'|'doc', ownerSkill?, surface?,
//     sha256, mode, origin: 'kit' }

export const CONSUMER_MANIFEST_NAME = 'agent-workflow-kit.json';
export const PACKAGE_MANIFEST_NAME = 'agent-workflow-kit.package.json';

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

export function emptyConsumerManifest(kitVersion) {
  return { kitVersion, installed: [] };
}

/** Map a manifest's file list (under `key`) by `path` for quick lookup. */
export function indexByPath(manifest, key) {
  const idx = new Map();
  for (const entry of (manifest?.[key] ?? [])) idx.set(entry.path, entry);
  return idx;
}
