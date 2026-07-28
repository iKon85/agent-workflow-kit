#!/usr/bin/env node
/**
 * Doctrine migration — retire the hand-maintained model-and-effort routing
 * table from the user-global instruction file.
 *
 * The table competes with the configuration that now holds the same knowledge:
 * the Routing profile carries the Model roster and the three Standard routes,
 * the Routing policy is derived from it, and the Route decision names the model
 * and effort one dispatch applies. What the table never was is judgment — when
 * delegation pays for itself, the escalation rule, and one worktree per
 * parallel writing agent are decisions no roster can hold, so they stay.
 *
 * The file is the user's own, outside this repository and outside the consumer
 * manifest, and may carry unrelated instructions. Every step is therefore
 * fail-closed: an unplaceable bullet blocks the whole migration instead of
 * being guessed away, and so does a judgment surviving only inside a
 * data-bearing bullet; the removal is previewed as an exact diff, the original
 * copied to a named backup before a byte is written, the destination re-read
 * against the previewed fingerprint, and nothing written without acceptance.
 *
 * Runtime precedence does not wait for any of that. Where a Routing profile
 * decides model and effort, it decides them whether or not the old table is
 * still in the file — `resolveDoctrinePrecedence` reads the profile, never the
 * doctrine text — so deferring the migration forever still yields the profile's
 * answer. The table is only ever the fallback for a profile that cannot decide,
 * which is why applying the removal is refused while it still is one.
 *
 * Run: node scripts/doctrine-migration/index.mjs [--file <path>] [--apply --accept]
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { backupFile, lineDiff, writeAtomic } from '../../src/lib/atomicWrite.mjs';
import { readComposedRoutingProfile } from '../../src/lib/routingProfile.mjs';

/** The section that owns the doctrine, and the heading level that ends it. */
export const DOCTRINE_SECTION_PATTERN = /^##\s+Task-Routing\b/;
const SECTION_END_PATTERN = /^##\s/;

/** The one sentence that replaces the table, and the substring that proves it is there. */
export const PRECEDENCE_MARKER = 'decides model and effort';
export const PRECEDENCE_BULLET = '- Where a Routing profile exists, it decides model and effort;\n'
  + '  what stays here is the judgment that is not data.';

/**
 * The judgment that is not data. Each id must survive in a retained bullet or
 * the migration blocks: losing one of these is the failure this tool exists to
 * prevent, and "it was probably still somewhere" is not a check.
 */
export const RETAINED_JUDGMENTS = Object.freeze([
  { id: 'delegation-pays-for-itself', pattern: /delegat/i },
  { id: 'parallel-writes-need-a-worktree', pattern: /worktree/i },
  { id: 'escalation-after-repeated-failure', pattern: /eskalat|escalat/i },
]);

/**
 * What makes a bullet table content. A data marker outranks a judgment marker:
 * a bullet that names a model, an effort level or the table's own companion
 * file is routing data even when it also mentions delegation, and the judgment
 * coverage check is what proves nothing was lost by removing it.
 */
export const ROUTING_DATA_MARKERS = Object.freeze([
  { id: 'model-name', pattern: /\b(sonnet|opus|haiku|fable|gpt-[\w.-]+|claude-[\w[\].-]+)\b/i },
  { id: 'effort-level', pattern: /\beffort\b|\b(low|medium|high|xhigh)\b/i },
  { id: 'routing-table-pointer', pattern: /task-routing\.md/i },
]);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const stampOf = (now) => now.toISOString().replace(/[:.]/g, '-');

const blocked = (status, reasons) => Object.freeze({
  status, reasons: Object.freeze(reasons), retained: [], removed: [], migrated: null,
});

/** Where the doctrine section starts and ends, or `null` when the file has none. */
function sectionRange(lines) {
  const start = lines.findIndex((line) => DOCTRINE_SECTION_PATTERN.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1).findIndex((line) => SECTION_END_PATTERN.test(line));
  return { start, end: rest < 0 ? lines.length : start + 1 + rest };
}

/**
 * The section body as blocks: one per bullet, wrapped continuation lines kept
 * with the bullet they belong to, and any non-bullet prose as its own block so
 * it is classified rather than swept along.
 */
export function doctrineBlocks(bodyLines) {
  const blocks = [];
  let open = null;
  for (const line of bodyLines) {
    if (line.trim() === '') { open = null; continue; }
    const bullet = /^-\s/.test(line);
    if (bullet || open === null) {
      open = { kind: bullet ? 'bullet' : 'prose', lines: [] };
      blocks.push(open);
    }
    open.lines.push(line);
  }
  return blocks;
}

const matched = (text, markers) => markers.filter(({ pattern }) => pattern.test(text))
  .map(({ id }) => id);

/** Split the section's blocks into table data, retained judgment, and the unplaceable rest. */
export function classifyDoctrine(blocks) {
  const retained = [];
  const removed = [];
  const unclassified = [];
  for (const block of blocks) {
    const text = block.lines.join(' ');
    const markers = matched(text, ROUTING_DATA_MARKERS);
    const judgments = matched(text, RETAINED_JUDGMENTS);
    if (markers.length) removed.push({ ...block, markers });
    else if (judgments.length) retained.push({ ...block, judgments });
    else unclassified.push(block);
  }
  return { retained, removed, unclassified };
}

const rebuild = (lines, range, retained) => [
  ...lines.slice(0, range.start), lines[range.start], '', ...PRECEDENCE_BULLET.split('\n'),
  ...retained.flatMap((block) => block.lines), '', ...lines.slice(range.end),
].join('\n');

/**
 * The exact removal, decided from the file text alone. Returns the migrated
 * text only when every block was placed and every promised judgment survived.
 */
export function planDoctrineMigration(text) {
  const lines = text.split('\n');
  const range = sectionRange(lines);
  if (!range) return blocked('section-missing', ['no `## Task-Routing` section']);
  const body = lines.slice(range.start + 1, range.end);
  if (body.some((line) => line.includes(PRECEDENCE_MARKER))) {
    return Object.freeze({
      status: 'already-migrated', reasons: [], retained: [], removed: [], migrated: text,
    });
  }
  const { retained, removed, unclassified } = classifyDoctrine(doctrineBlocks(body));
  if (unclassified.length) {
    return blocked('blocked', unclassified.map((block) => `unclassified: ${block.lines[0]}`));
  }
  const kept = new Set(retained.flatMap((block) => block.judgments));
  const lost = RETAINED_JUDGMENTS.filter(({ id }) => !kept.has(id));
  if (lost.length) {
    return blocked('blocked', lost.map(({ id }) => `judgment-not-retained: ${id}`));
  }
  return Object.freeze({
    status: 'ready',
    reasons: [],
    retained: Object.freeze(retained),
    removed: Object.freeze(removed),
    migrated: rebuild(lines, range, retained),
  });
}

/**
 * Who decides model and effort right now. The doctrine text is deliberately not
 * read: precedence is a property of the configuration, so the answer cannot
 * depend on whether the old table has been removed yet. `tablePresent` only
 * records whether the removal still has anything to remove.
 */
export function resolveDoctrinePrecedence({ composed, tablePresent = false, reasons = [] }) {
  const routes = composed?.standardRoutes ?? {};
  const decides = Object.entries(routes)
    .filter(([, route]) => route?.state === 'configured')
    .map(([workload, route]) => Object.freeze({
      workload, model: route.model, effort: route.effort ?? null,
    }));
  return Object.freeze({
    source: decides.length ? 'routing-profile' : 'doctrine',
    decides: Object.freeze(decides),
    tablePresent: Boolean(tablePresent),
    supersededTable: Boolean(decides.length && tablePresent),
    reasons: Object.freeze([...reasons]),
  });
}

/** The same answer read from the real two-level Routing profile store. */
export async function readDoctrinePrecedence({ tablePresent = false, ...options } = {}) {
  try {
    const snapshot = await readComposedRoutingProfile({
      projectRoot: process.cwd(), ...options,
    });
    return resolveDoctrinePrecedence({
      composed: snapshot.composed, tablePresent, reasons: snapshot.reasons,
    });
  } catch (error) {
    return resolveDoctrinePrecedence({
      composed: null, tablePresent, reasons: [`profile-unreadable: ${error.message}`],
    });
  }
}

/**
 * Read the file, plan the removal, report it — the fingerprint the apply step
 * re-checks, the backup path it would write, the exact diff. Writes nothing.
 */
export async function previewDoctrineMigration({
  path, now = new Date(), resolvePrecedence = readDoctrinePrecedence,
}) {
  const text = await readFile(path, 'utf8');
  const plan = planDoctrineMigration(text);
  const stamp = stampOf(now);
  return Object.freeze({
    path,
    status: plan.status,
    reasons: plan.reasons,
    retained: plan.retained,
    removed: plan.removed,
    migrated: plan.migrated,
    fingerprint: sha256(text),
    stamp,
    backupPath: `${path}.${stamp}.bak`,
    diff: plan.migrated === null || plan.migrated === text ? '' : lineDiff(text, plan.migrated),
    precedence: await resolvePrecedence({ tablePresent: plan.removed.length > 0 }),
  });
}

const refused = (reason, preview) => Object.freeze({
  status: 'refused', reason, path: preview.path, backupPath: null,
});

/**
 * Write the previewed removal — and only that. Every gate below is a separate
 * reason a caller can report, because "it did not run" is not a diagnosis.
 */
export async function applyDoctrineMigration({ preview, accept = false }) {
  if (preview.status === 'already-migrated') {
    return Object.freeze({ status: 'already-migrated', path: preview.path, backupPath: null });
  }
  if (accept !== true) return refused('acceptance-required', preview);
  if (preview.status !== 'ready') return refused(`not-ready: ${preview.status}`, preview);
  if (preview.precedence?.source !== 'routing-profile') {
    return refused('doctrine-table-still-authoritative', preview);
  }
  const current = await readFile(preview.path, 'utf8');
  if (sha256(current) !== preview.fingerprint) return refused('destination-changed', preview);
  const backupPath = await backupFile(preview.path, preview.stamp);
  await writeAtomic(preview.path, preview.migrated);
  return Object.freeze({ status: 'applied', path: preview.path, backupPath });
}

function parseArgs(argv) {
  const args = { apply: false, accept: false, file: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--accept') args.accept = true;
    else if (argv[i] === '--file') args.file = argv[i += 1];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function render(preview, out) {
  const { precedence } = preview;
  out.log(`file:       ${preview.path}`);
  out.log(`status:     ${preview.status}`);
  for (const reason of preview.reasons) out.log(`  reason:   ${reason}`);
  out.log(`precedence: ${precedence.source}`
    + (precedence.supersededTable ? ' (the table below is already inert)' : ''));
  for (const { workload, model, effort } of precedence.decides) {
    out.log(`  ${workload}: ${model}${effort ? ` ${effort}` : ''}`);
  }
  for (const reason of precedence.reasons) out.log(`  profile:  ${reason}`);
  out.log(`backup:     ${preview.backupPath}`);
  out.log(preview.diff ? `\n${preview.diff}` : '\n(no change)');
}

export async function main(argv = process.argv.slice(2), out = console) {
  const args = parseArgs(argv);
  const path = args.file ?? join(homedir(), '.claude', 'CLAUDE.md');
  const preview = await previewDoctrineMigration({ path }).catch((error) => error);
  if (preview instanceof Error) {
    out.log(`file:       ${path}\nstatus:     unreadable: ${preview.code ?? preview.message}`);
    return 1;
  }
  render(preview, out);
  if (!args.apply) {
    out.log('\npreview only — re-run with --apply --accept to write it.');
    return preview.status === 'ready' || preview.status === 'already-migrated' ? 0 : 1;
  }
  const result = await applyDoctrineMigration({ preview, accept: args.accept });
  out.log(`\n${result.status}${result.reason ? `: ${result.reason}` : ''}`);
  if (result.backupPath) out.log(`backup written: ${result.backupPath}`);
  return result.status === 'refused' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
