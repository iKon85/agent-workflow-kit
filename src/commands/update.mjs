import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertConsumerReleaseParity } from '../../scripts/release-parity.mjs';
import {
  activateCandidate, adoptReadinessCandidate, materializeUpdateCandidate, readReadinessManifest,
} from '../lib/updateCandidate.mjs';
import {
  verifyCandidateSchema, verifyUpdateCandidate,
} from '../lib/verifyUpdateCandidate.mjs';
import { reconcile } from '../lib/updateReconcile.mjs';
import {
  CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME, PROJECT_SKILL_REGISTRY_PATH, readManifest,
} from '../lib/manifest.mjs';
import {
  inspectRoutingProfile, reconcileRoutingProfile,
} from '../lib/routingProfile.mjs';
import { evaluateConsumerMigrations } from '../lib/consumerMigrations.mjs';

const RELEASE_NAME = '@ikon85/agent-workflow-kit';

export function renderUpdateFailure(result) {
  const failure = result.failure ?? { phase: 'unknown', consumerState: 'unknown' };
  return `candidate update failed · phase: ${failure.phase} · ` +
    `consumerState: ${failure.consumerState} · ${result.error}`;
}

/**
 * Transactionally reconcile a consumer with a parity-proven kit release.
 * checking -> preview/awaiting_decision -> staging -> verifying -> terminal state.
 */
export async function update(options) {
  const preflight = options.routingProfile
    ? await inspectRoutingProfile({ consumerRoot: options.consumerRoot, ...options.routingProfile })
    : null;
  const result = await updatePackage(options);
  if (!preflight || options.dryRun || result.state !== 'applied') return result;
  const inspection = await inspectRoutingProfile({
    consumerRoot: options.consumerRoot,
    ...options.routingProfile,
  });
  return {
    ...result,
    routingProfile: await reconcileRoutingProfile(
      { consumerRoot: options.consumerRoot, ...options.routingProfile },
      inspection,
    ),
  };
}

async function updatePackage(options) {
  const {
    kitRoot, consumerRoot, decide = () => false, dryRun = false,
    releaseIdentities, verify = verifyUpdateCandidate, activate = activateCandidate,
    signal, onState = () => {}, resumeFrom,
  } = options;
  const history = [];
  const transition = async (state) => { history.push(state); await onState(state); };

  await transition('checking');
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  if (!pkg) throw new Error('kit package manifest not found');
  if (!dryRun) verifyRelease(releaseIdentities, pkg.kitVersion);
  const consumerManifestPath = join(consumerRoot, CONSUMER_MANIFEST_NAME);
  const priorConsumerManifest = await readManifest(consumerManifestPath);
  if (!priorConsumerManifest) {
    throw new Error('not initialised — run `init` first');
  }
  const consumerManifestBefore = await readFile(consumerManifestPath);
  const priorReadinessManifest = await readReadinessManifest(consumerRoot);
  const nextReadinessManifest = await readReadinessManifest(kitRoot);

  const decisions = new Map();
  const choosePreview = async (action, path) => {
    if (action === 'collision') return undefined;
    const key = decisionKey(action, path);
    if (!decisions.has(key)) decisions.set(key, await decide(action, path));
    return decisions.get(key);
  };
  // Required consumer migrations are decisions the consumer still owes; `update`
  // never writes the consumer's project layer, so the pre-apply reading is also
  // the post-apply state. Detected once, rendered by every surface.
  const requiredMigrations = await evaluateConsumerMigrations({
    consumerRoot, kitVersion: pkg.kitVersion,
  });
  const preview = await reconcile({ kitRoot, consumerRoot, decide: choosePreview, dryRun: true });
  preview.requiredMigrations = requiredMigrations;
  let previewFailure;
  try {
    Object.assign(preview, await previewReadinessAdoption({
      kitRoot, consumerRoot, pkg, priorReadinessManifest, nextReadinessManifest,
    }));
    preview.conflicts.push(...(preview.migrationConflicts ?? []).map(migrationConflictRecord));
  } catch (error) {
    previewFailure = error;
  }
  await transition('preview');
  if (previewFailure) {
    return {
      ...await terminal(preview, 'failed', history, transition), error: previewFailure.message,
      failure: { phase: 'staging', consumerState: 'unchanged' },
    };
  }
  if (dryRun) return { ...preview, state: 'preview', history, report: reportOf(preview) };
  if (preview.migrationConflicts?.length) {
    return terminal(preview, 'conflicted', history, transition);
  }
  if (preview.conflicts.length) return terminal(preview, 'conflicted', history, transition);
  const resolvedPreview = await resolvePreview({
    kitRoot, consumerRoot, preview, decisions, decide, transition,
  });
  resolvedPreview.requiredMigrations = requiredMigrations;
  if (resolvedPreview.collisions.length) {
    return terminal(resolvedPreview, 'conflicted', history, transition);
  }
  if (resolvedPreview.conflicts.length) {
    return terminal(resolvedPreview, 'conflicted', history, transition);
  }
  if (!hasUpstreamDelta(resolvedPreview)) {
    return { ...await terminal(resolvedPreview, 'applied', history, transition), status: 'current' };
  }
  return applyTransaction({
    kitRoot, consumerRoot, pkg, preview: resolvedPreview, decisions, verify, activate, signal, resumeFrom,
    consumerManifestBefore, priorConsumerManifest,
    priorReadinessManifest, nextReadinessManifest, history, transition,
  });
}

async function previewReadinessAdoption(context) {
  const {
    kitRoot, consumerRoot, pkg, priorReadinessManifest, nextReadinessManifest,
  } = context;
  const candidateRoot = await materializeUpdateCandidate({
    consumerRoot, pkg, priorReadinessManifest, nextReadinessManifest,
  });
  try {
    const candidatePreview = await reconcile({
      kitRoot, consumerRoot: candidateRoot,
      decide: (action) => action === 'collision' ? 'keep-as-owned' : false,
    });
    const readiness = await adoptReadinessCandidate({
      candidateRoot, consumerRoot, kitRoot, priorManifest: priorReadinessManifest,
      nextManifest: nextReadinessManifest,
    });
    candidatePreview.generated = readiness.generated;
    candidatePreview.migrations = readiness.migrations;
    candidatePreview.migrated = readiness.migrated;
    if (!readiness.migrationConflicts.length && !candidatePreview.conflicts.length) {
      await verifyCandidateSchema(candidateRoot, {
        pkg, preview: candidatePreview, priorReadinessManifest, nextReadinessManifest,
      });
    }
    return readiness;
  } finally {
    await rm(candidateRoot, { recursive: true, force: true });
  }
}

async function resolvePreview({ kitRoot, consumerRoot, preview, decisions, decide, transition }) {
  if (preview.deleted.length || preview.keptDeleted.length || preview.collisions.length) {
    await transition('awaiting_decision');
  }
  for (const path of preview.collisions) {
    const classification = preview.ownershipStates?.find(
      (candidate) => candidate.path === path,
    );
    decisions.set(
      decisionKey('collision', path),
      await decide('collision', path, classification),
    );
  }
  if (!preview.collisions.length) return preview;
  return reconcile({
    kitRoot, consumerRoot, dryRun: true,
    decide: (action, path) => decisions.get(decisionKey(action, path)),
  });
}

async function applyTransaction(context) {
  const {
    kitRoot, consumerRoot, pkg, preview, decisions, verify, activate, signal, resumeFrom,
    consumerManifestBefore, priorConsumerManifest,
    priorReadinessManifest, nextReadinessManifest, history, transition,
  } = context;
  let candidateRoot = resumeFrom;
  let keepCandidate = false;
  let phase = 'staging';
  try {
    await transition('staging');
    if (candidateRoot && preview.collisionResolutions.length) {
      throw new Error('collision-bearing candidate cannot be resumed safely');
    }
    if (!candidateRoot) {
      candidateRoot = await materializeUpdateCandidate({
        consumerRoot, pkg, priorReadinessManifest, nextReadinessManifest,
      });
      await reconcile({
        kitRoot, consumerRoot: candidateRoot,
        decide: (action, path) => decisions.get(decisionKey(action, path)),
      });
    }
    phase = 'verification';
    await transition('verifying');
    const abort = async () => {
      keepCandidate = true;
      return { ...await terminal(preview, 'aborted', history, transition), candidateRoot };
    };
    if (signal?.aborted) return abort();
    const canonicalContext = {
      pkg: structuredClone(pkg),
      preview: structuredClone(preview),
      priorConsumerManifest: structuredClone(priorConsumerManifest),
      priorReadinessManifest: structuredClone(priorReadinessManifest),
      nextReadinessManifest: structuredClone(nextReadinessManifest),
    };
    const readiness = await adoptReadinessCandidate({
      candidateRoot, consumerRoot, kitRoot, priorManifest: priorReadinessManifest,
      nextManifest: nextReadinessManifest,
    });
    preview.generated = readiness.generated;
    preview.migrations = readiness.migrations;
    preview.migrated = readiness.migrated;
    preview.migrationConflicts = readiness.migrationConflicts;
    preview.availability = readiness.availability;
    if (readiness.migrationConflicts.length) {
      throw new Error(`readiness migration conflict: ${readiness.migrationConflicts.join(', ')}`);
    }
    if (readiness.incompatible.length) {
      throw new Error(`monotonic compatibility would block existing skill core: ${readiness.incompatible.join(', ')}`);
    }
    canonicalContext.preview = structuredClone(preview);
    await verifyCandidateSchema(candidateRoot, canonicalContext);
    await verifyUpdateCandidate(candidateRoot, canonicalContext);
    if (verify !== verifyUpdateCandidate) {
      const extensionContext = structuredClone(canonicalContext);
      await verify(candidateRoot, extensionContext);
      await verifyUpdateCandidate(candidateRoot, canonicalContext);
    }
    if (signal?.aborted) return abort();
    phase = 'activation';
    await activate({
      candidateRoot, consumerRoot,
      pkg: canonicalContext.pkg,
      preview: canonicalContext.preview,
      consumerManifestBefore,
    });
    return { ...await terminal(preview, 'applied', history, transition), status: 'updated' };
  } catch (error) {
    return {
      ...await terminal(preview, 'failed', history, transition), error: error.message,
      failure: { phase, consumerState: error.consumerState ?? 'unchanged' },
    };
  } finally {
    if (candidateRoot && !keepCandidate) await rm(candidateRoot, { recursive: true, force: true });
  }
}

function decisionKey(action, path) {
  return `${action}\0${path}`;
}

function verifyRelease(identities, kitVersion) {
  const release = assertConsumerReleaseParity(identities);
  if (release.name !== RELEASE_NAME) throw new Error(`invalid release origin: ${release.name}`);
  if (release.version !== kitVersion) {
    throw new Error(`release version ${release.version} does not match kit ${kitVersion}`);
  }
}

function hasUpstreamDelta(result) {
  return result.manifestChanged ||
    (result.migrations?.length ?? 0) > 0 ||
    (result.bridgeRetired?.length ?? 0) > 0 ||
    result.added.length + result.updated.length + result.deleted.length > 0;
}

async function terminal(result, state, history, transition) {
  await transition(state);
  return { ...result, state, history, report: reportOf(result) };
}

function reportOf(result) {
  return {
    unchanged: result.unchanged.length,
    added: result.added.length,
    updated: result.updated.length,
    deleted: result.deleted.length,
    localModified: result.userModified.length,
    conflicts: result.conflicts.length,
    keptDeleted: result.keptDeleted.length,
    paths: {
      added: result.added,
      updated: result.updated,
      deleted: result.deleted,
      localModified: result.userModified,
      conflicts: result.conflicts.map(({ path }) => path),
      keptDeleted: result.keptDeleted,
    },
    recommendation: updateRecommendation(result),
    requiredMigrations: result.requiredMigrations ?? [],
  };
}

function updateRecommendation(result) {
  if (result.migrationConflicts?.length) {
    return migrationRecommendation(result.migrationConflicts);
  }
  if (result.collisions.length
      || result.conflicts.some(({ kind }) => kind === 'ownership-lifecycle')) {
    return ownershipRecommendation(result);
  }
  return result.conflicts.length
    ? 'Review each named conflict; keep the local file or apply the incoming diff manually.'
    : null;
}

function migrationConflictRecord(detail) {
  const path = detail.split(': ', 1)[0];
  const projectRegistry = path === PROJECT_SKILL_REGISTRY_PATH
    || path === '.claude/skills/skill-manifest.json';
  return {
    path,
    kind: projectRegistry ? 'skill-registry' : 'prod-section',
    diff: projectRegistry
      ? `Skill registry migration is ambiguous: ${detail}`
      : 'Prod section differs from the other instruction surface or is malformed.',
  };
}

function migrationRecommendation(conflicts) {
  const registryConflict = conflicts.some((detail) => (
    detail.startsWith(`${PROJECT_SKILL_REGISTRY_PATH}:`)
    || detail.startsWith('.claude/skills/skill-manifest.json:')
  ));
  return (registryConflict
    ? `Readiness migration is ambiguous in: ${conflicts.join(', ')}. `
    : `Prod sections differ or are malformed in: ${conflicts.join(', ')}. `) +
    'Resolve them manually; no consumer file was changed.';
}

function ownershipRecommendation(result) {
  const paths = new Set([
    ...result.collisions,
    ...result.conflicts.filter(({ kind }) => kind === 'ownership-lifecycle')
      .map(({ path }) => path),
  ]);
  const unresolved = (result.ownershipStates ?? []).filter(
    ({ path }) => paths.has(path),
  );
  return unresolved.map(({ path, state, evidence, routes }) => (
    `${path}: ${state} ` +
    `(package=${evidence.packageDeclared ? 'declared' : 'absent'}, ` +
    `ledger=${evidence.ledgerOrigin}, destination=${evidence.destination}, ` +
    `extension=${evidence.projectExtension}` +
    (evidence.extensionDiagnostic
      ? `, extensionDiagnostic=${evidence.extensionDiagnostic}` : '') +
    '); explicit routes: ' +
    routes.map(({ id, action }) => `${id} (${action})`).join(', ')
  )).join('\n') +
    '. No consumer file was changed; --yes cannot choose a route.';
}

export { verifyUpdateCandidate, verifyUpdateCandidate as verifyCandidate } from '../lib/verifyUpdateCandidate.mjs';
