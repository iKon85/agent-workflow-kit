import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRelease } from './release-delta-guard.mjs';

const file = (path, sha256) => ({ path, sha256 });

test('an unbumped shipped change is blocked with its concrete delta', () => {
  const result = assessRelease({
    baseVersion: '1.2.3', currentVersion: '1.2.3',
    baseManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'old')] },
    builtManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'new')] },
    checkedManifest: { kitVersion: '1.2.3', files: [file('skill.md', 'old')] },
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
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /dead entry: gone\.md/);
});

test('a matching regenerated manifest and semantic bump pass', () => {
  const current = { kitVersion: '1.3.0', files: [file('new.md', 'one')] };
  const result = assessRelease({
    baseVersion: '1.2.3', currentVersion: '1.3.0',
    baseManifest: { kitVersion: '1.2.3', files: [] }, builtManifest: current,
    checkedManifest: current,
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
      builtManifest: current, checkedManifest: current,
    });
    assert.equal(result.ok, false, currentVersion);
    assert.match(result.errors.join('\n'), /invalid version transition: 1\.2\.3 ->/);
  }
});
