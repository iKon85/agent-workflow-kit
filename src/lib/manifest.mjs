import { readFile, writeFile } from 'node:fs/promises';

// Two manifests (Codex R1#9 / R3#1):
//  - package manifest (shipped with the kit): the desired-state file list.
//  - consumer manifest (agent-workflow-kit.json in the target repo root): installed state.
// Both model every file kind:
//   { path, kind: 'skill'|'script'|'hook'|'template'|'doc', ownerSkill?, surface?,
//     sha256, mode, origin: 'kit' }

export const CONSUMER_MANIFEST_NAME = 'agent-workflow-kit.json';
export const PACKAGE_MANIFEST_NAME = 'agent-workflow-kit.package.json';

/** Parse a JSON manifest, or null if the file does not exist. */
export async function readManifest(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

/** Write a manifest as pretty JSON with a trailing newline. */
export async function writeManifest(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
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
