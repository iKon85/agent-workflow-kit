/**
 * Dispatching a resolved Route decision.
 *
 * The dispatch holds a revision-bound dispatch lease across the spawn handoff
 * whenever one is configured: the store is re-read and the Routing policy
 * recomputed before the adapter prepares, and again after it, so an
 * authorization revoked in that window fails the dispatch instead of racing it.
 * Without a lease the only remaining guard is the in-process comparison of the
 * caller's own resolver input, which cannot see another process at all.
 *
 * A lease survives no crash, so a configured dispatch journal carries the other
 * half: the `prepared` entry is written before the spawn and its terminal entry
 * after, and a dispatch that finds an indeterminate entry from an earlier run
 * blocks pending reconciliation instead of spawning a second agent — unless the
 * surface pre-assigned a spawn id that makes the retry provably safe.
 */
import { createDispatchReceipt } from './dispatchReceipt.mjs';
import {
  appendDispatchJournalEntry,
  dispatchIdempotencyKey,
  journalEntryForReceipt,
  planDispatchRecovery,
  readDispatchJournal,
} from './dispatchJournal.mjs';
import { resolveRoute } from './routingResolver.mjs';
import { openDispatchLease } from './routingDispatchLease.mjs';
import {
  assertRoutingProfileUnchanged,
  captureRoutingProfileSnapshot,
} from './routingEvidenceCache.mjs';

const RECEIPT_ROUTE_FIELDS = [
  'providerId',
  'modelId',
  'effort',
  'surfaceId',
  'transportId',
];

function receiptRoute(route) {
  return Object.fromEntries(RECEIPT_ROUTE_FIELDS.map((field) => [field, route[field]]));
}

function receiptRevisions(decision) {
  return Object.fromEntries(
    ['catalog', 'accessGraph', 'policy'].map((field) => [
      field,
      decision.revisions[field] ?? 'missing',
    ]),
  );
}

/**
 * The plan-authorization a dispatch runs under: what the caller named, or the
 * approval the Route decision already recorded.
 */
function authorizationId(input, decision) {
  return input.authorizationId ?? decision.approval?.authorizationId ?? null;
}

function blockedReceipt(input, decision, reason, details = {}) {
  return createDispatchReceipt({
    executionId: input.executionId,
    status: 'blocked',
    afk: input.afk,
    requestedRoute: details.requestedRoute ?? null,
    appliedRoute: details.appliedRoute ?? null,
    enforcement: details.enforcement ?? null,
    precedence: details.precedence ?? null,
    revisions: receiptRevisions(decision),
    resultingAccessRevision: input.resultingAccessRevision ?? null,
    authorizationId: authorizationId(input, decision),
    dispatchedAt: input.dispatchedAt,
    reason,
  });
}

function decisionReason(decision) {
  const blockers = decision.blockers.length > 0 ? `:${decision.blockers.join(',')}` : '';
  return `${decision.status}:${decision.reason}${blockers}`;
}

/**
 * The closed set of failure reasons a receipt may name. A message is reduced to
 * the reason it starts with, so neither a revision value nor an adapter
 * diagnostic can travel into a receipt.
 */
const SAFE_FAILURE_REASONS = Object.freeze([
  'Claude route capability is not attested',
  'route identity is incomplete',
  'transport is not detected',
  'transport is not callable',
  'transport is not permitted',
  'model control is not enforced',
  'effort control is not enforced',
  'model environment precedence is unverified',
  'effort environment precedence is unverified',
  'model applied value is unverified',
  'effort applied value is unverified',
  'transport has no approved dispatcher',
  'environment precedence mismatch: model',
  'environment precedence mismatch: effort',
  'applied route mismatch',
  'spawn guard received no callable dispatcher',
  'applied route differs from requested route',
  'applied enforcement differs from attested access path',
  'AFK dispatch requires enforced model and effort selection',
  'AFK dispatch requires verified environment precedence',
  'concurrent routing profile mutation',
  'concurrent evidence catalog mutation',
  'routing profile store carries no committed authorization',
  'dispatch lease is reserved for a writer',
  'dispatch lease is held',
  'dispatch lease superseded',
  'dispatch lease expired',
  'dispatch is indeterminate pending reconciliation',
  'dispatch is already recorded',
]);

/**
 * The two reasons the journal itself raised. Recording a terminal entry for
 * them would settle the very indeterminacy that has to stay open until it is
 * reconciled, so a dispatch blocked by the guard writes nothing.
 */
const JOURNAL_GUARD_REASONS = Object.freeze([
  'dispatch is indeterminate pending reconciliation',
  'dispatch is already recorded',
]);

function safeFailureReason(error) {
  const message = error instanceof Error ? error.message : '';
  return SAFE_FAILURE_REASONS.find((reason) => message.startsWith(reason))
    ?? 'dispatch adapter rejected route';
}

function safeDispatchResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const taskId = typeof result.taskId === 'string' && result.taskId !== ''
    ? result.taskId
    : null;
  return taskId === null ? null : Object.freeze({ taskId });
}

function assertAppliedEnforcement(decision, applied) {
  for (const field of ['model', 'effort']) {
    if (decision.bestExecutable.enforcement[field] !== applied[field]) {
      throw new Error(`applied enforcement differs from attested access path: ${field}`);
    }
  }
}

/**
 * The in-process comparison over the caller's own resolver input. It catches only
 * a mutation this process made to that object; a store-backed lease is what sees
 * an external writer.
 */
function inProcessGuard(resolverInput) {
  const snapshot = captureRoutingProfileSnapshot(resolverInput);
  const catalogRevision = resolverInput.catalog.revision;
  return () => {
    assertRoutingProfileUnchanged(snapshot, resolverInput);
    if (catalogRevision !== resolverInput.catalog?.revision) {
      throw new Error('concurrent evidence catalog mutation');
    }
  };
}

/** The lease is bound to the revisions the Route decision itself named. */
function leaseOptions(input, decision) {
  if (input.lease == null) return null;
  if (typeof input.lease !== 'object' || Array.isArray(input.lease)) {
    throw new TypeError('dispatch lease options must be an object');
  }
  return {
    ...input.lease,
    holder: input.lease.holder ?? input.executionId,
    expected: decision.revisions,
  };
}

function preparedReceipt(input, decision, requestedRoute, prepared) {
  const applied = {
    requestedRoute,
    appliedRoute: receiptRoute(prepared.appliedRoute),
    enforcement: prepared.enforcement,
    precedence: prepared.precedence,
  };
  if (prepared.mismatchReason) {
    return blockedReceipt(
      input, decision, safeFailureReason(new Error(prepared.mismatchReason)), applied,
    );
  }
  return createDispatchReceipt({
    executionId: input.executionId,
    kind: 'routed-dispatch',
    afk: input.afk,
    ...applied,
    revisions: receiptRevisions(decision),
    authorizationId: authorizationId(input, decision),
    dispatchedAt: input.dispatchedAt,
  });
}

/**
 * The journal a dispatch records into. The idempotency key is derived from the
 * surface actually being dispatched, so a caller cannot claim a Claude spawn id
 * for a Codex run.
 */
function journalOptions(input, decision) {
  if (input.journal == null) return null;
  if (typeof input.journal !== 'object' || Array.isArray(input.journal)) {
    throw new TypeError('dispatch journal options must be an object');
  }
  if (typeof input.journal.file !== 'string' || input.journal.file.trim() === '') {
    throw new TypeError('dispatch journal options need a journal file');
  }
  const { surfaceId, transportId } = decision.bestExecutable;
  const cwd = input.journal.cwd;
  return Object.freeze({
    file: input.journal.file,
    cwd,
    surfaceId,
    transportId,
    idempotencyKey: dispatchIdempotencyKey({
      surfaceId, cwd, sessionId: input.journal.sessionId ?? null,
    }),
  });
}

/** What an earlier run left behind decides whether this one may spawn at all. */
async function assertJournalPermitsDispatch(journal, executionId) {
  const { entries, damaged } = await readDispatchJournal(journal.file);
  const recovery = planDispatchRecovery({
    entries,
    damaged,
    executionId,
    surfaceId: journal.surfaceId,
    idempotencyKey: journal.idempotencyKey,
  });
  if (recovery.state === 'settled') throw new Error('dispatch is already recorded');
  if (recovery.state === 'blocked-pending-reconciliation') {
    throw new Error('dispatch is indeterminate pending reconciliation');
  }
  return recovery;
}

function recordJournalEntry(journal, receipt, taskId = null) {
  return appendDispatchJournalEntry(journal.file, journalEntryForReceipt(receipt, {
    cwd: journal.cwd,
    surfaceId: journal.surfaceId,
    transportId: journal.transportId,
    idempotencyKey: journal.idempotencyKey,
    taskId,
  }));
}

function recordPreparedEntry(journal, receipt) {
  return appendDispatchJournalEntry(journal.file, {
    phase: 'prepared',
    executionId: receipt.executionId,
    surfaceId: journal.surfaceId,
    transportId: journal.transportId,
    cwd: journal.cwd,
    idempotencyKey: journal.idempotencyKey,
    authorizationId: receipt.authorizationId,
    recordedAt: receipt.dispatchedAt,
  });
}

async function performDispatch(input, decision, { journal, requestedRoute }) {
  const assertInProcessUnchanged = inProcessGuard(input.resolverInput);
  const lease = leaseOptions(input, decision);
  let held = null;
  try {
    if (journal) await assertJournalPermitsDispatch(journal, input.executionId);
    if (lease) held = await openDispatchLease(lease);
    const prepared = await input.adapter.prepare(requestedRoute);
    assertInProcessUnchanged();
    if (held) await held.revalidate();
    assertAppliedEnforcement(decision, prepared.enforcement);
    const receipt = preparedReceipt(input, decision, requestedRoute, prepared);
    if (receipt.status !== 'dispatched') {
      if (journal) await recordJournalEntry(journal, receipt);
      return Object.freeze({ decision, receipt, dispatchResult: null });
    }
    if (typeof prepared.dispatch !== 'function') {
      throw new Error('spawn guard received no callable dispatcher');
    }
    if (journal) await recordPreparedEntry(journal, receipt);
    const dispatchResult = safeDispatchResult(await prepared.dispatch());
    if (journal) await recordJournalEntry(journal, receipt, dispatchResult?.taskId ?? null);
    return Object.freeze({ decision, receipt, dispatchResult });
  } finally {
    held?.release();
  }
}

/**
 * A failed dispatch is journaled too — a terminal entry is what keeps the next
 * run from reading this one as an unresolved crash. A journal write that fails
 * here leaves the entry indeterminate, which blocks rather than spawns.
 */
async function blockedOutcome(input, decision, { journal, requestedRoute, error }) {
  const reason = safeFailureReason(error);
  const receipt = blockedReceipt(input, decision, reason, { requestedRoute });
  if (journal && !JOURNAL_GUARD_REASONS.includes(reason)) {
    await recordJournalEntry(journal, receipt).catch(() => {});
  }
  return Object.freeze({ decision, receipt, dispatchResult: null });
}

export async function dispatchResolvedRoute(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dispatch input must be an object');
  }
  if (!input.adapter || typeof input.adapter.prepare !== 'function') {
    throw new TypeError('dispatch adapter must expose prepare');
  }
  const decision = resolveRoute(input.resolverInput);
  if (decision.status !== 'ready') {
    return Object.freeze({
      decision,
      receipt: blockedReceipt(input, decision, decisionReason(decision)),
      dispatchResult: null,
    });
  }
  const journal = journalOptions(input, decision);
  const requestedRoute = receiptRoute(decision.bestExecutable);
  try {
    return await performDispatch(input, decision, { journal, requestedRoute });
  } catch (error) {
    return blockedOutcome(input, decision, { journal, requestedRoute, error });
  }
}
