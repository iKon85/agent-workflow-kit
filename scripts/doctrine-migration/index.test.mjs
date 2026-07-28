import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyDoctrineMigration,
  classifyDoctrine,
  doctrineBlocks,
  planDoctrineMigration,
  previewDoctrineMigration,
  resolveDoctrinePrecedence,
  RETAINED_JUDGMENTS,
} from './index.mjs';

/**
 * The fixture is the user-global doctrine section verbatim, because the
 * migration's whole risk is that it mangles prose it did not understand. A
 * paraphrase would test a file that does not exist.
 */
const PREAMBLE = `# Global CLAUDE.md

## Arbeitsweise

- Ein Task pro Chat.

`;

const SECTION = `## Task-Routing (Subagent-Dispatch) — v2, 2026-07-05, ADR-0055

- Hauptsession-Modell und Effort wählt Niko.
- Mechanisch verifizierbar → Sonnet oder gpt-5.6-luna low/medium;
  alltägliche Tool-Arbeit → gpt-5.6-terra medium; subtile Logik,
  Architektur und Verdicts → Opus oder gpt-5.6-sol high/xhigh; Fable bleibt
  Hauptsession-only. Konkrete Auswahl bleibt intelligence > taste > cost.
- Verdicts nie unter high. User-facing Arbeit braucht das geschmacksstärkste
  verfügbare Modell.
- Delegation nur, wenn sie mehr Hauptthread-Kontext spart als Transfer,
  Doppel-Read und Re-Verify kosten. Paralleles schreibendes Work braucht je
  einen Worktree.
- Eskalation erst nach zweimaligem Scheitern am selben Problem oder
  strukturell falschem Ansatz; jede Eskalation im Report nennen.
- Vor nichttrivialem Dispatch, Codex-CLI-Aufruf oder Eskalation
  \`~/.claude/task-routing.md\` lesen.
`;

const DOCTRINE = PREAMBLE + SECTION;

const COMPOSED = {
  standardRoutes: {
    mechanical: { model: 'claude-sonnet-4-5', effort: null, state: 'configured' },
    development: { model: 'gpt-5.6-terra', effort: 'medium', state: 'configured' },
    judgment: { model: 'claude-opus-5', effort: 'high', state: 'configured' },
  },
};

const decides = (tablePresent) => resolveDoctrinePrecedence({ composed: COMPOSED, tablePresent });

const STAMP = new Date('2026-07-28T09:00:00.000Z');

async function fixtureFile(body = DOCTRINE) {
  const dir = await mkdtemp(join(tmpdir(), 'doctrine-migration-'));
  const path = join(dir, 'CLAUDE.md');
  await writeFile(path, body, 'utf8');
  return { dir, path };
}

const preview = (path, precedence = decides(true)) => previewDoctrineMigration({
  path, now: STAMP, resolvePrecedence: async () => precedence,
});

test('the section splits into bullets, continuation lines kept with their bullet', () => {
  const body = SECTION.split('\n').slice(1);
  const blocks = doctrineBlocks(body);
  assert.equal(blocks.length, 6);
  assert.equal(blocks[1].lines.length, 4, 'the model table bullet wraps over four lines');
  assert.ok(blocks.every((block) => block.kind === 'bullet'));
});

test('only the model-and-effort data is removed; the judgment that is not data stays', () => {
  const plan = planDoctrineMigration(DOCTRINE);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.removed.map((block) => block.lines[0]), [
    '- Hauptsession-Modell und Effort wählt Niko.',
    '- Mechanisch verifizierbar → Sonnet oder gpt-5.6-luna low/medium;',
    '- Verdicts nie unter high. User-facing Arbeit braucht das geschmacksstärkste',
    '- Vor nichttrivialem Dispatch, Codex-CLI-Aufruf oder Eskalation',
  ]);
  assert.deepEqual(plan.retained.map((block) => block.lines[0]), [
    '- Delegation nur, wenn sie mehr Hauptthread-Kontext spart als Transfer,',
    '- Eskalation erst nach zweimaligem Scheitern am selben Problem oder',
  ]);
  assert.deepEqual(
    [...new Set(plan.retained.flatMap((block) => block.judgments))].sort(),
    RETAINED_JUDGMENTS.map(({ id }) => id).sort(),
    'every judgment the migration promises to keep survives in a retained bullet',
  );
});

test('the migrated section keeps the heading, adds one precedence sentence, drops nothing else', () => {
  const { migrated } = planDoctrineMigration(DOCTRINE);
  assert.ok(migrated.startsWith(PREAMBLE), 'text outside the section is untouched');
  assert.ok(migrated.includes('## Task-Routing (Subagent-Dispatch) — v2, 2026-07-05, ADR-0055'));
  assert.equal(migrated.match(/Routing profile/g).length, 1, 'exactly one precedence sentence');
  assert.match(migrated, /Routing profile[^]*decides model and effort/);
  assert.ok(migrated.includes('einen Worktree.') && migrated.includes('jede Eskalation im Report'));
  assert.ok(!migrated.includes('gpt-5.6-luna') && !migrated.includes('task-routing.md'));
  assert.ok(migrated.endsWith('\n'), 'the trailing newline survives');
});

test('re-planning the migrated text is a no-op, so a second run cannot double-write', () => {
  const once = planDoctrineMigration(DOCTRINE);
  const twice = planDoctrineMigration(once.migrated);
  assert.equal(twice.status, 'already-migrated');
  assert.equal(twice.migrated, once.migrated);
});

test('a bullet that is neither judgment nor routing data blocks the migration', () => {
  const withStranger = DOCTRINE.replace(
    '- Eskalation erst',
    '- Rechnungen liegen im Ordner Buchhaltung.\n- Eskalation erst',
  );
  const plan = planDoctrineMigration(withStranger);
  assert.equal(plan.status, 'blocked');
  assert.deepEqual(plan.reasons, [
    'unclassified: - Rechnungen liegen im Ordner Buchhaltung.',
  ]);
  assert.equal(plan.migrated, null, 'a blocked plan offers no text to write');
});

test('a judgment carried only by a data bullet blocks rather than being lost', () => {
  const withoutWorktreeJudgment = DOCTRINE.replace(
    '- Delegation nur, wenn sie mehr Hauptthread-Kontext spart als Transfer,\n'
    + '  Doppel-Read und Re-Verify kosten. Paralleles schreibendes Work braucht je\n'
    + '  einen Worktree.\n',
    '- Delegation lohnt nur mit Opus high, und Worktree je paralleler Agent.\n',
  );
  const plan = planDoctrineMigration(withoutWorktreeJudgment);
  assert.equal(plan.status, 'blocked');
  assert.deepEqual(plan.reasons, [
    'judgment-not-retained: delegation-pays-for-itself',
    'judgment-not-retained: parallel-writes-need-a-worktree',
  ]);
});

test('a file without the doctrine section is reported, never rewritten', () => {
  const plan = planDoctrineMigration('# Global\n\n## Sicherheit\n\n- Secrets nie in Git.\n');
  assert.equal(plan.status, 'section-missing');
  assert.equal(plan.migrated, null);
});

test('classifyDoctrine treats a bullet mixing judgment with routing data as data', () => {
  const { retained, removed, unclassified } = classifyDoctrine(
    doctrineBlocks(['- Eskalation an Opus high.']),
  );
  assert.deepEqual(retained, []);
  assert.deepEqual(unclassified, []);
  assert.deepEqual(removed[0].markers, ['model-name', 'effort-level']);
});

test('the preview names the backup path and the exact removal, and writes nothing', async () => {
  const { dir, path } = await fixtureFile();
  const result = await preview(path);
  assert.equal(result.status, 'ready');
  assert.equal(result.backupPath, `${path}.2026-07-28T09-00-00-000Z.bak`);
  assert.ok(result.diff.includes('-- Mechanisch verifizierbar → Sonnet oder gpt-5.6-luna low/medium;'));
  assert.ok(result.diff.includes('+- Where a Routing profile exists'));
  assert.ok(!result.diff.includes('-- Eskalation erst nach zweimaligem'));
  assert.deepEqual(await readdir(dir), ['CLAUDE.md'], 'preview creates no file');
  assert.equal(await readFile(path, 'utf8'), DOCTRINE, 'preview changes no byte');
});

test('applying without an explicit acceptance is refused', async () => {
  const { path } = await fixtureFile();
  const result = await applyDoctrineMigration({ preview: await preview(path) });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'acceptance-required');
  assert.equal(await readFile(path, 'utf8'), DOCTRINE);
});

test('applying is refused while the doctrine table is still the only decider', async () => {
  const { path } = await fixtureFile();
  const noProfile = resolveDoctrinePrecedence({ composed: null, tablePresent: true });
  const result = await applyDoctrineMigration({
    preview: await preview(path, noProfile), accept: true,
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'doctrine-table-still-authoritative');
  assert.equal(await readFile(path, 'utf8'), DOCTRINE);
});

test('a destination that moved after the preview is refused, not overwritten', async () => {
  const { path } = await fixtureFile();
  const previewed = await preview(path);
  await writeFile(path, `${DOCTRINE}\n- spät ergänzt.\n`, 'utf8');
  const result = await applyDoctrineMigration({ preview: previewed, accept: true });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'destination-changed');
  assert.equal(await readFile(path, 'utf8'), `${DOCTRINE}\n- spät ergänzt.\n`);
});

test('an accepted migration backs the original up before it writes, and is idempotent', async () => {
  const { path } = await fixtureFile();
  const previewed = await preview(path);
  const result = await applyDoctrineMigration({ preview: previewed, accept: true });
  assert.equal(result.status, 'applied');
  assert.equal(await readFile(result.backupPath, 'utf8'), DOCTRINE);
  assert.equal(await readFile(path, 'utf8'), previewed.migrated);

  const again = await applyDoctrineMigration({ preview: await preview(path), accept: true });
  assert.equal(again.status, 'already-migrated');
  assert.equal(await readFile(path, 'utf8'), previewed.migrated);
});

test('runtime precedence is the Routing profile whether or not the old table is present', () => {
  const withTable = decides(true);
  const withoutTable = decides(false);
  assert.equal(withTable.source, 'routing-profile');
  assert.equal(withoutTable.source, 'routing-profile');
  assert.deepEqual(withTable.decides, withoutTable.decides);
  assert.deepEqual(withTable.decides, [
    { workload: 'mechanical', model: 'claude-sonnet-4-5', effort: null },
    { workload: 'development', model: 'gpt-5.6-terra', effort: 'medium' },
    { workload: 'judgment', model: 'claude-opus-5', effort: 'high' },
  ]);
  assert.equal(withTable.supersededTable, true, 'the still-present table is inert');
  assert.equal(withoutTable.supersededTable, false);
});

test('without a decidable Routing profile the doctrine table stays the fallback', () => {
  assert.equal(resolveDoctrinePrecedence({ composed: null, tablePresent: true }).source, 'doctrine');
  const unresolved = {
    standardRoutes: {
      mechanical: { model: null, effort: null, state: 'unresolved' },
      development: { model: null, effort: null, state: 'unresolved' },
      judgment: { model: null, effort: null, state: 'unresolved' },
    },
  };
  const precedence = resolveDoctrinePrecedence({ composed: unresolved, tablePresent: true });
  assert.equal(precedence.source, 'doctrine');
  assert.deepEqual(precedence.decides, []);
});
