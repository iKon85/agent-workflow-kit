/**
 * The dispatch journal — the durable, owner-only record of what a dispatch was
 * about to do and what became of it.
 *
 * A receipt proves what ran; the journal is what makes a *crash* provable. The
 * `prepared` entry is written before the spawn and its terminal entry after, so
 * a process that dies in between leaves an entry that is neither dispatched nor
 * blocked. That entry is indeterminate: the agent may or may not have been
 * started, and nothing on disk can tell the difference.
 *
 * How an indeterminate entry resolves is a property of the surface, not a
 * preference:
 *
 * - **Claude** has a caller-assignable spawn id (`claude --session-id <uuid>`),
 *   assigned before the spawn and refused loudly on reuse. A retry against that
 *   id therefore cannot start a second agent. The id is scoped per
 *   `(cwd, session-id)` — the same uuid re-run from another working directory
 *   was accepted — so the journal keys on the pair and a recovery is valid only
 *   from the directory that prepared it.
 * - **Codex** exposes no caller-assignable thread id at all (`resume` only
 *   targets an already-recorded session), so an indeterminate Codex entry keeps
 *   blocking pending reconciliation.
 *
 * The file is `0600`, append-only under an exclusive lock, and carries a closed,
 * redacted field set: no task text, no prompt, no adapter diagnostic. A line
 * truncated by a crash is quarantined rather than fatal — the readable entries
 * survive, the damage is counted, and an execution whose state cannot be proven
 * clear blocks until a prune reconciles it.
 */
import { appendFile, chmod, mkdir, readFile, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writeAtomic } from './atomicWrite.mjs';

export const DISPATCH_JOURNAL_VERSION = 1;
/** User-local dispatch evidence: owner-only, like every other routing document. */
export const DISPATCH_JOURNAL_MODE = 0o600;
export const DEFAULT_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const JOURNAL_PHASES = Object.freeze([
  'prepared', 'dispatched', 'handed-off', 'blocked',
]);
export const TERMINAL_JOURNAL_PHASES = Object.freeze(['dispatched', 'handed-off', 'blocked']);
export const DISPATCH_RECOVERY_STATES = Object.freeze([
  'clear', 'settled', 'retry-idempotent', 'blocked-pending-reconciliation',
]);
/** The surfaces that can pre-assign a spawn id, and so may retry a crash. */
export const IDEMPOTENT_DISPATCH_SURFACES = Object.freeze(['claude']);

const ENTRY_FIELDS = [
  'schemaVersion', 'phase', 'executionId', 'surfaceId', 'transportId', 'cwd',
  'idempotencyKey', 'taskId', 'reason', 'authorizationId', 'recordedAt',
];
const RECEIPT_PHASE = Object.freeze({
  'routed-dispatch': 'dispatched',
  'inherited-dispatch': 'dispatched',
  handoff: 'handed-off',
  blocked: 'blocked',
});

const MAX_FIELD_LENGTH = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_POLL_MS = 10;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Every recorded value is short, printable and free of consumer task data. */
function redacted(value, field, optional = false) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`dispatch journal entry ${field} must be a non-empty string`);
  }
  if (value.length > MAX_FIELD_LENGTH) {
    throw new TypeError(`dispatch journal entry ${field} exceeds the redacted length limit`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`dispatch journal entry ${field} must carry no control characters`);
  }
  return value;
}

function assertPhaseFields(entry) {
  if (!JOURNAL_PHASES.includes(entry.phase)) {
    throw new TypeError(
      `dispatch journal entry phase must be one of: ${JOURNAL_PHASES.join(', ')}`,
    );
  }
  if (entry.taskId != null && entry.phase !== 'dispatched') {
    throw new TypeError('dispatch journal entry taskId is recorded on a dispatched entry only');
  }
  if (entry.reason != null && !TERMINAL_JOURNAL_PHASES.includes(entry.phase)) {
    throw new TypeError('dispatch journal entry reason is recorded on a terminal entry only');
  }
}

export function validateDispatchJournalEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('dispatch journal entry must be an object');
  }
  for (const key of Object.keys(entry)) {
    if (!ENTRY_FIELDS.includes(key)) {
      throw new TypeError(`dispatch journal entry must carry no consumer task data: ${key}`);
    }
  }
  if (entry.schemaVersion != null && entry.schemaVersion !== DISPATCH_JOURNAL_VERSION) {
    throw new TypeError(`dispatch journal entry schemaVersion must be ${DISPATCH_JOURNAL_VERSION}`);
  }
  assertPhaseFields(entry);
  const recordedAt = redacted(entry.recordedAt, 'recordedAt');
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new TypeError('dispatch journal entry recordedAt must be an ISO timestamp');
  }
  return Object.freeze({
    schemaVersion: DISPATCH_JOURNAL_VERSION,
    phase: entry.phase,
    executionId: redacted(entry.executionId, 'executionId'),
    surfaceId: redacted(entry.surfaceId, 'surfaceId'),
    transportId: redacted(entry.transportId, 'transportId', true),
    cwd: redacted(entry.cwd, 'cwd'),
    idempotencyKey: redacted(entry.idempotencyKey, 'idempotencyKey', true),
    taskId: redacted(entry.taskId, 'taskId', true),
    reason: redacted(entry.reason, 'reason', true),
    authorizationId: redacted(entry.authorizationId, 'authorizationId', true),
    recordedAt,
  });
}

/**
 * The pre-assigned spawn id a retry may reuse, or `null` when the surface has
 * none. The key is the `(cwd, session-id)` pair because that is the scope the
 * host actually enforces.
 */
export function dispatchIdempotencyKey({ surfaceId, cwd, sessionId = null } = {}) {
  redacted(cwd, 'cwd');
  if (!IDEMPOTENT_DISPATCH_SURFACES.includes(surfaceId) || sessionId == null) return null;
  return `${surfaceId}:${cwd}::${redacted(sessionId, 'idempotencyKey')}`;
}

async function withJournalLock(file, lockTimeoutMs, run) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try {
      await mkdir(lock, { recursive: false });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`dispatch journal is locked: ${lock}`);
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await run();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

/** Append one entry. The lock serializes writers; `0600` is enforced every time. */
export async function appendDispatchJournalEntry(file, entry, options = {}) {
  const validated = validateDispatchJournalEntry(entry);
  const { lockTimeoutMs = LOCK_TIMEOUT_MS } = options;
  await mkdir(dirname(file), { recursive: true });
  return withJournalLock(file, lockTimeoutMs, async () => {
    await appendFile(file, `${JSON.stringify(validated)}\n`, {
      encoding: 'utf8', mode: DISPATCH_JOURNAL_MODE,
    });
    await chmod(file, DISPATCH_JOURNAL_MODE);
    return validated;
  });
}

/**
 * Read the journal. A line a crash truncated is counted as damage — by position
 * and size, never by content — and every readable entry survives it.
 */
export async function readDispatchJournal(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return Object.freeze({ entries: Object.freeze([]), damaged: Object.freeze([]) });
  }
  const entries = [];
  const damaged = [];
  raw.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      entries.push(validateDispatchJournalEntry(JSON.parse(line)));
    } catch {
      damaged.push(Object.freeze({ line: index + 1, bytes: line.length }));
    }
  });
  return Object.freeze({ entries: Object.freeze(entries), damaged: Object.freeze(damaged) });
}

function outcome(state, reason, entry) {
  if (!DISPATCH_RECOVERY_STATES.includes(state)) {
    throw new TypeError(`unknown dispatch recovery state: ${state}`);
  }
  return Object.freeze({ state, reason, entry });
}

/** What an indeterminate `prepared` entry permits, decided by surface. */
function indeterminate(entry, surfaceId, idempotencyKey) {
  if (!IDEMPOTENT_DISPATCH_SURFACES.includes(surfaceId)) {
    return outcome(
      'blocked-pending-reconciliation', `no-idempotency-key-on-surface:${surfaceId}`, entry,
    );
  }
  if (idempotencyKey == null || entry.idempotencyKey == null) {
    return outcome('blocked-pending-reconciliation', 'no-idempotency-key-recorded', entry);
  }
  if (entry.idempotencyKey !== idempotencyKey) {
    return outcome('blocked-pending-reconciliation', 'idempotency-key-scope-mismatch', entry);
  }
  return outcome('retry-idempotent', 'idempotency-key-reserved', entry);
}

/**
 * Decide what one execution may still do. A settled execution never dispatches
 * again, an indeterminate one retries only against a pre-assigned key, and
 * unidentifiable damage cannot prove anything clear.
 */
export function planDispatchRecovery({
  entries = [], damaged = [], executionId, surfaceId, idempotencyKey = null,
} = {}) {
  redacted(executionId, 'executionId');
  redacted(surfaceId, 'surfaceId');
  const mine = entries.filter((entry) => entry.executionId === executionId);
  const last = mine[mine.length - 1] ?? null;
  if (last && TERMINAL_JOURNAL_PHASES.includes(last.phase)) {
    return outcome('settled', `already-recorded:${last.phase}`, last);
  }
  if (last) return indeterminate(last, surfaceId, idempotencyKey);
  if (damaged.length > 0) {
    return outcome('blocked-pending-reconciliation', 'journal-damaged', null);
  }
  return outcome('clear', 'no-indeterminate-entry', null);
}

function indeterminateExecutions(entries) {
  const last = new Map();
  for (const entry of entries) last.set(entry.executionId, entry);
  return new Set([...last.values()]
    .filter((entry) => entry.phase === 'prepared')
    .map((entry) => entry.executionId));
}

/**
 * Retention: aged terminal entries are dropped, an indeterminate execution is
 * kept at any age (dropping it would silently unblock a crash), and damage is
 * only discarded when the caller explicitly reconciles it.
 */
export async function pruneDispatchJournal(file, options = {}) {
  const {
    retainMs = DEFAULT_JOURNAL_RETENTION_MS, now = Date.now(),
    dropDamaged = false, lockTimeoutMs = LOCK_TIMEOUT_MS,
  } = options;
  return withJournalLock(file, lockTimeoutMs, async () => {
    const { entries, damaged } = await readDispatchJournal(file);
    if (damaged.length > 0 && !dropDamaged) {
      throw new Error('dispatch journal has damaged entries: reconcile with dropDamaged');
    }
    const pending = indeterminateExecutions(entries);
    const kept = entries.filter((entry) => pending.has(entry.executionId)
      || Date.parse(entry.recordedAt) > now - retainMs);
    await writeAtomic(
      file,
      kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
      DISPATCH_JOURNAL_MODE,
    );
    return Object.freeze({
      kept: kept.length,
      dropped: entries.length - kept.length,
      damagedDropped: damaged.length,
    });
  });
}

/** The terminal entry one receipt of any kind leaves behind. */
export function journalEntryForReceipt(receipt, context = {}) {
  const phase = RECEIPT_PHASE[receipt?.kind];
  if (!phase) throw new TypeError(`unknown dispatch receipt kind: ${receipt?.kind}`);
  const route = receipt.appliedRoute ?? receipt.requestedRoute ?? null;
  return validateDispatchJournalEntry({
    phase,
    executionId: receipt.executionId,
    surfaceId: context.surfaceId ?? route?.surfaceId ?? null,
    transportId: context.transportId ?? route?.transportId ?? null,
    cwd: context.cwd,
    idempotencyKey: context.idempotencyKey ?? null,
    taskId: phase === 'dispatched' ? context.taskId ?? null : null,
    reason: phase === 'dispatched' ? null : receipt.reason,
    authorizationId: receipt.authorizationId ?? null,
    recordedAt: receipt.dispatchedAt,
  });
}
