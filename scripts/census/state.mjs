export const CENSUS_STATES = Object.freeze([
  'disabled',
  'bootstrap',
  'current',
  'refresh_required',
  'updating',
  'failed',
]);

export const CENSUS_VERDICTS = Object.freeze({
  covered: 'abgedeckt',
  notRelevant: 'nicht relevant',
  open: 'offen',
});

export function resolveCensusState({ enabled, hasActive, hasOpen = false, updating = false, failed = false }) {
  if (!enabled) return 'disabled';
  if (updating) return 'updating';
  if (failed) return 'failed';
  if (!hasActive) return 'bootstrap';
  if (hasOpen) return 'refresh_required';
  return 'current';
}
