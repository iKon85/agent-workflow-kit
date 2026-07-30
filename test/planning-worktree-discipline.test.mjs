/**
 * Planning-side lifecycle contract.
 *
 * Two facts have to be legible on every published planning surface, and both
 * are counted from the skill manifest rather than from a remembered file list:
 *
 *   1. `to-issues` does not end at publication. It reports an end state that
 *      classifies what the session leaves behind — durable content, scratch,
 *      nothing — names the next step, and degrades honestly in a project that
 *      has no worktree helper at all. It never deletes any of it.
 *   2. A worktree isolates a build, so it belongs to the implementing session.
 *      No grill may instruct a planning session to create one, and none may
 *      still describe the locked plan as something written to a worktree root.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(
  await readFile(join(REPO, '.claude', 'skills', 'skill-manifest.json'), 'utf8'),
).skills;

const TREE = { claude: '.claude', codex: '.agents' };
const GRILLS = ['grill-me', 'grill-with-docs', 'grill-me-codex', 'grill-with-docs-codex'];

/** Every published surface of one skill, derived from the manifest. */
function surfacesOf(name) {
  const entry = MANIFEST[name];
  assert.ok(entry, `${name} is missing from the skill manifest`);
  assert.ok(entry.surfaces?.length, `${name} declares no surface`);
  return entry.surfaces.map((surface) => ({
    label: `${surface}:${name}`,
    path: join(REPO, TREE[surface], 'skills', name, 'SKILL.md'),
  }));
}

const flat = (text) => text.replace(/\s+/g, ' ');

/** One Markdown section, up to the next heading of the same or a higher level. */
function section(body, heading) {
  const start = body.indexOf(heading);
  assert.notEqual(start, -1, `section not found: ${heading}`);
  const level = heading.match(/^#+/)[0].length;
  const rest = body.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

test('to-issues reports an end state covering every artifact class, on every surface', async () => {
  const surfaces = surfacesOf('to-issues');
  assert.equal(surfaces.length, 2, 'to-issues is a dual-surface skill');

  for (const { label, path } of surfaces) {
    const body = await readFile(path, 'utf8');
    const endState = flat(section(body, '### 8. End state'));

    for (const phrase of [
      '**Durable content**',   // the class that must reach a commit
      '**Scratch**',           // ignored by the repository, deletable, never deleted here
      '**Nothing**',           // the empty case is still reported
      'no worktree helper',    // a consumer whose project has none
      '`$make-landable`',      // the named next step, never invoked from here
      'never deletes',         // to-issues classifies, it does not clean up
    ]) {
      assert.ok(endState.includes(phrase), `${label}: end state must name ${phrase}`);
    }
  }
});

test('no grill binds worktree creation to planning, on any surface', async () => {
  const surfaces = GRILLS.flatMap(surfacesOf);
  assert.equal(
    surfaces.length,
    GRILLS.reduce((count, name) => count + MANIFEST[name].surfaces.length, 0),
    'the grill surface denominator comes from the manifest',
  );

  for (const { label, path } of surfaces) {
    const body = flat(await readFile(path, 'utf8'));

    assert.ok(
      body.includes('Planning creates no worktree'),
      `${label}: must state that planning creates no worktree`,
    );
    assert.ok(
      body.includes('implementing session'),
      `${label}: must hand worktree creation to the implementing session`,
    );
    assert.ok(
      body.includes('`$make-landable`'),
      `${label}: must route durable planning output to the landing skill`,
    );
    assert.doesNotMatch(
      body,
      /create the (issue )?worktree \**BEFORE/i,
      `${label}: must not order a worktree before the plan is written`,
    );
    assert.doesNotMatch(
      body,
      /to the worktree root/i,
      `${label}: the locked plan is no longer written to a worktree root`,
    );
  }
});

test('the maintainer worktree rule binds a worktree to implementation', async () => {
  const body = await readFile(join(REPO, 'CLAUDE.md'), 'utf8');
  const rules = flat(section(body, '### Git'));

  assert.ok(
    rules.includes('**Worktree binds to implementation.**'),
    'CLAUDE.md must carry the implementation-bound worktree rule',
  );
  assert.ok(
    !rules.includes('Plan/grill sessions create the worktree'),
    'the planning-session worktree rule must be gone, not merely supplemented',
  );
});
