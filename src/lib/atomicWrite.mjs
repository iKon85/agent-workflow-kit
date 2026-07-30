import { constants } from 'node:fs';
import { writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_BACKUP_NAMES = 1000;

/**
 * Write `content` to `path` atomically: write a sibling temp file, then rename
 * (atomic on the same filesystem). Creates parent dirs. Preserves `mode` if given.
 */
export async function writeAtomic(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const opts = mode === undefined ? 'utf8' : { encoding: 'utf8', mode };
  await writeFile(tmp, content, opts);
  await rename(tmp, path);
}

/**
 * Copy an existing file to `path.<stamp>.bak` and return the backup path.
 *
 * A backup is the only copy of bytes the caller is about to replace, so this is
 * non-clobbering by construction: the copy is exclusive (`COPYFILE_EXCL`), and
 * an occupied name falls through to `path.<stamp>-1.bak`, `-2`, … . The stamp
 * stays caller-supplied so tests stay deterministic — but a same-stamp retry,
 * two writes inside one second, or a leftover backup can no longer overwrite
 * the copy that already holds the original.
 */
export async function backupFile(path, stamp) {
  for (let attempt = 0; attempt < MAX_BACKUP_NAMES; attempt += 1) {
    const bak = attempt === 0 ? `${path}.${stamp}.bak` : `${path}.${stamp}-${attempt}.bak`;
    try {
      await copyFile(path, bak, constants.COPYFILE_EXCL);
      return bak;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`no free backup name for ${path} at stamp ${stamp}`);
}

/** The backup suffix: `YYYYMMDDTHHMMSS`, no separator a shell would eat. */
export function backupStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

/**
 * Minimal LCS-based line diff → unified-ish text. Context lines prefixed ' ',
 * removals '-', additions '+'. Empty string when the inputs are identical.
 */
export function lineDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // LCS table
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(' ' + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push('-' + a[i]); i++; }
    else { out.push('+' + b[j]); j++; }
  }
  while (i < m) out.push('-' + a[i++]);
  while (j < n) out.push('+' + b[j++]);
  return out.some((l) => l[0] !== ' ') ? out.join('\n') : '';
}
