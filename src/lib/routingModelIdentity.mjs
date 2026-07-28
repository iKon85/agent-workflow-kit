/**
 * The join between a model id an owner publishes and the pinned Model
 * inventory.
 *
 * `candidateEntries` in `routingResolver.mjs` pairs an observation with an
 * Access-graph path on exact string equality of `providerId` and `modelId`, and
 * on a mismatch it simply continues: no blocker, no diagnostic, no trace that
 * a board ever named that model. This module is the layer that keeps the
 * mismatch visible — every published id either resolves to exactly one
 * inventory model or comes back as an unresolved record naming the id and the
 * reason, so the caller can report it.
 *
 * Matching follows the roster identification rule already in the repo
 * (`routingAdapters/hostBridge.mjs`): an id counts as identified when the
 * inventory lists it as an identifier of exactly one model. One tier is added
 * below it — punctuation-insensitive comparison, so a board writing
 * `gpt-5-6-sol` reaches the inventory's `gpt-5.6-sol` — and nothing beyond.
 * A form matching several models is ambiguous, not a guess.
 */

export const IDENTITY_MATCH_EXACT = 'exact';
export const IDENTITY_MATCH_PUNCTUATION = 'punctuation-insensitive';
export const IDENTITY_UNRESOLVED_UNKNOWN = 'no-inventory-model';
export const IDENTITY_UNRESOLVED_AMBIGUOUS = 'ambiguous-inventory-match';

const MATCH_TIERS = Object.freeze([IDENTITY_MATCH_EXACT, IDENTITY_MATCH_PUNCTUATION]);

const folded = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

function inventoryEntries(inventory) {
  const entries = [];
  for (const snapshot of inventory?.snapshots ?? []) {
    for (const model of snapshot.models ?? []) {
      entries.push(Object.freeze({
        surface: snapshot.surface,
        provider: snapshot.provider,
        modelId: model.modelId,
        identifiers: Object.freeze([...(model.identifiers ?? [])]),
      }));
    }
  }
  return entries;
}

function matchedIdentifier(entry, publishedId, tier) {
  if (tier === IDENTITY_MATCH_EXACT) {
    return entry.identifiers.find((identifier) => identifier === publishedId) ?? null;
  }
  const wanted = folded(publishedId);
  return entry.identifiers.find((identifier) => folded(identifier) === wanted) ?? null;
}

function resolvedRecord(publishedId, { entry, identifier }, matchedBy) {
  return Object.freeze({
    publishedId,
    resolved: true,
    matchedBy,
    identifier,
    surface: entry.surface,
    provider: entry.provider,
    modelId: entry.modelId,
  });
}

function unresolvedRecord(publishedId, reason, hits) {
  return Object.freeze({
    publishedId,
    resolved: false,
    reason,
    candidates: Object.freeze(hits.map(({ entry }) => `${entry.surface}:${entry.modelId}`).sort()),
  });
}

/**
 * Build a resolver over one pinned inventory. Pinned, not live: the resolver
 * reads the snapshots the caller already loaded and never widens them.
 */
export function createModelIdentityResolver(inventory) {
  const entries = inventoryEntries(inventory);
  if (entries.length === 0) {
    throw new TypeError('the routing inventory lists no model to join against');
  }
  const resolve = (publishedId) => {
    if (typeof publishedId !== 'string' || publishedId.trim() === '') {
      throw new TypeError('publishedId must be a non-empty string');
    }
    for (const tier of MATCH_TIERS) {
      const hits = entries
        .map((entry) => ({ entry, identifier: matchedIdentifier(entry, publishedId, tier) }))
        .filter(({ identifier }) => identifier !== null);
      if (hits.length === 1) return resolvedRecord(publishedId, hits[0], tier);
      if (hits.length > 1) {
        return unresolvedRecord(publishedId, IDENTITY_UNRESOLVED_AMBIGUOUS, hits);
      }
    }
    return unresolvedRecord(publishedId, IDENTITY_UNRESOLVED_UNKNOWN, []);
  };
  return Object.freeze({ resolve });
}
