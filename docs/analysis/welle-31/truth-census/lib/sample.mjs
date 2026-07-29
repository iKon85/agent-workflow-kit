#!/usr/bin/env node
// Stratified calibration sample for the #380 truth census (§3).
//
//   sample size per stratum = max(ceil(0.15 * N), min(20, N))
//   stratum                 = partition x artifact kind
//   draw                    = stable rule-ID hash, ascending — never random,
//                             so the sample re-derives from the same rules.
//
// Usage: node docs/analysis/welle-31/truth-census/lib/sample.mjs [--print]
// Writes: docs/analysis/welle-31/truth-census/data/sample.json

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const RULES = path.join(ROOT, 'docs/analysis/welle-31/truth-census/data/rules.json');
const OUT = path.join(ROOT, 'docs/analysis/welle-31/truth-census/data/sample.json');

export function sampleSize(n) {
  return Math.min(n, Math.max(Math.ceil(0.15 * n), Math.min(20, n)));
}

export function drawOrder(ruleId) {
  return createHash('sha1').update(`welle-31/truth-census/draw:${ruleId}`).digest('hex');
}

function main() {
  const { rules, byStratum } = JSON.parse(readFileSync(RULES, 'utf8'));
  const groups = new Map();
  for (const rule of rules) {
    const stratum = `${rule.partition}/${rule.kind}`;
    if (!groups.has(stratum)) groups.set(stratum, []);
    groups.get(stratum).push(rule);
  }
  const strata = [];
  const drawn = [];
  for (const [stratum, members] of [...groups].sort()) {
    const size = sampleSize(members.length);
    const ordered = members
      .map((rule) => ({ rule, key: drawOrder(rule.rule_id) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, size)
      .map(({ rule }) => rule);
    strata.push({ stratum, population: members.length, sampled: ordered.length, full: ordered.length === members.length });
    drawn.push(...ordered);
  }
  const indexed = drawn.map((rule, index) => ({ index: index + 1, ...rule }));
  const payload = {
    schema: 'welle-31/truth-census/sample/v1',
    formula: 'max(ceil(0.15*N), min(20,N)) per partition x kind, drawn by stable rule-ID hash',
    populationTotal: Object.values(byStratum).reduce((a, b) => a + b, 0),
    sampleTotal: indexed.length,
    strata,
    sample: indexed,
  };
  writeFileSync(OUT, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`sample: ${indexed.length} of ${payload.populationTotal}`);
  for (const s of strata) console.log(` ${s.stratum}: ${s.sampled} of ${s.population}${s.full ? ' (full)' : ''}`);

  if (process.argv.includes('--print')) {
    for (const r of indexed) {
      console.log(`${String(r.index).padStart(3, '0')}\t${r.carrier}\t${r.partition}/${r.kind}\t${r.path}:${r.line}\t${r.span.slice(0, 200)}`);
    }
  }
}

main();
