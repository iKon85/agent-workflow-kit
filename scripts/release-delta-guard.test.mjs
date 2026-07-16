import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKit } from './build-kit.mjs';
import {
  assessRelease, manifestDelta, packedPayloadManifest,
} from './release-delta-guard.mjs';

const file = (path, sha256) => ({ path, sha256 });
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('fresh build manifest hashes match the actual npm package payload', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'awkit-packed-manifest-test-'));
  try {
    const distDir = join(tempRoot, 'dist');
    await buildKit({ repoRoot, distDir });
    const built = JSON.parse(await readFile(join(distDir, 'agent-workflow-kit.package.json'), 'utf8'));
    const packed = await packedPayloadManifest({ repoRoot, manifest: built });
    assert.deepEqual(manifestDelta(built, packed), { added: [], removed: [], changed: [] });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('an unbumped shipped change is blocked with its concrete delta', () => {
  const result = assessRelease({
    baseVersion: '1.2.3', currentVersion: '1.2.3',
    baseManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'old')] },
    builtManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'new')] },
    checkedManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'old')] },
    payloadManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'new')] },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.delta.changed, ['skill.md']);
  assert.match(result.errors.join('\n'), /skill\.md/);
  assert.match(result.errors.join('\n'), /version remains 1\.2\.3/);
});

test('dead checked-manifest entries are rejected', () => {
  const result = assessRelease({
    baseVersion: '1.2.3', currentVersion: '1.3.0',
    baseManifest: { kitVersion: '1.2.3', files: [] },
    builtManifest: { kitVersion: '1.3.0', files: [] },
    checkedManifest: { kitVersion: '1.3.0', files: [file('gone.md', 'old')] },
    payloadManifest: { kitVersion: '1.3.0', files: [] },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /dead entry: gone\.md/);
});

test('a matching regenerated manifest and semantic bump pass', () => {
  const current = { kitVersion: '1.3.0', files: [file('new.md', 'one')] };
  const result = assessRelease({
    baseVersion: '1.2.3', currentVersion: '1.3.0',
    baseManifest: { kitVersion: '1.2.3', files: [] }, builtManifest: current,
    checkedManifest: current, payloadManifest: current,
  });
  assert.equal(result.ok, true);
  assert.equal(result.recommendedBump, 'minor');
});

test('shipped content rejects downgrade and malformed version transitions', () => {
  for (const currentVersion of ['1.1.0', 'banana']) {
    const current = { kitVersion: currentVersion, files: [file('skill.md', 'new')] };
    const result = assessRelease({
      baseVersion: '1.2.3', currentVersion,
      baseManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'old')] },
      builtManifest: current, checkedManifest: current, payloadManifest: current,
    });
    assert.equal(result.ok, false, currentVersion);
    assert.match(result.errors.join('\n'), /invalid version transition: 1\.2\.3 ->/);
  }
});

test('actual npm payload drift is blocked even when checked and built manifests match', () => {
  const scrubbed = { kitVersion: '1.2.3', files: [file('skill.md', 'scrubbed')] };
  const result = assessRelease({
    baseVersion: '1.2.3', currentVersion: '1.2.3',
    baseManifest: scrubbed, builtManifest: scrubbed, checkedManifest: scrubbed,
    payloadManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'source')] },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /npm package payload.*changed: skill\.md/);
});
