import test from 'node:test';
import assert from 'node:assert/strict';

import { loadRoutingInventory, snapshotDigest } from '../src/lib/routingInventory.mjs';
import {
  IDENTITY_MATCH_EXACT,
  IDENTITY_MATCH_PUNCTUATION,
  IDENTITY_UNRESOLVED_AMBIGUOUS,
  IDENTITY_UNRESOLVED_UNKNOWN,
  createModelIdentityResolver,
} from '../src/lib/routingModelIdentity.mjs';

// The six models the Routing profile authorizes, as DeepSWE publishes them in
// the live artifact recorded on 2026-07-28.
const ROSTER = [
  ['claude-opus-5', 'claude-code', 'anthropic', 'opus', IDENTITY_MATCH_EXACT],
  ['claude-sonnet-5', 'claude-code', 'anthropic', 'sonnet', IDENTITY_MATCH_EXACT],
  ['claude-fable-5', 'claude-code', 'anthropic', 'fable', IDENTITY_MATCH_EXACT],
  ['gpt-5-6-sol', 'codex', 'openai', 'gpt-5.6-sol', IDENTITY_MATCH_PUNCTUATION],
  ['gpt-5-6-terra', 'codex', 'openai', 'gpt-5.6-terra', IDENTITY_MATCH_PUNCTUATION],
  ['gpt-5-6-luna', 'codex', 'openai', 'gpt-5.6-luna', IDENTITY_MATCH_PUNCTUATION],
];

test('every roster model published by an owner joins onto its inventory pair', async () => {
  const resolver = createModelIdentityResolver(await loadRoutingInventory());
  for (const [publishedId, surface, provider, modelId, matchedBy] of ROSTER) {
    const record = resolver.resolve(publishedId);
    assert.equal(record.resolved, true, `${publishedId} must resolve`);
    assert.equal(record.publishedId, publishedId);
    assert.equal(record.surface, surface, `${publishedId} surface`);
    assert.equal(record.provider, provider, `${publishedId} provider`);
    assert.equal(record.modelId, modelId, `${publishedId} modelId`);
    assert.equal(record.matchedBy, matchedBy, `${publishedId} match tier`);
  }
});

test('a published id outside the inventory is returned unresolved, never dropped', async () => {
  const resolver = createModelIdentityResolver(await loadRoutingInventory());
  const record = resolver.resolve('glm-5-2');
  assert.equal(record.resolved, false);
  assert.equal(record.publishedId, 'glm-5-2');
  assert.equal(record.reason, IDENTITY_UNRESOLVED_UNKNOWN);
  assert.deepEqual([...record.candidates], []);
});

test('a form matching several inventory models is ambiguous, not a guess', () => {
  const resolver = createModelIdentityResolver({
    snapshots: [
      { surface: 'claude-code', provider: 'anthropic', models: [{ modelId: 'opus', identifiers: ['opus'] }] },
      { surface: 'codex', provider: 'openai', models: [{ modelId: 'opus', identifiers: ['opus'] }] },
    ],
  });
  const record = resolver.resolve('opus');
  assert.equal(record.resolved, false);
  assert.equal(record.reason, IDENTITY_UNRESOLVED_AMBIGUOUS);
  assert.deepEqual([...record.candidates], ['claude-code:opus', 'codex:opus']);
});

test('an exact identifier wins over a punctuation-insensitive one', () => {
  const resolver = createModelIdentityResolver({
    snapshots: [{
      surface: 'codex',
      provider: 'openai',
      models: [
        { modelId: 'gpt-5.6', identifiers: ['gpt-5.6'] },
        { modelId: 'gpt-56', identifiers: ['gpt-56'] },
      ],
    }],
  });
  const record = resolver.resolve('gpt-56');
  assert.equal(record.resolved, true);
  assert.equal(record.modelId, 'gpt-56');
  assert.equal(record.matchedBy, IDENTITY_MATCH_EXACT);
});

test('an inventory with no model is refused instead of resolving nothing', () => {
  assert.throws(
    () => createModelIdentityResolver({ snapshots: [] }),
    /lists no model to join against/,
  );
});

test('a blank published id is refused rather than matched', async () => {
  const resolver = createModelIdentityResolver(await loadRoutingInventory());
  assert.throws(() => resolver.resolve('  '), /publishedId must be a non-empty string/);
});

test('the edited snapshots still validate against their recorded provenance hash', async () => {
  const inventory = await loadRoutingInventory();
  for (const snapshot of inventory.snapshots) {
    assert.equal(
      snapshotDigest(snapshot),
      snapshot.provenance.integrity,
      `${snapshot.file} digest must match its recorded provenance hash`,
    );
    assert.match(snapshot.provenance.integrity, /^sha256-[A-Za-z0-9_-]+$/);
  }
  const claude = inventory.snapshots.find(({ file }) => file === 'claude.json');
  const sonnet = claude.models.find(({ modelId }) => modelId === 'sonnet');
  assert.ok(sonnet.identifiers.includes('claude-sonnet-5'), 'sonnet must list its published alias');
  assert.ok(sonnet.identifiers.includes('sonnet'), 'a model never drops its canonical id');
});
