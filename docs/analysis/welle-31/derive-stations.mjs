#!/usr/bin/env node
/**
 * Welle 31 · Slice 0 — station-table derivation (#404; #380 §5).
 *
 * Expands the authored station model into `substrate/stations.json`, the
 * ten-column station table #380 §5 specifies, and refuses to emit a table that
 * does not close:
 *
 *  - every journey in `substrate/journeys.json` has a station table, and every
 *    modelled journey exists in the journey set — neither side may drift;
 *  - station ids are unique inside a journey;
 *  - binding hardness, phase and authorization boundary come from the declared
 *    vocabularies, never free text (an unenumerated value is how a census
 *    silently gains a category);
 *  - every `recovery relation` target resolves: a `variant-of` names a real
 *    station, an `escalates-to` names a journey that is a recovery journey WITH
 *    its own entry points (#380 §5: a recovery branch is a station variant
 *    unless it has its own entry point), and a `recovers` target is a
 *    non-recovery journey.
 *
 * Citation resolution is deliberately NOT checked here — `derive-census.mjs`
 * checks it for journeys and stations together, against the frozen evidence
 * export, so there is one place that can fail it.
 *
 * `sourceCommit` is read from `journeys.json` rather than from `git HEAD`: the
 * substrate is a freeze, so re-running this script after the freeze commit must
 * reproduce the same bytes. A derivation whose output changes because it was
 * re-run is not a derivation.
 *
 * Usage: node docs/analysis/welle-31/derive-stations.mjs [--out <file>] [--check]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTHORIZATION_BOUNDARIES, BINDING_HARDNESS, PHASES, STATION_MODEL, TUPLE_COLUMNS,
} from './stations-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUBSTRATE = join(HERE, 'substrate');

/** #380 §5, verbatim and in order. The emitted rows carry exactly these fields. */
export const COLUMNS = [
  'journey_id', 'station_id', 'promise (cited)', 'what it actually verifies',
  'binding hardness', 'phase', 'user decision', 'agent action',
  'authorization boundary', 'recovery relation',
];

const FIELD_BY_COLUMN = {
  'journey_id': 'journeyId',
  'station_id': 'stationId',
  'promise (cited)': 'promise',
  'what it actually verifies': 'verifies',
  'binding hardness': 'bindingHardness',
  'phase': 'phase',
  'user decision': 'userDecision',
  'agent action': 'agentAction',
  'authorization boundary': 'authorizationBoundary',
  'recovery relation': 'recoveryRelation',
};

export function expand(model = STATION_MODEL) {
  const rows = [];
  for (const [journeyId, tuples] of Object.entries(model)) {
    for (const tuple of tuples) {
      if (tuple.length !== TUPLE_COLUMNS.length) {
        throw new Error(`${journeyId}: station tuple has ${tuple.length} fields, expected ${TUPLE_COLUMNS.length}`);
      }
      const [stationId, promiseText, promiseCitation, verifies, bindingHardness,
        phase, userDecision, agentAction, authorizationBoundary, recoveryRelation] = tuple;
      rows.push({
        journeyId,
        stationId,
        promise: { text: promiseText, citation: promiseCitation },
        verifies,
        bindingHardness,
        phase,
        userDecision,
        agentAction,
        authorizationBoundary,
        recoveryRelation,
      });
    }
  }
  return rows;
}

export function validate(rows, journeySet) {
  const problems = [];
  const journeys = new Map(journeySet.journeys.map((journey) => [journey.id, journey]));
  const stationKeys = new Set(rows.map((row) => `${row.journeyId}#${row.stationId}`));
  const modelled = new Set(rows.map((row) => row.journeyId));

  for (const id of journeys.keys()) {
    if (!modelled.has(id)) problems.push(`journey ${id}: no station table`);
  }
  for (const id of modelled) {
    if (!journeys.has(id)) problems.push(`station table for unknown journey ${id}`);
  }

  const seen = new Set();
  for (const row of rows) {
    const key = `${row.journeyId}#${row.stationId}`;
    if (seen.has(key)) problems.push(`${key}: duplicate station id`);
    seen.add(key);
    for (const [field, vocabulary] of [
      ['bindingHardness', BINDING_HARDNESS],
      ['phase', PHASES],
      ['authorizationBoundary', AUTHORIZATION_BOUNDARIES],
    ]) {
      if (!vocabulary.includes(row[field])) problems.push(`${key}: unknown ${field} "${row[field]}"`);
    }
    for (const [field, value] of [
      ['promise.text', row.promise.text],
      ['promise.citation', row.promise.citation],
      ['verifies', row.verifies],
      ['userDecision', row.userDecision],
      ['agentAction', row.agentAction],
    ]) {
      if (!value || !String(value).trim()) problems.push(`${key}: empty ${field}`);
    }

    const relation = row.recoveryRelation;
    if (relation === 'none') continue;
    const [kind, target] = relation.split(':');
    if (kind === 'variant-of') {
      if (!stationKeys.has(target)) problems.push(`${key}: variant-of target does not resolve: ${target}`);
    } else if (kind === 'escalates-to') {
      const journey = journeys.get(target);
      if (!journey) problems.push(`${key}: escalates-to unknown journey ${target}`);
      // The #380 §5 rule, mechanised: a branch may only be its own journey when
      // it really has its own entry point. Otherwise it is a station variant.
      else if (!journey.isRecovery) problems.push(`${key}: escalates-to ${target} is not a recovery journey`);
      else if (!journey.entryPoints?.length) problems.push(`${key}: escalates-to ${target} has no entry point of its own`);
    } else if (kind === 'recovers') {
      const journey = journeys.get(target);
      const self = journeys.get(row.journeyId);
      if (!journey) problems.push(`${key}: recovers unknown journey ${target}`);
      else if (journey.isRecovery) problems.push(`${key}: recovers ${target}, which is itself a recovery journey`);
      if (self && !self.isRecovery) problems.push(`${key}: uses "recovers" outside a recovery journey`);
    } else {
      problems.push(`${key}: unknown recovery relation "${relation}"`);
    }
  }
  return problems;
}

const tally = (values) => values.reduce((acc, value) => {
  acc[value] = (acc[value] ?? 0) + 1;
  return acc;
}, {});

export async function deriveStations() {
  const journeySet = JSON.parse(await readFile(join(SUBSTRATE, 'journeys.json'), 'utf8'));
  const stations = expand();
  const problems = validate(stations, journeySet);
  if (problems.length) {
    throw new Error(`station model does not close:\n  - ${problems.join('\n  - ')}`);
  }
  const perJourney = tally(stations.map(({ journeyId }) => journeyId));
  return {
    schema: 'welle-31/substrate/stations/v1',
    sourceCommit: journeySet.sourceCommit,
    note: 'One station table per journey, columns verbatim from #380 §5. The '
      + '"promise" column quotes a shipped artifact and cites it; the "what it '
      + 'actually verifies" column says what the mechanism at that station can '
      + 'observe. Keeping the two apart is the point — this slice freezes them '
      + 'and adjudicates neither.',
    columns: COLUMNS,
    fieldByColumn: FIELD_BY_COLUMN,
    stationTotal: stations.length,
    journeysWithStations: Object.keys(perJourney).length,
    stationsPerJourney: perJourney,
    stations,
  };
}

export function renderSummary(payload) {
  const counts = Object.values(payload.stationsPerJourney);
  return [
    `source commit: ${payload.sourceCommit}`,
    `${payload.stationTotal} stations over ${payload.journeysWithStations} journeys `
      + `(${Math.min(...counts)}–${Math.max(...counts)} per journey)`,
    `binding hardness: ${JSON.stringify(tally(payload.stations.map((s) => s.bindingHardness)))}`,
    `phase: ${JSON.stringify(tally(payload.stations.map((s) => s.phase)))}`,
    `authorization boundary: ${JSON.stringify(tally(payload.stations.map((s) => s.authorizationBoundary)))}`,
  ].join('\n');
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outFile = outIndex === -1
    ? join(SUBSTRATE, 'stations.json')
    : resolve(process.argv[outIndex + 1]);
  const payload = await deriveStations();
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const committed = await readFile(outFile, 'utf8');
    if (committed === body) console.log(`reproduces byte-equal: ${outFile}`);
    else {
      console.error(`DOES NOT REPRODUCE: ${outFile}`);
      process.exitCode = 1;
      return;
    }
  } else {
    await writeFile(outFile, body);
  }
  console.log(renderSummary(payload));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
