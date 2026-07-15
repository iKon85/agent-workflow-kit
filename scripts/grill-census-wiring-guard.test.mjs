import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CENSUS_PREFLIGHT_CONTRACT,
  auditGrillCensusWiring,
} from './grill-census-wiring-guard.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const realManifest = JSON.parse(await readFile(
  join(REPO, '.claude', 'skills', 'skill-manifest.json'),
  'utf8',
)).skills;
const baselineGrills = Object.fromEntries(
  Object.entries(realManifest).filter(([name]) => name.startsWith('grill-')),
);
const baselineCounts = {
  logical: Object.keys(baselineGrills).length,
  physical: Object.values(baselineGrills)
    .reduce((count, entry) => count + entry.surfaces.length, 0),
};
const [baselineName, baselineEntry] = Object.entries(baselineGrills)[0];
const baselineSurface = baselineEntry.surfaces[0];
let extraGrillName = 'grill-fixture-extra';
while (extraGrillName in baselineGrills) extraGrillName += '-next';

async function fixture({ manifest = baselineGrills, omitInvocation, omitFile } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'grill-census-guard-'));
  await mkdir(join(root, '.claude', 'skills'), { recursive: true });
  await writeFile(
    join(root, '.claude', 'skills', 'skill-manifest.json'),
    `${JSON.stringify({ skills: manifest })}\n`,
  );
  for (const [name, entry] of Object.entries(manifest)) {
    for (const surface of entry.surfaces) {
      const relative = `${surface}:${name}`;
      if (relative === omitFile) continue;
      const tree = surface === 'claude' ? '.claude' : '.agents';
      const directory = join(root, tree, 'skills', name);
      await mkdir(directory, { recursive: true });
      const invocation = relative === omitInvocation ? '' : CENSUS_PREFLIGHT_CONTRACT;
      await writeFile(join(directory, 'SKILL.md'), `# ${name}\n${invocation}\n`);
    }
  }
  return root;
}

test('fixture wiring covers every grill and surface in the real manifest', async () => {
  const result = await auditGrillCensusWiring(await fixture());

  assert.deepEqual(result.counts, baselineCounts);
  assert.deepEqual(result.problems, []);
});

test('a grill surface missing the shared preflight invocation is rejected', async () => {
  const result = await auditGrillCensusWiring(await fixture({
    omitInvocation: `${baselineSurface}:${baselineName}`,
  }));

  assert.match(
    result.problems.join('\n'),
    new RegExp(`missing census preflight invocation.*${baselineName}`, 'i'),
  );
});

test('a dead manifest surface reference is rejected', async () => {
  const result = await auditGrillCensusWiring(await fixture({
    omitFile: `${baselineSurface}:${baselineName}`,
  }));

  assert.match(
    result.problems.join('\n'),
    new RegExp(`manifest surface has no skill file.*${baselineName}`, 'i'),
  );
});

test('a newly manifested grill variant expands the family and cannot hide a missing surface', async () => {
  const addedSurfaces = ['claude', 'codex'];
  const manifest = {
    ...baselineGrills,
    [extraGrillName]: { surfaces: addedSurfaces },
  };
  const result = await auditGrillCensusWiring(await fixture({
    manifest,
    omitFile: `codex:${extraGrillName}`,
  }));

  assert.deepEqual(result.counts, {
    logical: baselineCounts.logical + 1,
    physical: baselineCounts.physical + addedSurfaces.length,
  });
  assert.match(
    result.problems.join('\n'),
    new RegExp(`manifest surface has no skill file.*${extraGrillName}`, 'i'),
  );
});

test('the repository wiring covers the complete manifest-derived grill family', async () => {
  const result = await auditGrillCensusWiring(REPO);

  assert.deepEqual(result.counts, baselineCounts);
  assert.deepEqual(result.problems, []);
});
