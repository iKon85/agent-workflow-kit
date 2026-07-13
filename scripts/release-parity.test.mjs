import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertReleaseParity, releaseIdentityFromTarball } from './release-parity.mjs';

const exec = promisify(execFile);

const identity = {
  name: 'agent-workflow-kit',
  version: '1.2.3',
  tarballIntegrity: 'sha512-example',
  manifestSha256: 'abc123',
};

test('identical local, npm, and GitHub release identities have parity', () => {
  assert.deepEqual(assertReleaseParity({ local: identity, npm: { ...identity }, github: { ...identity } }), identity);
});

test('a registry or GitHub content mismatch fails closed', () => {
  assert.throws(() => assertReleaseParity({
    local: identity,
    npm: { ...identity, manifestSha256: 'different' },
    github: { ...identity },
  }), /npm manifestSha256 mismatch/);
  assert.throws(() => assertReleaseParity({
    local: identity,
    npm: { ...identity },
    github: { ...identity, tarballIntegrity: 'different' },
  }), /github tarballIntegrity mismatch/);
});

test('a package tarball produces a deterministic content identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-parity-'));
  const packageDir = join(root, 'package');
  const tarball = join(root, 'kit.tgz');
  try {
    await mkdir(packageDir);
    await writeFile(join(packageDir, 'package.json'), '{"name":"kit","version":"2.0.0"}\n');
    await writeFile(join(packageDir, 'agent-workflow-kit.package.json'), '{"kitVersion":"2.0.0","files":[]}\n');
    await exec('tar', ['-czf', tarball, '-C', root, 'package']);
    const first = await releaseIdentityFromTarball(tarball);
    const second = await releaseIdentityFromTarball(tarball);
    assert.equal(first.name, 'kit');
    assert.equal(first.version, '2.0.0');
    assert.match(first.tarballIntegrity, /^sha512-/);
    assert.match(first.manifestSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(first, second);
  } finally { await rm(root, { recursive: true, force: true }); }
});
