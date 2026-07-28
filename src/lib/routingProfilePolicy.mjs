/**
 * Deriving the Routing policy from a composed Routing profile.
 *
 * A Routing profile is the stored personal choice and carries no revision; the
 * Routing policy is the revisioned constraint object derived from it for one
 * dispatch. Derivation is a pure function: the same composed profile, the same
 * two document generations and the same inventory revision always produce the
 * same policy and the same revision, so a Dispatch receipt can name one
 * revision and a later re-derivation can prove the constraints did not move.
 *
 * The revision is a canonical hash over exactly three facts — the global
 * generation, the project generation, and the inventory revision. Those three
 * are what a composed authorization is a function of: every profile change
 * commits a new immutable generation, and every roster reconcile names an
 * inventory revision. Hashing the composed values themselves would add nothing
 * and would stop the revision being a token a store can compare.
 *
 * Nothing here consults the Access graph, the Evidence catalog, the resolver or
 * a dispatcher. Composition and derivation answer "what is authorized";
 * executability is decided at decision time.
 */
import { createHash } from 'node:crypto';

import { STANDARD_ROUTE_CLASSES } from './routingProfile.mjs';
import { ROUTING_POLICY_VERSION, validateRoutingPolicy } from './routingPolicy.mjs';

/** The revision inputs — those three, nothing else. */
export const ROUTING_POLICY_REVISION_INPUTS = Object.freeze([
  'globalGeneration',
  'projectGeneration',
  'inventoryRevision',
]);

/** The fail-closed fallbacks a profile does not carry and a caller may override. */
const DEFAULT_UNREACHABLE = 'block';
const DEFAULT_MISSING_INFRASTRUCTURE = 'block';

const COMPOSED_FIELDS = ['selectedSurfaces', 'authorizedTransports', 'switching', 'roster',
  'standardRoutes'];

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

/** Key order is fixed, so the same three facts always hash to the same digest. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const sha256 = (text) => `sha256-${createHash('sha256').update(text).digest('base64url')}`;

function generation(value, field, { required }) {
  if (value === null || value === undefined) {
    if (required) throw new TypeError(`${field} must be a non-negative integer`);
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * The policy revision: a canonical hash over exactly the global generation, the
 * project generation and the inventory revision. A policy without a committed
 * global authorization cannot exist, so the global generation is required; a
 * project without a narrowing is a normal state and contributes `null`.
 */
export function routingPolicyRevision(input) {
  object(input, 'routing policy revision input');
  assertFields(input, new Set(ROUTING_POLICY_REVISION_INPUTS), 'routing policy revision input');
  const inventoryRevision = input.inventoryRevision ?? null;
  if (inventoryRevision !== null
      && (typeof inventoryRevision !== 'string' || inventoryRevision.trim() === '')) {
    throw new TypeError('inventoryRevision must be a non-empty string or null');
  }
  return sha256(canonical({
    globalGeneration: generation(input.globalGeneration, 'globalGeneration', { required: true }),
    projectGeneration: generation(input.projectGeneration, 'projectGeneration', { required: false }),
    inventoryRevision,
  }));
}

/** Project a composed profile onto the policy's axes, without reinterpreting it. */
function authorizationOf(composed) {
  object(composed, 'composed routing profile');
  for (const field of COMPOSED_FIELDS) {
    if (composed[field] === undefined) {
      throw new TypeError(`composed routing profile is missing ${field}`);
    }
  }
  if (!Array.isArray(composed.authorizedTransports)) {
    throw new TypeError('composed routing profile authorizedTransports must be an array');
  }
  return {
    allowedSurfaces: [...composed.selectedSurfaces],
    // The resolver matches a path's transport id, so the policy carries ids.
    allowedTransports: composed.authorizedTransports.map(({ transport }) => transport),
    roster: composed.roster.map(({ model, effort }) => ({ model, effort })),
    standardRoutes: Object.fromEntries(
      STANDARD_ROUTE_CLASSES.map((cls) => [cls, composed.standardRoutes?.[cls] ?? null]),
    ),
  };
}

/**
 * Derive the Routing policy for one dispatch. The inventory revision defaults to
 * the one the composition actually reconciled the roster against, so the
 * revision names the inventory that produced the effective roster rather than a
 * separately supplied one. `unreachable` and `missingInfrastructure` are not
 * profile fields; they default fail-closed and every explicit value is
 * validated. A composed profile that authorizes nothing throws with the named
 * reason instead of yielding an empty policy.
 */
export function deriveRoutingPolicy({
  composed,
  globalGeneration,
  projectGeneration = null,
  inventoryRevision,
  unreachable = DEFAULT_UNREACHABLE,
  missingInfrastructure = DEFAULT_MISSING_INFRASTRUCTURE,
}) {
  const authorization = authorizationOf(composed);
  const reconciled = inventoryRevision === undefined
    ? (composed.rosterState?.inventoryRevision ?? composed.inventoryRevision ?? null)
    : inventoryRevision;
  return validateRoutingPolicy({
    schemaVersion: ROUTING_POLICY_VERSION,
    revision: routingPolicyRevision({
      globalGeneration,
      projectGeneration,
      inventoryRevision: reconciled,
    }),
    allowedSurfaces: authorization.allowedSurfaces,
    allowedTransports: authorization.allowedTransports,
    switching: composed.switching,
    roster: authorization.roster,
    standardRoutes: authorization.standardRoutes,
    unreachable,
    missingInfrastructure,
  });
}
