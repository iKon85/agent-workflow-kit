/**
 * Fail-closed audit of what `npm publish` actually ships.
 *
 * `scrub()` runs only while build-kit materializes `dist-kit/`, and `dist-kit/`
 * is never packed — `npm pack` takes the SOURCE tree per `package.json:"files"`.
 * So the published population and the scrubbed population are two different
 * sets, and only the smaller one was ever gated. This audit closes that gap
 * from the other side: it packs for real, extracts the tarball, and asserts
 * that every published body is already a `scrub()` no-op — i.e. that publishing
 * the source is indistinguishable from publishing the scrubbed build.
 *
 * The install manifest stays the load-bearing subset: `init` copies files out
 * of the packed tree, so an exclusion that drops a manifest entry breaks
 * installation for every consumer. That containment is asserted here rather
 * than remembered.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub } from './lib/scrub.mjs';
import { isPublishExcluded } from '../src/lib/bundle.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Published bodies that deliberately survive `scrub()` unchanged. Each entry
 * names what scrubbing it would break — an exemption without a live reason is
 * rejected below, so this table cannot quietly grow into a blanket permission.
 */
const SCRUB_EXEMPT = new Map([
  ['LICENSE', 'credit file: scrubbing would erase the copyright holder'],
  ['README.md', 'documents the real `npx github:iKon85/agent-workflow-kit` install '
    + 'command; a scrubbed README would tell consumers to install from `<owner>`'],
  ['PROVENANCE.md', 'attribution: scrubbing would erase the maintainer and the '
    + 'vendored upstream authors it exists to credit'],
  ['package.json', 'npm metadata: `repository.url` must resolve to this package\'s '
    + 'real upstream repository'],
  ['src/cli.mjs', '`GH_REPO` is the kit\'s own upstream repo, read at runtime by the '
    + '`gh` calls; its `../scripts/` imports are code, not doc cross-references'],
  ['src/commands/update.mjs', 'relative `../../scripts/` ESM import: scrub rule (c) '
    + 'rewrites doc cross-references and would leave an unresolvable bare specifier'],
  ['src/lib/updateCandidate.mjs', 'relative `../../scripts/` ESM import: same as '
    + '`src/commands/update.mjs`'],
]);

/**
 * The project-private identity tokens scrub rule (a) replaces. Kept in sync with
 * `privateTokens()` in `scripts/lib/scrub.mjs`; the no-op audit above is the
 * wider net, this one states the leak class in its own terms so a regression
 * reads as "a private token shipped", not "a body changed".
 */
const PRIVATE_TOKEN = /(?:[a-z0-9-]+\.)*iverra\.de|\bCoolify\b|\biKon85\b|\bTestreporter\b|\btestreporter\b|\bNikos?\b/g;

/** The kit's own upstream repo slug — a published fact, not a leaked one. */
const OWN_REPO_SLUG = 'iKon85/agent-workflow-kit';

/**
 * Files allowed to carry a private token. The three root files ship unscrubbed
 * on purpose; the other two may carry the kit's own repo slug and nothing else.
 */
const TOKEN_EXEMPT = new Set(['LICENSE', 'README.md', 'PROVENANCE.md']);
const OWN_SLUG_ONLY = new Set(['package.json', 'src/cli.mjs']);

const destination = await mkdtemp(join(tmpdir(), 'awkit-publish-scope-'));
after(() => rm(destination, { recursive: true, force: true }));

const [packed] = JSON.parse(execFileSync('npm', [
  'pack', '--pack-destination', destination, '--json',
], { cwd: REPO, encoding: 'utf8' }));
execFileSync('tar', ['-xzf', join(destination, packed.filename), '-C', destination]);

const TARBALL_ROOT = join(destination, 'package');
const TARBALL = packed.files.map(({ path }) => path).sort();

const readPacked = (path) => readFile(join(TARBALL_ROOT, path));
/** build-kit's own binary heuristic, so both gates classify a body identically. */
const isBinary = (buf) => buf.includes(0);

/** Text bodies as extracted from the real tarball, read once and reused. */
let bodyCache;
async function packedTextBodies() {
  bodyCache ??= (async () => {
    const bodies = new Map();
    for (const path of TARBALL) {
      const raw = await readPacked(path);
      if (!isBinary(raw)) bodies.set(path, raw.toString('utf8'));
    }
    return bodies;
  })();
  return bodyCache;
}

test('every install-manifest file survives into the npm tarball', async () => {
  const manifest = JSON.parse(await readPacked('agent-workflow-kit.package.json'));
  const missing = [];
  for (const { path } of manifest.files) {
    // init copies out of the extracted tree, so presence on disk is the claim —
    // not merely membership in the pack index.
    if (!await access(join(TARBALL_ROOT, path)).then(() => true, () => false)) missing.push(path);
  }
  const total = manifest.files.length;
  assert.deepEqual(
    missing, [],
    `tarball carries ${total - missing.length} of ${total} install-manifest files; `
    + `init would fail on: ${missing.join(', ')}`,
  );
  assert.equal(total - missing.length, total);
});

test('the publish-excluded predicate never claims a file that is actually published', () => {
  const claimed = TARBALL.filter(isPublishExcluded);
  assert.deepEqual(
    claimed, [],
    'the release guard downgrades removals of publish-excluded paths to a minor '
    + 'change; a path it claims while `package.json:"files"` still publishes it '
    + `would hide a breaking removal: ${claimed.join(', ')}`,
  );
});

test('every published body is a scrub() no-op outside the named exemptions', async () => {
  const bodies = await packedTextBodies();
  const unscrubbed = [...bodies]
    .filter(([path, body]) => !SCRUB_EXEMPT.has(path) && scrub(body) !== body)
    .map(([path]) => path);
  assert.deepEqual(
    unscrubbed, [],
    'npm pack ships the SOURCE tree, so these files publish content the scrub was '
    + `written to remove: ${unscrubbed.join(', ')}`,
  );
});

test('no scrub exemption outlives the reason it was granted', async () => {
  const bodies = await packedTextBodies();
  const stale = [...SCRUB_EXEMPT.keys()].filter((path) => {
    const body = bodies.get(path);
    return body === undefined || scrub(body) === body;
  });
  assert.deepEqual(
    stale, [],
    'these files are exempt from the scrub audit but no longer need to be — drop '
    + `the exemption rather than leaving it as blanket permission: ${stale.join(', ')}`,
  );
});

test('no published file carries a project-private token', async () => {
  const bodies = await packedTextBodies();
  const leaks = [];
  for (const [path, body] of bodies) {
    if (TOKEN_EXEMPT.has(path)) continue;
    const searched = OWN_SLUG_ONLY.has(path) ? body.split(OWN_REPO_SLUG).join('') : body;
    for (const [token] of searched.matchAll(PRIVATE_TOKEN)) leaks.push(`${path}: ${token}`);
  }
  assert.deepEqual(leaks, [], `private tokens in the published tree: ${leaks.join(', ')}`);
});

test('the own-repo-slug allowance stays bounded to the runtime facts that need it', async () => {
  const cli = await readPacked('src/cli.mjs').then((raw) => raw.toString('utf8'));
  assert.match(cli, new RegExp(`GH_REPO: '${OWN_REPO_SLUG}'`));
  const pkg = JSON.parse(await readPacked('package.json'));
  assert.equal(pkg.repository.url, `git+https://github.com/${OWN_REPO_SLUG}.git`);
  for (const path of OWN_SLUG_ONLY) {
    const body = (await readPacked(path)).toString('utf8');
    assert.ok(body.includes(OWN_REPO_SLUG), `${path} no longer carries the own repo slug`);
  }
});
