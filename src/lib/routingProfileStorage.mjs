/**
 * The two-level Routing profile store: one immutable generation per document,
 * global and project independent. The generation id lives in the storage
 * envelope *around* a document, never in the Routing profile schema — a profile
 * carries no revision. Composition takes the latest committed global generation
 * plus this project's own narrowing, so a global choice made after a narrowing
 * is never invisible to that project; the generation a narrowing was authored
 * against travels with it for diagnostics, never as the read key.
 *
 * A transaction descriptor is written only when one interview changes both
 * documents, and exists solely so recovery can discard a half-written pair: a
 * generation the descriptor names is not committed, reads skip it, recovery
 * deletes it — leaving the last committed pair.
 *
 * The project key is a deliberately opaque identity: a UUID in a marker
 * file inside the git common directory, so every worktree of one repository
 * narrows once and the marker stays outside `git status` and outside the
 * consumer's project layer. A fresh clone is a project without a narrowing yet.
 * Without git the canonical project-root path keys it at lower confidence,
 * because a path does not survive a move.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { writeAtomic } from './atomicWrite.mjs';

export const ROUTING_PROFILE_ENVELOPE_VERSION = 1;

/** User-local routing evidence: owner-only, like every other routing document. */
const STORE_MODE = 0o600;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 10;
const GENERATION_FILE = /^generation-(\d+)\.json$/;
const PENDING_FILE = 'pending-transaction.json';
const MARKER_SEGMENTS = ['agent-workflow-kit', 'project-id'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((done) => { setTimeout(done, ms); });
const exists = (path) => access(path).then(() => true, () => false);
/** Missing is a state, not a failure; anything else stays an error. */
const readTextOrNull = (file) => readFile(file, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

/** Git is evidence, not a dependency: an unavailable git yields no common dir. */
const defaultRunGit = (args, cwd) => execFileAsync('git', args, { cwd, encoding: 'utf8' })
  .then(({ stdout }) => stdout, () => null);

/** Where one generation of one document lives. Immutable once written. */
export function routingProfileGenerationPath({ root, scope, projectKey = null, generation }) {
  if (scope !== 'global' && !projectKey) throw new TypeError('a project generation needs a key');
  const dir = scope === 'global' ? join(root, 'global') : join(root, 'projects', projectKey);
  return join(dir, `generation-${generation}.json`);
}

const writeJson = (file, value) =>
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, STORE_MODE);

async function readJson(file, label) {
  const raw = await readTextOrNull(file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON: ${file}`);
  }
}

function validateEnvelope(value, { scope, generation, file }) {
  const object = (candidate) => Boolean(candidate) && typeof candidate === 'object'
    && !Array.isArray(candidate);
  if (!object(value) || value.envelopeVersion !== ROUTING_PROFILE_ENVELOPE_VERSION
    || value.scope !== scope || value.generation !== generation) {
    throw new Error(`routing profile envelope does not match its generation file: ${file}`);
  }
  if (!object(value.document)) {
    throw new Error(`routing profile envelope carries no document: ${file}`);
  }
  return Object.freeze({ ...value, file });
}

async function listGenerations(root, scope, projectKey) {
  const dir = dirname(routingProfileGenerationPath({ root, scope, projectKey, generation: 0 }));
  const names = await readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return names.map((name) => GENERATION_FILE.exec(name)).filter(Boolean)
    .map((match) => Number(match[1])).sort((a, b) => a - b);
}

/** Generations a pending descriptor names are not committed. */
function pendingGenerations(pending, scope, projectKey) {
  const entries = Array.isArray(pending?.entries) ? pending.entries : [];
  return new Set(entries
    .filter((entry) => entry.scope === scope
      && (scope === 'global' || entry.projectKey === projectKey))
    .map((entry) => entry.generation));
}

async function readLatestCommitted(root, scope, projectKey, pending) {
  const uncommitted = pendingGenerations(pending, scope, projectKey);
  const generation = (await listGenerations(root, scope, projectKey))
    .filter((candidate) => !uncommitted.has(candidate)).at(-1);
  if (generation === undefined) return null;
  const file = routingProfileGenerationPath({ root, scope, projectKey, generation });
  const document = await readJson(file, 'routing profile envelope');
  return validateEnvelope(document, { scope, generation, file });
}

/**
 * The committed pair: the latest committed global generation plus this project's
 * own narrowing. No project document is a normal, safe state — a fresh clone
 * simply falls back to the global authorization.
 */
export async function readCommittedRoutingProfilePair({ root, projectKey = null }) {
  const pending = await readJson(join(root, PENDING_FILE), 'routing profile transaction');
  return Object.freeze({
    global: await readLatestCommitted(root, 'global', null, pending),
    project: projectKey ? await readLatestCommitted(root, 'project', projectKey, pending) : null,
    pendingTransactionId: pending?.id ?? null,
  });
}

async function withStorageLock(root, lockTimeoutMs, run) {
  await mkdir(root, { recursive: true });
  const lock = join(root, '.lock');
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try { await mkdir(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`routing profile store is locked: ${lock}`);
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await run();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function discardPendingTransaction(root) {
  const pending = await readJson(join(root, PENDING_FILE), 'routing profile transaction');
  if (!pending) return Object.freeze({ transactionId: null, discarded: [] });
  const discarded = [];
  for (const entry of pending.entries ?? []) {
    const file = routingProfileGenerationPath({
      root, scope: entry.scope, projectKey: entry.projectKey ?? null, generation: entry.generation,
    });
    if (await exists(file)) {
      await rm(file, { recursive: true, force: true });
      discarded.push(file);
    }
  }
  await rm(join(root, PENDING_FILE), { force: true });
  return Object.freeze({ transactionId: pending.id ?? null, discarded });
}

/** Discard a half-written pair: the store reads back as the last committed pair. */
export async function recoverRoutingProfileStorage({ root, lockTimeoutMs = LOCK_TIMEOUT_MS }) {
  return withStorageLock(root, lockTimeoutMs, () => discardPendingTransaction(root));
}

/**
 * Never rewrite a generation: the counter only moves forward, and a caller that
 * states the generation it read is rejected once the store moved on.
 */
function nextGeneration(current, document, expected) {
  const committed = current?.generation ?? null;
  if (expected !== undefined && expected !== committed) {
    throw new Error(`stale routing profile generation: expected ${expected ?? 'none'}, `
      + `found ${committed ?? 'none'}`);
  }
  return document ? (committed ?? 0) + 1 : null;
}

const writeGeneration = (root, envelope) => writeJson(routingProfileGenerationPath({
  root, scope: envelope.scope, projectKey: envelope.projectKey ?? null,
  generation: envelope.generation,
}), envelope);

async function commitUnderLock({
  root, identity, globalDocument, projectDocument,
  expectedGlobalGeneration, expectedProjectGeneration, now,
}) {
  const projectKey = identity?.key ?? null;
  await discardPendingTransaction(root);
  const current = await readCommittedRoutingProfilePair({ root, projectKey });
  const global = nextGeneration(current.global, globalDocument, expectedGlobalGeneration);
  const project = nextGeneration(current.project, projectDocument, expectedProjectGeneration);
  const committedAt = now();
  const paired = Boolean(globalDocument && projectDocument);
  const transactionId = paired ? randomUUID() : null;
  if (paired) {
    await writeJson(join(root, PENDING_FILE), {
      id: transactionId,
      startedAt: committedAt,
      entries: [
        { scope: 'global', projectKey: null, generation: global },
        { scope: 'project', projectKey, generation: project },
      ],
    });
  }
  if (globalDocument) {
    await writeGeneration(root, {
      envelopeVersion: ROUTING_PROFILE_ENVELOPE_VERSION, scope: 'global',
      generation: global, committedAt, document: globalDocument,
    });
  }
  if (projectDocument) {
    await writeGeneration(root, {
      envelopeVersion: ROUTING_PROFILE_ENVELOPE_VERSION, scope: 'project',
      generation: project, committedAt, projectKey,
      identity: { source: identity.source, confidence: identity.confidence },
      authoredAgainstGlobalGeneration: global ?? current.global?.generation ?? null,
      document: projectDocument,
    });
  }
  if (paired) await rm(join(root, PENDING_FILE), { force: true });
  return Object.freeze({ transactionId, globalGeneration: global, projectGeneration: project });
}

/**
 * Commit a global authorization, a project narrowing, or both. Both together are
 * one transaction: the descriptor names the generations being written and only
 * its removal commits them.
 */
export async function commitRoutingProfileGenerations(options) {
  const { root, identity = null, globalDocument = null, projectDocument = null,
    now = () => new Date().toISOString(), lockTimeoutMs = LOCK_TIMEOUT_MS } = options;
  if (!globalDocument && !projectDocument) {
    throw new TypeError('a routing profile commit must carry a global or a project document');
  }
  if (projectDocument && !identity?.key) {
    throw new TypeError('a project narrowing needs a resolved project identity');
  }
  return withStorageLock(root, lockTimeoutMs, () => commitUnderLock({
    ...options, identity, globalDocument, projectDocument, now,
  }));
}

async function readMarker(markerPath) {
  const raw = await readTextOrNull(markerPath);
  if (raw === null) return null;
  const value = raw.trim();
  if (!UUID.test(value)) {
    throw new Error(`routing project identity marker is unreadable: ${markerPath}`);
  }
  return value;
}

/** Write the marker once. A concurrent writer that got there first wins. */
async function createMarker(markerPath) {
  await mkdir(dirname(markerPath), { recursive: true });
  const id = randomUUID();
  try {
    await writeFile(markerPath, `${id}\n`, { encoding: 'utf8', flag: 'wx', mode: STORE_MODE });
    return id;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readMarker(markerPath);
  }
}

function pathIdentity(projectRoot) {
  const digest = createHash('sha256').update(projectRoot).digest('hex').slice(0, 20);
  return Object.freeze({
    key: `path-${digest}`, value: projectRoot,
    source: 'project-path', confidence: 'lower', markerPath: null,
  });
}

/**
 * Resolve the project identity that keys the narrowing: the UUID marker in the
 * git common directory, shared by every worktree of one repository, or the
 * canonical project-root path at lower confidence outside git.
 */
export async function resolveProjectIdentity({ projectRoot, runGit = defaultRunGit }) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new TypeError('a project identity needs a project root');
  }
  const root = resolve(projectRoot);
  const stdout = await runGit(['rev-parse', '--git-common-dir'], root);
  const commonDir = typeof stdout === 'string' && stdout.trim()
    ? resolve(root, stdout.trim())
    : null;
  if (!commonDir) return pathIdentity(root);
  const markerPath = join(commonDir, ...MARKER_SEGMENTS);
  const key = (await readMarker(markerPath)) ?? (await createMarker(markerPath));
  return Object.freeze({
    key, value: key, source: 'git-marker', confidence: 'stable', markerPath,
  });
}
