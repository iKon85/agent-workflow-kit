import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CENSUS_PREFLIGHT_CONTRACT,
  auditGrillCensusWiring,
} from './grill-census-wiring-guard.mjs';

const GRILLS = {
  'grill-me': { surfaces: ['claude', 'codex'] },
  'grill-with-docs': { surfaces: ['claude', 'codex'] },
  'grill-me-codex': { surfaces: ['claude'] },
  'grill-with-docs-codex': { surfaces: ['claude'] },
};

async function fixture({ manifest = GRILLS, omitInvocation, omitFile } = {}) {
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

test('manifest derives all four logical grills and all six physical surfaces', async () => {
  const result = await auditGrillCensusWiring(await fixture());

  assert.deepEqual(result.counts, { logical: 4, physical: 6 });
  assert.deepEqual(result.problems, []);
});

test('a grill surface missing the shared preflight invocation is rejected', async () => {
  const result = await auditGrillCensusWiring(await fixture({
    omitInvocation: 'codex:grill-with-docs',
  }));

  assert.match(result.problems.join('\n'), /missing census preflight invocation.*grill-with-docs/i);
});

test('a dead manifest surface reference is rejected', async () => {
  const result = await auditGrillCensusWiring(await fixture({
    omitFile: 'claude:grill-me-codex',
  }));

  assert.match(result.problems.join('\n'), /manifest surface has no skill file.*grill-me-codex/i);
});

test('the repository wiring stays at the manifest-derived 4 of 4 and 6 of 6 contract', async () => {
  const result = await auditGrillCensusWiring(
    join(dirname(fileURLToPath(import.meta.url)), '..'),
  );

  assert.deepEqual(result.counts, { logical: 4, physical: 6 });
  assert.deepEqual(result.problems, []);
});
