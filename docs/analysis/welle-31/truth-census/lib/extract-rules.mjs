#!/usr/bin/env node
// Rule extraction for the #380 truth census.
//
// Reads the frozen Analysis substrate inventory (consume-only) and extracts
// rule spans per #380 §3 "Rule identity":
//
//   prose rule — one clause with a directive verb or modal constraining
//   behaviour; a compound sentence with two independent directives is two
//   rules; headings, fenced examples and rationale are not rules.
//
//   code rule — one enforced contract: a predicate plus the action it gates
//   (block / fail / warn / mutate), including its fail-open branch.
//
// Identity is `<path>#<sha1 of normalized span, 12>#<occurrence index>`.
// Line numbers are location metadata, never identity.
//
// Usage:  node docs/analysis/welle-31/truth-census/lib/extract-rules.mjs [--check]
// Writes: docs/analysis/welle-31/truth-census/data/rules.json

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const SUBSTRATE = path.join(ROOT, 'docs/analysis/welle-31/substrate/inventory.json');
const OUT = path.join(ROOT, 'docs/analysis/welle-31/truth-census/data/rules.json');

export const CODE_EXTENSIONS = new Set(['.py', '.mjs', '.js', '.sh', '.yml', '.yaml']);
export const PROSE_EXTENSIONS = new Set(['.md']);

// Closed, versioned directive vocabulary. A prose clause is a rule only if it
// matches one of these. Widening this list is a rubric change and re-runs the
// affected column (#380 §3).
export const DIRECTIVES = [
  /\bmust not\b/i, /\bmust\b/i, /\bnever\b/i, /\balways\b/i,
  /\bdo not\b/i, /\bdon't\b/i, /\bdoes not\b(?=[^.]*\b(allow|permit|accept|run)\b)/i,
  /\bshall\b/i, /\bmay not\b/i, /\bcannot\b/i, /\bcan't\b/i,
  /\brequired\b/i, /\brequires\b/i, /\brequire\b/i,
  /\bforbidden\b/i, /\bprohibited\b/i, /\bnot allowed\b/i,
  /\bonly (?:with|when|if|after|by|the|a|an|one)\b/i,
  /\bblocks?\b/i, /\brefuses?\b/i, /\brejects?\b/i,
  /\benforces?\b/i, /\benforced\b/i, /\bfails\b/i,
  /\bno \w+ (?:is|are) (?:allowed|permitted)\b/i,
  /\bbefore (?:any|the) \w+/i,
];

// Code actions that gate behaviour. Each match anchors one rule span; the span
// is the nearest enclosing predicate (searched upward, bounded) plus the action.
const ACTIONS = [
  { re: /\bsys\.exit\s*\(/, kind: 'fail' },
  { re: /\bprocess\.exit\s*\(/, kind: 'fail' },
  { re: /\braise\s+[A-Z]\w*/, kind: 'fail' },
  { re: /\bthrow new\s+[A-Z]\w*/, kind: 'fail' },
  { re: /\bexit\s+[0-9]+/, kind: 'fail' },
  { re: /Decision\(\s*["']block["']/, kind: 'block' },
  { re: /Decision\(\s*["']deny["']/, kind: 'block' },
  { re: /["']permissionDecision["']\s*:\s*["']deny["']/, kind: 'block' },
  { re: /\bdeny\s*\(/, kind: 'block' },
  { re: /\bblock\s*\(/, kind: 'block' },
  { re: /\bfail\s*\(/, kind: 'fail' },
  { re: /\bwarn\s*\(/, kind: 'warn' },
  { re: /\bproblems\.append\s*\(/, kind: 'warn' },
  { re: /\bissues\.push\s*\(/, kind: 'warn' },
  { re: /\bproblems\.push\s*\(/, kind: 'warn' },
];

// Fail-open branches are rules too (#380 §3: "including its fail-open branch").
const FAIL_OPEN = [
  { re: /except\s+\w*(Error|Exception)?\s*:?\s*(#.*)?$/, kind: 'fail-open' },
  { re: /\bcatch\s*\([^)]*\)\s*\{/, kind: 'fail-open' },
  { re: /Decision\(\s*["'](allow|skip)["']/, kind: 'fail-open' },
  { re: /return\s+(true|True)\s*(#.*)?$/, kind: 'fail-open' },
];

const PREDICATE = /^\s*(if|elif|else if|unless|while|case|when|\}?\s*else\b|\s*&&|\s*\|\|)\b|^\s*if\s*\(/;

// Module entry-point boilerplate gates nothing: `if __name__ == "__main__"`
// selects *how* the file was started, not whether an action is permitted. It
// is excluded from the rule population, not silently reviewed as a rule.
const NOT_A_RULE = [
  /__name__\s*==\s*["']__main__["']/,
  /^\s*import\.meta\.url\b/,
];

export function normalize(span) {
  return span.replace(/\s+/g, ' ').trim();
}

export function ruleId(filePath, span, occurrence) {
  const digest = createHash('sha1').update(normalize(span)).digest('hex').slice(0, 12);
  return `${filePath}#${digest}#${occurrence}`;
}

function stripFences(lines) {
  // Returns lines with fenced code and HTML comments blanked out, so that
  // examples never become rules but line numbers stay true.
  const out = lines.slice();
  let inFence = false;
  let inComment = false;
  for (let i = 0; i < out.length; i += 1) {
    const line = out[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out[i] = '';
      continue;
    }
    if (inFence) { out[i] = ''; continue; }
    if (/<!--/.test(line)) inComment = true;
    if (inComment) {
      const closes = /-->/.test(line);
      out[i] = '';
      if (closes) inComment = false;
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) out[i] = '';           // headings are not rules
  }
  return out;
}

function splitSentences(text) {
  // Sentence split that survives `e.g.`, file names and version numbers.
  const parts = [];
  let buffer = '';
  const tokens = text.split(/(?<=[.!?])\s+/);
  for (const token of tokens) {
    buffer = buffer ? `${buffer} ${token}` : token;
    if (/\b(e\.g|i\.e|vs|etc|Mr|cf)\.$/.test(buffer.trim())) continue;
    if (/[.!?]$/.test(buffer.trim()) || /:$/.test(buffer.trim())) {
      parts.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

// A directive is a word in the prose, never a fragment of an identifier:
// `enforce-worktree-cwd.py` is a file name, not the verb "enforce". Inline
// code spans and path-like tokens are removed before the directive test.
export function directiveProbe(text) {
  return text
    .replace(/`[^`]*`/g, ' ')
    .replace(/\S+\.(mjs|py|sh|json|md|yml|yaml)\b/g, ' ')
    .replace(/\S*\/\S*/g, ' ');
}

export function splitCompound(sentence) {
  // A compound sentence with two independent directives is two rules.
  const pieces = sentence.split(/;\s+|\s+—\s+(?=[A-Za-z`])|,\s+and\s+|\s+and\s+(?=never|always|must|do not|don't)/);
  const kept = pieces.map((p) => p.trim()).filter(Boolean);
  const directive = kept.filter((p) => DIRECTIVES.some((re) => re.test(directiveProbe(p))));
  if (directive.length >= 2) return directive;
  return DIRECTIVES.some((re) => re.test(directiveProbe(sentence))) ? [sentence.trim()] : [];
}

export function extractProse(relPath, text) {
  const rawLines = text.split('\n');
  const lines = stripFences(rawLines);
  const rules = [];
  let block = [];
  let blockStart = 0;
  const flush = () => {
    if (!block.length) return;
    const joined = block.join(' ').replace(/^[-*>\s]+/, '').trim();
    for (const sentence of splitSentences(joined)) {
      for (const span of splitCompound(sentence)) {
        if (normalize(span).length < 12) continue;
        rules.push({ span, line: blockStart + 1 });
      }
    }
    block = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*\|/.test(line)) {
      // Table rows are handled as their own single-line blocks below.
      flush();
      if (/^\s*\|/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line)) {
        const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
        for (const cell of cells) {
          for (const span of splitCompound(cell)) {
            if (normalize(span).length < 12) continue;
            rules.push({ span, line: i + 1 });
          }
        }
      }
      continue;
    }
    if (!block.length) blockStart = i;
    block.push(line.trim());
  }
  flush();
  return rules.map((r) => ({ ...r, carrier: 'prose' }));
}

export function extractCode(relPath, text) {
  const lines = text.split('\n');
  const rules = [];
  const seen = new Set();
  const consider = (i, kind) => {
    let start = i;
    for (let j = i; j >= Math.max(0, i - 12); j -= 1) {
      if (PREDICATE.test(lines[j])) { start = j; break; }
    }
    const span = lines.slice(start, i + 1).join('\n');
    const key = `${start}:${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (normalize(span).length < 8) return;
    if (NOT_A_RULE.some((re) => re.test(span))) return;
    rules.push({ span, line: start + 1, actionLine: i + 1, action: kind, carrier: 'code' });
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(#|\/\/|\*)/.test(line)) continue; // comments are rationale, not rules
    for (const { re, kind } of ACTIONS) {
      if (re.test(line)) { consider(i, kind); break; }
    }
    for (const { re, kind } of FAIL_OPEN) {
      if (re.test(line) && PREDICATE.test(lines[Math.max(0, i - 1)] || '')) {
        consider(i, kind);
        break;
      }
    }
  }
  return rules;
}

export function extractFile(relPath, text) {
  const ext = path.extname(relPath).toLowerCase();
  if (PROSE_EXTENSIONS.has(ext)) return extractProse(relPath, text);
  if (CODE_EXTENSIONS.has(ext)) return extractCode(relPath, text);
  return null; // no extractable rule surface
}

function main() {
  const check = process.argv.includes('--check');
  const inventory = JSON.parse(readFileSync(SUBSTRATE, 'utf8'));
  const sourceCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const rules = [];
  const noRuleSurface = [];
  const perFile = [];
  for (const row of inventory.rows) {
    let text;
    try {
      text = readFileSync(path.join(ROOT, row.path), 'utf8');
    } catch {
      noRuleSurface.push({ path: row.path, partition: row.partition, reason: 'unreadable as utf-8 text' });
      continue;
    }
    const extracted = extractFile(row.path, text);
    if (extracted === null) {
      noRuleSurface.push({ path: row.path, partition: row.partition, reason: `no extractable rule span (${path.extname(row.path) || 'no extension'})` });
      continue;
    }
    const occurrences = new Map();
    const fileRules = extracted.map((r) => {
      const key = createHash('sha1').update(normalize(r.span)).digest('hex').slice(0, 12);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      return {
        rule_id: `${row.path}#${key}#${occurrence}`,
        path: row.path,
        line: r.line,
        partition: row.partition ?? 'residual',
        kind: row.kind ?? (row.path.startsWith('src/') ? 'source' : 'other'),
        carrier: r.carrier,
        action: r.action ?? null,
        unit_id: row.ownerSkill ? `skill:${row.ownerSkill}` : `node:${row.path}`,
        span: normalize(r.span).slice(0, 400),
      };
    });
    perFile.push({ path: row.path, partition: row.partition ?? 'residual', kind: row.kind ?? 'other', rules: fileRules.length });
    rules.push(...fileRules);
  }

  const byPartition = {};
  const byStratum = {};
  for (const rule of rules) {
    byPartition[rule.partition] = (byPartition[rule.partition] ?? 0) + 1;
    const stratum = `${rule.partition}/${rule.kind}`;
    byStratum[stratum] = (byStratum[stratum] ?? 0) + 1;
  }

  const payload = {
    schema: 'welle-31/truth-census/rules/v1',
    substrateCommit: '16325e59f9c1815231f8e37c431881219fac9762',
    substrateInventorySourceCommit: inventory.sourceCommit,
    censusCommit: sourceCommit,
    directives: DIRECTIVES.map(String),
    total: rules.length,
    byPartition,
    byStratum,
    filesWithRules: perFile.filter((f) => f.rules > 0).length,
    filesWithoutRules: perFile.filter((f) => f.rules === 0).length,
    noRuleSurface,
    perFile,
    rules,
  };

  if (check) {
    const existing = JSON.parse(readFileSync(OUT, 'utf8'));
    const drop = (o) => { const c = { ...o }; delete c.censusCommit; return JSON.stringify(c); };
    const same = drop(existing) === drop(payload);
    console.log(same ? 'rules.json reproduces (every field but censusCommit)' : 'rules.json DIFFERS');
    process.exitCode = same ? 0 : 1;
    return;
  }

  writeFileSync(OUT, `${JSON.stringify(payload, null, 1)}\n`);
  console.log(`rules: ${rules.length}`);
  console.log('by partition:', byPartition);
  console.log('strata:', Object.keys(byStratum).length);
  console.log('no rule surface:', noRuleSurface.length);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
