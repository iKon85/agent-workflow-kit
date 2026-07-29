#!/usr/bin/env node
// Runs every reproduction probe with >= 3 repetitions and records the exact
// command, exit code and output of each run (#380 promotion rule: a
// `reproduction` is "the unobservable fact demonstrated directly, with command
// and output").
//
// Every probe is fixture-only and read-only against the repository: nothing
// under the repository is written, no network is touched, and no destructive
// journey is walked. Temp roots are created and removed by the probes.
//
// Usage: node lib/run-reproductions.mjs
// Writes: controls/reproductions.json

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(BASE, '../../../..');
const REPETITIONS = 3;

const PROBES = [
  {
    id: 'R1-env-proxy',
    target: 'scripts/worktree-lifecycle/classify.py::_env_problem',
    argv: ['python3', 'docs/analysis/welle-31/truth-census/fixtures/probe-env-proxy.py'],
  },
  {
    id: 'R2-command-substring',
    target: 'scripts/worktree-lifecycle/core.py::targets_linked_worktree',
    argv: ['python3', 'docs/analysis/welle-31/truth-census/fixtures/probe-command-substring.py'],
  },
  {
    id: 'R3-prod-heading',
    target: 'scripts/readiness.mjs::section',
    argv: ['node', 'docs/analysis/welle-31/truth-census/fixtures/probe-prod-heading.mjs'],
  },
];

const results = [];
for (const probe of PROBES) {
  const runs = [];
  for (let i = 0; i < REPETITIONS; i += 1) {
    const stdout = execFileSync(probe.argv[0], probe.argv.slice(1), { cwd: ROOT, encoding: 'utf8' });
    runs.push(JSON.parse(stdout.trim()));
  }
  const reproduced = runs.map((r) => r.reproduced);
  const majority = reproduced.filter(Boolean).length * 2 > runs.length;
  const identical = new Set(runs.map((r) => JSON.stringify(r))).size === 1;
  results.push({
    id: probe.id,
    target: probe.target,
    command: probe.argv.join(' '),
    repetitions: REPETITIONS,
    reproducedPerRun: reproduced,
    majority,
    spread: identical ? 'none — byte-identical output on every repetition' : 'runs differ',
    output: runs[0],
  });
}

const censusCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const srcTree = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD:scripts'], { encoding: 'utf8' }).trim();
mkdirSync(path.join(BASE, 'controls'), { recursive: true });
writeFileSync(path.join(BASE, 'controls/reproductions.json'), `${JSON.stringify({
  schema: 'welle-31/truth-census/reproductions/v1',
  censusCommit,
  scriptsTree: srcTree,
  fixtureOnly: true,
  probes: results,
}, null, 1)}\n`);

for (const r of results) console.log(`${r.id}: reproduced=${r.majority} (${r.reproducedPerRun.join(',')}) spread=${r.spread}`);
if (!results.every((r) => r.majority)) {
  console.error('a probe failed to reproduce — the finding it backs may not be promoted');
  process.exitCode = 1;
}
