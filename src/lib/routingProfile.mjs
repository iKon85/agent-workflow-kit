import { access, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { writeAtomic } from './atomicWrite.mjs';
import {
  AGENT_SURFACE_REGISTRY,
  AGENT_SURFACE_REGISTRY_REVISION,
  detectAgentSurfaces,
  surfaceById,
} from './agentSurfaceRegistry.mjs';
import {
  commitRoutingProfileGenerations,
  readCommittedRoutingProfilePair,
  resolveProjectIdentity,
} from './routingProfileStorage.mjs';
import { loadRoutingInventory, presentInventory } from './routingInventory.mjs';

export const ROUTING_PROFILE_VERSION = 2;
export const ROUTING_PROFILE_PATH = 'routing-profile.json';
/** The workload classes a Standard route is nominated for — the resolver's vocabulary. */
export const STANDARD_ROUTE_CLASSES = Object.freeze(['mechanical', 'development', 'judgment']);
/**
 * Per-pair roster state. `admitted` is the positive list a dispatch may pick
 * from; `declined` is a user decision that must never prompt again; `withdrawn`
 * is derived the moment the inventory no longer lists an admitted pair.
 */
export const ROSTER_PAIR_STATES = Object.freeze(['admitted', 'declined', 'withdrawn']);
/** A Standard route is either nominated and authorized, or knowingly broken. */
export const STANDARD_ROUTE_STATES = Object.freeze(['configured', 'unresolved']);

/** Loosest first: a project narrowing may only move toward the end of this list. */
const SWITCHING = Object.freeze(['automatic', 'ask', 'current-surface-only']);
const ACTIVATION = Object.freeze(['approve', 'back', 'advanced', 'safe-current-surface', 'decline']);
/** The transport by which a surface drives its own runtime, as the registry names it. */
const NATIVE_TRANSPORT = 'native';
const SHARED_FIELDS = [
  'schemaVersion', 'registryRevision', 'selectedSurfaces', 'consideredSurfaces', 'switching',
  'advanced',
];
const PROFILE_FIELDS = new Set([
  ...SHARED_FIELDS, 'authorizedTransports', 'roster', 'inventoryRevision', 'standardRoutes',
]);
const PROFILE_FIELDS_V1 = new Set(SHARED_FIELDS);
/** A project document owns nothing; every field it may carry is a narrowing axis. */
const NARROWING_FIELDS = new Set([
  'schemaVersion', 'selectedSurfaces', 'authorizedTransports', 'switching', 'roster',
  'standardRoutes',
]);
const ADVANCED_FIELDS = new Set(['legacy']);
const PAIR_FIELDS = new Set(['model', 'effort']);
/** A pair plus the state it is recorded in — the shape of a roster entry and of a Standard route. */
const STATED_PAIR_FIELDS = new Set(['model', 'effort', 'state']);
const TRANSPORT_FIELDS = new Set(['surface', 'transport']);
/** A model id may carry a context variant (`opus[1m]`); the attested channel drops it. */
const CONTEXT_VARIANT = /\[[^\]]*\]$/;

function uniqueStrings(value, field) {
  if (!Array.isArray(value) ||
      !value.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function assertFields(input, allowed, label) {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`unknown ${label} field: ${key}`);
  }
}

function plainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

/** The roster identity rule: trim and drop the context variant. */
export function normalizeRosterModelId(value, field = 'model') {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a non-empty string`);
  const model = value.trim().replace(CONTEXT_VARIANT, '').trim();
  if (!model) throw new TypeError(`${field} must be a non-empty string`);
  return model;
}

/**
 * A model-and-effort pair. Effort domains are per model, so effort is always
 * explicit: a value the model supports, or `null` for a model with no effort
 * axis. A pair is authorized as a pair, never as a model with an effort
 * attached afterwards.
 */
function validatePair(input, field) {
  plainObject(input, field);
  assertFields(input, PAIR_FIELDS, field);
  const model = normalizeRosterModelId(input.model, `${field}.model`);
  if (!('effort' in input) || (input.effort !== null &&
      (typeof input.effort !== 'string' || input.effort.trim() === ''))) {
    throw new TypeError(`${field}.effort must be a non-empty string or null (no effort axis)`);
  }
  return { model, effort: input.effort === null ? null : input.effort.trim() };
}

function pairKey({ model, effort }) {
  return `${model}\u0000${effort ?? ''}`;
}

/** The pair a diagnostic names, in the one form a human and a test both read. */
function pairLabel({ model, effort }) {
  return `${model}/${effort ?? 'no-effort'}`;
}

const barePair = ({ model, effort }) => ({ model, effort });
const admittedPairs = (roster) => roster.filter(({ state }) => state === 'admitted').map(barePair);

/** A transport authorization is a `(surface, transport)` pair, never a bare transport. */
function validateTransport(input, field) {
  plainObject(input, field);
  assertFields(input, TRANSPORT_FIELDS, field);
  for (const key of ['surface', 'transport']) {
    if (typeof input[key] !== 'string' || input[key].trim() === '') {
      throw new TypeError(`${field}.${key} must be a non-empty string`);
    }
  }
  return { surface: input.surface.trim(), transport: input.transport.trim() };
}

const transportKey = ({ surface, transport }) => `${surface}\u0000${transport}`;

/**
 * Selecting two agent apps does not authorize either to drive the other's CLI,
 * so every authorized transport names the surface it belongs to and that surface
 * must be one the document selected.
 */
function validateTransports(value, field, surfaces) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of {surface, transport} pairs`);
  }
  const authorized = new Map();
  value.forEach((input, index) => {
    const transport = validateTransport(input, `${field}[${index}]`);
    if (surfaces && !surfaces.includes(transport.surface)) {
      throw new TypeError(
        `${field}[${index}].surface must be a selected surface: ${transport.surface}`,
      );
    }
    authorized.set(transportKey(transport), transport);
  });
  return [...authorized.values()];
}

function validateRosterEntry(input, field) {
  plainObject(input, field);
  assertFields(input, STATED_PAIR_FIELDS, field);
  const pair = validatePair({ model: input.model, effort: input.effort }, field);
  if (!ROSTER_PAIR_STATES.includes(input.state)) {
    throw new TypeError(`${field}.state must be one of: ${ROSTER_PAIR_STATES.join(', ')}`);
  }
  return { ...pair, state: input.state };
}

/** The recorded roster: one state per pair. Two states for one pair is ambiguous. */
function validateRoster(value, field = 'roster') {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array of roster entries`);
  const entries = new Map();
  value.forEach((input, index) => {
    const entry = validateRosterEntry(input, `${field}[${index}]`);
    const prior = entries.get(pairKey(entry));
    if (prior && prior.state !== entry.state) {
      throw new TypeError(
        `${field} records the same pair twice with different states: ${pairLabel(entry)}`,
      );
    }
    entries.set(pairKey(entry), entry);
  });
  return [...entries.values()];
}

/** A narrowing does not decline a pair — it names the subset a project may use. */
function validateNarrowingRoster(value) {
  if (!Array.isArray(value)) throw new TypeError('roster must be an array of pairs');
  const pairs = new Map();
  value.forEach((input, index) => {
    const pair = validatePair(input, `roster[${index}]`);
    pairs.set(pairKey(pair), pair);
  });
  return [...pairs.values()];
}

function validateStandardRouteEntry(input, field) {
  plainObject(input, field);
  assertFields(input, STATED_PAIR_FIELDS, field);
  const pair = validatePair({ model: input.model, effort: input.effort }, field);
  if (!STANDARD_ROUTE_STATES.includes(input.state)) {
    throw new TypeError(`${field}.state must be one of: ${STANDARD_ROUTE_STATES.join(', ')}`);
  }
  return { ...pair, state: input.state };
}

/**
 * The global document nominates every workload class explicitly. A `configured`
 * route must name an admitted pair; an `unresolved` one is a knowingly broken
 * route the profile keeps rather than a profile the Kit calls invalid.
 */
function validateStandardRoutes(value, roster) {
  plainObject(value, 'standardRoutes');
  assertFields(value, new Set(STANDARD_ROUTE_CLASSES), 'standardRoutes');
  const authorized = new Set(admittedPairs(roster).map(pairKey));
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
    const entry = validateStandardRouteEntry(value[workload], `standardRoutes.${workload}`);
    if (entry.state === 'configured' && !authorized.has(pairKey(entry))) {
      throw new TypeError(`standardRoutes.${workload} must name an admitted roster pair`);
    }
    routes[workload] = entry;
  }
  return routes;
}

/** A project overrides the classes it names and inherits the rest. */
function validateNarrowingStandardRoutes(value) {
  plainObject(value, 'standardRoutes');
  assertFields(value, new Set(STANDARD_ROUTE_CLASSES), 'standardRoutes');
  const routes = {};
  for (const workload of STANDARD_ROUTE_CLASSES) {
    if (!(workload in value)) continue;
    routes[workload] = value[workload] === null
      ? null
      : validateStandardRouteEntry(value[workload], `standardRoutes.${workload}`);
  }
  return routes;
}

/** The inventory revision the roster was reconciled against; never a profile revision. */
function validateInventoryRevision(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('inventoryRevision must be a non-empty string or null');
  }
  return value;
}

/** v2 `advanced` carries preserved legacy evidence only — the optimization dial is gone. */
function validateAdvanced(value) {
  if (value === null) return null;
  plainObject(value, 'advanced');
  assertFields(value, ADVANCED_FIELDS, 'advanced');
  if (!('legacy' in value)) return null;
  return { legacy: structuredClone(plainObject(value.legacy, 'advanced.legacy')) };
}

function validateSharedFields(input, fields, version) {
  plainObject(input, 'routing profile');
  assertFields(input, fields, 'routing profile');
  if (input.schemaVersion !== version) {
    throw new TypeError(`routing profile schemaVersion must be ${version}`);
  }
  if (!Number.isInteger(input.registryRevision) || input.registryRevision < 0) {
    throw new TypeError('routing profile registryRevision must be a non-negative integer');
  }
  const selectedSurfaces = uniqueStrings(input.selectedSurfaces, 'selectedSurfaces');
  if (!selectedSurfaces.length) throw new TypeError('selectedSurfaces must not be empty');
  const consideredSurfaces = uniqueStrings(
    input.consideredSurfaces ?? selectedSurfaces,
    'consideredSurfaces',
  );
  if (selectedSurfaces.some((id) => !consideredSurfaces.includes(id))) {
    throw new TypeError('consideredSurfaces must include every selected surface');
  }
  if (!SWITCHING.includes(input.switching)) {
    throw new TypeError(`switching must be one of: ${SWITCHING.join(', ')}`);
  }
  return {
    schemaVersion: version,
    registryRevision: input.registryRevision,
    selectedSurfaces,
    consideredSurfaces,
    switching: input.switching,
  };
}

/** The global document: the authorization every project narrowing is derived against. */
export function validateRoutingProfile(input) {
  const shared = validateSharedFields(input, PROFILE_FIELDS, ROUTING_PROFILE_VERSION);
  const roster = validateRoster(input.roster);
  return {
    ...shared,
    authorizedTransports: validateTransports(
      input.authorizedTransports, 'authorizedTransports', shared.selectedSurfaces,
    ),
    roster,
    inventoryRevision: validateInventoryRevision(input.inventoryRevision),
    standardRoutes: validateStandardRoutes(input.standardRoutes, roster),
    advanced: validateAdvanced(input.advanced ?? null),
  };
}

/**
 * The project document: every field is a narrowing axis and `null` means "this
 * project narrows nothing here". A project owns no surfaces, no switching
 * autonomy and no roster of its own — it only ever subtracts from the global
 * authorization, which is why none of the global-only fields are accepted.
 */
export function validateRoutingNarrowing(input) {
  plainObject(input, 'routing narrowing');
  assertFields(input, NARROWING_FIELDS, 'routing narrowing');
  if (input.schemaVersion !== ROUTING_PROFILE_VERSION) {
    throw new TypeError(`routing narrowing schemaVersion must be ${ROUTING_PROFILE_VERSION}`);
  }
  const selectedSurfaces = input.selectedSurfaces == null
    ? null
    : uniqueStrings(input.selectedSurfaces, 'selectedSurfaces');
  if (selectedSurfaces && !selectedSurfaces.length) {
    throw new TypeError('selectedSurfaces must not be empty (use null to narrow no surface)');
  }
  if (input.switching != null && !SWITCHING.includes(input.switching)) {
    throw new TypeError(`switching must be one of: ${SWITCHING.join(', ')}`);
  }
  return {
    schemaVersion: ROUTING_PROFILE_VERSION,
    selectedSurfaces,
    authorizedTransports: input.authorizedTransports == null
      ? null
      : validateTransports(input.authorizedTransports, 'authorizedTransports', selectedSurfaces),
    switching: input.switching ?? null,
    roster: input.roster == null ? null : validateNarrowingRoster(input.roster),
    standardRoutes: input.standardRoutes == null
      ? null
      : validateNarrowingStandardRoutes(input.standardRoutes),
  };
}

function validateRoutingProfileV1(input) {
  const shared = validateSharedFields(input, PROFILE_FIELDS_V1, 1);
  const advanced = input.advanced;
  if (advanced !== null && (!advanced || typeof advanced !== 'object' || Array.isArray(advanced))) {
    throw new TypeError('advanced must be an object or null');
  }
  return { ...shared, advanced: advanced === null ? null : structuredClone(advanced) };
}

function emptyStandardRoutes() {
  return Object.fromEntries(STANDARD_ROUTE_CLASSES.map((workload) => [workload, null]));
}

/** Read one v1 model preference. Never throws: junk evidence is reported, not fatal. */
function readModelPreference(entry) {
  try {
    if (typeof entry === 'string') return { model: normalizeRosterModelId(entry), pair: null };
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'effort' in entry) {
      return { model: null, pair: validatePair({ model: entry.model, effort: entry.effort }, 'p') };
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return { model: normalizeRosterModelId(entry.model), pair: null };
    }
  } catch {
    return { model: null, pair: null };
  }
  return { model: null, pair: null };
}

/**
 * Reconcile v1 `advanced` explicitly: model preferences become roster pairs
 * where the evidence authorizes a pair, the removed dial and every unreconciled
 * preference are recorded, and the whole original object survives as legacy
 * evidence. Nothing the user chose is dropped.
 */
function reconcileV1Advanced(advanced) {
  const notes = [];
  const roster = [];
  if (!advanced) return { roster, notes, preserved: null };
  if ('optimization' in advanced) {
    notes.push({ code: 'optimization-removed', value: advanced.optimization });
  }
  const preferences = Array.isArray(advanced.preferredModels) ? advanced.preferredModels : [];
  preferences.forEach((entry, index) => {
    const { model, pair } = readModelPreference(entry);
    if (pair) {
      roster.push({ ...pair, state: 'admitted' });
      notes.push({ code: 'roster-pair-admitted', model: pair.model, effort: pair.effort });
    } else if (model) {
      notes.push({ code: 'model-preference-needs-effort', model });
    } else {
      notes.push({ code: 'model-preference-unreadable', index });
    }
  });
  const preserved = Object.keys(advanced).length ? { legacy: structuredClone(advanced) } : null;
  return { roster, notes, preserved };
}

function migrateRoutingProfileV1(document) {
  const { roster, notes, preserved } = reconcileV1Advanced(document.advanced);
  // v1 never asked a transport question. Reading the surfaces the user selected
  // as "may drive its own runtime" preserves what v1 meant without inventing a
  // cross-provider authorization, which stays the user's explicit decision.
  const authorizedTransports = document.selectedSurfaces
    .map((surface) => ({ surface, transport: NATIVE_TRANSPORT }));
  notes.push({
    code: 'transport-authorization-defaulted-to-native',
    surfaces: [...document.selectedSurfaces],
  });
  const profile = validateRoutingProfile({
    schemaVersion: ROUTING_PROFILE_VERSION,
    registryRevision: document.registryRevision,
    selectedSurfaces: document.selectedSurfaces,
    consideredSurfaces: document.consideredSurfaces,
    authorizedTransports,
    switching: document.switching,
    roster,
    inventoryRevision: null,
    standardRoutes: emptyStandardRoutes(),
    advanced: preserved,
  });
  return {
    profile,
    migration: {
      from: 1,
      to: ROUTING_PROFILE_VERSION,
      notes,
      backup: structuredClone(document),
    },
  };
}

const DECODERS = new Map([
  [1, (document) => migrateRoutingProfileV1(validateRoutingProfileV1(document))],
  [2, (document) => ({ profile: validateRoutingProfile(document), migration: null })],
]);

/**
 * Version-aware decode: read `schemaVersion` first, decode with that version's
 * own decoder, then migrate. An older document is never collapsed to invalid.
 */
export function decodeRoutingProfile(document) {
  plainObject(document, 'routing profile');
  const decode = DECODERS.get(document.schemaVersion);
  if (!decode) {
    throw new TypeError(
      `unsupported routing profile schemaVersion: ${JSON.stringify(document.schemaVersion)}`,
    );
  }
  return decode(document);
}

/**
 * Version-aware decode of a project narrowing. The two-level store is new, so
 * there is exactly one narrowing version — an unknown one fails closed instead
 * of being read as if it were the current shape.
 */
export function decodeRoutingNarrowing(document) {
  plainObject(document, 'routing narrowing');
  if (document.schemaVersion !== ROUTING_PROFILE_VERSION) {
    throw new TypeError(
      `unsupported routing narrowing schemaVersion: ${JSON.stringify(document.schemaVersion)}`,
    );
  }
  return { narrowing: validateRoutingNarrowing(document) };
}

const strictness = (switching) => SWITCHING.indexOf(switching);

/**
 * Every way a project document could widen the global authorization, named. A
 * narrowing may subtract from a set and move switching toward stricter — nothing
 * else. This is an authorization check only: whether a pair can actually be
 * reached is decided at dispatch time against the Access graph, not here.
 */
export function narrowingViolations(globalDocument, narrowingDocument) {
  const authorization = validateRoutingProfile(globalDocument);
  const narrowing = validateRoutingNarrowing(narrowingDocument);
  const violations = [];
  const surfaces = new Set(authorization.selectedSurfaces);
  for (const surface of narrowing.selectedSurfaces ?? []) {
    if (!surfaces.has(surface)) violations.push({ code: 'surface-not-authorized', surface });
  }
  const transports = new Set(authorization.authorizedTransports.map(transportKey));
  for (const transport of narrowing.authorizedTransports ?? []) {
    if (!transports.has(transportKey(transport))) {
      violations.push({ code: 'transport-not-authorized', ...transport });
    }
  }
  const admitted = new Set(admittedPairs(authorization.roster).map(pairKey));
  for (const pair of narrowing.roster ?? []) {
    if (!admitted.has(pairKey(pair))) violations.push({ code: 'pair-not-authorized', ...pair });
  }
  if (narrowing.switching && strictness(narrowing.switching) < strictness(authorization.switching)) {
    violations.push({
      code: 'switching-loosened', from: authorization.switching, to: narrowing.switching,
    });
  }
  // A replacement route must sit inside the roster this narrowing leaves behind,
  // not merely inside the global one.
  const effective = narrowing.roster
    ? new Set(narrowing.roster.map(pairKey).filter((key) => admitted.has(key)))
    : admitted;
  for (const [workload, entry] of Object.entries(narrowing.standardRoutes ?? {})) {
    if (entry && !effective.has(pairKey(entry))) {
      violations.push({
        code: 'standard-route-not-in-effective-roster',
        workload, model: entry.model, effort: entry.effort,
      });
    }
  }
  return violations;
}

/** One line per violation, so a rejection names what it refused and why. */
function describeNarrowingViolations(violations) {
  return violations.map((violation) => {
    if (violation.code === 'surface-not-authorized') return `${violation.code}:${violation.surface}`;
    if (violation.code === 'transport-not-authorized') {
      return `${violation.code}:${transportKey(violation).replace('\u0000', '/')}`;
    }
    if (violation.code === 'switching-loosened') {
      return `${violation.code}:${violation.from}->${violation.to}`;
    }
    if (violation.code === 'standard-route-not-in-effective-roster') {
      return `${violation.code}:${violation.workload}=${pairLabel(violation)}`;
    }
    return `${violation.code}:${pairLabel(violation)}`;
  }).join(', ');
}

/**
 * The pinned inventory the roster is reconciled against. An explicit
 * `inventory` — including an explicit `null` — wins; otherwise the shipped
 * snapshots are read, and an unreadable snapshot yields no inventory plus the
 * reason, rather than failing an update that has nothing to do with the roster.
 */
async function resolveInventory(options) {
  if (options.inventory !== undefined) return { inventory: options.inventory, error: null };
  try {
    return { inventory: await (options.loadInventory ?? loadRoutingInventory)(), error: null };
  } catch (error) {
    return { inventory: null, error: error.message };
  }
}

/** The pairs an inventory knows, keyed by pair identity after normalization. */
function knownInventoryPairs(inventory) {
  const known = new Map();
  for (const candidate of inventory.pairs) {
    const pair = {
      model: normalizeRosterModelId(candidate.modelId, 'inventory modelId'),
      effort: candidate.effort ?? null,
    };
    if (!known.has(pairKey(pair))) {
      known.set(pairKey(pair), { ...pair, surface: candidate.surface, provider: candidate.provider });
    }
  }
  return known;
}

/**
 * The roster state machine, run against one recorded inventory revision.
 *
 * Transitions: a pair the inventory adds and the roster does not record is
 * `pending` and the interview asks about it once; an `admitted` pair the
 * inventory no longer lists is `withdrawn` immediately, derived rather than
 * waiting for a write; a `declined` pair keeps its decline even when the pair
 * disappears, so a user decision is never re-asked when it comes back; and a
 * `withdrawn` pair the inventory lists again is `reopenable` — offered, never
 * silently re-admitted.
 */
export function reconcileRosterState({ roster = [], inventoryRevision = null, inventory }) {
  if (!inventory || typeof inventory.revision !== 'string' || !Array.isArray(inventory.pairs)) {
    throw new TypeError('a roster reconcile needs a loaded inventory with a revision and pairs');
  }
  const known = knownInventoryPairs(inventory);
  const recorded = new Set();
  const entries = [];
  const newlyWithdrawn = [];
  for (const entry of validateRoster(roster)) {
    const withdrawn = entry.state === 'admitted' && !known.has(pairKey(entry));
    if (withdrawn) newlyWithdrawn.push(barePair(entry));
    entries.push(withdrawn ? { ...entry, state: 'withdrawn' } : entry);
    recorded.add(pairKey(entry));
  }
  const inState = (state) => entries.filter((entry) => entry.state === state).map(barePair);
  const withdrawn = inState('withdrawn');
  return Object.freeze({
    inventoryRevision: inventory.revision,
    recordedInventoryRevision: inventoryRevision,
    stale: inventoryRevision !== inventory.revision,
    entries: Object.freeze(entries),
    admitted: Object.freeze(inState('admitted')),
    declined: Object.freeze(inState('declined')),
    withdrawn: Object.freeze(withdrawn),
    newlyWithdrawn: Object.freeze(newlyWithdrawn),
    reopenable: Object.freeze(withdrawn.filter((pair) => known.has(pairKey(pair)))),
    pending: Object.freeze([...known.values()]
      .filter((pair) => !recorded.has(pairKey(pair))).map(barePair)),
    known: Object.freeze([...known.values()]),
  });
}

/** Intersect one narrowing axis with its authorization, naming what fell out. */
function intersectAxis(authorized, narrowed, { axis, key, label }, notes) {
  if (!narrowed) return [...authorized];
  const available = new Map(authorized.map((value) => [key(value), value]));
  const wanted = new Set(narrowed.map(key));
  for (const value of narrowed) {
    if (!available.has(key(value))) {
      notes.push({ code: 'narrowing-dropped-by-global-contraction', axis, value: label(value) });
    }
  }
  return authorized.filter((value) => wanted.has(key(value)));
}

function composeStandardRoutes(authorization, narrowing, authorized, notes) {
  const routes = {};
  const blocked = [];
  for (const workload of STANDARD_ROUTE_CLASSES) {
    const override = narrowing?.standardRoutes && workload in narrowing.standardRoutes;
    const entry = override ? narrowing.standardRoutes[workload] : authorization.standardRoutes[workload];
    if (!entry) {
      routes[workload] = null;
      blocked.push({ workload, reason: 'standard-route-missing' });
      continue;
    }
    if (entry.state === 'unresolved' || !authorized.has(pairKey(entry))) {
      if (entry.state !== 'unresolved') {
        notes.push({
          code: 'standard-route-derived-unresolved',
          workload, model: entry.model, effort: entry.effort,
        });
      }
      routes[workload] = { ...barePair(entry), state: 'unresolved' };
      blocked.push({ workload, reason: 'standard-route-unresolved' });
      continue;
    }
    routes[workload] = { ...barePair(entry), state: 'configured' };
  }
  return { routes, blocked };
}

/**
 * Compose the global authorization with this project's narrowing: intersection
 * for surfaces, transports and roster, strictest-wins for switching.
 *
 * Composition answers exactly one question — what is authorized. It never
 * consults the Access graph, so an unreachable or untested pair still composes;
 * executability is decided at dispatch time. A global contraction therefore
 * never invalidates an older narrowing: the elements it lost are dropped with a
 * note, and a Standard route that named one of them is derived `unresolved` and
 * blocks its workload class. The Kit picks no replacement.
 */
export function composeRoutingProfile({ global, project = null, inventory = null }) {
  const authorization = validateRoutingProfile(global);
  const narrowing = project ? validateRoutingNarrowing(project) : null;
  const notes = [];
  const rosterState = inventory
    ? reconcileRosterState({
      roster: authorization.roster,
      inventoryRevision: authorization.inventoryRevision,
      inventory,
    })
    : null;
  const admitted = rosterState ? [...rosterState.admitted] : admittedPairs(authorization.roster);
  const selectedSurfaces = intersectAxis(authorization.selectedSurfaces, narrowing?.selectedSurfaces,
    { axis: 'surface', key: (id) => id, label: (id) => id }, notes);
  const authorizedTransports = intersectAxis(
    authorization.authorizedTransports, narrowing?.authorizedTransports,
    { axis: 'transport', key: transportKey, label: ({ surface, transport }) => `${surface}/${transport}` },
    notes,
  ).filter(({ surface }) => selectedSurfaces.includes(surface));
  const roster = intersectAxis(admitted, narrowing?.roster,
    { axis: 'pair', key: pairKey, label: pairLabel }, notes);
  const { routes, blocked } = composeStandardRoutes(
    authorization, narrowing, new Set(roster.map(pairKey)), notes,
  );
  return Object.freeze({
    selectedSurfaces: Object.freeze(selectedSurfaces),
    authorizedTransports: Object.freeze(authorizedTransports),
    switching: strictness(narrowing?.switching) > strictness(authorization.switching)
      ? narrowing.switching
      : authorization.switching,
    roster: Object.freeze(roster),
    standardRoutes: Object.freeze(routes),
    inventoryRevision: authorization.inventoryRevision,
    rosterState,
    blocked: Object.freeze(blocked),
    notes: Object.freeze(notes),
  });
}

function stateRoot(profileRoot) {
  return profileRoot ??
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-workflow-kit');
}

export function routingProfilePath(consumerRoot, profileRoot) {
  const consumerKey = createHash('sha256').update(resolve(consumerRoot)).digest('hex').slice(0, 20);
  return join(stateRoot(profileRoot), 'profiles', consumerKey, ROUTING_PROFILE_PATH);
}

/** Where the two-level store keeps its generations: one global, one per project key. */
export function routingProfileStorageRoot(profileRoot) {
  return join(stateRoot(profileRoot), 'routing');
}

async function projectIdentity({ identity, projectRoot, runGit }) {
  if (identity) return identity;
  return resolveProjectIdentity({ projectRoot, runGit });
}

function globalGeneration(envelope) {
  if (!envelope) return null;
  const { profile, migration } = decodeRoutingProfile(envelope.document);
  return {
    generation: envelope.generation,
    committedAt: envelope.committedAt,
    profile,
    migration,
  };
}

function projectGeneration(envelope) {
  if (!envelope) return null;
  return {
    generation: envelope.generation,
    committedAt: envelope.committedAt,
    authoredAgainstGlobalGeneration: envelope.authoredAgainstGlobalGeneration ?? null,
    narrowing: decodeRoutingNarrowing(envelope.document).narrowing,
  };
}

/**
 * Read the latest committed global generation plus this project's own narrowing
 * and compose them, so a global choice made after the narrowing is never
 * invisible to the project. The generation a narrowing was authored against is
 * reported for diagnostics, never used as the read key, and a project without a
 * narrowing is a normal, safe state rather than an error.
 */
export async function readComposedRoutingProfile(options) {
  const { profileRoot, projectRoot, identity, runGit } = options;
  const resolved = await projectIdentity({ identity, projectRoot, runGit });
  const pair = await readCommittedRoutingProfilePair({
    root: routingProfileStorageRoot(profileRoot),
    projectKey: resolved.key,
  });
  const reasons = [];
  if (!pair.global) reasons.push('no-global-authorization');
  if (!pair.project) reasons.push('no-project-narrowing');
  const global = globalGeneration(pair.global);
  const project = projectGeneration(pair.project);
  const { inventory } = await resolveInventory(options);
  return {
    identity: resolved,
    global,
    project,
    composed: global
      ? composeRoutingProfile({
        global: global.profile, project: project?.narrowing ?? null, inventory,
      })
      : null,
    reasons,
    pendingTransactionId: pair.pendingTransactionId,
  };
}

/** The authorization a project narrowing is derived against: the pair being committed, else the store's. */
async function authorizingGlobal(root, projectKey, globalDocument) {
  if (globalDocument) return { authorization: globalDocument, generation: undefined };
  const committed = await readCommittedRoutingProfilePair({ root, projectKey });
  if (!committed.global) {
    throw new Error('a project narrowing needs a committed global authorization: '
      + 'no-global-authorization');
  }
  return {
    authorization: decodeRoutingProfile(committed.global.document).profile,
    generation: committed.global.generation,
  };
}

/**
 * Commit the global authorization, the project narrowing, or both as one
 * transaction. Each document is validated against its own schema before it
 * reaches the store — the envelope carries the generation, the documents never
 * do — and a project document that would widen the authorization it narrows is
 * refused here, naming every axis it widened.
 */
export async function commitRoutingProfilePair({
  profileRoot, projectRoot, identity, runGit, global = null, project = null,
  expectedGlobalGeneration, expectedProjectGeneration, now,
}) {
  const resolved = await projectIdentity({ identity, projectRoot, runGit });
  const root = routingProfileStorageRoot(profileRoot);
  const globalDocument = global ? validateRoutingProfile(global) : null;
  const projectDocument = project ? validateRoutingNarrowing(project) : null;
  let expectedGlobal = expectedGlobalGeneration;
  if (projectDocument) {
    const { authorization, generation } = await authorizingGlobal(
      root, resolved.key, globalDocument,
    );
    const violations = narrowingViolations(authorization, projectDocument);
    if (violations.length) {
      throw new Error('project narrowing widens the global authorization: '
        + describeNarrowingViolations(violations));
    }
    // The narrowing was checked against the generation just read: bind the commit
    // to it so a global that moved in between fails instead of racing.
    if (expectedGlobal === undefined && generation !== undefined) expectedGlobal = generation;
  }
  return commitRoutingProfileGenerations({
    root,
    identity: resolved,
    globalDocument,
    projectDocument,
    expectedGlobalGeneration: expectedGlobal,
    expectedProjectGeneration,
    now,
  });
}

/** Where the pre-migration document is preserved before a migrated profile is written. */
export function routingProfileBackupPath(consumerRoot, profileRoot, fromVersion) {
  const path = routingProfilePath(consumerRoot, profileRoot);
  return join(dirname(path), `routing-profile.v${fromVersion}.backup.json`);
}

async function readProfileSnapshot(consumerRoot, profileRoot) {
  const path = routingProfilePath(consumerRoot, profileRoot);
  try {
    const bytes = await readFile(path, 'utf8');
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    try {
      const { profile, migration } = decodeRoutingProfile(JSON.parse(bytes));
      return { profile, migration, bytes, fingerprint, invalid: false };
    } catch {
      return { profile: null, migration: null, bytes, fingerprint, invalid: true };
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { profile: null, migration: null, bytes: null, fingerprint: null, invalid: false };
    }
    throw error;
  }
}

export async function readRoutingProfile(consumerRoot, profileRoot) {
  const snapshot = await readProfileSnapshot(consumerRoot, profileRoot);
  if (snapshot.invalid) throw new TypeError('routing profile is invalid');
  return snapshot.profile;
}

async function resolvedDetectedSurfaceIds(options) {
  if (options.detectedSurfaceIds) return uniqueStrings(options.detectedSurfaceIds, 'detectedSurfaceIds');
  const detected = await (options.detect ?? detectAgentSurfaces)();
  return detected.filter((surface) => surface.detected).map((surface) => surface.id);
}

/**
 * What the roster and the Standard routes still owe the user, and nothing more.
 *
 * A pair the roster never recorded, an admitted pair the inventory dropped, and
 * a withdrawn pair that came back each ask exactly one question. A bare
 * inventory revision bump with no pair delta asks nothing — it rides along with
 * the next authorized write, which is what keeps this from becoming the endless
 * reconcile prompt the plan set out to remove. A Standard route already stored
 * `unresolved` is a settled state and stays silent too; only a stored
 * `configured` route whose pair is no longer authorized is a new fact.
 */
function rosterDelta(profile, inventory, inventoryError) {
  if (!inventory) {
    return {
      reasons: inventoryError ? ['roster-inventory-unreadable'] : [],
      state: null,
      delta: { inventoryUnreadable: Boolean(inventoryError) },
      blocked: [],
    };
  }
  const state = reconcileRosterState({
    roster: profile.roster, inventoryRevision: profile.inventoryRevision, inventory,
  });
  const composed = composeRoutingProfile({ global: profile, inventory });
  const unresolved = composed.notes.filter(({ code }) => code === 'standard-route-derived-unresolved');
  const reasons = [];
  if (state.pending.length) reasons.push('roster-pairs-unrecorded');
  if (state.newlyWithdrawn.length) reasons.push('roster-pair-withdrawn');
  if (state.reopenable.length) reasons.push('roster-pair-reopenable');
  if (unresolved.length) reasons.push('standard-route-unresolved');
  return {
    reasons,
    state,
    blocked: composed.blocked,
    delta: {
      inventoryRevision: { from: state.recordedInventoryRevision, to: state.inventoryRevision },
      pending: [...state.pending],
      withdrawn: [...state.newlyWithdrawn],
      reopenable: [...state.reopenable],
      unresolvedRoutes: unresolved.map(({ workload, model, effort }) => ({ workload, model, effort })),
      inventoryUnreadable: false,
    },
  };
}

/** Which surfaces the registry gained or lost since the profile was written. */
function surfaceDelta(profile, registry, detectedSurfaceIds) {
  const known = new Set(registry.map(({ id }) => id));
  const considered = new Set(profile.consideredSurfaces);
  const removedSurfaceIds = profile.selectedSurfaces.filter((id) => !known.has(id));
  const newSurfaceIds = detectedSurfaceIds.filter((id) => known.has(id) && !considered.has(id));
  const reasons = [];
  if (profile.registryRevision < AGENT_SURFACE_REGISTRY_REVISION) reasons.push('materially-stale');
  if (removedSurfaceIds.length) reasons.push('removed-route');
  if (newSurfaceIds.length) reasons.push('new-meaningful-surface');
  return {
    reasons,
    delta: {
      registryRevision: { from: profile.registryRevision, to: AGENT_SURFACE_REGISTRY_REVISION },
      removedSurfaces: removedSurfaceIds.map((id) => ({ id, label: id })),
      newSurfaces: newSurfaceIds.map((id) => ({ id, label: surfaceById(id, registry).label })),
    },
  };
}

export async function inspectRoutingProfile(options) {
  const { consumerRoot, registry = AGENT_SURFACE_REGISTRY } = options;
  const detectedSurfaceIds = await resolvedDetectedSurfaceIds(options);
  const snapshot = await readProfileSnapshot(consumerRoot, options.profileRoot);
  const { profile, fingerprint, migration } = snapshot;
  const unusable = snapshot.invalid ? 'invalid' : (profile ? null : 'missing');
  if (unusable) {
    return {
      status: 'needs-reconcile',
      reasons: [unusable],
      delta: { type: `${unusable}-profile` },
      profile: null,
      migration: null,
      rosterState: null,
      fingerprint,
      detectedSurfaceIds,
    };
  }
  const surfaces = surfaceDelta(profile, registry, detectedSurfaceIds);
  const { inventory, error } = await resolveInventory(options);
  const roster = rosterDelta(profile, inventory, error);
  const reasons = [...surfaces.reasons, ...roster.reasons];
  return {
    status: reasons.length ? 'needs-reconcile' : 'still valid',
    reasons,
    delta: { type: 'profile-delta', ...surfaces.delta, roster: roster.delta },
    profile,
    migration,
    rosterState: roster.state,
    blocked: roster.blocked,
    inventory,
    fingerprint,
    detectedSurfaceIds,
  };
}

function surfaceQuestion(registry, preselected) {
  return {
    kind: 'surfaces',
    message: 'Which agent apps do you use?',
    options: registry.map(({ id, label }) => ({ id, label })),
    preselected,
  };
}

function autonomyQuestion() {
  return {
    kind: 'autonomy',
    message: 'May the Kit switch agent apps for a task?',
    options: [
      { value: 'automatic', label: 'Switch automatically' },
      { value: 'ask', label: 'Ask before switching' },
      { value: 'current-surface-only', label: 'Stay in the current app' },
    ],
  };
}

/** Every `(surface, transport)` the selected apps declare, native first. */
function transportChoices(selectedSurfaces, registry) {
  return selectedSurfaces.flatMap((id) => {
    const surface = surfaceById(id, registry);
    if (!surface) return [];
    return [...surface.adapter.transports]
      .sort((left, right) => Number(right === NATIVE_TRANSPORT) - Number(left === NATIVE_TRANSPORT))
      .map((transport) => ({
        surface: id,
        surfaceLabel: surface.label,
        transport,
        native: transport === NATIVE_TRANSPORT,
      }));
  });
}

function transportQuestion(choices) {
  return {
    kind: 'transports',
    message: 'Which runtime may each agent app drive?',
    options: choices,
    preselected: choices.filter(({ native }) => native)
      .map(({ surface, transport }) => ({ surface, transport })),
  };
}

/** How many entries a long list shows at once before it scrolls. */
const ROSTER_PAGE_SIZE = 10;

/**
 * The roster question: the inventory grouped per agent app, detected apps first,
 * with the pair count and a page size, so a list that grows to dozens of pairs
 * stays navigable instead of scrolling off the screen.
 */
function rosterQuestion({ inventory, detectedSurfaceIds, registry }, selectable, message) {
  const wanted = new Set(selectable.map(pairKey));
  const seen = new Set();
  const groups = [];
  for (const candidate of presentInventory(inventory, detectedSurfaceIds).pairs) {
    const pair = {
      model: normalizeRosterModelId(candidate.modelId, 'inventory modelId'),
      effort: candidate.effort ?? null,
    };
    if (!wanted.has(pairKey(pair)) || seen.has(pairKey(pair))) continue;
    seen.add(pairKey(pair));
    const label = surfaceById(candidate.surface, registry)?.label ?? candidate.surface;
    let group = groups.find(({ surface }) => surface === candidate.surface);
    if (!group) {
      group = {
        surface: candidate.surface,
        label,
        detected: detectedSurfaceIds.includes(candidate.surface),
        pairs: [],
      };
      groups.push(group);
    }
    group.pairs.push(pair);
  }
  return { kind: 'roster', message, groups, total: seen.size, preselected: [] };
}

function standardRouteQuestion(workload, admitted, current) {
  return {
    kind: 'standard-route',
    workload,
    message: `Which pair decides ${workload} work when no evidence covers it?`,
    options: admitted,
    current: current ?? null,
    pageSize: ROSTER_PAGE_SIZE,
  };
}

/**
 * The interview, in order, with what the user sees at each stage. The loop below
 * is driven by this table, so the sequence a reader finds here is the sequence
 * that runs.
 */
export const ROUTING_INTERVIEW_SEQUENCE = Object.freeze([
  Object.freeze({
    id: 'surfaces',
    kinds: Object.freeze(['surfaces']),
    asks: 'which agent apps you use',
    shows: 'every registered app, the detected entries preselected, one hint per app',
  }),
  Object.freeze({
    id: 'transports',
    kinds: Object.freeze(['transports']),
    asks: 'which runtime each selected app may drive',
    shows: 'one entry per app and transport, native preselected, cross-app CLI control spelled out',
    skippedWhen: 'no selected app declares a transport',
  }),
  Object.freeze({
    id: 'switching',
    kinds: Object.freeze(['autonomy']),
    asks: 'whether the Kit may move a task to another app',
    shows: 'the three switching modes with what each one does',
    skippedWhen: 'a single app is selected — there is nothing to switch to',
  }),
  Object.freeze({
    id: 'roster',
    kinds: Object.freeze(['roster']),
    asks: 'which model-and-effort pairs the Kit may pick from',
    shows: 'the pinned inventory grouped per app, detected apps first, with the pair count, '
      + 'a page size, and the warning that an unselected pair is recorded as declined',
    skippedWhen: 'the pinned inventory is unreadable or has nothing left to decide',
  }),
  Object.freeze({
    id: 'standardRoutes',
    kinds: Object.freeze(['standard-route']),
    asks: 'which admitted pair decides a workload class without decisive evidence',
    shows: 'one question per workload class over the admitted pairs, each answerable with none',
    skippedWhen: 'no pair is admitted, so there is nothing to nominate',
  }),
  Object.freeze({
    id: 'activation',
    kinds: Object.freeze(['activation', 'advanced']),
    asks: 'whether to store the reviewed profile',
    shows: 'the whole draft — apps, transports, switching, roster counts, Standard routes, '
      + 'advanced draft — plus what each action does',
  }),
]);

async function askSurfaces(context, draft) {
  const selected = uniqueStrings(
    await context.prompt(surfaceQuestion(context.registry, context.preselected)),
    'selected surfaces',
  ).filter((id) => context.knownSurfaces.has(id));
  if (!selected.length) selected.push(context.currentSurface);
  draft.selectedSurfaces = selected;
  return 'ok';
}

async function askTransports(context, draft) {
  const choices = transportChoices(draft.selectedSurfaces, context.registry);
  if (!choices.length) {
    draft.authorizedTransports = [];
    return 'ok';
  }
  const offered = new Map(choices.map((choice) => [
    transportKey(choice), { surface: choice.surface, transport: choice.transport },
  ]));
  const answer = await context.prompt(transportQuestion(choices));
  draft.authorizedTransports = (Array.isArray(answer) ? answer : [])
    .filter((entry) => entry && offered.has(transportKey(entry)))
    .map((entry) => offered.get(transportKey(entry)));
  return 'ok';
}

async function askSwitching(context, draft) {
  if (draft.selectedSurfaces.length === 1) {
    draft.switching = 'current-surface-only';
    return 'ok';
  }
  const chosen = await context.prompt(autonomyQuestion());
  if (!SWITCHING.includes(chosen)) throw new TypeError('invalid autonomy choice');
  draft.switching = chosen;
  return 'ok';
}

/**
 * Record one answer per offered pair: what the user picked is `admitted`, what
 * they left is `declined`. A decline is a durable decision, which is exactly why
 * the pair is never offered again until the user reopens it.
 */
function mergeRosterAnswer(entries, selectable, answer) {
  const offered = new Set(selectable.map(pairKey));
  const chosen = new Set((Array.isArray(answer) ? answer : [])
    .filter((pair) => pair && offered.has(pairKey(pair)))
    .map(pairKey));
  const decided = new Map(entries.map((entry) => [pairKey(entry), entry]));
  for (const pair of selectable) {
    decided.set(pairKey(pair), {
      ...pair, state: chosen.has(pairKey(pair)) ? 'admitted' : 'declined',
    });
  }
  return [...decided.values()];
}

async function askRoster(context, draft) {
  if (!context.inventory) {
    draft.roster = [];
    draft.inventoryRevision = null;
    return 'ok';
  }
  const state = reconcileRosterState({ roster: [], inventoryRevision: null, inventory: context.inventory });
  draft.inventoryRevision = state.inventoryRevision;
  draft.roster = state.pending.length
    ? mergeRosterAnswer([], [...state.pending],
      await context.prompt(rosterQuestion(context, state.pending,
        'Which model-and-effort pairs may the Kit use?')))
    : [];
  return 'ok';
}

/** Match an answer back onto the offered pairs; anything else nominates nothing. */
function matchOffered(answer, offered) {
  const known = new Map(offered.map((pair) => [pairKey(pair), pair]));
  return answer && known.get(pairKey(answer)) ? known.get(pairKey(answer)) : null;
}

async function askStandardRoutes(context, draft) {
  draft.standardRoutes = emptyStandardRoutes();
  const admitted = admittedPairs(draft.roster);
  if (!admitted.length) return 'ok';
  for (const workload of STANDARD_ROUTE_CLASSES) {
    const chosen = matchOffered(
      await context.prompt(standardRouteQuestion(workload, admitted, null)), admitted,
    );
    draft.standardRoutes[workload] = chosen ? { ...chosen, state: 'configured' } : null;
  }
  return 'ok';
}

/** One activation review: back, decline, optional advanced draft, or activate. */
async function askActivation(context, draft) {
  while (true) {
    const action = await context.prompt({
      kind: 'activation',
      message: 'Review routing activation',
      selectedSurfaces: draft.selectedSurfaces,
      authorizedTransports: draft.authorizedTransports,
      switching: draft.switching,
      roster: draft.roster,
      standardRoutes: draft.standardRoutes,
      advancedDraft: draft.advanced,
      actions: ACTIVATION,
    });
    if (!ACTIVATION.includes(action)) throw new TypeError('invalid activation choice');
    if (action === 'back') return 'back';
    if (action === 'decline') return 'declined';
    if (action === 'advanced') {
      draft.advanced = await context.prompt({
        kind: 'advanced',
        message: 'Optional model and optimization preferences',
        draft: draft.advanced,
      });
      if (!draft.advanced || typeof draft.advanced !== 'object' || Array.isArray(draft.advanced)) {
        throw new TypeError('advanced choice must be an object');
      }
      continue;
    }
    if (action === 'safe-current-surface') draft.switching = 'current-surface-only';
    return 'ok';
  }
}

const STAGE_HANDLERS = Object.freeze({
  surfaces: askSurfaces,
  transports: askTransports,
  switching: askSwitching,
  roster: askRoster,
  standardRoutes: askStandardRoutes,
  activation: askActivation,
});

export async function setupRoutingProfile(options) {
  const { consumerRoot, prompt, registry = AGENT_SURFACE_REGISTRY } = options;
  if (typeof prompt !== 'function') {
    return { status: 'needs-reconcile', reasons: ['personal-choice-required'] };
  }
  const detectedSurfaceIds = await resolvedDetectedSurfaceIds(options);
  const currentSurface = options.currentSurface ?? detectedSurfaceIds[0] ?? registry[0]?.id;
  if (!surfaceById(currentSurface, registry)) throw new TypeError('currentSurface must be registered');
  const expectedFingerprint = options.expectedFingerprint === undefined
    ? (await readProfileSnapshot(consumerRoot, options.profileRoot)).fingerprint
    : options.expectedFingerprint;
  const knownSurfaces = new Set(registry.map(({ id }) => id));
  const preselected = detectedSurfaceIds.filter((id) => knownSurfaces.has(id));
  if (!preselected.includes(currentSurface)) preselected.unshift(currentSurface);
  const { inventory } = await resolveInventory(options);
  const context = {
    prompt, registry, knownSurfaces, preselected, currentSurface, detectedSurfaceIds, inventory,
  };

  while (true) {
    const draft = { advanced: null };
    const outcome = await runInterview(context, draft);
    if (outcome === 'back') continue;
    if (outcome === 'declined') return { status: 'declined' };
    const profile = validateRoutingProfile({
      schemaVersion: ROUTING_PROFILE_VERSION,
      registryRevision: AGENT_SURFACE_REGISTRY_REVISION,
      selectedSurfaces: draft.selectedSurfaces,
      consideredSurfaces: [...new Set([...preselected, ...draft.selectedSurfaces])],
      authorizedTransports: draft.authorizedTransports,
      switching: draft.switching,
      roster: draft.roster,
      inventoryRevision: draft.inventoryRevision,
      standardRoutes: draft.standardRoutes,
      advanced: legacyAdvanced(draft.advanced),
    });
    await writeProfileExpected(options, profile, expectedFingerprint);
    return { status: 'activated', profile };
  }
}

/** Run the declared sequence once; `back` restarts it from the first stage. */
async function runInterview(context, draft) {
  for (const stage of ROUTING_INTERVIEW_SEQUENCE) {
    const outcome = await STAGE_HANDLERS[stage.id](context, draft);
    if (outcome !== 'ok') return outcome;
  }
  return 'ok';
}

/** An advanced draft the v2 schema does not model is kept verbatim as legacy evidence. */
function legacyAdvanced(draft) {
  if (!draft || !Object.keys(draft).length) return null;
  const keys = Object.keys(draft);
  if (keys.length === 1 && keys[0] === 'legacy') return validateAdvanced(draft);
  return { legacy: structuredClone(draft) };
}

export async function reconcileRoutingProfile(options, inspection) {
  if (inspection.status === 'still valid') return { status: 'still valid' };
  if (typeof options.prompt !== 'function') {
    return { status: 'needs-reconcile', reasons: inspection.reasons };
  }
  const choice = await options.prompt({
    kind: 'reconcile',
    message: 'Your routing choices need review.',
    reasons: inspection.reasons,
    delta: inspection.delta,
    actions: ['review', 'decline'],
  });
  if (choice === 'decline' || choice?.action === 'decline') {
    return { status: 'declined', reasons: inspection.reasons };
  }
  if (!inspection.profile) {
    if (choice !== 'review' && choice?.action !== 'review') {
      return { status: 'declined', reasons: inspection.reasons };
    }
    return setupRoutingProfile({ ...options, expectedFingerprint: inspection.fingerprint });
  }
  if (choice !== 'apply' && choice?.action !== 'apply') {
    return { status: 'declined', reasons: inspection.reasons };
  }

  const surfaces = reconcileSurfaces(options, inspection, choice);
  const roster = await reconcileRoster(options, inspection);
  const profile = validateRoutingProfile({
    ...inspection.profile,
    registryRevision: AGENT_SURFACE_REGISTRY_REVISION,
    selectedSurfaces: surfaces.selectedSurfaces,
    consideredSurfaces: surfaces.consideredSurfaces,
    // A transport belongs to a surface: dropping the surface drops its authorization.
    authorizedTransports: inspection.profile.authorizedTransports
      .filter(({ surface }) => surfaces.selectedSurfaces.includes(surface)),
    switching: surfaces.switching,
    roster: roster.entries,
    inventoryRevision: roster.inventoryRevision,
    standardRoutes: await reconcileStandardRoutes(options, inspection, roster.entries),
  });
  await writeProfileExpected(options, profile, inspection.fingerprint);
  return { status: 'reconciled', reasons: inspection.reasons, profile };
}

/** The surface half of a reconcile: only the surfaced delta may change a choice. */
function reconcileSurfaces(options, inspection, choice) {
  const removed = new Set(inspection.delta.removedSurfaces.map(({ id }) => id));
  const requestedAdds = new Set(choice.addSurfaceIds ?? []);
  const knownAdds = inspection.delta.newSurfaces
    .map(({ id }) => id)
    .filter((id) => requestedAdds.has(id));
  const selectedSurfaces = [
    ...inspection.profile.selectedSurfaces.filter((id) => !removed.has(id)),
    ...knownAdds,
  ];
  let switching = inspection.profile.switching;
  if (!selectedSurfaces.length) {
    const safeSurface = options.currentSurface ??
      inspection.detectedSurfaceIds[0] ??
      AGENT_SURFACE_REGISTRY[0].id;
    selectedSurfaces.push(safeSurface);
    switching = 'current-surface-only';
  }
  return {
    selectedSurfaces,
    consideredSurfaces: [
      ...inspection.profile.consideredSurfaces.filter((id) => !removed.has(id)),
      ...inspection.delta.newSurfaces.map(({ id }) => id),
    ],
    switching,
  };
}

/**
 * The roster half of a reconcile: ask only about the pairs this run actually
 * changed. With nothing new to decide, the derived states are persisted and the
 * recorded inventory revision rides along with this authorized write.
 */
async function reconcileRoster(options, inspection) {
  const state = inspection.rosterState;
  if (!state) {
    return {
      entries: inspection.profile.roster,
      inventoryRevision: inspection.profile.inventoryRevision,
    };
  }
  const selectable = [...state.pending, ...state.reopenable];
  if (!selectable.length) {
    return { entries: [...state.entries], inventoryRevision: state.inventoryRevision };
  }
  const context = {
    inventory: inspection.inventory,
    detectedSurfaceIds: inspection.detectedSurfaceIds,
    registry: options.registry ?? AGENT_SURFACE_REGISTRY,
  };
  const answer = await options.prompt(rosterQuestion(
    context, selectable, 'Your Model roster changed — which pairs may the Kit use?',
  ));
  return {
    entries: mergeRosterAnswer([...state.entries], selectable, answer),
    inventoryRevision: state.inventoryRevision,
  };
}

/**
 * A Standard route whose pair is no longer admitted is persisted `unresolved`,
 * and the user is asked once for a replacement. Answering nothing leaves the
 * route unresolved and its workload class blocked — the Kit never picks a
 * replacement, and an already-unresolved route is not asked about again.
 */
async function reconcileStandardRoutes(options, inspection, roster) {
  const admitted = admittedPairs(roster);
  const authorized = new Set(admitted.map(pairKey));
  const routes = { ...inspection.profile.standardRoutes };
  for (const workload of STANDARD_ROUTE_CLASSES) {
    const entry = routes[workload];
    if (!entry || entry.state !== 'configured' || authorized.has(pairKey(entry))) continue;
    routes[workload] = { ...barePair(entry), state: 'unresolved' };
    if (!admitted.length) continue;
    const chosen = matchOffered(
      await options.prompt(standardRouteQuestion(workload, admitted, routes[workload])), admitted,
    );
    if (chosen) routes[workload] = { ...chosen, state: 'configured' };
  }
  return routes;
}

/**
 * Preserve the pre-migration document before a migrated profile replaces it.
 * The earliest preserved evidence wins: an existing backup is never overwritten.
 */
async function backupLegacyDocument(options, snapshot) {
  const path = routingProfileBackupPath(
    options.consumerRoot,
    options.profileRoot,
    snapshot.migration.from,
  );
  if (await access(path).then(() => true, () => false)) return;
  await writeAtomic(path, snapshot.bytes);
}

async function writeProfileExpected(options, profile, expectedFingerprint) {
  const path = routingProfilePath(options.consumerRoot, options.profileRoot);
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  let lock;
  try {
    lock = await open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('concurrent routing profile mutation: profile lock is held');
    }
    throw error;
  }
  try {
    const snapshot = await readProfileSnapshot(options.consumerRoot, options.profileRoot);
    if (snapshot.fingerprint !== expectedFingerprint) {
      throw new Error('concurrent routing profile mutation: profile changed during decision');
    }
    if (snapshot.migration) await backupLegacyDocument(options, snapshot);
    await writeAtomic(path, `${JSON.stringify(profile, null, 2)}\n`);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
