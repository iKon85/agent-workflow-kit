/**
 * The Dispatch plan and the authorization record that binds it.
 *
 * A delegating workflow presents one table before its first dispatch: each unit
 * of work with its Routing intent, the chosen route, and the reason that route
 * won. It runs the two stages in order — intent resolution first (an explicit
 * intent, otherwise the provider-neutral workflow classifier), then route
 * selection against decisive evidence, otherwise the Standard route for the
 * resolved workload class. A route is never an intent source, so nothing that
 * comes out of stage two ever flows back into stage one.
 *
 * The plan is canonicalized and hashed over every unit, intent, route, reason
 * and the policy, catalog and Access-graph revisions, and that hash is bound to
 * an authorization record naming id, scope, mode, timestamp and actor. Every
 * dispatch references the record and every receipt carries its id, so a wave is
 * authorized once and that authorization cannot silently cover something else:
 * a mismatch blocks pending a newly attributed authorization. Only a recorded
 * mode that explicitly permits bounded dynamic re-resolution continues, and only
 * within the axes it names — a bound may accept a *different route for the same
 * work*, never different work and never a changed authorization basis, which is
 * why `units`, `intent`, `intentSource` and `policy` can never be bounded.
 */
import { createHash } from 'node:crypto';

import { resolveRoute } from './routingResolver.mjs';
import { resolveRoutingIntent } from './routingIntentClassifier.mjs';

export const DISPATCH_PLAN_VERSION = 1;

export const PLAN_AUTHORIZATION_MODES = Object.freeze(['fixed', 'bounded-re-resolution']);

/** What a bounded mode may cover: a re-chosen route and the facts that moved it. */
export const BOUNDED_RE_RESOLUTION_AXES = Object.freeze([
  'route', 'reason', 'origin', 'state', 'catalog', 'accessGraph',
]);

export const PLAN_AUTHORIZATION_MISMATCH = 'dispatch plan authorization does not cover this dispatch';
export const PLAN_UNIT_UNAUTHORIZED = 'dispatch plan authorization names no such unit';
export const PLAN_ROUTE_DRIFT = 'dispatch route differs from the authorized dispatch plan';

const UNIT_FIELDS = ['unitId', 'intent', 'signals', 'approval'];
const UNIT_AXES = ['intentSource', 'intent', 'origin', 'state', 'route', 'reason'];
const REVISION_AXES = ['catalog', 'accessGraph', 'policy'];
const ROUTE_FIELDS = ['providerId', 'modelId', 'effort', 'surfaceId', 'transportId'];
const RECORD_FIELDS = ['id', 'scope', 'mode', 'timestamp', 'actor', 'bounds'];

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

function closedFields(value, allowed, message) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${message}: ${key}`);
  }
  return value;
}

/** The dispatchable identity of the selected candidate, or none if it has no path. */
function plannedRoute(selected) {
  if (!selected || typeof selected.modelId !== 'string' || typeof selected.surfaceId !== 'string') {
    return null;
  }
  return Object.freeze(Object.fromEntries(
    ROUTE_FIELDS.map((field) => [field, selected[field] ?? null]),
  ));
}

function plannedUnit(input, resolverInput) {
  closedFields(object(input, 'dispatch plan unit'), UNIT_FIELDS, 'unknown dispatch plan unit field');
  const resolved = resolveRoutingIntent({
    explicit: input.intent ?? null, signals: input.signals ?? null,
  });
  const decision = resolveRoute({
    ...resolverInput,
    intent: resolved.intent,
    ...(input.approval == null ? {} : { approval: input.approval }),
  });
  return {
    revisions: decision.revisions,
    unit: Object.freeze({
      unitId: string(input.unitId, 'dispatch plan unitId'),
      intentSource: resolved.source,
      intent: resolved.intent,
      origin: decision.origin,
      state: decision.state,
      route: plannedRoute(decision.selected),
      reason: decision.selected?.reason ?? decision.reason,
    }),
  };
}

/** One plan decides under one set of revisions; a plan that cannot name them is not bindable. */
function planRevisions(entries) {
  const [first, ...rest] = entries.map(({ revisions }) => revisions);
  for (const field of REVISION_AXES) {
    if (typeof first[field] !== 'string') {
      throw new TypeError(`dispatch plan requires a ${field} revision`);
    }
    if (rest.some((revisions) => revisions[field] !== first[field])) {
      throw new TypeError(`dispatch plan units disagree on the ${field} revision`);
    }
  }
  return Object.freeze(Object.fromEntries(REVISION_AXES.map((field) => [field, first[field]])));
}

export function buildDispatchPlan(input) {
  object(input, 'dispatch plan input');
  if (!Array.isArray(input.units) || input.units.length === 0) {
    throw new TypeError('dispatch plan needs at least one unit');
  }
  const entries = input.units.map((unit) => plannedUnit(unit, input.resolverInput));
  const units = sortedUnits(entries.map(({ unit }) => unit));
  units.forEach((unit, index) => {
    if (index > 0 && units[index - 1].unitId === unit.unitId) {
      throw new TypeError(`duplicate dispatch plan unit: ${unit.unitId}`);
    }
  });
  const document = {
    schemaVersion: DISPATCH_PLAN_VERSION,
    units: Object.freeze(units),
    revisions: planRevisions(entries),
  };
  return Object.freeze({ ...document, planHash: dispatchPlanHash(document) });
}

const sortedUnits = (units) =>
  [...units].sort((left, right) => left.unitId.localeCompare(right.unitId));

/** Key order, unit order and absent values never change what a plan is. */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value === undefined ? null : value;
}

export function canonicalizeDispatchPlan(plan) {
  object(plan, 'dispatch plan');
  if (!Array.isArray(plan.units)) throw new TypeError('dispatch plan units must be an array');
  return JSON.stringify(canonicalValue({
    schemaVersion: plan.schemaVersion,
    units: sortedUnits(plan.units),
    revisions: plan.revisions,
  }));
}

export function dispatchPlanHash(plan) {
  return `sha256-${createHash('sha256').update(canonicalizeDispatchPlan(plan)).digest('hex')}`;
}

function validateBounds(input, mode) {
  if (mode === 'fixed') {
    if (input != null) throw new TypeError('a fixed plan authorization records no bounds');
    return null;
  }
  if (input == null || !Array.isArray(object(input, 'plan authorization bounds').axes)
      || input.axes.length === 0) {
    throw new TypeError('bounded re-resolution must name the axes it covers');
  }
  closedFields(input, ['axes'], 'unknown plan authorization bounds field');
  for (const axis of input.axes) {
    if (!BOUNDED_RE_RESOLUTION_AXES.includes(axis)) {
      throw new TypeError(`bounded re-resolution cannot cover: ${axis}`);
    }
  }
  return Object.freeze({ axes: Object.freeze([...new Set(input.axes)].sort()) });
}

export function authorizeDispatchPlan(plan, input) {
  const planHash = dispatchPlanHash(plan);
  closedFields(object(input, 'plan authorization'), RECORD_FIELDS, 'unknown plan authorization field');
  if (!PLAN_AUTHORIZATION_MODES.includes(input.mode)) {
    throw new TypeError(
      `plan authorization mode must be one of: ${PLAN_AUTHORIZATION_MODES.join(', ')}`,
    );
  }
  string(input.timestamp, 'plan authorization timestamp');
  if (!Number.isFinite(Date.parse(input.timestamp))) {
    throw new TypeError('plan authorization timestamp must be an ISO timestamp');
  }
  return Object.freeze({
    schemaVersion: DISPATCH_PLAN_VERSION,
    id: string(input.id, 'plan authorization id'),
    scope: string(input.scope, 'plan authorization scope'),
    mode: input.mode,
    timestamp: input.timestamp,
    actor: string(input.actor, 'plan authorization actor'),
    bounds: validateBounds(input.bounds ?? null, input.mode),
    planHash,
    // The bound contents, so a mismatch can name what actually moved.
    plan: Object.freeze({
      schemaVersion: plan.schemaVersion,
      units: Object.freeze(sortedUnits(plan.units)),
      revisions: plan.revisions,
    }),
  });
}

const sameValue = (left, right) =>
  JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));

/** Which axes moved between the authorized plan and the one about to run. */
function planDrift(authorized, current) {
  const axes = new Set();
  for (const field of REVISION_AXES) {
    if (authorized.revisions?.[field] !== current.revisions?.[field]) axes.add(field);
  }
  const currentUnits = new Map(current.units.map((unit) => [unit.unitId, unit]));
  const authorizedIds = authorized.units.map((unit) => unit.unitId);
  if (authorizedIds.length !== currentUnits.size
      || authorizedIds.some((unitId) => !currentUnits.has(unitId))) {
    axes.add('units');
  }
  for (const unit of authorized.units) {
    const other = currentUnits.get(unit.unitId);
    if (!other) continue;
    for (const axis of UNIT_AXES) {
      if (!sameValue(unit[axis], other[axis])) axes.add(axis);
    }
  }
  return Object.freeze([...axes].sort());
}

const blockedCheck = (mode, drift, outside) => Object.freeze({
  state: 'blocked', mode, drift, outside, reason: PLAN_AUTHORIZATION_MISMATCH,
});

export function checkPlanAuthorization(input) {
  object(input, 'plan authorization check');
  const authorization = object(input.authorization, 'plan authorization');
  const plan = object(input.plan, 'dispatch plan');
  // A record whose bound contents no longer hash to the id it carries proves
  // nothing about the plan the user saw, so it authorizes nothing.
  if (dispatchPlanHash(authorization.plan) !== authorization.planHash) {
    return blockedCheck(authorization.mode, Object.freeze(['authorization']), Object.freeze(['authorization']));
  }
  const drift = dispatchPlanHash(plan) === authorization.planHash
    ? Object.freeze([])
    : planDrift(authorization.plan, plan);
  if (drift.length === 0) {
    return Object.freeze({
      state: 'authorized', mode: authorization.mode, drift, outside: drift, reason: null,
    });
  }
  const allowed = authorization.bounds?.axes ?? [];
  const outside = Object.freeze(drift.filter((axis) => !allowed.includes(axis)));
  if (authorization.mode === 'bounded-re-resolution' && outside.length === 0) {
    return Object.freeze({
      state: 'authorized', mode: authorization.mode, drift, outside, reason: null,
    });
  }
  return blockedCheck(authorization.mode, drift, outside);
}

/**
 * The dispatch-time gate: the authorization must still cover the plan, the plan
 * must carry the unit, and the route about to run must be the one the unit was
 * authorized for. The returned id is what the Dispatch receipt carries, blocked
 * or not, so a refusal stays attributable to the authorization it was checked
 * against.
 */
export function authorizeDispatchUnit(input) {
  object(input, 'dispatch authorization input');
  const authorizationId = input.authorization?.id ?? null;
  const blocked = (reason) => Object.freeze({ authorizationId, reason });
  const check = checkPlanAuthorization(input);
  if (check.state !== 'authorized') return blocked(check.reason);
  const unit = input.plan.units.find((entry) => entry.unitId === input.unitId);
  if (!unit) return blocked(PLAN_UNIT_UNAUTHORIZED);
  if (input.route != null && !sameValue(unit.route, plannedRoute(input.route))) {
    return blocked(PLAN_ROUTE_DRIFT);
  }
  return blocked(null);
}
