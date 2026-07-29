#!/usr/bin/env node
/**
 * Welle 31 · Slice 0 — scripted inventory (#404; mandate #380 §1
 * "Denominator is a query, not a count").
 *
 * The denominator is derived from the kit's own declarations — `HELPER_FILES`
 * and `collectBundle()` in `src/lib/bundle.mjs`, the skill manifest, and the
 * `isPublishExcluded()` predicate — never from a directory listing. That is not
 * pedantry: the refuted denominator in #380's own review came from an `ls` that
 * skipped subdirectories.
 *
 * `git ls-tree` appears below and is deliberately not a directory listing: it
 * is an exhaustive, recursive query over the tracked set at one commit, and it
 * is only ever used as the POPULATION that the kit's own predicates then
 * classify. Every partition boundary is a shipped declaration, not a path
 * guess.
 *
 * The population is pinned to a COMMIT, not to the working tree, because the
 * substrate is a freeze: committing this analysis adds files to the repository,
 * and a denominator that moves when the analysis lands is not a denominator.
 * `--check` re-derives against the commit the committed artifact names and
 * compares — that is the re-derivation command the summary cites.
 *
 * Four partitions, and findings never cross them (#380 §1). Anything the
 * declarations do not claim lands in a residual bucket and is named there
 * rather than dropped (#380 §8.1: "any artifact left unexamined is named").
 *
 * Usage: node docs/analysis/welle-31/derive-inventory.mjs [--out <file>]
 *                                                        [--commit <sha>] [--check]
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  HELPER_FILES, STUB_TARGETS, collectBundle, isPublishExcluded, publishableSkills,
} from '../../../src/lib/bundle.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

export const PARTITIONS = ['kit-core', 'shipped-surface', 'maintainer-only', 'consumer-owned'];

/** Consumer-owned project extension: dogfood instances, never evidence about the product. */
const CONSUMER_OWNED_PREFIX = ['docs/agents/', 'docs/conventions/', '.codex/'];
const CONSUMER_OWNED_FILE = new Set([
  ...STUB_TARGETS, 'CLAUDE.md', 'AGENTS.md', 'CONTEXT.md', 'max-lines-allowlist.json',
]);
/** Maintainer-only by location: neither published nor installed, runs the build/land gates. */
const MAINTAINER_PREFIX = ['.github/', '.githooks/', 'test/'];
/** This wave's own output. Named, not silently dropped — it is not kit surface. */
const ANALYSIS_PREFIX = ['docs/analysis/', 'docs/evidence/'];
/**
 * Emitted by `build-kit.mjs` and read back by `bundle.mjs` as the verification
 * source — a generated SHIPPED CONTRACT, explicitly in scope per #380 §1, not
 * transient build output.
 */
const GENERATED_SHIPPED_CONTRACT = new Set(['agent-workflow-kit.package.json']);
/** Declares the maintainer's build/test/release commands and the publish scope. */
const MAINTAINER_METADATA = new Set(['package.json', 'package-lock.json']);
/** Published to consumers as documents; they codify no enforced rule. */
const PUBLISHED_DOC = new Set([
  'README.md', 'LICENSE', 'PROVENANCE.md',
  'docs/index.html', 'docs/methodology.html', 'docs/methodology.svg',
  'docs/workflow.html', 'docs/workflow.png',
]);
/** Packaging directives and ignore files; no rule, no surface. */
const REPO_METADATA = new Set(['.gitignore']);
const REPO_METADATA_SUFFIX = ['/.npmignore'];

const startsWithAny = (path, prefixes) => prefixes.some((prefix) => path.startsWith(prefix));

/**
 * Classify one tracked path. Precedence matters: the install manifest is the
 * strongest declaration, so a bundle entry is never reclassified by location.
 */
export function classify(path, bundleIndex) {
  const entry = bundleIndex.get(path);
  if (entry) {
    if (entry.kind === 'skill') return { partition: 'shipped-surface', reason: 'install-manifest skill file' };
    if (entry.installRole === 'maintainer') return { partition: 'maintainer-only', reason: 'install-manifest maintainer role' };
    return { partition: 'kit-core', reason: `install-manifest ${entry.kind}` };
  }
  if (GENERATED_SHIPPED_CONTRACT.has(path)) {
    return { partition: 'kit-core', reason: 'generated shipped contract (#380 §1)' };
  }
  if (MAINTAINER_METADATA.has(path)) {
    return { partition: 'maintainer-only', reason: 'package metadata: build/test/release commands and publish scope' };
  }
  if (CONSUMER_OWNED_FILE.has(path) || startsWithAny(path, CONSUMER_OWNED_PREFIX)) {
    return { partition: 'consumer-owned', reason: 'project-extension path' };
  }
  if (startsWithAny(path, ANALYSIS_PREFIX)) return { partition: null, reason: 'analysis-artifact' };
  if (startsWithAny(path, MAINTAINER_PREFIX)) return { partition: 'maintainer-only', reason: 'ci/hook location' };
  if (isPublishExcluded(path)) return { partition: 'maintainer-only', reason: 'isPublishExcluded()' };
  if (path.startsWith('src/')) return { partition: 'kit-core', reason: 'src/ — installer CLI and its libraries' };
  // Published by `package.json:"files"` yet absent from the install manifest:
  // real shipped code a consumer can run, so it carries rules and stays in
  // scope even though `init` never copies it.
  if (path.startsWith('scripts/')) return { partition: 'kit-core', reason: 'published, not install-manifest' };
  if (PUBLISHED_DOC.has(path)) return { partition: null, reason: 'published-doc-no-rule-surface' };
  if (REPO_METADATA.has(path) || REPO_METADATA_SUFFIX.some((s) => path.endsWith(s))) {
    return { partition: null, reason: 'repo-metadata' };
  }
  return { partition: null, reason: 'unclassified' };
}

/** Logical skills and their mirrors — a `.agents/` copy is a mirror, not a second artifact. */
export function skillUnits(manifest) {
  const units = publishableSkills(manifest).map(({ name, surfaces, installRole }) => ({
    name,
    surfaces,
    installRole,
    mirrored: surfaces.includes('claude') && surfaces.includes('codex'),
    primarySurface: surfaces.includes('claude') ? 'claude' : 'codex',
  }));
  return {
    logicalTotal: units.length,
    mirrored: units.filter((unit) => unit.mirrored).length,
    claudeOnly: units.filter((unit) => !unit.surfaces.includes('codex')).map(({ name }) => name),
    codexOnly: units.filter((unit) => !unit.surfaces.includes('claude')).map(({ name }) => name),
    maintainerRole: units.filter((unit) => unit.installRole === 'maintainer').map(({ name }) => name),
    units,
  };
}

const tally = (rows, key) => rows.reduce((acc, row) => {
  acc[row[key]] = (acc[row[key]] ?? 0) + 1;
  return acc;
}, {});

export async function deriveInventory(repoRoot = REPO_ROOT, commit = null) {
  const manifest = JSON.parse(await readFile(join(repoRoot, '.claude/skills/skill-manifest.json'), 'utf8'));
  const { files } = await collectBundle(repoRoot, manifest);
  const bundleIndex = new Map(files.map((file) => [file.dest, file]));

  const sourceCommit = commit
    ?? (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
  const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', sourceCommit], {
    cwd: repoRoot, maxBuffer: 32 * 1024 * 1024,
  });
  const tracked = stdout.split('\n').filter(Boolean).sort();

  const rows = tracked.map((path) => {
    const { partition, reason } = classify(path, bundleIndex);
    const entry = bundleIndex.get(path);
    return {
      path,
      partition,
      reason,
      kind: entry?.kind ?? null,
      surface: entry?.surface ?? null,
      ownerSkill: entry?.ownerSkill ?? null,
      installRole: entry?.installRole ?? null,
      installed: Boolean(entry),
    };
  });

  const partitions = Object.fromEntries(PARTITIONS.map((name) => {
    const members = rows.filter((row) => row.partition === name);
    return [name, {
      total: members.length,
      byKind: tally(members.filter((row) => row.kind), 'kind'),
      byReason: tally(members, 'reason'),
      paths: members.map(({ path }) => path),
    }];
  }));

  const residual = rows.filter((row) => row.partition === null);

  return {
    schema: 'welle-31/substrate/inventory/v1',
    sourceCommit,
    derivedAt: new Date().toISOString(),
    sources: [
      'src/lib/bundle.mjs — HELPER_FILES, collectBundle(), isPublishExcluded()',
      '.claude/skills/skill-manifest.json — publish/surfaces/installRole',
      'git ls-tree -r --name-only <sourceCommit> — the tracked population the predicates above classify',
    ],
    trackedTotal: tracked.length,
    installManifestTotal: files.length,
    installManifestByKind: tally(files, 'kind'),
    helperFileTotal: HELPER_FILES.length,
    stubTargetTotal: STUB_TARGETS.length,
    skills: skillUnits(manifest),
    partitions,
    residual: {
      total: residual.length,
      byReason: tally(residual, 'reason'),
      unclassified: residual.filter((row) => row.reason === 'unclassified').map(({ path }) => path),
      paths: residual.map(({ path, reason }) => ({ path, reason })),
    },
    rows,
  };
}

export function renderSummary(inventory) {
  const lines = [];
  const { trackedTotal, partitions, residual, skills } = inventory;
  lines.push(`source commit: ${inventory.sourceCommit}`);
  lines.push(`tracked artifacts (denominator): ${trackedTotal}`);
  for (const name of PARTITIONS) {
    const kinds = Object.entries(partitions[name].byKind)
      .map(([kind, count]) => `${kind}=${count}`).join(' ');
    lines.push(`  ${name}: ${partitions[name].total} of ${trackedTotal}${kinds ? ` (${kinds})` : ''}`);
  }
  lines.push(`  residual (named, not partitioned): ${residual.total} of ${trackedTotal} `
    + `(${Object.entries(residual.byReason).map(([r, c]) => `${r}=${c}`).join(' ')})`);
  lines.push(`install manifest: ${inventory.installManifestTotal} files — `
    + Object.entries(inventory.installManifestByKind).map(([k, c]) => `${k}=${c}`).join(' '));
  lines.push(`logical skills: ${skills.logicalTotal} (${skills.mirrored} mirrored on both surfaces, `
    + `${skills.claudeOnly.length} Claude-only, ${skills.codexOnly.length} Codex-only)`);
  const sum = PARTITIONS.reduce((acc, name) => acc + partitions[name].total, 0) + residual.total;
  lines.push(`partition closure: ${sum} of ${trackedTotal} — ${sum === trackedTotal ? 'complete' : 'INCOMPLETE'}`);
  return lines.join('\n');
}

const argValue = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
};

/**
 * Everything except `derivedAt` must match: the timestamp records when the
 * derivation ran, and no re-run can reproduce a past instant. The counted
 * content is what has to be re-derivable, and it is.
 */
const withoutTimestamp = (inventory) => {
  const { derivedAt, ...rest } = inventory;
  return JSON.stringify(rest, null, 2);
};

async function main() {
  const outFile = argValue('--out')
    ? resolve(argValue('--out'))
    : join(REPO_ROOT, 'docs/analysis/welle-31/substrate/inventory.json');

  if (process.argv.includes('--check')) {
    const committed = JSON.parse(await readFile(outFile, 'utf8'));
    const rederived = await deriveInventory(REPO_ROOT, committed.sourceCommit);
    if (withoutTimestamp(committed) === withoutTimestamp(rederived)) {
      console.log(`reproduces (every field but derivedAt): ${outFile}`);
      console.log(renderSummary(rederived));
      return;
    }
    console.error(`DOES NOT REPRODUCE: ${outFile}`);
    process.exitCode = 1;
    return;
  }

  const inventory = await deriveInventory(REPO_ROOT, argValue('--commit'));
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(renderSummary(inventory));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
