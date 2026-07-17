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
  name: '@ikon85/agent-workflow-kit',
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

test('consumer parity proves npm↔github and matches the installed copy without re-packing', async () => {
  const { assertConsumerReleaseParity } = await import('./release-parity.mjs');
  const installed = { name: identity.name, version: identity.version, manifestSha256: identity.manifestSha256 };
  assert.deepEqual(
    assertConsumerReleaseParity({ installed, npm: { ...identity }, github: { ...identity } }),
    identity,
  );
  assert.throws(() => assertConsumerReleaseParity({
    installed, npm: { ...identity }, github: { ...identity, tarballIntegrity: 'different' },
  }), /github tarballIntegrity mismatch/);
  assert.throws(() => assertConsumerReleaseParity({
    installed: { ...installed, manifestSha256: 'different' },
    npm: { ...identity }, github: { ...identity },
  }), /installed manifestSha256 mismatch/);
  assert.throws(() => assertConsumerReleaseParity({
    installed: { ...installed, version: '9.9.9' },
    npm: { ...identity }, github: { ...identity },
  }), /installed version mismatch/);
});

test('an installed kit directory yields a content identity without npm pack', async () => {
  const { installedIdentityFromDir } = await import('./release-parity.mjs');
  const root = await mkdtemp(join(tmpdir(), 'release-parity-installed-'));
  try {
    const manifest = JSON.stringify({ kitVersion: '1.2.3', files: [] });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: identity.name, version: '1.2.3' }));
    await writeFile(join(root, 'agent-workflow-kit.package.json'), manifest);
    const installed = await installedIdentityFromDir(root);
    assert.equal(installed.name, identity.name);
    assert.equal(installed.version, '1.2.3');
    assert.equal(typeof installed.manifestSha256, 'string');
    assert.equal('tarballIntegrity' in installed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
