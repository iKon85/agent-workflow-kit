function byPath(census) {
  return new Map(census.denominator.map((entry) => [entry.path, entry.hash]));
}

export function diffCensus(previous, next) {
  const before = byPath(previous);
  const after = byPath(next);
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const changed = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path)).sort();
  const open = [...next.families.surfaces, ...next.families.behaviors]
    .filter(({ status }) => status === 'offen').map(({ name }) => name).sort();
  return { added, changed, open, removed };
}
