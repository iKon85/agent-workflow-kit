/**
 * The Access graph — the user-local map of native and cross-provider paths by
 * which an agent surface can reach a model runtime, together with dated
 * capability attestations.
 *
 * A path identifies a model-AND-effort pair, so only an exact pair match
 * resolves and availability is attested per pair rather than per model.
 * Detection is never authorization: a freshly built path is `unknown`, and only
 * a user-authorized capability probe promotes it to `available` or writes a
 * dated `unavailable` attestation. `unknown` is not a deadlock — a supervised
 * run may take the `verification-required` route to produce the proof, while an
 * AFK dispatch stays blocked until that proof exists.
 *
 * Only a deterministic unsupported or authorization failure may mutate
 * availability. A timeout, rate limit, malformed response or transient provider
 * failure leaves the path `unknown`, so one bad minute cannot poison the graph.
 */
import { createHash } from 'node:crypto';

export const ACCESS_GRAPH_VERSION = 2;

export const ROUTE_AVAILABILITY = Object.freeze([
  'available',
  'unavailable',
  'unknown',
]);

export const ENFORCEMENT_METHODS = Object.freeze([
  'per-spawn',
  'named-agent',
  'session-default',
  'none',
]);

/** What one pair may do next, once the graph has been consulted. */
export const ACCESS_ROUTE_STATES = Object.freeze([
  'ready',
  'verification-required',
  'blocked',
]);

const PATH_FIELDS = new Set([
  'id', 'surfaceId', 'providerId', 'modelId', 'effort', 'transportId',
  'availability', 'enforcement', 'capabilityEvidence', 'attestation',
]);

const ATTESTATION_FIELDS = new Set([
  'result', 'failureKind', 'probeId', 'authorizationId', 'observedAt', 'expiresAt',
]);

const CAPABILITY_IDENTITY = ['surfaceId', 'providerId', 'modelId', 'transportId'];

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

function oneOf(value, values, field) {
  if (!values.includes(value)) throw new TypeError(`${field} must be one of: ${values.join(', ')}`);
  return value;
}

function timestamp(value, field) {
  string(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return value;
}

function dated(input, field) {
  const observedAt = timestamp(input.observedAt, `${field}.observedAt`);
  const expiresAt = timestamp(input.expiresAt, `${field}.expiresAt`);
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError(`${field}.expiresAt must follow observedAt`);
  }
  return { observedAt, expiresAt };
}

function closedFields(value, allowed, message) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${message}: ${key}`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The pair identity of a path: surface, provider, model, effort, transport. */
export function accessPairKey(path) {
  return JSON.stringify([
    path.surfaceId, path.providerId, path.modelId, path.effort ?? null, path.transportId,
  ]);
}

/** Content-derived revision: an unchanged graph keeps its revision. */
export function deriveAccessGraphRevision(paths) {
  return `sha256-${createHash('sha256').update(canonical(paths)).digest('base64url')}`;
}

function validateAttestation(input, field, availability) {
  const attestation = `${field}.attestation`;
  if (input == null) {
    if (availability !== 'unknown') {
      throw new TypeError(`${field}.availability requires a dated attestation`);
    }
    return null;
  }
  if (availability === 'unknown') {
    throw new TypeError(`${field}: unknown availability must carry no attestation`);
  }
  object(input, attestation);
  closedFields(input, ATTESTATION_FIELDS, 'unknown access attestation field');
  const result = oneOf(input.result, ['available', 'unavailable'], `${attestation}.result`);
  if (result !== availability) {
    throw new TypeError(`${attestation} result must match the recorded availability`);
  }
  const failureKind = input.failureKind == null
    ? null
    : string(input.failureKind, `${attestation}.failureKind`);
  if ((result === 'unavailable') !== (failureKind !== null)) {
    throw new TypeError(`${attestation}.failureKind belongs to an unavailable attestation only`);
  }
  return {
    result,
    failureKind,
    probeId: string(input.probeId, `${attestation}.probeId`),
    authorizationId: string(input.authorizationId, `${attestation}.authorizationId`),
    ...dated(input, attestation),
  };
}

function validatePath(path, index) {
  const field = `paths[${index}]`;
  object(path, field);
  closedFields(path, PATH_FIELDS, 'unknown access path field');
  const enforcement = object(path.enforcement, `${field}.enforcement`);
  const evidence = object(path.capabilityEvidence, `${field}.capabilityEvidence`);
  const availability = oneOf(path.availability, ROUTE_AVAILABILITY, `${field}.availability`);
  return {
    id: string(path.id, `${field}.id`),
    surfaceId: string(path.surfaceId, `${field}.surfaceId`),
    providerId: string(path.providerId, `${field}.providerId`),
    modelId: string(path.modelId, `${field}.modelId`),
    effort: path.effort === null ? null : string(path.effort, `${field}.effort`),
    transportId: string(path.transportId, `${field}.transportId`),
    availability,
    enforcement: {
      model: oneOf(enforcement.model, ENFORCEMENT_METHODS, `${field}.enforcement.model`),
      effort: oneOf(enforcement.effort, ENFORCEMENT_METHODS, `${field}.enforcement.effort`),
    },
    capabilityEvidence: {
      revision: string(evidence.revision, `${field}.capabilityEvidence.revision`),
      ...dated(evidence, `${field}.capabilityEvidence`),
    },
    attestation: validateAttestation(path.attestation, field, availability),
  };
}

export function validateAccessGraph(input) {
  object(input, 'access graph');
  if (input.schemaVersion !== ACCESS_GRAPH_VERSION) {
    throw new TypeError(`access graph schemaVersion must be ${ACCESS_GRAPH_VERSION}`);
  }
  const revision = string(input.revision, 'access graph revision');
  if (!Array.isArray(input.paths)) throw new TypeError('access graph paths must be an array');
  const paths = input.paths.map(validatePath);
  const ids = new Set();
  const pairs = new Set();
  for (const path of paths) {
    if (ids.has(path.id)) throw new TypeError(`duplicate access path: ${path.id}`);
    ids.add(path.id);
    const pair = accessPairKey(path);
    if (pairs.has(pair)) {
      throw new TypeError(`duplicate access pair: ${path.modelId}+${path.effort ?? 'none'}`);
    }
    pairs.add(pair);
  }
  return deepFreeze({ schemaVersion: ACCESS_GRAPH_VERSION, revision, paths });
}

/** Validate a path list and stamp it with its content-derived revision. */
export function sealAccessGraph(paths) {
  const validated = validateAccessGraph({
    schemaVersion: ACCESS_GRAPH_VERSION,
    revision: 'derived',
    paths,
  });
  return validateAccessGraph({
    ...validated,
    revision: deriveAccessGraphRevision(validated.paths),
  });
}

/** Exact pair match. A requested effort the path never attested never matches. */
export function accessPathMatchesPair(path, pair) {
  if (!path || !pair) return false;
  if (path.providerId !== pair.providerId || path.modelId !== pair.modelId) return false;
  if ((path.effort ?? null) !== (pair.effort ?? null)) return false;
  if (pair.surfaceId !== undefined && path.surfaceId !== pair.surfaceId) return false;
  if (pair.transportId !== undefined && path.transportId !== pair.transportId) return false;
  return true;
}

export function selectAccessPaths(graph, pair) {
  return validateAccessGraph(graph).paths.filter((path) => accessPathMatchesPair(path, pair));
}

/**
 * The executable state of one pair: attested access is `ready`, untested access
 * is `verification-required` for a supervised run and blocked for an AFK one.
 */
export function resolveAccessRoute(graph, pair, { afk = false } = {}) {
  const matches = selectAccessPaths(graph, pair);
  const label = `${pair?.providerId}:${pair?.modelId}:${pair?.effort ?? 'none'}`;
  if (matches.length === 0) {
    return Object.freeze({ state: 'blocked', path: null, reason: `pair-not-attested:${label}` });
  }
  const available = matches.find((path) => path.availability === 'available');
  if (available) {
    return Object.freeze({ state: 'ready', path: available, reason: `access-attested:${available.id}` });
  }
  const untested = matches.find((path) => path.availability === 'unknown');
  if (untested) {
    return Object.freeze(afk
      ? { state: 'blocked', path: untested, reason: `afk-requires-attested-access:${untested.id}` }
      : { state: 'verification-required', path: untested, reason: `access-unknown:${untested.id}` });
  }
  return Object.freeze({
    state: 'blocked',
    path: matches[0],
    reason: `route-unavailable:${matches[0].id}`,
  });
}

/**
 * Assemble surface-adapter attestations into a graph. A path whose capability
 * the surface could not attest never becomes dispatchable, a pair outside the
 * model's effort domain is refused, and a previously recorded availability is
 * carried forward so a rebuild never silently rewrites authorization.
 */
export function buildAccessGraph({ attestations, previous = null, effortDomains = null } = {}) {
  if (!Array.isArray(attestations)) {
    throw new TypeError('access graph attestations must be an array');
  }
  const prior = previous == null
    ? new Map()
    : new Map(validateAccessGraph(previous).paths.map((path) => [accessPairKey(path), path]));
  const paths = [];
  for (const [index, record] of attestations.entries()) {
    const field = `attestations[${index}]`;
    object(record, field);
    if (record.attested !== true) continue;
    const providerId = string(record.providerId, `${field}.providerId`);
    const modelId = string(record.modelId, `${field}.modelId`);
    const effort = record.effort == null ? null : string(record.effort, `${field}.effort`);
    const domain = effortDomains?.[`${providerId}:${modelId}`];
    if (Array.isArray(domain) && !domain.includes(effort)) {
      throw new TypeError(
        `${field}.effort is outside the model effort domain: ${modelId}+${effort ?? 'none'}`,
      );
    }
    const path = {
      id: record.id,
      surfaceId: record.surfaceId,
      providerId,
      modelId,
      effort,
      transportId: record.transportId,
      availability: 'unknown',
      enforcement: record.enforcement,
      capabilityEvidence: record.capabilityEvidence,
      attestation: null,
    };
    const carried = prior.get(accessPairKey(path));
    if (carried) {
      path.availability = carried.availability;
      path.attestation = carried.attestation;
    }
    paths.push(path);
  }
  return sealAccessGraph(paths);
}

/** Adapter-side identity match: surface, provider, model and transport. */
export function capabilityPathMatchesIdentity(path, route) {
  return CAPABILITY_IDENTITY.every((field) => path?.[field] === route?.[field]);
}

/** Adapter-side pair match: identity plus the exact attested effort. */
export function capabilityPathMatchesPair(path, route) {
  const applied = path?.effort?.applied;
  return capabilityPathMatchesIdentity(path, route)
    && typeof applied === 'string'
    && applied !== 'unknown'
    && applied === route?.effort;
}

/**
 * Pick the capability path for a requested route: the exact pair when one
 * exists, otherwise the identity match, so an unattested control still reports
 * its own verification failure instead of looking like a missing route.
 */
export function selectCapabilityPath(paths, route) {
  const candidates = paths.filter((path) => capabilityPathMatchesIdentity(path, route));
  if (candidates.length === 0) return null;
  return candidates.find((path) => capabilityPathMatchesPair(path, route)) ?? candidates[0];
}

/** Turn one normalized surface-capability path into an Access-graph attestation. */
export function attestAccessPath(path, { revision, observedAt, expiresAt } = {}) {
  const capabilityEvidence = Object.freeze({
    revision: string(revision, 'capability attestation revision'),
    ...dated({ observedAt, expiresAt }, 'capability attestation'),
  });
  const attested = path.verified === true;
  return Object.freeze({
    id: path.id,
    surfaceId: path.surfaceId,
    providerId: path.providerId,
    modelId: path.modelId,
    effort: attested ? path.effort.applied : null,
    transportId: path.transportId,
    attested,
    attestationFailures: Object.freeze([...path.verificationFailures]),
    enforcement: Object.freeze({ model: path.model.method, effort: path.effort.method }),
    capabilityEvidence,
  });
}
