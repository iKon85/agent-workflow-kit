import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256File } from '../src/lib/hash.mjs';

test('sha256File returns the hex digest of file contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awk-hash-'));
  try {
    const f = join(dir, 'x.txt');
    await writeFile(f, 'hello'); // known vector
    assert.equal(
      await sha256File(f),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
