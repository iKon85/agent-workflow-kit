#!/usr/bin/env node
// Findings schema validator (#380 §3).
//
// One declared output schema per finding:
//   rule_id · line · partition · carrier · column · verdict · claim ·
//   evidence[] · promotion · confidence · reviewer · unit_id
//
// The rule this file exists for: **`cut`/`keep` are schema-invalid without a
// well-formed `promotion` object** and are rejected mechanically, not reviewed
// and waved through. A `cut` additionally requires an `ablation` promotion —
// nothing else promotes a cut.
//
// Usage: node lib/validate-findings.mjs [path]   (exit 1 on any violation)

import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = path.resolve(import.meta.dirname, '..');

export const VERDICTS = new Set(['hypothesis', 'cut', 'keep', 'unknown', 'no-finding']);
export const COLUMNS = new Set(['ownership', 'truth', 'form']);
export const CARRIERS = new Set(['prose', 'code']);
export const CONFIDENCE = new Set(['low', 'medium', 'high']);
export const PROMOTION_KINDS = new Set([
  'ablation', 'reproduction', 'repeated-incident', 'structural-invariant',
]);
const REQUIRED = [
  'rule_id', 'line', 'partition', 'carrier', 'column', 'verdict', 'claim',
  'evidence', 'promotion', 'confidence', 'reviewer', 'unit_id',
];

export function validatePromotion(promotion) {
  const problems = [];
  if (!promotion || typeof promotion !== 'object' || Array.isArray(promotion)) {
    return ['promotion must be an object'];
  }
  if (!PROMOTION_KINDS.has(promotion.kind)) problems.push(`promotion.kind ${promotion.kind} is not a promotion kind`);
  if (promotion.kind === 'ablation') {
    if (!promotion.command) problems.push('ablation promotion needs the command that ran');
    if (!(promotion.repetitions >= 3)) problems.push('ablation promotion needs >= 3 repetitions');
    if (!promotion.positiveControl) problems.push('ablation promotion needs a positive control');
    if (!promotion.dimensions) problems.push('ablation promotion needs the directional vector (correctness/safety/recovery/friction)');
    if (!promotion.crossSurface) problems.push('ablation promotion needs cross-surface evidence before it generalizes');
  }
  if (promotion.kind === 'reproduction') {
    if (!promotion.command) problems.push('reproduction promotion needs a command');
    if (!promotion.observed) problems.push('reproduction promotion needs the observed output');
  }
  if (promotion.kind === 'repeated-incident') {
    if (!(promotion.occurrences >= 2)) problems.push('repeated-incident promotion needs >= 2 occurrences');
    if (!promotion.citation) problems.push('repeated-incident promotion needs an immutable citation');
  }
  if (promotion.kind === 'structural-invariant') {
    if (!Array.isArray(promotion.citations) || promotion.citations.length === 0) {
      problems.push('structural-invariant promotion needs citations');
    }
  }
  return problems;
}

export function validateFinding(finding, index) {
  const problems = [];
  const where = `finding[${index}] ${finding?.rule_id ?? '(no rule_id)'}`;
  for (const field of REQUIRED) {
    if (!(field in finding)) problems.push(`${where}: missing ${field}`);
  }
  if (!VERDICTS.has(finding.verdict)) problems.push(`${where}: verdict ${finding.verdict} is not in the declared set`);
  if (!COLUMNS.has(finding.column)) problems.push(`${where}: column ${finding.column} is not a declared column`);
  if (!CARRIERS.has(finding.carrier)) problems.push(`${where}: carrier ${finding.carrier} is not declared`);
  if (!CONFIDENCE.has(finding.confidence)) problems.push(`${where}: confidence ${finding.confidence} is not declared`);
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    problems.push(`${where}: evidence[] must carry at least one citation`);
  }
  if (typeof finding.claim !== 'string' || finding.claim.length < 20) {
    problems.push(`${where}: claim must state the defect`);
  }
  if (finding.verdict === 'cut' || finding.verdict === 'keep') {
    if (finding.promotion === null) {
      problems.push(`${where}: verdict ${finding.verdict} without a promotion object is schema-invalid`);
    } else {
      problems.push(...validatePromotion(finding.promotion).map((p) => `${where}: ${p}`));
      if (finding.verdict === 'cut' && finding.promotion?.kind !== 'ablation') {
        problems.push(`${where}: a cut is promoted by ablation alone, not by ${finding.promotion?.kind}`);
      }
      if (finding.verdict === 'keep' && finding.promotion?.kind === 'ablation') {
        problems.push(`${where}: an ablation promotes a cut, not a keep`);
      }
    }
  }
  if ((finding.verdict === 'hypothesis' || finding.verdict === 'unknown') && finding.promotion !== null) {
    problems.push(`${where}: ${finding.verdict} must carry promotion: null`);
  }
  return problems;
}

export function validateAll(findings) {
  return findings.flatMap((finding, index) => validateFinding(finding, index));
}

if (process.argv[1] && process.argv[1].endsWith('validate-findings.mjs')) {
  const target = process.argv[2] ?? path.join(BASE, 'findings.json');
  const document = JSON.parse(readFileSync(target, 'utf8'));
  const problems = validateAll(document.findings);
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error(`INVALID: ${problems.length} schema violation(s) over ${document.findings.length} findings`);
    process.exit(1);
  }
  const byVerdict = {};
  for (const f of document.findings) byVerdict[f.verdict] = (byVerdict[f.verdict] ?? 0) + 1;
  console.log(`VALID: ${document.findings.length} findings`, byVerdict);
}
