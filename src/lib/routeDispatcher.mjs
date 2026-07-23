import { createDispatchReceipt } from './dispatchReceipt.mjs';
import { resolveRoute } from './routingResolver.mjs';
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
    dispatchedAt: input.dispatchedAt,
    reason,
  });
}

function decisionReason(decision) {
  const blockers = decision.blockers.length > 0 ? `:${decision.blockers.join(',')}` : '';
  return `${decision.status}:${decision.reason}${blockers}`;
}

function safeFailureReason(error) {
  const message = error instanceof Error ? error.message : '';
  const safeReasons = [
    ['Claude route capability is not attested', 'Claude route capability is not attested'],
    ['route identity is incomplete', 'route identity is incomplete'],
    ['transport is not detected', 'transport is not detected'],
    ['transport is not callable', 'transport is not callable'],
    ['transport is not permitted', 'transport is not permitted'],
    ['model control is not enforced', 'model control is not enforced'],
    ['effort control is not enforced', 'effort control is not enforced'],
    ['model environment precedence is unverified', 'model environment precedence is unverified'],
    ['effort environment precedence is unverified', 'effort environment precedence is unverified'],
    ['model applied value is unverified', 'model applied value is unverified'],
    ['effort applied value is unverified', 'effort applied value is unverified'],
    ['transport has no approved dispatcher', 'transport has no approved dispatcher'],
    ['environment precedence mismatch: model', 'environment precedence mismatch: model'],
    ['environment precedence mismatch: effort', 'environment precedence mismatch: effort'],
    ['applied route mismatch', 'applied route mismatch'],
    ['spawn guard received no callable dispatcher', 'spawn guard received no callable dispatcher'],
    ['applied route differs from requested route', 'applied route differs from requested route'],
    ['applied enforcement differs from attested access path', 'applied enforcement differs from attested access path'],
    ['AFK dispatch requires enforced model and effort selection', 'AFK dispatch requires enforced model and effort selection'],
    ['AFK dispatch requires verified environment precedence', 'AFK dispatch requires verified environment precedence'],
    ['concurrent routing profile mutation', 'concurrent routing profile mutation'],
    ['concurrent evidence catalog mutation', 'concurrent evidence catalog mutation'],
  ];
  return safeReasons.find(([prefix]) => message.startsWith(prefix))?.[1]
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
  const profileSnapshot = captureRoutingProfileSnapshot(input.resolverInput);
  const catalogRevision = input.resolverInput.catalog.revision;

  const requestedRoute = receiptRoute(decision.bestExecutable);
  try {
    const prepared = await input.adapter.prepare(requestedRoute);
    assertRoutingProfileUnchanged(profileSnapshot, input.resolverInput);
    if (catalogRevision !== input.resolverInput.catalog?.revision) {
      throw new Error('concurrent evidence catalog mutation');
    }
    assertAppliedEnforcement(decision, prepared.enforcement);
    if (prepared.mismatchReason) {
      return Object.freeze({
        decision,
        receipt: blockedReceipt(input, decision, safeFailureReason(
          new Error(prepared.mismatchReason),
        ), {
          requestedRoute,
          appliedRoute: receiptRoute(prepared.appliedRoute),
          enforcement: prepared.enforcement,
          precedence: prepared.precedence,
        }),
        dispatchResult: null,
      });
    }
    const receipt = createDispatchReceipt({
      executionId: input.executionId,
      status: 'dispatched',
      afk: input.afk,
      requestedRoute,
      appliedRoute: receiptRoute(prepared.appliedRoute),
      enforcement: prepared.enforcement,
      precedence: prepared.precedence,
      revisions: receiptRevisions(decision),
      dispatchedAt: input.dispatchedAt,
    });
    if (typeof prepared.dispatch !== 'function') {
      throw new Error('spawn guard received no callable dispatcher');
    }
    const dispatchResult = safeDispatchResult(await prepared.dispatch());
    return Object.freeze({ decision, receipt, dispatchResult });
  } catch (error) {
    return Object.freeze({
      decision,
      receipt: blockedReceipt(input, decision, safeFailureReason(error), { requestedRoute }),
      dispatchResult: null,
    });
  }
}
