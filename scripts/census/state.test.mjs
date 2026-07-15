import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CENSUS_STATES, resolveCensusState } from './index.mjs';

test('state resolver implements the complete census state contract', () => {
  assert.deepEqual(CENSUS_STATES, [
    'disabled', 'bootstrap', 'current', 'refresh_required', 'updating', 'failed',
  ]);
  assert.equal(resolveCensusState({ enabled: false }), 'disabled');
  assert.equal(resolveCensusState({ enabled: true, hasActive: false }), 'bootstrap');
  assert.equal(resolveCensusState({ enabled: true, hasActive: true }), 'current');
  assert.equal(resolveCensusState({ enabled: true, hasActive: true, hasOpen: true }), 'refresh_required');
  assert.equal(resolveCensusState({ enabled: true, hasActive: true, updating: true }), 'updating');
  assert.equal(resolveCensusState({ enabled: true, hasActive: true, failed: true }), 'failed');
});
