#!/usr/bin/env node
// Dependency graph (#380 §4) — the edge denominator, and the one edge class
// this round actually reviews.
//
// Nodes are the inventory's artifacts, each reviewed once for its own rules;
// that is what `findings.json` covers. Edges are caller->core contracts,
// reviewed **per caller**, and a mirror is an edge to its primary.
//
// This pass reviews the mirror edge class in full (every `.agents/` file against
// its `.claude/` primary, rule-set for rule-set) and counts the import edge
// class without reviewing it — named, not implied.
//
// Usage: node lib/edges.mjs
// Writes: data/edges.json

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(BASE, '../../../..');
const rulesDoc = JSON.parse(readFileSync(path.join(BASE, 'data/rules.json'), 'utf8'));
const inventory = JSON.parse(readFileSync(path.join(ROOT, 'docs/analysis/welle-31/substrate/inventory.json'), 'utf8'));

// --- mirror edges ----------------------------------------------------------
const byPath = new Map();
for (const rule of rulesDoc.rules) {
  if (!byPath.has(rule.path)) byPath.set(rule.path, []);
  byPath.get(rule.path).push(rule.rule_id.split('#')[1]); // the normalized-span digest
}

const mirrorEdges = [];
for (const row of inventory.rows) {
  if (!row.path.startsWith('.agents/')) continue;
  const primary = row.path.replace(/^\.agents\//, '.claude/');
  const mirrorDigests = byPath.get(row.path) ?? [];
  const primaryDigests = byPath.get(primary) ?? [];
  const inPrimary = new Set(primaryDigests);
  const inMirror = new Set(mirrorDigests);
  const onlyMirror = mirrorDigests.filter((d) => !inPrimary.has(d));
  const onlyPrimary = primaryDigests.filter((d) => !inMirror.has(d));
  mirrorEdges.push({
    edge: `${row.path} -> ${primary}`,
    primaryExists: byPath.has(primary) || inventory.rows.some((r) => r.path === primary),
    mirrorRules: mirrorDigests.length,
    primaryRules: primaryDigests.length,
    onlyInMirror: onlyMirror.length,
    onlyInPrimary: onlyPrimary.length,
    identicalRuleSet: onlyMirror.length === 0 && onlyPrimary.length === 0,
  });
}

const divergent = mirrorEdges.filter((e) => !e.identicalRuleSet);
const missingPrimary = mirrorEdges.filter((e) => !e.primaryExists);

// --- import edges (counted, not reviewed) ----------------------------------
const IMPORT = [
  /^\s*from\s+([\w.]+)\s+import\s+/gm,
  /^\s*import\s+([\w.]+)\s*$/gm,
  /^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm,
  /require\(['"]([^'"]+)['"]\)/gm,
];
let importEdges = 0;
const importsPerFile = [];
for (const row of inventory.rows) {
  if (!/\.(py|mjs|js)$/.test(row.path)) continue;
  let text;
  try { text = readFileSync(path.join(ROOT, row.path), 'utf8'); } catch { continue; }
  let count = 0;
  for (const re of IMPORT) count += [...text.matchAll(re)].length;
  importEdges += count;
  importsPerFile.push({ path: row.path, imports: count });
}

const payload = {
  schema: 'welle-31/truth-census/edges/v1',
  nodeTotal: inventory.trackedTotal,
  edgeClasses: {
    mirror: {
      reviewed: true,
      total: mirrorEdges.length,
      identical: mirrorEdges.length - divergent.length,
      divergent: divergent.length,
      missingPrimary: missingPrimary.length,
      finding: 'a divergent mirror is a finding on the primary (#380 §1), not a second artifact',
    },
    importCallerToCore: {
      reviewed: false,
      total: importEdges,
      files: importsPerFile.length,
      why: 'each caller->core contract needs its own review of what the caller assumes about inputs, outputs, failure mode and fail-open behaviour. That is a per-caller reading of 1 000+ edges and this round did not run it; it is named in `unexamined.md` with this count rather than implied as covered.',
    },
  },
  divergentMirrors: divergent.slice(0, 60),
};
writeFileSync(path.join(BASE, 'data/edges.json'), `${JSON.stringify(payload, null, 1)}\n`);
console.log(`mirror edges: ${mirrorEdges.length}, identical rule set: ${mirrorEdges.length - divergent.length}, divergent: ${divergent.length}, missing primary: ${missingPrimary.length}`);
console.log(`import edges counted, not reviewed: ${importEdges} across ${importsPerFile.length} files`);
