import { writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
 * Copy an existing file to `path.<stamp>.bak` (caller supplies the stamp so the
 * name never collides and tests stay deterministic). Returns the backup path.
 */
export async function backupFile(path, stamp) {
  const bak = `${path}.${stamp}.bak`;
  await copyFile(path, bak);
  return bak;
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
