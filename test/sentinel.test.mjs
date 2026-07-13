import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubSentinel, firstLineState } from '../src/lib/sentinel.mjs';

test('stubSentinel is the #989 contract first line', () => {
  assert.equal(stubSentinel(), '<!-- setup-workflow: state=stub -->');
});

test('firstLineState reads the state from a sentinel first line', () => {
  assert.equal(firstLineState('<!-- setup-workflow: state=stub -->\nbody'), 'stub');
  assert.equal(firstLineState('<!-- setup-workflow: state=filled -->\n# Title'), 'filled');
  assert.equal(
    firstLineState('<!-- setup-workflow: state=not-applicable; mode=none -->'),
    'not-applicable'
  );
});

test('firstLineState returns null when the first line is not a sentinel', () => {
  assert.equal(firstLineState('# Just a heading\n<!-- setup-workflow: state=stub -->'), null);
  assert.equal(firstLineState(''), null);
});
