/**
 * The Dispatch receipt — the runtime record proving which requested Route
 * decision was actually applied, by which enforcement mechanism, under which
 * policy and evidence revisions.
 *
 * A receipt has one of four kinds, and each validates its own field set rather
 * than a union of everything any dispatch could ever carry. `routed-dispatch`
 * ran the resolved route, applied matching requested field for field, and
 * `blocked` did not run at all. `inherited-dispatch` ran the session default: it
 * is a receipt only when it carries the *attested* applied pair and the
 * session-default enforcement method, because the inherited pair may
 * legitimately differ from the route that was requested. `handoff` dispatched
 * nothing and handed the work on, so it records no applied route and no
 * enforcement and can never read as proof that something ran.
 *
 * Every kind names the revisions it decided under (`policyRevision`,
 * `catalogRevision`, `decisionAccessRevision`) plus the plan-authorization id
 * it dispatched against; a blocked receipt additionally names
 * `resultingAccessRevision` when the failure itself mutated the Access graph.
 */
export const DISPATCH_RECEIPT_VERSION = 2;

export const DISPATCH_RECEIPT_KINDS = Object.freeze([
  'routed-dispatch', 'inherited-dispatch', 'handoff', 'blocked',
]);

const KIND_STATUS = Object.freeze({
  'routed-dispatch': 'dispatched',
  'inherited-dispatch': 'dispatched',
  handoff: 'handoff',
  blocked: 'blocked',
});

/** What a caller that only knows the legacy outcome axis means by its status. */
const STATUS_KIND = Object.freeze({
  dispatched: 'routed-dispatch', handoff: 'handoff', blocked: 'blocked',
});

const ROUTE_FIELDS = ['providerId', 'modelId', 'effort', 'surfaceId', 'transportId'];

const ENFORCEMENT_METHODS = ['per-spawn', 'named-agent', 'session-default', 'none'];

export const DISPATCH_PRECEDENCE = Object.freeze([
  'explicit-argument', 'agent-definition-over-environment',
  'environment-over-agent-definition', 'session-default', 'uncontrolled', 'unreported',
]);

/**
 * The readback channels that may attest an applied pair, and what each proves
 * per axis. A channel absent from this table is not an attestation:
 * `~/.claude/settings.json` reported `medium` for a session that ran at `xhigh`,
 * so a configured value never attests an applied one. Claude's transcript
 * returns `message.model` from the server while its top-level `effort` is the
 * CLI's own record; Codex's `turn_context` is client-written throughout, so a
 * Codex receipt cannot claim provider attestation.
 */
export const APPLIED_PAIR_ATTESTATION_SOURCES = Object.freeze({
  'session-transcript': Object.freeze({ model: true, effort: false }),
  'rollout-turn-context': Object.freeze({ model: false, effort: false }),
});

const COMMON_FIELDS = [
  'kind', 'status', 'executionId', 'afk', 'revisions', 'authorizationId', 'dispatchedAt',
];
const APPLIED_FIELDS = ['requestedRoute', 'appliedRoute', 'enforcement', 'precedence'];

/** The closed field set of each kind — what it may carry, and nothing else. */
const KIND_FIELDS = Object.freeze({
  'routed-dispatch': new Set([...COMMON_FIELDS, ...APPLIED_FIELDS]),
  'inherited-dispatch': new Set([...COMMON_FIELDS, ...APPLIED_FIELDS, 'attestation']),
  handoff: new Set([...COMMON_FIELDS, 'requestedRoute', 'handoff', 'reason']),
  blocked: new Set([...COMMON_FIELDS, ...APPLIED_FIELDS, 'reason', 'resultingAccessRevision']),
});

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function closedFields(value, allowed, message) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${message}: ${key}`);
  }
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

const optionalString = (value, field) => (value == null ? null : string(value, field));

function timestamp(value, field) {
  string(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function route(input, field) {
  closedFields(object(input, field), ROUTE_FIELDS, `unknown ${field} field`);
  return Object.freeze(Object.fromEntries(
    ROUTE_FIELDS.map((key) => [key, string(input[key], `${field}.${key}`)]),
  ));
}

const optionalRoute = (input, field) => (input == null ? null : route(input, field));

function pair(input, field, allowed) {
  object(input, field);
  const result = {};
  for (const axis of ['model', 'effort']) {
    if (!allowed.includes(input[axis])) {
      throw new TypeError(`${axis} ${field} must be one of: ${allowed.join(', ')}`);
    }
    result[axis] = input[axis];
  }
  return Object.freeze(result);
}

const enforcement = (input) => pair(input, 'enforcement', ENFORCEMENT_METHODS);

function precedence(input) {
  if (input == null) return Object.freeze({ model: 'unreported', effort: 'unreported' });
  return pair(input, 'precedence', DISPATCH_PRECEDENCE);
}

function revisions(input) {
  object(input, 'revisions');
  return Object.freeze({
    catalog: string(input.catalog, 'revisions.catalog'),
    accessGraph: string(input.accessGraph, 'revisions.accessGraph'),
    policy: string(input.policy, 'revisions.policy'),
  });
}

/** The kind a caller asked for, or the one its legacy status still implies. */
function receiptKind(input) {
  if (input.kind == null) {
    const derived = STATUS_KIND[input.status];
    if (derived) return derived;
    throw new TypeError(
      `dispatch receipt needs a kind, or a status of: ${Object.keys(STATUS_KIND).join(', ')}`,
    );
  }
  if (!DISPATCH_RECEIPT_KINDS.includes(input.kind)) {
    throw new TypeError(
      `dispatch receipt kind must be one of: ${DISPATCH_RECEIPT_KINDS.join(', ')}`,
    );
  }
  if (input.status != null && input.status !== KIND_STATUS[input.kind]) {
    throw new TypeError(`${input.kind} receipt status must be ${KIND_STATUS[input.kind]}`);
  }
  return input.kind;
}

/**
 * `resultingAccessRevision` is the Access-graph revision *after* a failure
 * mutated the graph, so it belongs to a blocked receipt and must differ from the
 * decision's own — repeating that one names a mutation that never happened.
 */
function namedRevisions(input, kind, decided) {
  const resulting = optionalString(input.resultingAccessRevision, 'resultingAccessRevision');
  if (resulting !== null && resulting === decided.accessGraph) {
    throw new TypeError('resultingAccessRevision names no access graph mutation');
  }
  return {
    catalogRevision: decided.catalog,
    decisionAccessRevision: decided.accessGraph,
    policyRevision: decided.policy,
    resultingAccessRevision: kind === 'blocked' ? resulting : null,
  };
}

function baseReceipt(input, kind) {
  const decided = revisions(input.revisions);
  return {
    schemaVersion: DISPATCH_RECEIPT_VERSION,
    kind,
    executionId: string(input.executionId, 'executionId'),
    status: KIND_STATUS[kind],
    afk: input.afk === true,
    requestedRoute: null, appliedRoute: null, enforcement: null, precedence: null,
    attestation: null, handoff: null,
    revisions: decided,
    ...namedRevisions(input, kind, decided),
    authorizationId: optionalString(input.authorizationId, 'authorizationId'),
    dispatchedAt: timestamp(input.dispatchedAt, 'dispatchedAt'),
    reason: null,
  };
}

/** The attested applied pair: which channel read it back, and what that proves. */
function appliedPairAttestation(input, appliedRoute) {
  if (input == null) throw new TypeError('inherited dispatch requires an attested applied pair');
  const sources = Object.keys(APPLIED_PAIR_ATTESTATION_SOURCES);
  closedFields(object(input, 'attestation'),
    ['source', 'model', 'effort', 'observedAt'], 'unknown attestation field');
  if (!sources.includes(input.source)) {
    throw new TypeError(`attestation source must be one of: ${sources.join(', ')}`);
  }
  const model = string(input.model, 'attestation.model');
  const effort = string(input.effort, 'attestation.effort');
  if (model !== appliedRoute.modelId || effort !== appliedRoute.effort) {
    throw new Error('attested applied pair differs from the applied route');
  }
  return Object.freeze({
    source: input.source, model, effort,
    observedAt: timestamp(input.observedAt, 'attestation.observedAt'),
    providerAttested: APPLIED_PAIR_ATTESTATION_SOURCES[input.source],
  });
}

function routedDispatch(input, base) {
  const requestedRoute = route(input.requestedRoute, 'requestedRoute');
  const appliedRoute = route(input.appliedRoute, 'appliedRoute');
  for (const field of ROUTE_FIELDS) {
    if (requestedRoute[field] !== appliedRoute[field]) {
      throw new Error(`applied route differs from requested route: ${field}`);
    }
  }
  const applied = enforcement(input.enforcement);
  const order = precedence(input.precedence);
  if (base.afk && (applied.model === 'none' || applied.effort === 'none')) {
    throw new Error('AFK dispatch requires enforced model and effort selection');
  }
  if (base.afk && Object.values(order).some((value) =>
    value === 'uncontrolled' || value === 'unreported')) {
    throw new Error('AFK dispatch requires verified environment precedence');
  }
  return { ...base, requestedRoute, appliedRoute, enforcement: applied, precedence: order };
}

/**
 * Inheritance is the constrained non-AFK path: the applied pair is whatever the
 * session already runs, so it proves nothing without its attestation.
 */
function inheritedDispatch(input, base) {
  const appliedRoute = route(input.appliedRoute, 'appliedRoute');
  const applied = enforcement(input.enforcement);
  if (applied.model !== 'session-default' || applied.effort !== 'session-default') {
    throw new TypeError('inherited dispatch requires the session-default enforcement method');
  }
  if (base.afk) throw new Error('AFK dispatch cannot inherit a session default');
  return {
    ...base,
    requestedRoute: optionalRoute(input.requestedRoute, 'requestedRoute'),
    appliedRoute,
    enforcement: applied,
    precedence: precedence(input.precedence),
    attestation: appliedPairAttestation(input.attestation, appliedRoute),
  };
}

function handoffReceipt(input, base) {
  const target = closedFields(object(input.handoff, 'handoff'), ['to'], 'unknown handoff field');
  return {
    ...base,
    requestedRoute: optionalRoute(input.requestedRoute, 'requestedRoute'),
    handoff: Object.freeze({ to: string(target.to, 'handoff.to') }),
    reason: string(input.reason, 'reason'),
  };
}

function blockedReceipt(input, base) {
  const requestedRoute = optionalRoute(input.requestedRoute, 'requestedRoute');
  const appliedRoute = optionalRoute(input.appliedRoute, 'appliedRoute');
  if (appliedRoute !== null && requestedRoute === null) {
    throw new TypeError('blocked applied route requires a requested route');
  }
  const applied = input.enforcement == null ? null : enforcement(input.enforcement);
  const order = input.precedence == null ? null : precedence(input.precedence);
  if (appliedRoute !== null && (applied === null || order === null)) {
    throw new TypeError('blocked applied route requires enforcement and precedence');
  }
  return {
    ...base,
    requestedRoute, appliedRoute, enforcement: applied, precedence: order,
    reason: string(input.reason, 'reason'),
  };
}

const BUILDERS = Object.freeze({
  'routed-dispatch': routedDispatch,
  'inherited-dispatch': inheritedDispatch,
  handoff: handoffReceipt,
  blocked: blockedReceipt,
});

export function createDispatchReceipt(input) {
  object(input, 'dispatch receipt');
  const kind = receiptKind(input);
  closedFields(input, [...KIND_FIELDS[kind]], `unknown ${kind} receipt field`);
  return Object.freeze(BUILDERS[kind](input, baseReceipt(input, kind)));
}
