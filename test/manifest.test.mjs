import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readManifest,
  writeManifest,
  emptyConsumerManifest,
  indexByPath,
} from '../src/lib/manifest.mjs';

test('readManifest returns null for a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awk-mf-'));
  try {
    assert.equal(await readManifest(join(dir, 'nope.json')), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeManifest then readManifest round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awk-mf-'));
  try {
    const p = join(dir, 'm.json');
    const obj = {
      kitVersion: '0.1.0',
      installed: [
        { path: '.claude/skills/to-prd/SKILL.md', kind: 'skill', ownerSkill: 'to-prd',
          surface: 'claude', sha256: 'abc', mode: 0o644, origin: 'kit' },
      ],
    };
    await writeManifest(p, obj);
    assert.deepEqual(await readManifest(p), obj);
    // human-readable (pretty-printed, trailing newline)
    const raw = await readFile(p, 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.ok(raw.includes('\n  '));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('emptyConsumerManifest carries the kit version and empty install list', () => {
  const m = emptyConsumerManifest('1.2.3');
  assert.equal(m.kitVersion, '1.2.3');
  assert.deepEqual(m.installed, []);
});

test('indexByPath maps each file entry by its path', () => {
  const idx = indexByPath({ files: [{ path: 'a' }, { path: 'b' }] }, 'files');
  assert.equal(idx.get('a').path, 'a');
  assert.equal(idx.size, 2);
});

test('writeManifest routes through writeAtomic: creates missing parent dirs', async () => {
  // A plain fs.writeFile would throw ENOENT here — the target dir does not exist
  // yet. writeAtomic mkdir(dirname, {recursive:true})s before writing, so this
  // only succeeds if writeManifest is wired through the atomic-write seam.
  const dir = await mkdtemp(join(tmpdir(), 'awk-mf-'));
  try {
    const p = join(dir, 'nested', 'sub', 'agent-workflow-kit.json');
    const obj = emptyConsumerManifest('1.0.0');
    await writeManifest(p, obj);
    assert.deepEqual(await readManifest(p), obj);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readManifest on a corrupt file throws a clear recovery-hint error, not a raw JSON.parse stack', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'awk-mf-'));
  try {
    const p = join(dir, 'agent-workflow-kit.json');
    await writeFile(p, '{ this is not valid json');
    await assert.rejects(() => readManifest(p), (err) => {
      assert.doesNotMatch(err.message, /Unexpected token/i, 'no raw JSON.parse message leaked');
      assert.match(err.message, /corrupt/i, 'names the problem');
      assert.match(err.message, /init|backup|delete/i, 'gives a recovery hint');
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
