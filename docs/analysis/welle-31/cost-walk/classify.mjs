#!/usr/bin/env node
// Cost walk (#343, Welle 31 Slice 2) — stage 2: classification into the four
// bins of Amendment 3, applying `ac-1-measurement-record.md` §5 verbatim.
//
// The rules and their threshold values were committed in the AC-1 record
// BEFORE this stage existed (commit "pin the cost-walk measurement record
// before classifying"). This script contains no threshold of its own: it reads
// them out of cost-rows.json, which derive-cost.mjs computed from the
// population.
//
// Output: docs/analysis/welle-31/cost-walk/classification.json
//         docs/analysis/welle-31/cost-walk/cost-table.md
// Re-run: node docs/analysis/welle-31/cost-walk/classify.mjs
// Check:  node docs/analysis/welle-31/cost-walk/classify.mjs --check

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const COST = path.join(HERE, 'cost-rows.json');
const OUT_JSON = path.join(HERE, 'classification.json');
const OUT_MD = path.join(HERE, 'cost-table.md');

const cost = JSON.parse(readFileSync(COST, 'utf8'));
const rows = cost.rows;

// --- §5 of the AC-1 record, verbatim ---------------------------------------
// Traversal is observable only where the actor walks inside THIS repository:
// change-traffic cannot see a consumer running `init` elsewhere, and a platform
// journey is a workflow run, not a commit.
const OBSERVABLE_ACTORS = new Set(['maintainer', 'agent']);
const HIGH_TRAVERSAL = cost.thresholds.highTraversal.value; // 9
const TOP_QUARTILE_GATES = 3; // 75th percentile of the per-journey gate count

function classify(r) {
  const traversal = r.traversal.attributedCommits;
  if (!OBSERVABLE_ACTORS.has(r.actor)) {
    return {
      bin: 'unknown',
      rule: `actor "${r.actor}" walks outside this repository — change-traffic cannot observe traversal`,
    };
  }
  if (r.gates === 0) {
    return { bin: 'unwatched', rule: 'zero gates — no station on this journey can refuse passage' };
  }
  if (traversal >= HIGH_TRAVERSAL && !r.hasNamedRecovery) {
    return {
      bin: 'unwatched',
      rule: `traversal ${traversal} >= ${HIGH_TRAVERSAL} and no named recovery record (${r.recoveryPaths.join(', ')})`,
    };
  }
  if (r.gates >= TOP_QUARTILE_GATES && traversal < HIGH_TRAVERSAL) {
    return {
      bin: 'secured-out-of-proportion',
      rule: `${r.gates} gates (top-quartile gating >= ${TOP_QUARTILE_GATES}) against traversal ${traversal} < ${HIGH_TRAVERSAL}`,
    };
  }
  return {
    bin: 'covered-and-priced',
    rule: `${r.gates} gates, traversal ${traversal}, named recovery ${r.hasNamedRecovery ? 'present' : 'absent'}`,
  };
}

const classified = rows.map((r) => {
  const c = classify(r);
  return {
    journeyId: r.journeyId,
    title: r.title,
    actor: r.actor,
    seed: r.seed,
    bin: c.bin,
    rule: c.rule,
    steps: r.steps,
    gates: r.gates,
    humanInteractions: r.humanInteractions,
    standingAuthorizations: r.standingAuthorizations,
    traversalAttributedCommits: r.traversal.attributedCommits,
    traversalObservable: OBSERVABLE_ACTORS.has(r.actor),
    hasNamedRecovery: r.hasNamedRecovery,
    artifactsTouched: r.artifactsTouched.total,
    failureModesCited: r.failureModesCited.map((f) => f.issue),
  };
});

const bins = {};
for (const c of classified) bins[c.bin] = (bins[c.bin] ?? 0) + 1;

// --- the judgment set (Amendment 2) -----------------------------------------
// Three declared inclusion rules; nothing is added by hand.
const CONSUMER_JOURNEY_IDS = [
  'consumer-first-init',
  'consumer-first-own-workflow',
  'consumer-update-over-local-edits',
];

const judgmentReasons = new Map();
const addReason = (id, why) => {
  if (!judgmentReasons.has(id)) judgmentReasons.set(id, []);
  judgmentReasons.get(id).push(why);
};

for (const c of classified) {
  if (c.seed) addReason(c.journeyId, `carries #343 ${c.seed}`);
  if (c.bin === 'secured-out-of-proportion') addReason(c.journeyId, 'classified secured-out-of-proportion');
  if (c.bin === 'unwatched' && c.traversalAttributedCommits >= HIGH_TRAVERSAL) {
    addReason(c.journeyId, `classified unwatched with high traversal (${c.traversalAttributedCommits} >= ${HIGH_TRAVERSAL})`);
  }
  if (CONSUMER_JOURNEY_IDS.includes(c.journeyId)) addReason(c.journeyId, 'the consumer journey the mandate names');
}

const judgmentSet = classified
  .filter((c) => judgmentReasons.has(c.journeyId))
  .map((c) => ({ journeyId: c.journeyId, bin: c.bin, reasons: judgmentReasons.get(c.journeyId) }));

const notJudged = classified
  .filter((c) => !judgmentReasons.has(c.journeyId))
  .map((c) => ({ journeyId: c.journeyId, bin: c.bin, actor: c.actor }));

const doc = {
  schema: 'welle-31/cost-walk/classification/v1',
  slice: '#343',
  substrateCommit: cost.substrateCommit,
  appliedRecord: 'docs/analysis/welle-31/cost-walk/ac-1-measurement-record.md',
  thresholdsApplied: { highTraversal: HIGH_TRAVERSAL, topQuartileGates: TOP_QUARTILE_GATES },
  binCounts: bins,
  binTotal: classified.length,
  judgmentPass: {
    rule: 'seed-carrying journeys + every secured-out-of-proportion + every unwatched with traversal >= threshold + the three consumer journeys the mandate names',
    covered: judgmentSet.length,
    of: classified.length,
    journeys: judgmentSet,
    namedNonCoverage: {
      count: notJudged.length,
      note: 'These journeys carry a counted cost row but no judgment pass. Amendment 2 requires them to be named, not silently capped.',
      journeys: notJudged,
    },
  },
  journeys: classified,
};

const serialized = `${JSON.stringify(doc, null, 2)}\n`;

// --- the human-readable cost table ------------------------------------------
const esc = (s) => String(s).replace(/\|/g, '\\|');
const binOrder = ['covered-and-priced', 'unwatched', 'secured-out-of-proportion', 'unknown'];

const lines = [];
lines.push('<!-- language-census: ok -->');
lines.push('# Cost table — one counted row per derived journey (70 of 70)');
lines.push('');
lines.push('**Generated** by `classify.mjs`. Do not hand-edit — re-run');
lines.push('`node docs/analysis/welle-31/cost-walk/classify.mjs` instead.');
lines.push('');
lines.push(`Substrate commit \`${cost.substrateCommit}\` · journey denominator **${classified.length} of ${classified.length}** ` +
  '(the substrate\'s set, verbatim — Amendment 1).');
lines.push('');
lines.push('Column meanings and every threshold are fixed in');
lines.push('[`ac-1-measurement-record.md`](./ac-1-measurement-record.md), committed before this table existed.');
lines.push('');
lines.push('- **steps** — stations on the journey');
lines.push('- **gates** — stations that can refuse passage (human-gate/platform-gate, or mechanical/platform-enforced)');
lines.push('- **human** — stations the human must personally clear · **standing** — authority granted once and reused');
lines.push('- **traversal** — attributed change-traffic (commits in the window touching this journey\'s specific paths); *not* telemetry, and blind for consumer/platform actors');
lines.push('- **artifacts** — distinct repository paths this journey\'s stations cite');
lines.push('- **failure modes** — issue numbers cited by the station table or the journey derivation');
lines.push('');
lines.push('## Totals');
lines.push('');
lines.push('| Quantity | Count |');
lines.push('|---|---|');
lines.push(`| journeys | ${cost.totals.journeys} |`);
lines.push(`| stations (steps) | ${cost.totals.stations} |`);
lines.push(`| gates | ${cost.totals.gates} |`);
lines.push(`| human interactions | ${cost.totals.humanInteractions} |`);
lines.push(`| standing authorizations | ${cost.totals.standingAuthorizations} |`);
lines.push(`| journeys with a named recovery record | ${cost.totals.journeysWithNamedRecovery} of ${cost.totals.journeys} |`);
lines.push(`| journeys citing at least one issue | ${cost.totals.journeysCitingAnIssue} of ${cost.totals.journeys} |`);
lines.push(`| commits in the traversal population | ${cost.measurement.traversalPopulationCommits} |`);
lines.push('');
lines.push('## Classification');
lines.push('');
lines.push('| Bin | Journeys |');
lines.push('|---|---|');
for (const b of binOrder) lines.push(`| \`${b}\` | ${bins[b] ?? 0} of ${classified.length} |`);
lines.push('');
lines.push(`Judgment pass covers **${judgmentSet.length} of ${classified.length}** journeys; the remaining ` +
  `**${notJudged.length}** are named in \`classification.json\` under \`judgmentPass.namedNonCoverage\` ` +
  'and in `fable-pass.md`.');
lines.push('');

for (const b of binOrder) {
  const group = classified.filter((c) => c.bin === b);
  lines.push(`## \`${b}\` — ${group.length} of ${classified.length}`);
  lines.push('');
  lines.push('| Journey | Actor | Seed | steps | gates | human | standing | traversal | recovery | artifacts | failure modes |');
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---|---:|---|');
  for (const c of group.sort((x, y) => y.traversalAttributedCommits - x.traversalAttributedCommits)) {
    lines.push(
      `| \`${c.journeyId}\` | ${c.actor} | ${c.seed ?? '—'} | ${c.steps} | ${c.gates} | ${c.humanInteractions} | ` +
        `${c.standingAuthorizations} | ${c.traversalObservable ? c.traversalAttributedCommits : `(${c.traversalAttributedCommits})`} | ` +
        `${c.hasNamedRecovery ? 'named' : 'none'} | ${c.artifactsTouched} | ` +
        `${c.failureModesCited.length ? esc(c.failureModesCited.join(' ')) : '—'} |`,
    );
  }
  lines.push('');
}
lines.push('A traversal number in parentheses is **not** a traversal measurement: the');
lines.push('actor walks outside this repository, so the figure is maintainer churn on the');
lines.push('machinery and nothing more (AC-1 record §1).');
lines.push('');

const md = `${lines.join('\n')}`;

if (process.argv.includes('--check')) {
  let ok = true;
  if (readFileSync(OUT_JSON, 'utf8') !== serialized) {
    console.error('classification.json does not reproduce byte-equal');
    ok = false;
  }
  if (readFileSync(OUT_MD, 'utf8') !== md) {
    console.error('cost-table.md does not reproduce byte-equal');
    ok = false;
  }
  if (!ok) process.exit(1);
  console.log('classification.json and cost-table.md reproduce byte-equal');
  process.exit(0);
}

writeFileSync(OUT_JSON, serialized);
writeFileSync(OUT_MD, md);
console.log(`wrote ${path.relative(REPO, OUT_JSON)} and ${path.relative(REPO, OUT_MD)}`);
console.log(`bins: ${binOrder.map((b) => `${b} ${bins[b] ?? 0}`).join(' · ')} (total ${classified.length})`);
console.log(`judgment pass: ${judgmentSet.length} of ${classified.length}; named non-coverage ${notJudged.length}`);
