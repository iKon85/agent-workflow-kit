#!/usr/bin/env node
// Reviewer A — the mechanical half of the double review (#380 §3).
//
// Applies the rubric's signal table literally to a rule span and returns
// { column, signal, signals[] }. It is deterministic and re-runnable, which is
// the point: reviewer B reads the column definitions, reviewer A applies the
// table, and the disagreement between them is what calibrates the rubric.
//
// Usage:
//   node lib/reviewer-mechanical.mjs --revision r2 --sample   # sample only
//   node lib/reviewer-mechanical.mjs --revision r2 --all      # every rule
//
// Writes data/reviewer-a.<revision>.<scope>.json

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const BASE = path.join(ROOT, 'docs/analysis/welle-31/truth-census');

const RE = {
  equality: /(===|!==|\.trim\(\)\s*===|==\s*["'])/,
  containment: /(\.includes\(|\.startsWith\(|startswith\(|\bin command\b|fnmatch|\.endsWith\(|\bin\s+\w+_?text\b|re\.(search|match)\(|\.match\(\/)/i,
  bytes: /(sha256|digest|same_bytes|byte-compare|_same_bytes|hash\(|read_bytes\(\)\s*==)/i,
  verifyClaim: /\b(verifies|verifie[sd]|ensures?|guarantees?|proves?|makes sure)\b/i,
  imperative: /\b(must|never|always|do not|don't|shall|forbidden|prohibited)\b/i,
  mechanismNamed: /(`[^`]*\.(mjs|py|sh|json|md)`|\b(hook|lint|guard|workflow|script|test|CI|gate)\b|scripts\/|\.claude\/)/i,
  blocks: /\b(blocks?|refuses?|rejects?|fails?|stops?|blocked|STOP)\b/i,
  recovery: /\b(instead|recover|recovery|re-?run|rerun|then|fix|route|fallback|next step|resume|retry|repair)\b/i,
  prescribes: /\b(use\s+`?[A-Za-z@./-]+`?\s+(for|when|to|instead)|prefer\b|instead of\b|rather than\b|always use\b|never use\b|via\b)/i,
  convention: /(naming|heading|frontmatter|manifest|vocabulary|marker|label|slug|template|schema)/i,
  projectFact: /(#\d+|`[^`]+`|scripts\/|src\/|docs\/|\.claude\/|\.agents\/|@ikon85)/,
  readerMismatch: /\b(the user (?:will|must|should)|ask the user|tell the user|the human)\b/i,
};

// --- r3 -------------------------------------------------------------------
// r1 fired the truth signals on every string comparison, including the
// shape/type validations where the comparison IS the question; r2 widened the
// form signals until nearly every imperative clause was a finding. r3 keeps
// the same column definitions and narrows the signals to the distinguishing
// property: a comparison is a truth signal when the compared value stands in
// for something else (a path, a command, a heading, an estimate), not when it
// validates its own shape.
const R3 = {
  literalCompare: /(===|!==|\s==\s|\s!=\s)\s*(['"][^'"]{1,60}['"]|true|false)|(['"][^'"]{1,60}['"])\s*(===|!==|\s==\s|\s!=\s)/,
  shapeCheck: /(typeof |Array\.isArray|instanceof |Number\.isFinite|isinstance|=== *(null|undefined)|!== *(null|undefined)|is not True|is None)/,
  shapeMessage: /(must be an?|must be one of|is required|must contain|must not contain|non-empty|unique|invalid |unknown |unsupported |duplicate|schemaVersion)/i,
  containment: /(\.includes\(|\.startsWith\(|\.endsWith\(|startswith\(|endswith\(|\bin command\b|\bnot in\b|fnmatch|\bin\s+\(|glob)/i,
  proxySubject: /\b(command|path|cwd|target|url|branch|line|heading|dir|root|worktree|checkout|file name|filename)\b/i,
  failOpen: /(fail-open|fails open|fail closed only when|we return False|counts as ignored)/i,
  bytesProxy: /(same_bytes|byte-compare|byte-identical|byte-for-byte)/i,
  verifyClaim: /\b(verifies|verified|ensures?|guarantees?|proves?)\b/i,
  literalTrigger: /(##\s+[A-Z][\w-]+|byte-identical|byte-for-byte|verbatim|exactly one of|exact match|exact tested-version)/,
  thresholdCode: /(>=?|<=?)\s*([A-Z][A-Z_]*_(LIMIT|MAX|MIN|THRESHOLD|COUNT)|\d{1,6})\b/,
  thresholdProse: /(≥|>=|>|<|×|x)\s*\d+\s*(estimated|files?|×|times|the estimate)|\b\d+×|\bmore than \d+/i,
  errnoPredicate: /(error\.code|errno|typeof |isinstance|Array\.isArray)/,
  authorizationMessage: /(unsafe|outside the|authoriz|forbidden|not permitted|escapes)/i,
  formatRegex: /(\.test\(|re\.match|re\.search|match\(\/)/,
  formatSubject: /\b(version|semver|tag|branch|heading|marker)\b/i,
  imperative: /\b(never|don'?t|do not|must|always)\b/i,
  vagueness: /\b(blind(ly)?|organically|rigid|radically|structurally|concise|fake|invent|leftover|guess|cave|skip|a few|as needed|appropriate|reasonable|proof)\b/i,
  closedSet: /(closed set|copy verbatim|mandatory)/i,
  prescribes: /(\balways (via|use|through|through)\b|\bonly (through|via|with)\b|\bnever (use|substitute|port|add|expose|introduce|reference|drift|assume|hand-assemble|`?closes`?)\b|\bdon'?t (use|expose|introduce|reference|assume|drift|build|copy)\b|\binstead of\b|\brather than\b|\bprefer\b|\bDispatch only through\b|\bmay specialize\b)/i,
};

function reviewR3(rule) {
  const span = rule.span ?? '';
  const code = rule.carrier === 'code';
  const prose = rule.carrier === 'prose';
  const hits = [];

  if (code && R3.literalCompare.test(span)
    && !R3.shapeCheck.test(span) && !R3.shapeMessage.test(span)) hits.push('T1');
  if (code && R3.containment.test(span) && R3.proxySubject.test(span)
    && !R3.shapeMessage.test(span)) hits.push('T2');
  if (rule.action === 'fail-open' || R3.failOpen.test(span)) hits.push('T3');
  if (R3.bytesProxy.test(span)) hits.push('T4');
  if (prose && R3.verifyClaim.test(span)) hits.push('T5');
  if (prose && R3.literalTrigger.test(span)) hits.push('T6');
  if ((code && R3.thresholdCode.test(span) && !R3.shapeMessage.test(span))
    || (prose && R3.thresholdProse.test(span))) hits.push('T7');
  if (code && R3.errnoPredicate.test(span) && R3.authorizationMessage.test(span)) hits.push('T8');
  if (code && R3.formatRegex.test(span) && R3.formatSubject.test(span)) hits.push('T9');

  if (prose && R3.imperative.test(span) && R3.vagueness.test(span)) hits.push('F1');
  if (code && rule.action === 'warn' && R3.imperative.test(span)) hits.push('F2');
  if (prose && R3.closedSet.test(span) && R3.imperative.test(span)) hits.push('F5');

  if (prose && R3.prescribes.test(span)) hits.push('O1');

  const column = hits.some((h) => h.startsWith('T')) ? 'truth'
    : hits.some((h) => h.startsWith('F')) ? 'form'
      : hits.some((h) => h.startsWith('O')) ? 'ownership'
        : 'none';
  return { column, signal: column === 'none' ? 'no-finding' : 'finding', signals: hits };
}

export function reviewRule(rule, revision = 'r3') {
  if (revision === 'r3') return reviewR3(rule);
  return reviewLegacy(rule, revision);
}

function reviewLegacy(rule, revision) {
  const span = rule.span ?? '';
  const code = rule.carrier === 'code';
  const prose = rule.carrier === 'prose';
  const hits = [];

  // --- truth -------------------------------------------------------------
  if (code && RE.equality.test(span)) hits.push('T1');
  if (code && RE.containment.test(span)) {
    if (revision === 'r1') {
      if (/(\.includes\(|\.startsWith\(|startswith\()/.test(span)) hits.push('T2');
    } else hits.push('T2');
  }
  if (rule.action === 'fail-open') hits.push('T3');
  if (revision !== 'r1' && code && RE.bytes.test(span)) hits.push('T4');
  if (prose && RE.verifyClaim.test(span)) hits.push('T5');

  // --- form --------------------------------------------------------------
  if (revision !== 'r1' && prose && RE.imperative.test(span) && !RE.mechanismNamed.test(span)) hits.push('F1');
  if (code && rule.action === 'warn' && RE.imperative.test(span)) hits.push('F2');
  if (revision !== 'r1' && RE.blocks.test(span) && !RE.recovery.test(span)) hits.push('F3');
  if (revision !== 'r1' && prose && RE.readerMismatch.test(span)) hits.push('F4');

  // --- ownership ---------------------------------------------------------
  if (prose && RE.prescribes.test(span)) hits.push('O1');
  if (code && RE.convention.test(span)) hits.push('O2');
  if (revision !== 'r1' && prose && RE.imperative.test(span) && !RE.projectFact.test(span)) hits.push('O3');

  const column = hits.some((h) => h.startsWith('T')) ? 'truth'
    : hits.some((h) => h.startsWith('F')) ? 'form'
      : hits.some((h) => h.startsWith('O')) ? 'ownership'
        : 'none';

  return { column, signal: column === 'none' ? 'no-finding' : 'finding', signals: hits };
}

function main() {
  const revision = process.argv.includes('--revision')
    ? process.argv[process.argv.indexOf('--revision') + 1] : 'r3';
  const all = process.argv.includes('--all');
  const scope = all ? 'all' : 'sample';
  const rules = all
    ? JSON.parse(readFileSync(path.join(BASE, 'data/rules.json'), 'utf8')).rules
    : JSON.parse(readFileSync(path.join(BASE, 'data/sample.json'), 'utf8')).sample;

  const labels = rules.map((rule) => ({
    rule_id: rule.rule_id,
    index: rule.index ?? null,
    ...reviewRule(rule, revision),
  }));
  const byColumn = {};
  for (const l of labels) byColumn[l.column] = (byColumn[l.column] ?? 0) + 1;

  const out = path.join(BASE, `data/reviewer-a.${revision}.${scope}.json`);
  writeFileSync(out, `${JSON.stringify({
    schema: 'welle-31/truth-census/reviewer/v1',
    reviewer: 'A-mechanical',
    revision,
    scope,
    total: labels.length,
    byColumn,
    labels,
  }, null, 1)}\n`);
  // Deliberately silent about the distribution: reviewer B labels the same
  // sample before this file is read, and printing it here would leak.
  console.log(`reviewer A (${revision}, ${scope}) wrote ${labels.length} labels`);
}

if (process.argv[1] && process.argv[1].endsWith('reviewer-mechanical.mjs')) main();
