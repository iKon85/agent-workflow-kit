import assert from 'node:assert/strict';
import test from 'node:test';

import { assertReleasableDelta } from '../scripts/kit-release.mjs';

/**
 * A release prepared with no delta against its base is not a release. The guard
 * exists because a preparation run from the wrong checkout produced exactly
 * that: version, manifest and release notes written, and a release note reading
 * "Metadata-only release." as its only tell.
 */

const empty = { added: [], removed: [], changed: [] };

test('an empty delta is refused with a named reason', () => {
  assert.throws(
    () => assertReleasableDelta(empty),
    /no shipped delta/,
  );
});

test('each delta field alone is enough to release', () => {
  // Positive control: the guard must not refuse by default. A test that only
  // proves the refusal cannot distinguish a working guard from a broken one
  // that refuses everything.
  for (const field of ['added', 'removed', 'changed']) {
    const delta = { ...empty, [field]: ['src/lib/example.mjs'] };
    assert.equal(assertReleasableDelta(delta), delta, `${field} alone must pass`);
  }
});

test('a missing or malformed delta is refused rather than assumed empty', () => {
  // Fail closed: an unreadable delta must not read as "nothing changed", which
  // would turn the guard into a silent pass on the one input it cannot judge.
  for (const bad of [undefined, null, {}, { added: 'src/lib/example.mjs' }]) {
    assert.throws(() => assertReleasableDelta(bad), /delta/);
  }
});
