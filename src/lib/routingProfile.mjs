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

export const ROUTING_PROFILE_VERSION = 2;
export const ROUTING_PROFILE_PATH = 'routing-profile.json';
/** The workload classes a Standard route is nominated for — the resolver's vocabulary. */
export const STANDARD_ROUTE_CLASSES = Object.freeze(['mechanical', 'development', 'judgment']);

const SWITCHING = Object.freeze(['automatic', 'ask', 'current-surface-only']);
const ACTIVATION = Object.freeze(['approve', 'back', 'advanced', 'safe-current-surface', 'decline']);
const SHARED_FIELDS = [
  'schemaVersion', 'registryRevision', 'selectedSurfaces', 'consideredSurfaces', 'switching',
  'advanced',
];
const PROFILE_FIELDS = new Set([...SHARED_FIELDS, 'roster', 'standardRoutes']);
const PROFILE_FIELDS_V1 = new Set(SHARED_FIELDS);
const ADVANCED_FIELDS = new Set(['legacy']);
const PAIR_FIELDS = new Set(['model', 'effort']);
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

function validateRoster(value) {
  if (!Array.isArray(value)) throw new TypeError('roster must be an array of pairs');
  const pairs = new Map();
  value.forEach((entry, index) => {
    const pair = validatePair(entry, `roster[${index}]`);
    pairs.set(pairKey(pair), pair);
  });
  return [...pairs.values()];
}

function validateStandardRoutes(value, roster) {
  plainObject(value, 'standardRoutes');
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
    const pair = validatePair(value[workload], `standardRoutes.${workload}`);
    if (!authorized.has(pairKey(pair))) {
      throw new TypeError(`standardRoutes.${workload} must name a roster pair`);
    }
    routes[workload] = pair;
  }
  return routes;
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

export function validateRoutingProfile(input) {
  const shared = validateSharedFields(input, PROFILE_FIELDS, ROUTING_PROFILE_VERSION);
  const roster = validateRoster(input.roster);
  return {
    ...shared,
    roster,
    standardRoutes: validateStandardRoutes(input.standardRoutes, roster),
    advanced: validateAdvanced(input.advanced ?? null),
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
      roster.push(pair);
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
  const profile = validateRoutingProfile({
    schemaVersion: ROUTING_PROFILE_VERSION,
    registryRevision: document.registryRevision,
    selectedSurfaces: document.selectedSurfaces,
    consideredSurfaces: document.consideredSurfaces,
    switching: document.switching,
    roster,
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

export function routingProfilePath(consumerRoot, profileRoot) {
  const root = profileRoot ??
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-workflow-kit');
  const consumerKey = createHash('sha256').update(resolve(consumerRoot)).digest('hex').slice(0, 20);
  return join(root, 'profiles', consumerKey, ROUTING_PROFILE_PATH);
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
      fingerprint,
      detectedSurfaceIds,
    };
  }
  const known = new Set(registry.map(({ id }) => id));
  const considered = new Set(profile.consideredSurfaces);
  const reasons = [];
  const removedSurfaceIds = profile.selectedSurfaces.filter((id) => !known.has(id));
  const newSurfaceIds = detectedSurfaceIds.filter((id) => known.has(id) && !considered.has(id));
  if (profile.registryRevision < AGENT_SURFACE_REGISTRY_REVISION) reasons.push('materially-stale');
  if (removedSurfaceIds.length) reasons.push('removed-route');
  if (newSurfaceIds.length) reasons.push('new-meaningful-surface');
  return {
    status: reasons.length ? 'needs-reconcile' : 'still valid',
    reasons,
    delta: {
      type: 'profile-delta',
      registryRevision: {
        from: profile.registryRevision,
        to: AGENT_SURFACE_REGISTRY_REVISION,
      },
      removedSurfaces: removedSurfaceIds.map((id) => ({ id, label: id })),
      newSurfaces: newSurfaceIds.map((id) => {
        const surface = surfaceById(id, registry);
        return { id, label: surface.label };
      }),
    },
    profile,
    migration,
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

export async function setupRoutingProfile(options) {
  const {
    consumerRoot,
    prompt,
    registry = AGENT_SURFACE_REGISTRY,
  } = options;
  if (typeof prompt !== 'function') {
    return { status: 'needs-reconcile', reasons: ['personal-choice-required'] };
  }
  const detectedSurfaceIds = await resolvedDetectedSurfaceIds(options);
  const currentSurface = options.currentSurface ?? detectedSurfaceIds[0] ?? registry[0]?.id;
  if (!surfaceById(currentSurface, registry)) throw new TypeError('currentSurface must be registered');
  const expectedFingerprint = options.expectedFingerprint === undefined
    ? (await readProfileSnapshot(consumerRoot, options.profileRoot)).fingerprint
    : options.expectedFingerprint;
  const known = new Set(registry.map(({ id }) => id));
  const preselected = detectedSurfaceIds.filter((id) => known.has(id));
  if (!preselected.includes(currentSurface)) preselected.unshift(currentSurface);

  while (true) {
    const selectedSurfaces = uniqueStrings(
      await prompt(surfaceQuestion(registry, preselected)),
      'selected surfaces',
    ).filter((id) => known.has(id));
    if (!selectedSurfaces.length) selectedSurfaces.push(currentSurface);
    const chosen = selectedSurfaces.length === 1
      ? 'current-surface-only'
      : await prompt(autonomyQuestion());
    if (!SWITCHING.includes(chosen)) throw new TypeError('invalid autonomy choice');

    const round = await activationRound(prompt, selectedSurfaces, chosen);
    if (round.outcome === 'back') continue;
    if (round.outcome === 'declined') return { status: 'declined' };
    const profile = validateRoutingProfile({
      schemaVersion: ROUTING_PROFILE_VERSION,
      registryRevision: AGENT_SURFACE_REGISTRY_REVISION,
      selectedSurfaces,
      consideredSurfaces: [...new Set([...preselected, ...selectedSurfaces])],
      switching: round.switching,
      roster: [],
      standardRoutes: emptyStandardRoutes(),
      advanced: legacyAdvanced(round.advanced),
    });
    await writeProfileExpected(options, profile, expectedFingerprint);
    return { status: 'activated', profile };
  }
}

/** One activation review: back, decline, optional advanced draft, or activate. */
async function activationRound(prompt, selectedSurfaces, switching) {
  let advanced = null;
  while (true) {
    const action = await prompt({
      kind: 'activation',
      message: 'Review routing activation',
      selectedSurfaces,
      switching,
      advancedDraft: advanced,
      actions: ACTIVATION,
    });
    if (!ACTIVATION.includes(action)) throw new TypeError('invalid activation choice');
    if (action === 'back') return { outcome: 'back' };
    if (action === 'decline') return { outcome: 'declined' };
    if (action === 'advanced') {
      advanced = await prompt({
        kind: 'advanced',
        message: 'Optional model and optimization preferences',
        draft: advanced,
      });
      if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced)) {
        throw new TypeError('advanced choice must be an object');
      }
      continue;
    }
    return {
      outcome: 'activate',
      switching: action === 'safe-current-surface' ? 'current-surface-only' : switching,
      advanced,
    };
  }
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
  const profile = validateRoutingProfile({
    ...inspection.profile,
    registryRevision: AGENT_SURFACE_REGISTRY_REVISION,
    selectedSurfaces,
    consideredSurfaces: [
      ...inspection.profile.consideredSurfaces.filter((id) => !removed.has(id)),
      ...inspection.delta.newSurfaces.map(({ id }) => id),
    ],
    switching,
  });
  await writeProfileExpected(options, profile, inspection.fingerprint);
  return { status: 'reconciled', reasons: inspection.reasons, profile };
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
