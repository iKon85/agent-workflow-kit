#!/usr/bin/env node
// Calibration — the double review of the stratified sample (#380 §3).
//
// Reviewer A: `lib/reviewer-mechanical.mjs`, the rubric's signal table applied
// literally, deterministic and re-runnable.
// Reviewer B: `data/reviewer-b.json`, one column per sampled rule, produced by
// reading the rule against the rubric's column definitions. B's labels were
// recorded BEFORE any reviewer-A output was read, and are frozen — a rubric
// revision changes the signal table only, never a column definition, so B is
// not re-run (#380 §3: "any later change re-runs the affected column").
//
// Disagreement is COUNTED, never estimated: the rate is the share of sampled
// rules where the two reviewers name a different column.
//
// Usage: node lib/calibrate.mjs
// Writes: data/calibration.json

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = path.resolve(import.meta.dirname, '..');
const read = (rel) => JSON.parse(readFileSync(path.join(BASE, rel), 'utf8'));

function compare(a, b, sample) {
  const byId = new Map(a.labels.map((l) => [l.rule_id, l]));
  const rows = [];
  for (const label of b.labels) {
    const mine = byId.get(label.rule_id);
    const rule = sample.find((r) => r.rule_id === label.rule_id);
    rows.push({
      rule_id: label.rule_id,
      index: rule?.index ?? null,
      stratum: rule ? `${rule.partition}/${rule.kind}` : null,
      a: mine?.column ?? null,
      b: label.column,
      agree: (mine?.column ?? null) === label.column,
    });
  }
  const disagreements = rows.filter((r) => !r.agree);
  const confusion = {};
  for (const r of disagreements) {
    const key = `A:${r.a} vs B:${r.b}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  const perStratum = {};
  for (const r of rows) {
    perStratum[r.stratum] ??= { n: 0, disagree: 0 };
    perStratum[r.stratum].n += 1;
    if (!r.agree) perStratum[r.stratum].disagree += 1;
  }
  for (const s of Object.values(perStratum)) s.rate = Number((s.disagree / s.n).toFixed(4));
  return {
    n: rows.length,
    disagreements: disagreements.length,
    rate: Number((disagreements.length / rows.length).toFixed(4)),
    confusion,
    perStratum,
    rows,
  };
}

const sample = read('data/sample.json').sample;
const b = read('data/reviewer-b.json');
const rounds = {};
for (const revision of ['r1', 'r2', 'r3']) {
  rounds[revision] = compare(read(`data/reviewer-a.${revision}.sample.json`), b, sample);
}

const frozen = rounds.r3.rate <= 0.2 ? 'r3' : null;
const payload = {
  schema: 'welle-31/truth-census/calibration/v1',
  threshold: 0.2,
  adjudicator: 'Niko',
  reviewers: {
    A: 'mechanical — lib/reviewer-mechanical.mjs, the rubric signal table applied literally',
    B: 'reading — data/reviewer-b.json, the rubric column definitions applied to each span',
  },
  rounds: Object.fromEntries(Object.entries(rounds).map(([k, v]) => [k, {
    rate: v.rate, disagreements: v.disagreements, n: v.n, confusion: v.confusion, perStratum: v.perStratum,
  }])),
  frozenRevision: frozen,
  frozenRate: frozen ? rounds[frozen].rate : null,
  detail: rounds.r3.rows,
};
writeFileSync(path.join(BASE, 'data/calibration.json'), `${JSON.stringify(payload, null, 1)}\n`);
for (const [rev, r] of Object.entries(rounds)) {
  console.log(`${rev}: ${r.disagreements}/${r.n} = ${(r.rate * 100).toFixed(1)}%`);
  console.log('  ', JSON.stringify(r.confusion));
}
console.log('frozen:', frozen ?? 'NOT FROZEN — the full pass may not begin');
