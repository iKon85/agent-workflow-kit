import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, backupFile, lineDiff } from '../src/lib/atomicWrite.mjs';

test('writeAtomic writes content and preserves mode', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awk-aw-'));
  try {
    const p = join(dir, 'sub', 'f.txt'); // nested dir created
    await writeAtomic(p, 'data', 0o755);
    assert.equal(await readFile(p, 'utf8'), 'data');
    assert.equal((await stat(p)).mode & 0o777, 0o755);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backupFile copies the existing file to a timestamped, non-colliding name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awk-aw-'));
  try {
    const p = join(dir, 'f.txt');
    await writeFile(p, 'old');
    const bak = await backupFile(p, '20260610T120000');
    assert.equal(bak, p + '.20260610T120000.bak');
    assert.equal(await readFile(bak, 'utf8'), 'old');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lineDiff marks added and removed lines', () => {
  const d = lineDiff('a\nb\nc\n', 'a\nB\nc\n');
  assert.ok(d.includes('-b'));
  assert.ok(d.includes('+B'));
  assert.ok(d.includes(' a')); // context kept
});

test('lineDiff of identical text is empty', () => {
  assert.equal(lineDiff('x\ny\n', 'x\ny\n'), '');
});
