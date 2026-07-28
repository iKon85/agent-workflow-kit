/**
 * The Routing policy schema: the constraint object derived from a Routing
 * profile for one dispatch — allowed surfaces, allowed transports, the
 * authorized Model roster, the effective Standard routes, and switching
 * autonomy. It carries a revision so a Dispatch receipt can prove which
 * constraints applied, and it never changes Evidence catalog facts.
 *
 * v2 removes the optimization dial. What a user is willing to spend
 * is a Routing profile choice, not a per-dispatch constraint, so the roster
 * pairs and the effective Standard routes move in instead: the resolver keeps
 * its four inputs and one receipt names one revision. `unreachable` and
 * `missingInfrastructure` stay — they are the resolver's fallback semantics and
 * have nothing to do with the removed dial.
 *
 * Fail-closed by construction. A policy that authorizes no roster pair and no
 * Standard route is invalid rather than an empty default that would read as a
 * policy; dispatch blocks with that named reason.
 *
 * Authorization only. The policy states what a user authorized; whether a pair
 * is reachable is decided at decision time against the Access graph, never
 * here. The roster vocabulary and the Standard-route classes come from the
 * Routing profile, which owns them — this module never restates them.
 */
import {
  STANDARD_ROUTE_CLASSES,
  STANDARD_ROUTE_STATES,
  normalizeRosterModelId,
} from './routingProfile.mjs';

export const ROUTING_POLICY_VERSION = 2;
export const ROUTING_POLICY_LEGACY_VERSION = 1;

/** The reason an authorization-free policy gives, so a dispatch can name it. */
export const ROUTING_POLICY_NOT_DERIVABLE = 'routing-policy-not-derivable';

const POLICY_FIELDS = new Set([
  'schemaVersion',
  'revision',
  'allowedSurfaces',
  'allowedTransports',
  'switching',
  'roster',
  'standardRoutes',
  'unreachable',
  'missingInfrastructure',
]);
/** The v1 shape, kept only so the decoder can read one and say what it dropped. */
const LEGACY_POLICY_FIELDS = new Set([
  'schemaVersion',
  'revision',
  'allowedSurfaces',
  'allowedTransports',
  'switching',
  'optimization',
  'unreachable',
  'missingInfrastructure',
]);
/** What a v1 document cannot carry and a caller must therefore supply. */
const DERIVATION_FIELDS = new Set(['roster', 'standardRoutes']);
const PAIR_FIELDS = new Set(['model', 'effort']);
const STANDARD_ROUTE_FIELDS = new Set(['model', 'effort', 'state']);

const SWITCHING = ['automatic', 'ask', 'current-surface-only'];
const UNREACHABLE = ['handoff', 'inherit', 'block'];
const MISSING_INFRASTRUCTURE = ['inherit', 'block'];

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function assertFields(input, allowed, label) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${label} field: ${key}`);
  }
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function stringList(value, field) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry !== '')) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function oneOf(value, values, field) {
  if (!values.includes(value)) throw new TypeError(`${field} must be one of: ${values.join(', ')}`);
  return value;
}

/**
 * A model-and-effort pair, under the roster's own identity rule: effort is
 * always explicit, `null` meaning a model with no effort axis.
 */
function policyPair(input, field) {
  object(input, field);
  assertFields(input, PAIR_FIELDS, field);
  const model = normalizeRosterModelId(input.model, `${field}.model`);
  if (!('effort' in input) || (input.effort !== null
      && (typeof input.effort !== 'string' || input.effort.trim() === ''))) {
    throw new TypeError(`${field}.effort must be a non-empty string or null (no effort axis)`);
  }
  return { model, effort: input.effort === null ? null : input.effort.trim() };
}

const pairKey = ({ model, effort }) => `${model}\u0000${effort ?? ''}`;

/** The positive list this policy authorizes: pairs, deduped, order preserved. */
function validateRoster(value) {
  if (!Array.isArray(value)) {
    throw new TypeError('roster must be an array of {model, effort} pairs');
  }
  const pairs = new Map();
  value.forEach((input, index) => {
    const pair = policyPair(input, `roster[${index}]`);
    pairs.set(pairKey(pair), Object.freeze(pair));
  });
  return [...pairs.values()];
}

/**
 * The effective Standard routes, one per workload class. A `configured` route
 * must name a pair the roster authorizes — the policy is the authorization
 * surface, so an authorized route over an unauthorized pair is a contradiction,
 * not a fallback. An `unresolved` route keeps a knowingly broken nomination
 * instead of invalidating the whole policy; it authorizes nothing.
 */
function validateStandardRoutes(value, roster) {
  object(value, 'standardRoutes');
  assertFields(value, new Set(STANDARD_ROUTE_CLASSES), 'standardRoutes');
  const authorized = new Set(roster.map(pairKey));
  const routes = {};
  for (const workload of STANDARD_ROUTE_CLASSES) {
    if (!(workload in value)) {
      throw new TypeError(
        `standardRoutes must name every workload class: ${STANDARD_ROUTE_CLASSES.join(', ')}`,
      );
    }
    if (value[workload] === null) {
      routes[workload] = null;
      continue;
    }
    const field = `standardRoutes.${workload}`;
    object(value[workload], field);
    assertFields(value[workload], STANDARD_ROUTE_FIELDS, field);
    const pair = policyPair({ model: value[workload].model, effort: value[workload].effort }, field);
    const state = oneOf(value[workload].state, STANDARD_ROUTE_STATES, `${field}.state`);
    if (state === 'configured' && !authorized.has(pairKey(pair))) {
      throw new TypeError(`${field} must name an authorized roster pair`);
    }
    routes[workload] = Object.freeze({ ...pair, state });
  }
  return routes;
}

/** Never a silent default: a policy that authorizes nothing is invalid. */
function assertDerivable(roster, routes) {
  const configured = STANDARD_ROUTE_CLASSES.some((cls) => routes[cls]?.state === 'configured');
  if (roster.length === 0 && !configured) {
    throw new TypeError('routing policy derives neither a Model roster nor a Standard route: '
      + ROUTING_POLICY_NOT_DERIVABLE);
  }
}

/**
 * Validate a Routing policy. A v1 document is accepted and decoded, so a caller
 * that still holds one gets the named migration reason rather than an opaque
 * schema error.
 */
export function validateRoutingPolicy(input) {
  object(input, 'routing policy');
  if (input.schemaVersion === ROUTING_POLICY_LEGACY_VERSION) {
    return decodeRoutingPolicy(input).policy;
  }
  assertFields(input, POLICY_FIELDS, 'routing policy');
  if (input.schemaVersion !== ROUTING_POLICY_VERSION) {
    throw new TypeError('routing policy schemaVersion must be '
      + `${ROUTING_POLICY_LEGACY_VERSION} or ${ROUTING_POLICY_VERSION}`);
  }
  const roster = validateRoster(input.roster);
  const standardRoutes = validateStandardRoutes(input.standardRoutes, roster);
  assertDerivable(roster, standardRoutes);
  return Object.freeze({
    schemaVersion: ROUTING_POLICY_VERSION,
    revision: string(input.revision, 'routing policy revision'),
    allowedSurfaces: Object.freeze(stringList(input.allowedSurfaces, 'allowedSurfaces')),
    allowedTransports: Object.freeze(stringList(input.allowedTransports, 'allowedTransports')),
    switching: oneOf(input.switching, SWITCHING, 'switching'),
    roster: Object.freeze(roster),
    standardRoutes: Object.freeze(standardRoutes),
    unreachable: oneOf(input.unreachable, UNREACHABLE, 'unreachable'),
    missingInfrastructure: oneOf(
      input.missingInfrastructure,
      MISSING_INFRASTRUCTURE,
      'missingInfrastructure',
    ),
  });
}

function droppedOptimization(document) {
  if (!('optimization' in document)) return { dropped: [], notes: [] };
  return {
    dropped: ['optimization'],
    notes: [Object.freeze({ code: 'optimization-removed', value: document.optimization ?? null })],
  };
}

/**
 * The deterministic v1 → v2 decode. The optimization dial is dropped and
 * *recorded*, never silently ignored, and the roster and Standard routes a v1
 * document cannot carry come from the derivation its caller already holds. A
 * decode that can derive neither fails closed with that reason instead of
 * producing an empty authorization that would read as a policy.
 */
export function decodeRoutingPolicy(document, derivation = {}) {
  object(document, 'routing policy');
  object(derivation, 'routing policy derivation');
  assertFields(derivation, DERIVATION_FIELDS, 'routing policy derivation');
  if (document.schemaVersion === ROUTING_POLICY_VERSION) {
    return Object.freeze({
      policy: validateRoutingPolicy(document),
      fromVersion: ROUTING_POLICY_VERSION,
      dropped: Object.freeze([]),
      notes: Object.freeze([]),
    });
  }
  if (document.schemaVersion !== ROUTING_POLICY_LEGACY_VERSION) {
    throw new TypeError('routing policy schemaVersion must be '
      + `${ROUTING_POLICY_LEGACY_VERSION} or ${ROUTING_POLICY_VERSION}`);
  }
  assertFields(document, LEGACY_POLICY_FIELDS, 'routing policy');
  const { dropped, notes } = droppedOptimization(document);
  const { schemaVersion, optimization, ...carried } = document;
  return Object.freeze({
    policy: validateRoutingPolicy({
      ...carried,
      schemaVersion: ROUTING_POLICY_VERSION,
      roster: derivation.roster ?? [],
      standardRoutes: derivation.standardRoutes
        ?? Object.fromEntries(STANDARD_ROUTE_CLASSES.map((cls) => [cls, null])),
    }),
    fromVersion: ROUTING_POLICY_LEGACY_VERSION,
    dropped: Object.freeze(dropped),
    notes: Object.freeze(notes),
  });
}
