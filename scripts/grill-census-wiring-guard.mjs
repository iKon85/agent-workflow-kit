#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CENSUS_PREFLIGHT_INVOCATION =
  'python3 .claude/hooks/drift-guard.py --census-status';
export const CENSUS_PREFLIGHT_CONTRACT =
  'For a cross-cutting plan, run `python3 .claude/hooks/drift-guard.py --census-status` before locking it. When an activated census reports `block_handoff: true` (including stale or open surfaces), stop the lock, run `$census-update`, resolve the findings, and retry. When the census is disabled or not activated, keep the status visible and perform the existing manual surface walk; do not replace that walk with census guesses.';

const GRILL_NAMES = new Set([
  'grill-me',
  'grill-with-docs',
  'grill-me-codex',
  'grill-with-docs-codex',
]);
const SURFACE_TREES = { claude: '.claude', codex: '.agents' };
const LOCAL_CENSUS_LOGIC = /\b(?:scanCensus|diffCensus|fingerprintCensus|resolveCensusState|activateCensus)\s*\(/;

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function auditGrillCensusWiring(repoRoot) {
  const manifestPath = join(repoRoot, '.claude', 'skills', 'skill-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entries = Object.entries(manifest.skills ?? {})
    .filter(([name]) => GRILL_NAMES.has(name));
  const problems = [];
  const physical = [];

  const missingLogical = [...GRILL_NAMES].filter(
    (name) => !entries.some(([candidate]) => candidate === name),
  );
  for (const name of missingLogical) {
    problems.push(`manifest has no logical grill variant: ${name}`);
  }

  for (const [name, entry] of entries) {
    if (!Array.isArray(entry.surfaces) || entry.surfaces.length === 0) {
      problems.push(`manifest grill has no surfaces: ${name}`);
      continue;
    }
    for (const surface of entry.surfaces) {
      const tree = SURFACE_TREES[surface];
      if (!tree) {
        problems.push(`manifest names an unknown surface for ${name}: ${surface}`);
        continue;
      }
      const path = join(repoRoot, tree, 'skills', name, 'SKILL.md');
      physical.push({ name, surface, path });
      if (!(await exists(path))) {
        problems.push(`manifest surface has no skill file: ${surface}:${name}`);
        continue;
      }
      const prose = await readFile(path, 'utf8');
      const invocationCount = prose.split(CENSUS_PREFLIGHT_INVOCATION).length - 1;
      if (invocationCount !== 1) {
        problems.push(
          invocationCount === 0
            ? `missing census preflight invocation: ${surface}:${name}`
            : `duplicate census preflight invocation: ${surface}:${name}`,
        );
      }
      if (!prose.includes(CENSUS_PREFLIGHT_CONTRACT)) {
        problems.push(`census preflight contract drifted: ${surface}:${name}`);
      }
      if (LOCAL_CENSUS_LOGIC.test(prose)) {
        problems.push(`grill duplicates census engine logic: ${surface}:${name}`);
      }
    }
  }

  if (entries.length !== 4) {
    problems.push(`expected 4 logical grill variants, found ${entries.length}`);
  }
  if (physical.length !== 6) {
    problems.push(`expected 6 physical grill files, found ${physical.length}`);
  }

  return {
    counts: { logical: entries.length, physical: physical.length },
    problems,
  };
}

async function main() {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await auditGrillCensusWiring(repoRoot);
  console.log(`grill census wiring: ${result.counts.logical}/4 logical, ${result.counts.physical}/6 physical`);
  if (result.problems.length > 0) {
    for (const problem of result.problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
