import { readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

const SETTINGS = ['.claude/settings.json', '.claude/settings.local.json'];

/**
 * True if any consumer settings file references the hook (by path or basename).
 * Used so update/uninstall never silently removes a hook that is still wired in
 * (Codex R3#7). Substring match on the raw text — robust to JSON shape.
 */
export async function hookReferenced(consumerRoot, hookPath) {
  const needle = basename(hookPath);
  for (const s of SETTINGS) {
    let raw;
    try {
      raw = await readFile(join(consumerRoot, s), 'utf8');
    } catch {
      continue;
    }
    if (raw.includes(hookPath) || raw.includes(needle)) return true;
  }
  return false;
}
