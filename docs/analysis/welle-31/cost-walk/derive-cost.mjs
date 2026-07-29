#!/usr/bin/env node
// Cost walk (#343, Welle 31 Slice 2) — stage 1: the counted cost row.
//
// Reads the frozen Analysis substrate (#404) and adds cost columns to it. It
// NEVER re-derives journeys or entry points (Amendment 1): journeys.json is the
// denominator, verbatim.
//
// Output: docs/analysis/welle-31/cost-walk/cost-rows.json
// Re-run:  node docs/analysis/welle-31/cost-walk/derive-cost.mjs
// Check:   node docs/analysis/welle-31/cost-walk/derive-cost.mjs --check
//          (re-derives and compares byte-equal against the committed artifact)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const SUBSTRATE = path.join(REPO, 'docs/analysis/welle-31/substrate');
const EVIDENCE = path.join(REPO, 'docs/evidence/welle-31');
const OUT = path.join(HERE, 'cost-rows.json');

// ---------------------------------------------------------------------------
// AC 1 constants — recorded in ac-1-measurement-record.md BEFORE classification
// ---------------------------------------------------------------------------

// Traversal-frequency source query. The population is git history reachable
// from the substrate's own freeze commit, so landing this analysis cannot move
// the denominator (same rule derive-inventory.mjs uses).
const FREEZE_COMMIT = 'c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2';
const WINDOW_SINCE = '2026-07-03T00:00:00Z';
const WINDOW_UNTIL = '2026-07-29T00:00:00Z';

// A path cited by more than HUB_PATH_LIMIT of the 70 journeys is a hub, not a
// journey signature: CLAUDE.md is touched by nearly every commit, so counting
// it would attribute the whole repository to every journey that cites it. Hub
// paths are excluded from attribution and reported separately, never dropped.
const HUB_PATH_LIMIT = 10;

// ---------------------------------------------------------------------------

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const journeysDoc = read(path.join(SUBSTRATE, 'journeys.json'));
const stationsDoc = read(path.join(SUBSTRATE, 'stations.json'));
const issueBodies = read(path.join(EVIDENCE, 'issue-bodies.json'));

const journeys = journeysDoc.journeys;
const stations = stationsDoc.stations;

if (journeysDoc.sourceCommit !== FREEZE_COMMIT) {
  throw new Error(`substrate sourceCommit ${journeysDoc.sourceCommit} != pinned ${FREEZE_COMMIT}`);
}

// --- tracked-path population at the freeze commit ---------------------------
const trackedAtFreeze = new Set(
  execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '--name-only', FREEZE_COMMIT], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean),
);

// --- gate-count basis (AC 1) ------------------------------------------------
// A station is a GATE when it can refuse passage, i.e. it is either an
// authorization boundary a human or the platform must clear, or a mechanically
// enforced check that returns non-zero. Documented-only and judgment-only
// stations are steps, not gates: nothing fails them.
const GATE_BOUNDARIES = new Set(['human-gate', 'platform-gate']);
const GATE_HARDNESS = new Set(['mechanical', 'platform-enforced']);
const isGate = (st) =>
  GATE_BOUNDARIES.has(st.authorizationBoundary) || GATE_HARDNESS.has(st.bindingHardness);
// A HUMAN INTERACTION is a station the human must personally clear at the
// moment it is reached. `standing-authorization` is counted separately: it is
// authority granted once and reused, which is the exact distinction #257 draws.
const isHumanInteraction = (st) => st.authorizationBoundary === 'human-gate';

// --- artifact extraction ----------------------------------------------------
const PATH_HEAD = /^([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+)/;
const ISSUE_REF = /#(\d{2,6})\b/g;

function pathOf(text) {
  const m = PATH_HEAD.exec(String(text).trim());
  if (!m) return null;
  const p = m[1];
  return trackedAtFreeze.has(p) ? p : null;
}

function classifyArtifact(p) {
  if (p.startsWith('.claude/skills/') || p.startsWith('.agents/skills/')) return 'skill';
  if (p.startsWith('.claude/hooks/') || p.startsWith('.githooks/')) return 'hook';
  if (p.startsWith('scripts/')) return 'script';
  if (p.startsWith('src/')) return 'src';
  if (p.startsWith('.github/workflows/')) return 'workflow';
  if (p.startsWith('docs/')) return 'doc';
  return 'root';
}

// --- per-journey station index ---------------------------------------------
const byJourney = new Map();
for (const st of stations) {
  if (!byJourney.has(st.journeyId)) byJourney.set(st.journeyId, []);
  byJourney.get(st.journeyId).push(st);
}

// --- issue title index from the frozen bodies -------------------------------
const issueTitle = new Map();
for (const e of issueBodies.exports) {
  if (!e.number) continue;
  let title = null;
  if (e.response) {
    try {
      const parsed = typeof e.response === 'string' ? JSON.parse(e.response) : e.response;
      title = parsed.title ?? null;
    } catch {
      const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(e.response));
      title = m ? JSON.parse(`"${m[1]}"`) : null;
    }
  }
  issueTitle.set(String(e.number), { title, disclosure: e.disclosure ?? 'full', url: e.url });
}

// --- pass 1: raw path sets, to find hub paths -------------------------------
const rawPaths = new Map();
for (const j of journeys) {
  const set = new Set();
  for (const d of j.derivedFrom) {
    const p = pathOf(d);
    if (p) set.add(p);
  }
  for (const st of byJourney.get(j.id) ?? []) {
    const p = pathOf(st.promise.citation);
    if (p) set.add(p);
  }
  rawPaths.set(j.id, set);
}

const pathJourneyCount = new Map();
for (const set of rawPaths.values()) {
  for (const p of set) pathJourneyCount.set(p, (pathJourneyCount.get(p) ?? 0) + 1);
}
const hubPaths = [...pathJourneyCount.entries()]
  .filter(([, n]) => n > HUB_PATH_LIMIT)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([p, n]) => ({ path: p, journeys: n }));
const hubSet = new Set(hubPaths.map((h) => h.path));

// --- traversal: commits in the window touching a journey's specific paths ---
const logRaw = execFileSync(
  'git',
  [
    '-C',
    REPO,
    'log',
    '--no-merges',
    `--since=${WINDOW_SINCE}`,
    `--until=${WINDOW_UNTIL}`,
    '--name-only',
    '--format=%x00%H',
    FREEZE_COMMIT,
  ],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
);

const commits = [];
for (const chunk of logRaw.split('\u0000').slice(1)) {
  const lines = chunk.split('\n').filter((l) => l.length > 0);
  const sha = lines.shift();
  commits.push({ sha, files: new Set(lines) });
}

// --- build the rows ---------------------------------------------------------
const rows = journeys.map((j) => {
  const sts = byJourney.get(j.id) ?? [];
  const gates = sts.filter(isGate);
  const humans = sts.filter(isHumanInteraction);
  const standing = sts.filter((s) => s.authorizationBoundary === 'standing-authorization');

  const all = [...rawPaths.get(j.id)].sort();
  const specific = all.filter((p) => !hubSet.has(p));
  const hubs = all.filter((p) => hubSet.has(p));

  const artifacts = { skill: [], hook: [], script: [], src: [], workflow: [], doc: [], root: [] };
  for (const p of all) artifacts[classifyArtifact(p)].push(p);

  const specificSet = new Set(specific);
  const attributedCommits = specific.length
    ? commits.filter((c) => [...c.files].some((f) => specificSet.has(f))).length
    : 0;

  const issues = new Set();
  for (const st of sts) {
    for (const m of String(st.promise.citation).matchAll(ISSUE_REF)) issues.add(m[1]);
    for (const m of String(st.promise.text).matchAll(ISSUE_REF)) issues.add(m[1]);
  }
  for (const d of j.derivedFrom) for (const m of String(d).matchAll(ISSUE_REF)) issues.add(m[1]);

  const hasNamedRecovery = j.recoveryPaths.some((r) => r !== 'unknown-recovery');

  const tally = (key) => {
    const out = {};
    for (const s of sts) out[s[key]] = (out[s[key]] ?? 0) + 1;
    return out;
  };

  return {
    journeyId: j.id,
    title: j.title,
    actor: j.actor,
    seed: j.seed,
    terminal: j.terminal,
    entryPoints: j.entryPoints,
    entryPointCount: j.entryPoints.length,
    steps: sts.length,
    gates: gates.length,
    gateStationIds: gates.map((s) => s.stationId),
    gateDensity: sts.length ? Number((gates.length / sts.length).toFixed(4)) : 0,
    humanInteractions: humans.length,
    humanGateStationIds: humans.map((s) => s.stationId),
    standingAuthorizations: standing.length,
    bindingHardness: tally('bindingHardness'),
    phases: tally('phase'),
    authorizationBoundaries: tally('authorizationBoundary'),
    artifactsTouched: {
      total: all.length,
      skills: artifacts.skill.length,
      scripts: artifacts.script.length,
      hooks: artifacts.hook.length,
      src: artifacts.src.length,
      workflows: artifacts.workflow.length,
      docs: artifacts.doc.length,
      root: artifacts.root.length,
      paths: all,
    },
    failureModesCited: [...issues]
      .sort((a, b) => Number(a) - Number(b))
      .map((n) => ({
        issue: `#${n}`,
        frozen: issueTitle.has(n),
        title: issueTitle.get(n)?.title ?? null,
        disclosure: issueTitle.get(n)?.disclosure ?? null,
      })),
    recoveryPaths: j.recoveryPaths,
    hasNamedRecovery,
    traversal: {
      specificPaths: specific.length,
      hubPathsExcluded: hubs,
      attributedCommits,
      attributable: specific.length > 0,
      blindReason: specific.length > 0 ? null : 'no repository path in this journey signature',
    },
  };
});

// --- thresholds, derived from the population, not chosen ---------------------
const attributed = rows.filter((r) => r.traversal.attributable).map((r) => r.traversal.attributedCommits);
const sortedAsc = [...attributed].sort((a, b) => a - b);
const median = (arr) => {
  if (!arr.length) return 0;
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[m] : Math.round((arr[m - 1] + arr[m]) / 2);
};
const quantile = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * arr.length))] : 0);

const densities = rows.map((r) => r.gateDensity).sort((a, b) => a - b);

const thresholds = {
  highTraversal: {
    rule: 'attributedCommits >= median of the attributable population',
    value: median(sortedAsc),
    population: sortedAsc.length,
  },
  gateDensityUpper: {
    rule: 'upper quartile of gateDensity over all 70 journeys',
    value: Number(quantile(densities, 0.75).toFixed(4)),
  },
  gateDensityLower: {
    rule: 'lower quartile of gateDensity over all 70 journeys',
    value: Number(quantile(densities, 0.25).toFixed(4)),
  },
};

const doc = {
  schema: 'welle-31/cost-walk/cost-rows/v1',
  slice: '#343',
  substrateCommit: FREEZE_COMMIT,
  note:
    'Cost columns over the frozen Analysis substrate (#404). The journey set is the substrate\'s, ' +
    'verbatim and unmodified (Amendment 1). Every number here is produced by this script; nothing is recalled.',
  measurement: {
    traversalSourceQuery: `git -C <repo> log --no-merges --since=${WINDOW_SINCE} --until=${WINDOW_UNTIL} --name-only --format=%x00%H ${FREEZE_COMMIT}`,
    traversalWindowUtc: { since: WINDOW_SINCE, until: WINDOW_UNTIL },
    traversalPopulationCommits: commits.length,
    hubPathLimit: HUB_PATH_LIMIT,
    hubPaths,
    gateCountBasis:
      "a station is a gate iff authorizationBoundary in {human-gate, platform-gate} OR bindingHardness in {mechanical, platform-enforced}; " +
      'human interactions are counted separately as authorizationBoundary == human-gate; standing-authorization is counted separately again',
    outputArtifact: 'docs/analysis/welle-31/cost-walk/cost-rows.json',
  },
  thresholds,
  totals: {
    journeys: rows.length,
    stations: rows.reduce((a, r) => a + r.steps, 0),
    gates: rows.reduce((a, r) => a + r.gates, 0),
    humanInteractions: rows.reduce((a, r) => a + r.humanInteractions, 0),
    standingAuthorizations: rows.reduce((a, r) => a + r.standingAuthorizations, 0),
    journeysWithAttributableTraversal: sortedAsc.length,
    journeysBlindToTraversal: rows.length - sortedAsc.length,
    journeysWithNamedRecovery: rows.filter((r) => r.hasNamedRecovery).length,
    journeysCitingAnIssue: rows.filter((r) => r.failureModesCited.length > 0).length,
  },
  rows,
};

const serialized = `${JSON.stringify(doc, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const existing = readFileSync(OUT, 'utf8');
  if (existing !== serialized) {
    console.error('cost-rows.json does not reproduce byte-equal');
    process.exit(1);
  }
  console.log('cost-rows.json reproduces byte-equal');
  process.exit(0);
}

writeFileSync(OUT, serialized);
console.log(`wrote ${path.relative(REPO, OUT)}`);
console.log(`journeys: ${doc.totals.journeys} · stations: ${doc.totals.stations} · gates: ${doc.totals.gates}`);
console.log(
  `traversal population: ${commits.length} commits · attributable journeys: ${doc.totals.journeysWithAttributableTraversal} of ${rows.length}`,
);
console.log(`high-traversal threshold: >= ${thresholds.highTraversal.value} attributed commits`);
console.log(
  `gate-density quartiles: lower ${thresholds.gateDensityLower.value} · upper ${thresholds.gateDensityUpper.value}`,
);
console.log(`hub paths excluded (> ${HUB_PATH_LIMIT} of 70 journeys): ${hubPaths.length}`);
