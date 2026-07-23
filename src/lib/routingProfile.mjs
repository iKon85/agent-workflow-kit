import { mkdir, open, readFile, rm } from 'node:fs/promises';
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

export const ROUTING_PROFILE_VERSION = 1;
export const ROUTING_PROFILE_PATH = 'routing-profile.json';

const SWITCHING = Object.freeze(['automatic', 'ask', 'current-surface-only']);
const ACTIVATION = Object.freeze(['approve', 'back', 'advanced', 'safe-current-surface', 'decline']);
const PROFILE_FIELDS = new Set([
  'schemaVersion', 'registryRevision', 'selectedSurfaces', 'consideredSurfaces',
  'switching', 'advanced',
]);

function uniqueStrings(value, field) {
  if (!Array.isArray(value) ||
      !value.every((entry) => typeof entry === 'string' && entry.trim() !== '')) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

export function validateRoutingProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('routing profile must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!PROFILE_FIELDS.has(key)) throw new TypeError(`unknown routing profile field: ${key}`);
  }
  if (input.schemaVersion !== ROUTING_PROFILE_VERSION) {
    throw new TypeError(`routing profile schemaVersion must be ${ROUTING_PROFILE_VERSION}`);
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
  if (input.advanced !== null &&
      (!input.advanced || typeof input.advanced !== 'object' || Array.isArray(input.advanced))) {
    throw new TypeError('advanced must be an object or null');
  }
  return {
    schemaVersion: ROUTING_PROFILE_VERSION,
    registryRevision: input.registryRevision,
    selectedSurfaces,
    consideredSurfaces,
    switching: input.switching,
    advanced: input.advanced === null ? null : structuredClone(input.advanced),
  };
}

export function routingProfilePath(consumerRoot, profileRoot) {
  const root = profileRoot ??
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'agent-workflow-kit');
  const consumerKey = createHash('sha256').update(resolve(consumerRoot)).digest('hex').slice(0, 20);
  return join(root, 'profiles', consumerKey, ROUTING_PROFILE_PATH);
}

async function readProfileSnapshot(consumerRoot, profileRoot) {
  const path = routingProfilePath(consumerRoot, profileRoot);
  try {
    const bytes = await readFile(path, 'utf8');
    const fingerprint = createHash('sha256').update(bytes).digest('hex');
    try {
      return { profile: validateRoutingProfile(JSON.parse(bytes)), fingerprint, invalid: false };
    } catch {
      return { profile: null, fingerprint, invalid: true };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { profile: null, fingerprint: null, invalid: false };
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
  const { profile, fingerprint } = snapshot;
  if (snapshot.invalid) {
    return {
      status: 'needs-reconcile',
      reasons: ['invalid'],
      delta: { type: 'invalid-profile' },
      profile: null,
      fingerprint,
      detectedSurfaceIds,
    };
  }
  if (!profile) {
    return {
      status: 'needs-reconcile',
      reasons: ['missing'],
      delta: { type: 'missing-profile' },
      profile: null,
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
    let switching = selectedSurfaces.length === 1
      ? 'current-surface-only'
      : await prompt(autonomyQuestion());
    if (!SWITCHING.includes(switching)) throw new TypeError('invalid autonomy choice');

    let advanced = null;
    let revisitChoices = false;
    while (true) {
      const summary = {
        kind: 'activation',
        message: 'Review routing activation',
        selectedSurfaces,
        switching,
        advancedDraft: advanced,
        actions: ACTIVATION,
      };
      const action = await prompt(summary);
      if (!ACTIVATION.includes(action)) throw new TypeError('invalid activation choice');
      if (action === 'back') {
        revisitChoices = true;
        break;
      }
      if (action === 'decline') return { status: 'declined' };
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
      if (action === 'safe-current-surface') switching = 'current-surface-only';
      const profile = validateRoutingProfile({
        schemaVersion: ROUTING_PROFILE_VERSION,
        registryRevision: AGENT_SURFACE_REGISTRY_REVISION,
        selectedSurfaces,
        consideredSurfaces: [...new Set([...preselected, ...selectedSurfaces])],
        switching,
        advanced,
      });
      await writeProfileExpected(options, profile, expectedFingerprint);
      return { status: 'activated', profile };
    }
    if (revisitChoices) continue;
  }
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
    const actual = (await readProfileSnapshot(options.consumerRoot, options.profileRoot)).fingerprint;
    if (actual !== expectedFingerprint) {
      throw new Error('concurrent routing profile mutation: profile changed during decision');
    }
    await writeAtomic(path, `${JSON.stringify(profile, null, 2)}\n`);
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
