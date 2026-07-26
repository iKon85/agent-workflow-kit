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
  validateManifest,
} from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';

const HASH = sha256('manifest bytes');

function packageManifest(overrides = {}) {
  return {
    kitVersion: '1.2.3',
    files: [{
      path: 'scripts/example.mjs',
      kind: 'script',
      sha256: HASH,
      mode: 0o644,
      origin: 'kit',
    }],
    ...overrides,
  };
}

function consumerManifest(overrides = {}) {
  return {
    kitVersion: '1.2.3',
    installed: [{
      path: 'scripts/example.mjs',
      kind: 'script',
      installedSha256: HASH,
      origin: 'kit',
    }],
    ...overrides,
  };
}

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

test('package and consumer manifest validation rejects duplicate paths before indexing', () => {
  for (const [kind, manifest, key] of [
    ['package', packageManifest(), 'files'],
    ['consumer', consumerManifest(), 'installed'],
  ]) {
    manifest[key].push({ ...manifest[key][0] });
    assert.throws(
      () => validateManifest(manifest, { kind, path: `/fixture/${kind}.json` }),
      (error) => {
        assert.match(error.message, new RegExp(`/fixture/${kind}\\.json`));
        assert.match(error.message, /duplicate.*scripts\/example\.mjs/i);
        assert.match(error.message, /restore|regenerate|init/i);
        return true;
      },
    );
  }
  assert.throws(
    () => indexByPath({ files: [{ path: 'same' }, { path: 'same' }] }, 'files'),
    /duplicate manifest path: same/,
  );
});

test('manifest validation rejects unsafe path spellings without normalising them', () => {
  const unsafe = [
    '', '.', '..', '/absolute', '../outside', 'nested/../outside', 'nested/./file',
    'nested//file', 'nested\\file', 'C:/absolute', 'C:drive-relative', '//server/share',
  ];
  for (const path of unsafe) {
    const manifest = packageManifest();
    manifest.files[0].path = path;
    assert.throws(
      () => validateManifest(manifest, { kind: 'package', path: '/kit/package.json' }),
      (error) => {
        assert.match(error.message, /\/kit\/package\.json/);
        assert.match(error.message, /entry #1/);
        assert.match(error.message, /unsafe.*path/i);
        return true;
      },
      path,
    );
  }
});

test('manifest validation rejects malformed hashes, known field types, and enum values', () => {
  const invalid = [
    ['package', packageManifest({ files: [{ ...packageManifest().files[0], sha256: 'ABC' }] }), /sha256/],
    ['package', packageManifest({ files: [{ ...packageManifest().files[0], kind: 'binary' }] }), /kind/],
    ['package', packageManifest({ files: [{ ...packageManifest().files[0], surface: 'both' }] }), /surface/],
    ['package', packageManifest({ files: [{ ...packageManifest().files[0], installRole: 'operator' }] }), /installRole/],
    ['package', packageManifest({ files: [{ ...packageManifest().files[0], origin: 'consumer' }] }), /origin/],
    ['package', packageManifest({ files: [{ ...packageManifest().files[0], mode: '0644' }] }), /mode/],
    ['consumer', consumerManifest({ installed: [{ ...consumerManifest().installed[0], installedSha256: null }] }), /installedSha256/],
    ['consumer', consumerManifest({ installed: [{ ...consumerManifest().installed[0], origin: 'vendor' }] }), /origin/],
    ['consumer', consumerManifest({ installed: [{ ...consumerManifest().installed[0], kind: [] }] }), /kind/],
    ['consumer', consumerManifest({ installRole: false }), /installRole/],
    ['consumer', consumerManifest({ readinessDecisions: [] }), /readinessDecisions/],
  ];
  for (const [kind, manifest, expected] of invalid) {
    assert.throws(
      () => validateManifest(manifest, { kind, path: `/fixture/${kind}.json` }),
      expected,
    );
  }
});

test('explicit compatibility accepts the immutable v0.9 package shape and legacy role omissions', async () => {
  const historical = JSON.parse(await readFile(
    join(import.meta.dirname, 'fixtures/v0.9.0-agent-workflow-kit.package.json'),
    'utf8',
  ));
  assert.equal(
    validateManifest(historical, { kind: 'package', path: 'v0.9.0 fixture' }),
    historical,
  );

  const legacy = consumerManifest();
  delete legacy.installed[0].installRole;
  delete legacy.installRole;
  assert.equal(
    validateManifest(legacy, { kind: 'consumer', path: 'legacy consumer fixture' }),
    legacy,
  );
});

test('consumer manifest validation preserves unknown extension keys', () => {
  const manifest = consumerManifest({
    consumerExtension: { future: true },
  });
  manifest.installed[0].extensionMetadata = { preserved: true };
  assert.equal(
    validateManifest(manifest, { kind: 'consumer', path: 'consumer fixture' }),
    manifest,
  );
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
