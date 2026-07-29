#!/usr/bin/env node
/**
 * Welle 31 · Slice 0 — counted journey census and substrate validator (#404).
 *
 * Two jobs, and the second is the one that matters. It COUNTS the derived
 * journey set along both required axes, and it CHECKS that the substrate is
 * what it claims to be:
 *
 *  - the four dimensions are keyed and mutually disjoint, so an entry point can
 *    never be mistaken for an evidence source (#404 AC 2);
 *  - every journey and every station references only declared dimension ids;
 *  - every citation RESOLVES — a repository path must exist on disk, an issue
 *    reference must be present in the frozen evidence export. #380's own review
 *    refuted three of its evidence claims; "plausible, `file:line`-garnished,
 *    wrong" is the failure mode this check exists to make expensive.
 *
 * A red here is a substrate defect and is fixed in the substrate, never patched
 * downstream.
 *
 * Usage: node docs/analysis/welle-31/derive-census.mjs [--json]
 */
import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SUBSTRATE = join(HERE, 'substrate');
const EVIDENCE = join(REPO_ROOT, 'docs/evidence/welle-31');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = (path) => access(join(REPO_ROOT, path)).then(() => true, () => false);
/** A citation that names a repository artifact rather than prose. */
const PATH_LIKE = /^[\w.@-]+(?:\/[\w.@-]+)+$|^[\w-]+\.(?:md|mjs|py|json|ya?ml|sh|html|svg|png)$/;
const ISSUE_LIKE = /^#(\d+)/;

function checkDimensionKeys(dimensions, problems) {
  const seen = new Map();
  const byDimension = {};
  for (const dimension of ['entryPoint', 'evidenceSource', 'recoveryPath']) {
    byDimension[dimension] = new Set();
    for (const { id } of dimensions[dimension]) {
      if (byDimension[dimension].has(id)) problems.push(`duplicate ${dimension} id: ${id}`);
      byDimension[dimension].add(id);
      // Disjointness is the anti-conflation check: one id, one dimension.
      if (seen.has(id)) problems.push(`id "${id}" appears in both ${seen.get(id)} and ${dimension}`);
      else seen.set(id, dimension);
    }
  }
  return byDimension;
}

async function checkCitations(citations, evidenceIssues, problems) {
  let resolved = 0;
  for (const { where, citation } of citations) {
    const head = citation.split(' ')[0].replace(/[,;]$/, '');
    const issue = ISSUE_LIKE.exec(head);
    if (issue) {
      if (evidenceIssues.has(Number(issue[1]))) resolved += 1;
      else problems.push(`${where}: issue ${head} is not in the frozen evidence export`);
      continue;
    }
    if (!PATH_LIKE.test(head)) continue; // prose citation: counted as unresolvable by design
    if (await exists(head)) resolved += 1;
    else problems.push(`${where}: citation path does not exist: ${head}`);
  }
  return resolved;
}

const tally = (values) => values.reduce((acc, value) => {
  acc[value] = (acc[value] ?? 0) + 1;
  return acc;
}, {});

export async function deriveCensus() {
  const dimensions = await readJson(join(SUBSTRATE, 'dimensions.json'));
  const journeySet = await readJson(join(SUBSTRATE, 'journeys.json'));
  const stationSet = await readJson(join(SUBSTRATE, 'stations.json'));
  const evidence = await readJson(join(EVIDENCE, 'issue-bodies.json'));
  const evidenceIssues = new Set(evidence.exports.map(({ number }) => number));

  const problems = [];
  const keys = checkDimensionKeys(dimensions, problems);
  const { journeys, seeds } = journeySet;
  const journeyIds = new Set(journeys.map(({ id }) => id));
  if (journeyIds.size !== journeys.length) problems.push('duplicate journey id');

  const citations = [];
  for (const journey of journeys) {
    for (const [field, allowed] of [
      ['entryPoints', keys.entryPoint],
      ['evidenceSources', keys.evidenceSource],
      ['recoveryPaths', keys.recoveryPath],
    ]) {
      if (!journey[field]?.length) problems.push(`${journey.id}: empty ${field}`);
      for (const value of journey[field] ?? []) {
        if (!allowed.has(value)) problems.push(`${journey.id}: unknown ${field} "${value}"`);
      }
    }
    if (journey.seed && !seeds.some(({ id }) => id === journey.seed)) {
      problems.push(`${journey.id}: unknown seed ${journey.seed}`);
    }
    for (const citation of journey.derivedFrom ?? []) {
      citations.push({ where: `${journey.id}.derivedFrom`, citation });
    }
  }

  const stationsByJourney = new Map();
  for (const station of stationSet.stations) {
    if (!journeyIds.has(station.journeyId)) {
      problems.push(`station ${station.stationId}: unknown journey ${station.journeyId}`);
    }
    const list = stationsByJourney.get(station.journeyId) ?? [];
    if (list.some(({ stationId }) => stationId === station.stationId)) {
      problems.push(`${station.journeyId}: duplicate station id ${station.stationId}`);
    }
    list.push(station);
    stationsByJourney.set(station.journeyId, list);
    if (station.promise?.citation) {
      citations.push({ where: `${station.journeyId}/${station.stationId}.promise`, citation: station.promise.citation });
    }
  }
  const withoutStations = journeys.filter(({ id }) => !stationsByJourney.has(id)).map(({ id }) => id);
  for (const id of withoutStations) problems.push(`${id}: no station table`);

  const resolvedCitations = await checkCitations(citations, evidenceIssues, problems);
  const seedJourneys = journeys.filter(({ seed }) => seed);
  const coveredSeeds = new Set(seedJourneys.map(({ seed }) => seed));
  const uncoveredSeeds = seeds.filter(({ id }) => !coveredSeeds.has(id)).map(({ id }) => id);
  for (const id of uncoveredSeeds) problems.push(`seed ${id} has no derived journey`);

  const entryPointAxis = Object.fromEntries(dimensions.entryPoint.map(({ id }) => [
    id, journeys.filter(({ entryPoints }) => entryPoints.includes(id)).length,
  ]));
  const evidenceSourceAxis = Object.fromEntries(dimensions.evidenceSource.map(({ id }) => [
    id, journeys.filter(({ evidenceSources }) => evidenceSources.includes(id)).length,
  ]));
  const recoveryAxis = Object.fromEntries(dimensions.recoveryPath.map(({ id }) => [
    id, journeys.filter(({ recoveryPaths }) => recoveryPaths.includes(id)).length,
  ]));

  // The freeze commit the substrate names, not `git HEAD`: committing the
  // substrate moves HEAD, and a census whose numbers depend on when it is run
  // is not a census.
  const sourceCommit = journeySet.sourceCommit;
  const promises = stationSet.stations.filter((station) => station.promise?.citation).length;

  return {
    schema: 'welle-31/substrate/census/v1',
    sourceCommit,
    journeyTotal: journeys.length,
    seedJourneyTotal: seedJourneys.length,
    seedTotal: seeds.length,
    seedsCovered: coveredSeeds.size,
    uncoveredSeeds,
    consumerAsActorTotal: journeys.filter(({ consumerAsActor }) => consumerAsActor).length,
    recoveryJourneyTotal: journeys.filter(({ isRecovery }) => isRecovery).length,
    unknownRecoveryTotal: journeys.filter(({ recoveryPaths }) => recoveryPaths.includes('unknown-recovery')).length,
    actorAxis: tally(journeys.map(({ actor }) => actor)),
    entryPointAxis,
    evidenceSourceAxis,
    recoveryAxis,
    stationTotal: stationSet.stations.length,
    stationsPerJourney: {
      min: Math.min(...[...stationsByJourney.values()].map((list) => list.length)),
      max: Math.max(...[...stationsByJourney.values()].map((list) => list.length)),
    },
    citedPromises: promises,
    uncitedStations: stationSet.stations.length - promises,
    bindingHardnessAxis: tally(stationSet.stations.map(({ bindingHardness }) => bindingHardness)),
    phaseAxis: tally(stationSet.stations.map(({ phase }) => phase)),
    citationsChecked: citations.length,
    citationsResolved: resolvedCitations,
    problems,
  };
}

export function renderCensus(census) {
  const axis = (name, values, denominator) => [`${name}:`, ...Object.entries(values)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `  ${key}: ${count} of ${denominator}`)].join('\n');
  const j = census.journeyTotal;
  return [
    `source commit: ${census.sourceCommit}`,
    `${j} journeys derived, of which ${census.seedJourneyTotal} carry one of the eight #343 seeds `
      + `(${census.seedsCovered} of ${census.seedTotal} seeds covered)`,
    `consumer-as-actor journeys: ${census.consumerAsActorTotal} of ${j}`,
    `recovery journeys: ${census.recoveryJourneyTotal} of ${j}; `
      + `journeys with no named recovery record (unknown-recovery): ${census.unknownRecoveryTotal} of ${j}`,
    axis('entry-point axis', census.entryPointAxis, j),
    axis('evidence-source axis', census.evidenceSourceAxis, j),
    axis('recovery-path axis', census.recoveryAxis, j),
    axis('actor axis', census.actorAxis, j),
    `stations: ${census.stationTotal} rows over ${j} journeys `
      + `(${census.stationsPerJourney.min}–${census.stationsPerJourney.max} per journey); `
      + `${census.citedPromises} carry a cited promise, ${census.uncitedStations} do not`,
    axis('binding hardness', census.bindingHardnessAxis, census.stationTotal),
    axis('phase', census.phaseAxis, census.stationTotal),
    `citations checked: ${census.citationsResolved} of ${census.citationsChecked} resolved`,
    census.problems.length
      ? `PROBLEMS (${census.problems.length}):\n${census.problems.map((p) => `  - ${p}`).join('\n')}`
      : 'PROBLEMS: none',
  ].join('\n');
}

async function main() {
  const census = await deriveCensus();
  if (process.argv.includes('--json')) console.log(JSON.stringify(census, null, 2));
  else console.log(renderCensus(census));
  if (census.problems.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
