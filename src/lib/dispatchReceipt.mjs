export const DISPATCH_RECEIPT_VERSION = 2;

const ROUTE_FIELDS = [
  'providerId',
  'modelId',
  'effort',
  'surfaceId',
  'transportId',
];

const ENFORCEMENT_METHODS = [
  'per-spawn',
  'named-agent',
  'session-default',
  'none',
];

export const DISPATCH_PRECEDENCE = Object.freeze([
  'explicit-argument',
  'agent-definition-over-environment',
  'environment-over-agent-definition',
  'session-default',
  'uncontrolled',
  'unreported',
]);

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function timestamp(value, field) {
  string(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function route(input, field) {
  object(input, field);
  for (const key of Object.keys(input)) {
    if (!ROUTE_FIELDS.includes(key)) throw new TypeError(`unknown ${field} field: ${key}`);
  }
  return Object.freeze(Object.fromEntries(
    ROUTE_FIELDS.map((key) => [key, string(input[key], `${field}.${key}`)]),
  ));
}

function enforcement(input) {
  object(input, 'enforcement');
  const result = {};
  for (const field of ['model', 'effort']) {
    if (!ENFORCEMENT_METHODS.includes(input[field])) {
      throw new TypeError(`${field} enforcement must be one of: ${ENFORCEMENT_METHODS.join(', ')}`);
    }
    result[field] = input[field];
  }
  return Object.freeze(result);
}

function precedence(input) {
  if (input == null) {
    return Object.freeze({ model: 'unreported', effort: 'unreported' });
  }
  object(input, 'precedence');
  const result = {};
  for (const field of ['model', 'effort']) {
    if (!DISPATCH_PRECEDENCE.includes(input[field])) {
      throw new TypeError(
        `${field} precedence must be one of: ${DISPATCH_PRECEDENCE.join(', ')}`,
      );
    }
    result[field] = input[field];
  }
  return Object.freeze(result);
}

function revisions(input) {
  object(input, 'revisions');
  return Object.freeze({
    catalog: string(input.catalog, 'revisions.catalog'),
    accessGraph: string(input.accessGraph, 'revisions.accessGraph'),
    policy: string(input.policy, 'revisions.policy'),
  });
}

function blockedReceipt(input) {
  const requestedRoute = input.requestedRoute == null
    ? null
    : route(input.requestedRoute, 'requestedRoute');
  const appliedRoute = input.appliedRoute == null
    ? null
    : route(input.appliedRoute, 'appliedRoute');
  if (appliedRoute !== null && requestedRoute === null) {
    throw new TypeError('blocked applied route requires a requested route');
  }
  const appliedEnforcement = input.enforcement == null ? null : enforcement(input.enforcement);
  const appliedPrecedence = input.precedence == null ? null : precedence(input.precedence);
  if (appliedRoute !== null && (appliedEnforcement === null || appliedPrecedence === null)) {
    throw new TypeError('blocked applied route requires enforcement and precedence');
  }
  return Object.freeze({
    schemaVersion: DISPATCH_RECEIPT_VERSION,
    executionId: string(input.executionId, 'executionId'),
    status: 'blocked',
    afk: input.afk === true,
    requestedRoute,
    appliedRoute,
    enforcement: appliedEnforcement,
    precedence: appliedPrecedence,
    revisions: revisions(input.revisions),
    dispatchedAt: timestamp(input.dispatchedAt, 'dispatchedAt'),
    reason: string(input.reason, 'reason'),
  });
}

export function createDispatchReceipt(input) {
  object(input, 'dispatch receipt');
  if (input.status === 'blocked') return blockedReceipt(input);
  if (input.status !== 'dispatched') {
    throw new TypeError('dispatch receipt status must be dispatched or blocked');
  }
  const requestedRoute = route(input.requestedRoute, 'requestedRoute');
  const appliedRoute = route(input.appliedRoute, 'appliedRoute');
  for (const field of ROUTE_FIELDS) {
    if (requestedRoute[field] !== appliedRoute[field]) {
      throw new Error(`applied route differs from requested route: ${field}`);
    }
  }
  const appliedEnforcement = enforcement(input.enforcement);
  const appliedPrecedence = precedence(input.precedence);
  if (input.afk === true
      && (appliedEnforcement.model === 'none' || appliedEnforcement.effort === 'none')) {
    throw new Error('AFK dispatch requires enforced model and effort selection');
  }
  if (input.afk === true
      && Object.values(appliedPrecedence).some((value) =>
        value === 'uncontrolled' || value === 'unreported')) {
    throw new Error('AFK dispatch requires verified environment precedence');
  }
  return Object.freeze({
    schemaVersion: DISPATCH_RECEIPT_VERSION,
    executionId: string(input.executionId, 'executionId'),
    status: 'dispatched',
    afk: input.afk === true,
    requestedRoute,
    appliedRoute,
    enforcement: appliedEnforcement,
    precedence: appliedPrecedence,
    revisions: revisions(input.revisions),
    dispatchedAt: timestamp(input.dispatchedAt, 'dispatchedAt'),
    reason: null,
  });
}
