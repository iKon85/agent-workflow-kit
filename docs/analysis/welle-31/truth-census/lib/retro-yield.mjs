#!/usr/bin/env node
// Recount of #380's "Retro yield" claim from the FROZEN export, not from a
// fresh query: `docs/evidence/welle-31/aggregate-queries.json`, export
// `merged-pr-retro-marker`. The mandate carried 128 / 69 / 8; the freeze is a
// day later and a larger population, so the claim is recounted rather than
// repeated.
//
// Usage: node lib/retro-yield.mjs
// Writes: data/retro-yield.json

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(BASE, '../../../..');
const file = path.join(ROOT, 'docs/evidence/welle-31/aggregate-queries.json');
const raw = readFileSync(file, 'utf8');
const doc = JSON.parse(raw);
const exportRow = doc.exports.find((e) => e.id === 'merged-pr-retro-marker');
const rows = exportRow.rows.map((r) => JSON.parse(r));

const marker = rows.filter((r) => r.retro !== 'absent');
const byValue = {};
for (const r of rows) byValue[r.retro] = (byValue[r.retro] ?? 0) + 1;

const payload = {
  schema: 'welle-31/truth-census/retro-yield/v1',
  source: 'docs/evidence/welle-31/aggregate-queries.json#merged-pr-retro-marker',
  sourceSha256: exportRow.sha256,
  fileSha256: createHash('sha256').update(raw).digest('hex'),
  fetchedAt: exportRow.fetchedAt,
  mergedPullRequests: rows.length,
  markerPresent: marker.length,
  markerByValue: byValue,
  offClosedSet: byValue.other ?? 0,
  anyFindingsHeading: rows.filter((r) => r.findingsHeading).length,
  metaSection: rows.filter((r) => r.metaSection).length,
  markerAndFindingsHeading: marker.filter((r) => r.findingsHeading).length,
  markerAndNoFindingsHeading: marker.filter((r) => !r.findingsHeading).length,
  mandateClaim: { mergedPullRequests: 128, markerPresent: 69, findingsSection: 8 },
  note: 'the `other` bucket is a `**Retro:**` line whose value is outside the enforced closed set — recorded, not promoted: the check may post-date those pull requests, and this census ran no ablation to tell the two apart',
};
writeFileSync(path.join(BASE, 'data/retro-yield.json'), `${JSON.stringify(payload, null, 1)}\n`);
console.log(payload);
