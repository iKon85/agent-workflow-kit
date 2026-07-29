#!/usr/bin/env node
// Journey pass (#380 §5) — counts the gap between what a station's **cited**
// promise claims and what the station actually verifies.
//
// The station tables are the frozen substrate's (#404); this pass never
// re-derives them. It reads `stations.json` and applies four gap classes.
// **A gap counts only for a cited promise** — every station row carries
// `promise.text` + `promise.citation`, and a row whose citation does not
// resolve is itself gap class G3 rather than a silent pass.
//
//   G1 narrowed verification — the station's own `verifies` column names what
//      it does NOT establish, and the promise claims it
//   G2 prose binding under an enforcement promise — the promise asserts that
//      something blocks/refuses/must, the station's binding is documented or
//      judgment
//   G3 unresolvable citation — the promise cannot be read back from the
//      repository or the frozen issue export
//   G4 blocking station on a journey with no named recovery record
//
// Usage: node lib/journey-gaps.mjs
// Writes: journey-gaps.json

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(BASE, '../../../..');
const substrate = (name) => JSON.parse(readFileSync(path.join(ROOT, 'docs/analysis/welle-31/substrate', name), 'utf8'));

const stationsDoc = substrate('stations.json');
const journeysDoc = substrate('journeys.json');
const stations = stationsDoc.stations;
const journeys = new Map(journeysDoc.journeys.map((j) => [j.id, j]));

const issueBodies = JSON.parse(readFileSync(path.join(ROOT, 'docs/evidence/welle-31/issue-bodies.json'), 'utf8'));
const frozenIssues = new Set(issueBodies.exports.map((e) => `#${e.number}`));

const NARROWING = /(,\s*not\s|\bnot that\b|\brather than\b|\bpresence,? not\b|\bnot whether\b|\bnot the\b|\bnot its\b|\bonly that\b|\bnot how\b|\bnot why\b)/i;
const ENFORCEMENT = /\b(blocks?|refuses?|rejects?|must|never|enforces?|requires?|cannot|forbidden)\b/i;
const SOFT_BINDING = new Set(['documented', 'judgment']);
const GATE = new Set(['human-gate', 'platform-gate']);

function citationResolves(citation) {
  const head = String(citation).split(/[\s:—]/)[0].replace(/^`|`$/g, '');
  if (/^#\d+$/.test(head)) return frozenIssues.has(head);
  if (/^(testreporter)?#?\d+$/.test(head)) return false;
  if (/[/.]/.test(head)) return existsSync(path.join(ROOT, head));
  return false;
}

// A negative measurement is no proof until the harness has produced a
// positive: G3 counts zero only if the resolver can return false at all.
const resolverControl = {
  positive: citationResolves('CLAUDE.md'),
  negativeMissingPath: citationResolves('docs/agents/does-not-exist.md'),
  negativeUnfrozenIssue: citationResolves('#999999'),
  negativeProse: citationResolves('board profile labels.waveStub'),
};
if (!resolverControl.positive || resolverControl.negativeMissingPath
  || resolverControl.negativeUnfrozenIssue || resolverControl.negativeProse) {
  console.error('citation resolver control failed', resolverControl);
  process.exit(1);
}

const gaps = [];
for (const station of stations) {
  const journey = journeys.get(station.journeyId);
  const id = `${station.journeyId}#${station.stationId}`;
  const resolves = citationResolves(station.promise.citation);
  if (!resolves) {
    gaps.push({
      gapClass: 'G3',
      station: id,
      promise: station.promise.text,
      citation: station.promise.citation,
      why: 'the promise cannot be read back from the repository or the frozen issue export, so nothing can be held to it',
    });
    continue; // an unreadable promise cannot found a further gap claim
  }
  if (NARROWING.test(station.verifies)) {
    gaps.push({
      gapClass: 'G1',
      station: id,
      promise: station.promise.text,
      citation: station.promise.citation,
      verifies: station.verifies,
      why: 'the station names, in its own verification column, the part of the promise it does not establish',
    });
  }
  if (ENFORCEMENT.test(station.promise.text) && SOFT_BINDING.has(station.bindingHardness)) {
    gaps.push({
      gapClass: 'G2',
      station: id,
      promise: station.promise.text,
      citation: station.promise.citation,
      bindingHardness: station.bindingHardness,
      why: 'the promise asserts that something is enforced; the binding that carries it is prose',
    });
  }
  const unknownRecovery = (journey?.recoveryPaths ?? []).includes('unknown-recovery');
  if (unknownRecovery && (GATE.has(station.authorizationBoundary) || station.bindingHardness === 'mechanical')) {
    gaps.push({
      gapClass: 'G4',
      station: id,
      promise: station.promise.text,
      citation: station.promise.citation,
      authorizationBoundary: station.authorizationBoundary,
      why: 'a station that can stop the journey sits on a journey whose recovery is `unknown-recovery` — the route out is not a named record',
    });
  }
}

const byClass = {};
for (const gap of gaps) byClass[gap.gapClass] = (byClass[gap.gapClass] ?? 0) + 1;
const stationsWithGap = new Set(gaps.map((g) => g.station));
const journeysWithGap = new Set(gaps.map((g) => g.station.split('#')[0]));

const payload = {
  schema: 'welle-31/truth-census/journey-gaps/v1',
  substrateCommit: '16325e59f9c1815231f8e37c431881219fac9762',
  substrateSourceCommit: stationsDoc.sourceCommit,
  stationsExamined: stations.length,
  journeysExamined: journeys.size,
  citedPromises: stations.length,
  citationResolverControl: resolverControl,
  gapClasses: {
    G1: 'narrowed verification — the station names what it does not establish',
    G2: 'prose binding under an enforcement promise',
    G3: 'unresolvable citation — the promise cannot be read back',
    G4: 'a blocking station on a journey carrying `unknown-recovery`',
  },
  totalGaps: gaps.length,
  byClass,
  stationsWithGap: stationsWithGap.size,
  journeysWithGap: journeysWithGap.size,
  unknownRecoveryJourneys: [...journeys.values()].filter((j) => (j.recoveryPaths ?? []).includes('unknown-recovery')).length,
  gaps,
};
writeFileSync(path.join(BASE, 'journey-gaps.json'), `${JSON.stringify(payload, null, 1)}\n`);
console.log(`stations examined: ${stations.length} of ${stationsDoc.stationTotal}`);
console.log(`gaps: ${gaps.length}`, byClass);
console.log(`stations with >=1 gap: ${stationsWithGap.size}; journeys with >=1 gap: ${journeysWithGap.size} of ${journeys.size}`);
