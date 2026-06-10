// setup-workflow idempotency sentinel (contract). npx init seeds project-layer
// stub files with this exact first line so /setup-workflow's stub→fill detection works.

const RE = /^<!--\s*setup-workflow:\s*state=([a-z-]+)(?:;[^>]*)?\s*-->\s*$/;

/** The first line npx init writes onto every seeded project-layer file. */
export function stubSentinel() {
  return '<!-- setup-workflow: state=stub -->';
}

/**
 * State declared by the FIRST line only (a later mention does not count, per).
 * Returns 'stub' | 'filled' | 'not-applicable' | ... or null if the first line
 * is not a sentinel.
 */
export function firstLineState(text) {
  const first = String(text).split('\n', 1)[0];
  const m = RE.exec(first);
  return m ? m[1] : null;
}
