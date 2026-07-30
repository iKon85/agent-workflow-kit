#!/usr/bin/env node
// Counter-control for the #380 truth census (§6 "Counter-control, independent
// of the metric *and* of the machinery under review").
//
// A frozen consumer fixture replays `init` -> consumer edits -> `update` and
// checks the four consumer-contract properties the kit promises:
//
//   C1 reconcile correctness — an untouched installed file fast-forwards
//   C2 no overwrite of consumer edits — an edited file keeps consumer bytes and
//      is reported (conflict / userModified), never silently replaced
//   C3 project layer is never overwritten by ordinary reconciliation
//   C4 byte-stable manifest — a second update over the same inputs is a no-op
//
// SUPERSEDED CONTRACT (2026-07-30, #414 / #433): C2 above states the pre-option-(c)
// contract, and this file is kept as the recorded measurement of that contract at
// the pinned `srcTree` — it is deliberately NOT rewritten. Since #433 an
// undeclared `origin=kit` edit is overwritten with a non-clobbering backup and
// named in the end-of-update summary; ledger-declared consumer ownership
// (`project-extension`/`contribution-bridge`/`explicit-fork`) is what is never
// overwritten. A re-run against current `src/` therefore reports C2 red for the
// old predicate, not a regression. Re-deriving C2 as "nothing lost (a backup
// holds the replaced bytes) and nothing silent (the summary names it)" is a
// precondition of re-running this control, not a repair of this record.
//
// Two arms, per §7 "positive control first":
//
//   positive-control  the same harness against a deliberately defective
//                     reconcile (one recorded mutation) — it MUST go red
//   shipped           the same harness against the kit under review
//
// Fixtures only: everything runs in a temp directory built by the repository's
// own committed helpers (`test/helpers.mjs`, consume-only). No live consumer,
// no registry, no network, nothing outside the temp root is written.
//
// Usage: node docs/analysis/welle-31/truth-census/lib/run-counter-control.mjs
// Writes: docs/analysis/welle-31/truth-census/controls/counter-control.json

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../../../../..');
const OUT = path.join(ROOT, 'docs/analysis/welle-31/truth-census/controls/counter-control.json');
const REPETITIONS = 3;

const KIT_FILE = '.claude/skills/to-prd/SKILL.md';   // consumer edits this one
const UNTOUCHED = '.claude/skills/to-issues/SKILL.md'; // must fast-forward
const PROJECT_LAYER = 'docs/agents/issue-tracker.md';  // seeded, never overwritten

// The recorded mutation for the positive control. Applied to a COPY of `src/`
// in a temp directory — the repository under review is never modified.
export const MUTATION = {
  file: 'src/lib/updateReconcile.mjs',
  from: 'const userEdited = current !== prior.installedSha256;',
  to: 'const userEdited = false; // POSITIVE CONTROL: reconcile forgets consumer edits',
  defect: 'reconcile treats every destination as untouched, so a consumer-edited '
    + 'file is silently overwritten by the incoming kit bytes — exactly the '
    + 'consumer-contract violation C2 exists to catch',
};

async function loadModules(srcRoot) {
  const url = (rel) => pathToFileURL(path.join(srcRoot, rel)).href;
  const [init, update, manifest, hash, decisions] = await Promise.all([
    import(url('src/commands/init.mjs')),
    import(url('src/commands/update.mjs')),
    import(url('src/lib/manifest.mjs')),
    import(url('src/lib/hash.mjs')),
    import(url('src/lib/updateDecisions.mjs')),
  ]);
  return { init: init.init, update: update.update, manifest, hash, decisions };
}

async function makeKit(root, files, kitVersion, manifestName, sha256) {
  await mkdir(root, { recursive: true });
  const manifestFiles = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    manifestFiles.push({
      path: rel,
      kind: rel.includes('/skills/') ? 'skill' : 'doc',
      sha256: sha256(content),
      mode: 0o644,
      origin: 'kit',
    });
  }
  await writeFile(
    path.join(root, manifestName),
    `${JSON.stringify({ kitVersion, files: manifestFiles }, null, 2)}\n`,
  );
}

function releaseIdentities(version = '0.2.0') {
  const identity = {
    name: '@ikon85/agent-workflow-kit', version,
    tarballIntegrity: 'sha512-fixture', manifestSha256: 'fixture-manifest',
  };
  return {
    installed: { name: identity.name, version, manifestSha256: identity.manifestSha256 },
    npm: { ...identity },
    github: { ...identity },
  };
}

const V1 = {
  [KIT_FILE]: '# to-prd\n\nstep one\n',
  [UNTOUCHED]: '# to-issues\n\nstep one\n',
};
const V2 = {
  [KIT_FILE]: '# to-prd\n\nstep one\nstep two (upstream)\n',
  [UNTOUCHED]: '# to-issues\n\nstep one\nstep two (upstream)\n',
};
const CONSUMER_EDIT = '# to-prd\n\nstep one\nMY OWN LOCAL EDIT\n';
const PROJECT_EDIT = '# Issue tracker\n\nOur board lives in Linear.\n';

async function runOnce(srcRoot, label, { consumerEdit = true } = {}) {
  const modules = await loadModules(srcRoot);
  const { CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME } = modules.manifest;
  const scratch = await mkdtemp(path.join(tmpdir(), `w31-cc-${label}-`));
  try {
    const kit = path.join(scratch, 'kit');
    const consumer = path.join(scratch, 'consumer');
    await mkdir(consumer, { recursive: true });
    await makeKit(kit, V1, '0.1.0', PACKAGE_MANIFEST_NAME, modules.hash.sha256);
    await modules.init({ kitRoot: kit, consumerRoot: consumer });

    // The consumer does what a consumer does: edits an installed file and
    // fills in the project layer.
    if (consumerEdit) await writeFile(path.join(consumer, KIT_FILE), CONSUMER_EDIT);
    await writeFile(path.join(consumer, PROJECT_LAYER), PROJECT_EDIT);

    // Upstream ships a new version of both files.
    await makeKit(kit, V2, '0.2.0', PACKAGE_MANIFEST_NAME, modules.hash.sha256);

    const first = await modules.update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async () => {},
      decide: modules.decisions.nonInteractiveUpdateDecision,
    });
    const manifestAfterFirst = await readFile(path.join(consumer, CONSUMER_MANIFEST_NAME), 'utf8');
    const second = await modules.update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async () => {},
      decide: modules.decisions.nonInteractiveUpdateDecision,
    });
    const manifestAfterSecond = await readFile(path.join(consumer, CONSUMER_MANIFEST_NAME), 'utf8');

    const editedBytes = await readFile(path.join(consumer, KIT_FILE), 'utf8');
    const untouchedBytes = await readFile(path.join(consumer, UNTOUCHED), 'utf8');
    const projectBytes = await readFile(path.join(consumer, PROJECT_LAYER), 'utf8');
    const reported = [
      ...(first.conflicts ?? []).map((c) => c.path ?? c),
      ...(first.userModified ?? []),
      ...(first.consumerOwned ?? []),
    ];

    return {
      C1: { pass: untouchedBytes === V2[UNTOUCHED], observed: untouchedBytes },
      C2: {
        pass: consumerEdit
          ? editedBytes === CONSUMER_EDIT && reported.includes(KIT_FILE)
          : editedBytes === V2[KIT_FILE],
        observed: editedBytes,
        reported: reported.includes(KIT_FILE),
      },
      C3: { pass: projectBytes === PROJECT_EDIT, observed: projectBytes },
      C4: { pass: manifestAfterFirst === manifestAfterSecond },
      state: { first: first.state ?? 'applied', second: second.state ?? 'applied' },
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function mutatedSource() {
  const scratch = await mkdtemp(path.join(tmpdir(), 'w31-cc-mutant-'));
  await cp(path.join(ROOT, 'src'), path.join(scratch, 'src'), { recursive: true });
  await cp(path.join(ROOT, 'scripts'), path.join(scratch, 'scripts'), { recursive: true });
  await cp(path.join(ROOT, 'package.json'), path.join(scratch, 'package.json'));
  const target = path.join(scratch, MUTATION.file);
  const text = await readFile(target, 'utf8');
  if (!text.includes(MUTATION.from)) {
    throw new Error(`positive-control mutation no longer applies to ${MUTATION.file}`);
  }
  await writeFile(target, text.replace(MUTATION.from, MUTATION.to));
  return scratch;
}

function verdict(runs) {
  const checks = ['C1', 'C2', 'C3', 'C4'];
  const perCheck = {};
  for (const check of checks) {
    const passes = runs.filter((r) => r[check].pass).length;
    perCheck[check] = {
      passes,
      of: runs.length,
      majority: passes * 2 > runs.length ? 'pass' : 'fail',
      spread: passes === 0 || passes === runs.length ? 'none' : 'split',
    };
  }
  return {
    perCheck,
    green: checks.every((c) => perCheck[c].majority === 'pass'),
  };
}

async function main() {
  const censusCommit = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // The identity of the code under test is the `src/` tree, not the commit:
  // committing this analysis moves HEAD without moving one byte of the kit.
  const srcTree = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD:src'], { encoding: 'utf8' }).trim();

  const mutant = await mutatedSource();
  let positiveRuns;
  let shippedRuns;
  let cleanRuns;
  try {
    positiveRuns = [];
    for (let i = 0; i < REPETITIONS; i += 1) positiveRuns.push(await runOnce(mutant, 'pos'));
    shippedRuns = [];
    for (let i = 0; i < REPETITIONS; i += 1) shippedRuns.push(await runOnce(ROOT, 'ship'));
    cleanRuns = [];
    for (let i = 0; i < REPETITIONS; i += 1) {
      cleanRuns.push(await runOnce(ROOT, 'clean', { consumerEdit: false }));
    }
  } finally {
    await rm(mutant, { recursive: true, force: true });
  }

  const positive = verdict(positiveRuns);
  const shipped = verdict(shippedRuns);
  const clean = verdict(cleanRuns);

  const payload = {
    schema: 'welle-31/truth-census/counter-control/v1',
    censusCommit,
    fixtureCommit: '320dece903a09ee63588d9b050713f8f0a63b594',
    srcTree,
    fixtureSource: 'built in a temp directory from the V1/V2 literals in this file; '
      + 'the reconcile under test is `src/` at the recorded srcTree',
    repetitions: REPETITIONS,
    checks: {
      C1: 'an untouched installed file fast-forwards to the incoming bytes',
      C2: 'a consumer-edited file keeps consumer bytes AND is reported',
      C3: 'the project layer is not overwritten by ordinary reconciliation',
      C4: 'the consumer manifest is byte-stable across a repeated update',
    },
    positiveControl: {
      mutation: MUTATION,
      appliedTo: `copy of src/ at tree ${srcTree}`,
      ranFirst: true,
      wentRed: !positive.green,
      redChecks: Object.entries(positive.perCheck)
        .filter(([, v]) => v.majority === 'fail').map(([k]) => k),
      perCheck: positive.perCheck,
      runs: positiveRuns,
    },
    shipped: {
      arm: 'consumer edited one installed file that upstream also changed',
      green: shipped.green,
      perCheck: shipped.perCheck,
      runs: shippedRuns,
    },
    shippedNoConflict: {
      arm: 'no consumer edit — isolates the fast-forward promise from the conflict path',
      green: clean.green,
      perCheck: clean.perCheck,
      runs: cleanRuns,
    },
    valid: !positive.green,
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(payload, null, 1)}\n`);
  console.log('positive control went red:', payload.positiveControl.wentRed,
    payload.positiveControl.redChecks);
  console.log("shipped green:", shipped.green, JSON.stringify(shipped.perCheck));
  console.log("no-conflict arm green:", clean.green, JSON.stringify(clean.perCheck));
  if (!payload.valid) {
    console.error('CONTROL INVALID — a control that never goes red is not evidence');
    process.exitCode = 1;
  }
}

await main();
