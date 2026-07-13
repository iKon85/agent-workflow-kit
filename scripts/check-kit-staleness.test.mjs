import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffManifests } from './check-kit-staleness.mjs';

test('manifest parity reports no drift for identical path hashes', () => {
  const manifest = { files: [{ path: 'a', sha256: 'one' }] };
  assert.deepEqual(diffManifests(manifest, manifest), { added: [], removed: [], changed: [] });
});

test('manifest parity counts added, removed, and changed files', () => {
  const checked = { files: [{ path: 'gone', sha256: '1' }, { path: 'same', sha256: '1' }, { path: 'changed', sha256: '1' }] };
  const built = { files: [{ path: 'new', sha256: '1' }, { path: 'same', sha256: '1' }, { path: 'changed', sha256: '2' }] };
  assert.deepEqual(diffManifests(checked, built), {
    added: ['new'], removed: ['gone'], changed: ['changed'],
  });
});
