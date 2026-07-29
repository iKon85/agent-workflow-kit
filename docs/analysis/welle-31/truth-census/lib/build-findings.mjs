#!/usr/bin/env node
// The full pass (#380 §8.3) — assembles findings.json from:
//
//   data/rules.json               the counted rule population (the denominator)
//   data/reviewer-a.r3.all.json   the frozen rubric applied to every rule
//   data/reviewer-b.json          the read review of the stratified sample
//   data/promotions.json          the promotion objects this round can carry
//
// Verdict assignment is mechanical, never editorial:
//   promotion present               -> the promotion's verdict (keep / cut)
//   sampled, reviewers disagree     -> unknown  (the column is unsettled)
//   column != none                  -> hypothesis
//   column == none                  -> no-finding, counted in coverage, not emitted
//
// Nothing here can hand a `cut` or `keep` to a rule without a promotion object:
// the output is validated by lib/validate-findings.mjs before it is written.
//
// Usage: node lib/build-findings.mjs
// Writes: findings.json, data/coverage.json

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { validateAll } from './validate-findings.mjs';

const BASE = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(BASE, '../../../..');
const read = (rel) => JSON.parse(readFileSync(path.join(BASE, rel), 'utf8'));

const rulesDoc = read('data/rules.json');
const rules = new Map(rulesDoc.rules.map((r) => [r.rule_id, r]));
const a = read('data/reviewer-a.r3.all.json');
const b = read('data/reviewer-b.json');
const promotions = new Map(read('data/promotions.json').promotions.map((p) => [p.rule_id, p]));
// The rubric froze on the POOLED rate. Five strata sit above the threshold on
// their own, and a finding drawn from one of them is not as well calibrated as
// the pooled number suggests — so it is capped at `low` confidence rather than
// inheriting the pooled reassurance.
const calibration = read('data/calibration.json');
const poorlyCalibrated = new Set(Object.entries(calibration.rounds.r3.perStratum)
  .filter(([, v]) => v.rate > calibration.threshold).map(([k]) => k));

const bByRule = new Map(b.labels.map((l) => [l.rule_id, l]));
const aByRule = new Map(a.labels.map((l) => [l.rule_id, l]));

const findings = [];
const coverage = {
  totalRules: rulesDoc.total,
  reviewedMechanical: a.labels.length,
  reviewedRead: b.labels.length,
  byPartition: {},
  byVerdict: {},
  byColumn: {},
  noFinding: 0,
};

function claimFor(rule, column) {
  const head = rule.span.length > 180 ? `${rule.span.slice(0, 177)}...` : rule.span;
  if (column === 'truth') {
    return `Truth (static): the enforced predicate in this span is not obviously the property the rule is about — \`${head}\`. Read statically against the frozen rubric; no fixture has been run against it, so the reading is a hypothesis, not a measurement.`;
  }
  if (column === 'form') {
    return `Form (static): the binding hardness of this span is not obviously proportionate to how certainly the thing is known, or it fires without naming a route out — \`${head}\`. Read statically; unpromoted.`;
  }
  return `Ownership (static): this span decides something that binds the project beyond the change it is written for, or states what a capable agent arrives at unaided — \`${head}\`. The unaided half is a CUT hypothesis and needs an ablation before it is anything more.`;
}

for (const [ruleId, labelA] of aByRule) {
  const rule = rules.get(ruleId);
  const labelB = bByRule.get(ruleId);
  const promoted = promotions.get(ruleId);
  const sampled = Boolean(labelB);
  const disagreed = sampled && labelB.column !== labelA.column;

  coverage.byPartition[rule.partition] ??= { rules: 0, findings: 0, sampled: 0 };
  coverage.byPartition[rule.partition].rules += 1;
  if (sampled) coverage.byPartition[rule.partition].sampled += 1;

  let column = labelA.column;
  let verdict;
  let promotion = null;
  let claim;
  let evidence;
  let confidence;

  if (promoted) {
    column = promoted.column;
    verdict = promoted.verdict;
    promotion = promoted.promotion;
    claim = promoted.claim;
    evidence = promoted.evidence;
    confidence = promoted.confidence;
  } else if (column === 'none' && (!sampled || labelB.column === 'none')) {
    coverage.noFinding += 1;
    coverage.byVerdict['no-finding'] = (coverage.byVerdict['no-finding'] ?? 0) + 1;
    continue;
  } else if (disagreed) {
    // The two reviewers name different columns: the column is unsettled, and
    // an unsettled column is `unknown` — a first-class outcome, not a coin flip.
    verdict = 'unknown';
    column = labelA.column === 'none' ? labelB.column : labelA.column;
    claim = `Unsettled column: the mechanical review reads this span as \`${labelA.column}\`, the read review as \`${labelB.column}\`. Within the calibrated ${(calibration.rounds.r3.rate * 100).toFixed(1)}% disagreement band; recorded as unknown rather than adjudicated silently.`;
    evidence = [
      `${rule.path}:${rule.line}`,
      'docs/analysis/welle-31/truth-census/data/calibration.json',
    ];
    confidence = 'low';
  } else {
    verdict = 'hypothesis';
    claim = claimFor(rule, column);
    evidence = [`${rule.path}:${rule.line}`, `signals: ${labelA.signals.join(', ') || 'read review only'}`];
    const stratum = `${rule.partition}/${rule.kind}`;
    confidence = sampled && !poorlyCalibrated.has(stratum) ? 'medium' : 'low';
  }

  coverage.byPartition[rule.partition].findings += 1;
  coverage.byVerdict[verdict] = (coverage.byVerdict[verdict] ?? 0) + 1;
  coverage.byColumn[column] = (coverage.byColumn[column] ?? 0) + 1;

  findings.push({
    rule_id: ruleId,
    line: rule.line,
    partition: rule.partition,
    carrier: rule.carrier,
    column,
    verdict,
    claim,
    evidence,
    promotion,
    confidence,
    reviewer: promoted ? 'A+B+promotion' : (sampled ? 'A+B' : 'A'),
    unit_id: rule.unit_id,
  });
}

const problems = validateAll(findings);
if (problems.length) {
  for (const problem of problems.slice(0, 40)) console.error(problem);
  console.error(`REFUSING TO WRITE: ${problems.length} schema violation(s)`);
  process.exit(1);
}

const censusCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
writeFileSync(path.join(BASE, 'findings.json'), `${JSON.stringify({
  schema: 'welle-31/truth-census/findings/v1',
  substrateCommit: '16325e59f9c1815231f8e37c431881219fac9762',
  censusCommit,
  rubricRevision: 'r3 (frozen)',
  calibrationRate: calibration.rounds.r3.rate,
  poorlyCalibratedStrata: [...poorlyCalibrated],
  total: findings.length,
  byVerdict: coverage.byVerdict,
  byColumn: coverage.byColumn,
  findings,
}, null, 1)}\n`);
writeFileSync(path.join(BASE, 'data/coverage.json'), `${JSON.stringify(coverage, null, 1)}\n`);
console.log('findings:', findings.length, coverage.byVerdict);
console.log('by column:', coverage.byColumn);
console.log('per partition:', coverage.byPartition);
