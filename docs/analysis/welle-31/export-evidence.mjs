#!/usr/bin/env node
/**
 * Welle 31 · Slice 0 — standing-evidence exporter (#404, mandate #380 "Standing
 * evidence").
 *
 * Live issue and pull-request bodies mutate independently of any commit, so a
 * census that cites them cites a moving target. This exporter freezes them:
 * every referenced item and every aggregate is fetched through one declared,
 * re-runnable command, and the command's verbatim stdout is committed together
 * with its sha256.
 *
 * Visibility rule. This repository is public; the consumer repository whose
 * items #380 cites is private. Exporting a private body here would publish it.
 * Private items are therefore exported as a PROVENANCE RECORD — immutable URL,
 * fetch timestamp, byte length and sha256 of the raw response — and never as a
 * body. The digest still freezes the text: a reader with access re-runs the
 * same command and compares. The deviation is named in the export itself, not
 * silently applied.
 *
 * Usage: node docs/analysis/welle-31/export-evidence.mjs [--out <dir>]
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const OWN_REPO = 'iKon85/agent-workflow-kit';
const CONSUMER_REPO = 'iKon85/Testreporter';

/** Issue bodies the wave's mandates cite. `public` decides body vs. digest. */
export const REFERENCED_ITEMS = [
  { repo: OWN_REPO, number: 205, public: true, why: 'red release run vs. successful publish (#380 promotion input)' },
  { repo: OWN_REPO, number: 243, public: true, why: 'awaiting-tag stacking (#380 promotion input)' },
  { repo: OWN_REPO, number: 257, public: true, why: 'tagging authority / gates-not-prompt (#380 promotion input)' },
  { repo: OWN_REPO, number: 320, public: true, why: 'session-end lifecycle, the confirmed cost instance (#343)' },
  { repo: OWN_REPO, number: 322, public: true, why: 'internal engine not invocable (#343 evidence)' },
  { repo: OWN_REPO, number: 341, public: true, why: 'close-verify closed a Program-PRD (#343 evidence)' },
  { repo: OWN_REPO, number: 343, public: true, why: 'cost-walk mandate (Slice 2)' },
  { repo: OWN_REPO, number: 380, public: true, why: 'truth-census mandate (Slice 1)' },
  { repo: OWN_REPO, number: 403, public: true, why: 'wave anchor' },
  { repo: OWN_REPO, number: 404, public: true, why: 'this slice' },
  { repo: OWN_REPO, number: 405, public: true, why: 'evaluation slice (Slice 3)' },
  { repo: CONSUMER_REPO, number: 2305, public: false, why: 'symlink identity freeze routed around teardown safeguard (#380)' },
  { repo: CONSUMER_REPO, number: 2312, public: false, why: 'impact-census guard cannot see a coordinator branch (#380)' },
  { repo: CONSUMER_REPO, number: 2283, public: false, why: 'readiness.mjs exact heading match reports missing (#380)' },
];

const ISSUE_FIELDS = 'number,title,state,url,createdAt,updatedAt,body,labels';

/**
 * Aggregates are declared as PROJECTION queries, so the committed stdout is the
 * raw response rather than a summary of one. Each row is one observation; the
 * counts below are computed from exactly these rows and from nothing else.
 */
export const AGGREGATE_QUERIES = [
  {
    id: 'merged-pr-retro-marker',
    why: '#380 "Retro yield" — the enforced closed-set `**Retro:**` line against '
      + 'PR bodies that actually carry a findings section.',
    argv: ['pr', 'list', '--repo', OWN_REPO, '--state', 'merged', '--limit', '500',
      '--json', 'number,mergedAt,body',
      '--jq', '.[] | {number, mergedAt, '
        + 'retro: (if (.body // "") | test("\\\\*\\\\*Retro:\\\\*\\\\* *ran") then "ran" '
        + 'elif (.body // "") | test("\\\\*\\\\*Retro:\\\\*\\\\* *skipped") then "skipped" '
        + 'elif (.body // "") | test("\\\\*\\\\*Retro:\\\\*\\\\*") then "other" else "absent" end), '
        // Two predicates, not one verdict: `metaSection` is the carrier CLAUDE.md
        // actually documents, `findingsHeading` a deliberately wider net. Which
        // one the retro-yield ratio should use is a census question, not an
        // export question — so the substrate freezes both and adjudicates neither.
        + 'metaSection: ((.body // "") | test("(?i)(^|\\n)#+ *Meta")), '
        + 'findingsHeading: ((.body // "") | test("(?i)(^|\\n)#+ *(Meta|Retro|Findings)"))} | tostring'],
  },
  {
    id: 'process-issue-population',
    why: '#343 "issue history is the dataset" — the open+closed issue population '
      + 'the journey derivation reads as the empirical record of journeys taken.',
    argv: ['issue', 'list', '--repo', OWN_REPO, '--state', 'all', '--limit', '1000',
      '--json', 'number,state,createdAt,closedAt,labels',
      '--jq', '.[] | {number, state, createdAt, closedAt, '
        + 'labels: [.labels[].name]} | tostring'],
  },
  {
    id: 'recovery-record-sources',
    why: '#380 §5 "Recovery journeys bounded to named record sources" — the '
      + 'searched population for recovery journeys; anything outside it is '
      + '`unknown-recovery`.',
    argv: ['issue', 'list', '--repo', OWN_REPO, '--state', 'all', '--limit', '1000',
      '--search', 'recover OR recovery OR rollback OR "wrong branch" OR interrupted OR STOP in:title',
      '--json', 'number,title,state',
      '--jq', '.[] | {number, state, title} | tostring'],
  },
];

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function gh(argv) {
  const { stdout } = await run('gh', argv, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** One frozen item: the command, when it ran, and the digest of what came back. */
function freeze({ argv, stdout, extra = {} }) {
  return {
    command: ['gh', ...argv],
    fetchedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(stdout, 'utf8'),
    sha256: sha256(stdout),
    ...extra,
  };
}

export async function exportIssueBodies(items = REFERENCED_ITEMS) {
  const exports = [];
  for (const item of items) {
    const argv = ['issue', 'view', String(item.number), '--repo', item.repo,
      '--json', ISSUE_FIELDS];
    const stdout = await gh(argv);
    const frozen = freeze({
      argv,
      stdout,
      extra: {
        repo: item.repo,
        number: item.number,
        url: `https://github.com/${item.repo}/issues/${item.number}`,
        why: item.why,
        disclosure: item.public ? 'body' : 'digest-only',
      },
    });
    // The digest is over the untouched response either way, so a private item's
    // freeze is verifiable by anyone who can re-run the command.
    if (item.public) frozen.response = JSON.parse(stdout);
    else frozen.withheldReason = 'private consumer repository; body withheld from this public repo';
    exports.push(frozen);
  }
  return exports;
}

export async function exportAggregates(queries = AGGREGATE_QUERIES) {
  const exports = [];
  for (const query of queries) {
    const stdout = await gh(query.argv);
    const rows = stdout.split('\n').filter(Boolean);
    exports.push(freeze({
      argv: query.argv,
      stdout,
      extra: { id: query.id, why: query.why, rowCount: rows.length, rows },
    }));
  }
  return exports;
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex === -1
    ? join(REPO_ROOT, 'docs/evidence/welle-31')
    : resolve(process.argv[outIndex + 1]);
  await mkdir(outDir, { recursive: true });

  const sourceCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim();
  const issues = await exportIssueBodies();
  const aggregates = await exportAggregates();

  const write = async (name, payload) => {
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    await writeFile(join(outDir, name), body);
    return { file: name, sha256: sha256(body) };
  };

  const written = [
    await write('issue-bodies.json', { sourceCommit, schema: 'welle-31/evidence/issues/v1', exports: issues }),
    await write('aggregate-queries.json', { sourceCommit, schema: 'welle-31/evidence/aggregates/v1', exports: aggregates }),
  ];

  for (const { file, sha256: digest } of written) console.log(`${digest}  ${file}`);
  const withheld = issues.filter((item) => item.disclosure === 'digest-only').length;
  console.log(`exported ${issues.length} referenced items (${withheld} digest-only), `
    + `${aggregates.length} aggregate queries; source commit ${sourceCommit}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
