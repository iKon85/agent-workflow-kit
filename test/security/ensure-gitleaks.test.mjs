import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ensureGitleaks } from '../../scripts/security/ensure-gitleaks.mjs';

const archive = Buffer.from('verified fixture archive');
const checksum = createHash('sha256').update(archive).digest('hex');
const profile = {
  version: 'fixture',
  platforms: {
    'linux-x64': {
      asset: 'gitleaks_fixture_linux_x64.tar.gz',
      sha256: checksum,
    },
  },
};

test('only checksum-verified bytes reach the installer', async () => {
  const installed = [];
  const result = await ensureGitleaks({
    profile,
    platform: 'linux',
    arch: 'x64',
    destination: '/fixture/bin/gitleaks',
    isAvailable: async () => false,
    fetchArchive: async () => archive,
    installArchive: async (input) => installed.push(input),
  });

  assert.equal(result.status, 'installed');
  assert.equal(installed.length, 1);
  assert.equal(installed[0].bytes, archive);
});

test('unsupported platforms perform no fetch or install writes', async () => {
  let touched = false;
  const result = await ensureGitleaks({
    profile,
    platform: 'darwin',
    arch: 'arm64',
    isAvailable: async () => false,
    fetchArchive: async () => {
      touched = true;
    },
    installArchive: async () => {
      touched = true;
    },
  });
  assert.equal(result.status, 'unsupported-platform');
  assert.equal(touched, false);
});

test('checksum mismatch never reaches the installer', async () => {
  let wrote = false;
  const result = await ensureGitleaks({
    profile,
    platform: 'linux',
    arch: 'x64',
    isAvailable: async () => false,
    fetchArchive: async () => Buffer.from('tampered archive'),
    installArchive: async () => {
      wrote = true;
    },
  });
  assert.equal(result.status, 'checksum-mismatch');
  assert.equal(wrote, false);
});

test('offline and unwritable provisioning are distinct non-throwing outcomes', async () => {
  const offline = await ensureGitleaks({
    profile,
    platform: 'linux',
    arch: 'x64',
    isAvailable: async () => false,
    fetchArchive: async () => {
      throw new Error('network unavailable');
    },
  });
  assert.equal(offline.status, 'offline');

  const unwritable = await ensureGitleaks({
    profile,
    platform: 'linux',
    arch: 'x64',
    isAvailable: async () => false,
    fetchArchive: async () => archive,
    installArchive: async () => {
      throw new Error('read-only destination');
    },
  });
  assert.equal(unwritable.status, 'unwritable');
});
