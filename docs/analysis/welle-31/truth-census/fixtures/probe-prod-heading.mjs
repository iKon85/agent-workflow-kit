#!/usr/bin/env node
// Reproduction probe R3 — the `## Prod` readiness section is matched by exact
// string equality (Truth / wrong axis, testreporter#2283).
//
// `scripts/readiness.mjs::section()` finds the section with
// `line.trim() === heading`, so any consumer whose heading carries its own
// wording reports `missing-section` while the section is plainly there.
//
// Runs the shipped `inspectProdSections` against throwaway fixture files in a
// temp directory. Deterministic; no network; nothing outside the temp root is
// written.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectProdSections } from '../../../../../scripts/readiness.mjs';

const ARMS = [
  { arm: 'canonical', heading: '## Prod' },
  { arm: 'consumer-wording', heading: '## Prod und Deployment' },
  { arm: 'trailing-colon', heading: '## Prod:' },
  { arm: 'absent', heading: '## Deployment' },
];

const root = await mkdtemp(path.join(tmpdir(), 'w31-r3-'));
try {
  const arms = [];
  for (const { arm, heading } of ARMS) {
    const dir = path.join(root, arm);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'CLAUDE.md'),
      `# Consumer\n\n${heading}\n\nPublished to npm; the tagged workflow publishes.\n`,
    );
    const [section] = await inspectProdSections(dir, ['CLAUDE.md']);
    arms.push({ arm, heading, state: section.state, problem: section.problem });
  }
  const by = Object.fromEntries(arms.map((a) => [a.arm, a]));
  const result = {
    probe: 'R3-prod-heading',
    target: 'scripts/readiness.mjs::section',
    arms,
    reproduced:
      by.canonical.state === 'valid'
      && by['consumer-wording'].problem === 'missing-section'
      && by['trailing-colon'].problem === 'missing-section',
  };
  console.log(JSON.stringify(result));
} finally {
  await rm(root, { recursive: true, force: true });
}
