/**
 * The host capability inventory — the missing input of the Access graph.
 *
 * `buildAccessGraph` assembles surface attestations and `reconcileAccessGraph`
 * stores them; both already exist and are tested. What never existed is the
 * inventory of host capability paths the surface adapters consume, so nothing
 * ever wrote `access-graph.json`. This module produces that inventory, and
 * `refreshAccessGraph` drives the existing reconcile with it.
 *
 * Only three things are knowable without touching a provider: the pair identity
 * (the pinned Model inventory), the transport list and the enforcement method
 * (the agent-surface registry), and whether the surface's executable is present
 * on this machine (a real PATH check). Everything else — callable, permitted,
 * whether a control is actually enforced, how it wins against the environment,
 * and the value the host applied — is a fact about a running host, and this
 * module never asserts one. An unobserved fact stays the `unknown` tri-state,
 * the surface adapter refuses to attest the path, and `buildAccessGraph` drops
 * it. An empty graph whose paths name why they are unattested is the correct
 * output for a host nobody has probed yet: a written graph already lifts the
 * resolver's `missing:accessGraph` blocker, and the capability probe promotes
 * individual paths to `available` afterwards.
 *
 * Detection gates the relay: an undetected surface cannot have been observed, so
 * a host claim about it is refused rather than passed on. And a surface the host
 * evidence never mentions has not been observed at all — it contributes no
 * attestation, because an adapter may not attest a host it never saw.
 */
import {
  AGENT_SURFACE_REGISTRY,
  AGENT_SURFACE_REGISTRY_REVISION,
  detectAgentSurfaces,
  surfaceById,
} from './agentSurfaceRegistry.mjs';
import { reconcileAccessGraph } from './routingAccessGraphStore.mjs';
import { claudeAccessAttestations } from './routingAdapters/claude.mjs';
import { codexAccessAttestations } from './routingAdapters/codex.mjs';
import { loadRoutingInventory, presentInventory } from './routingInventory.mjs';

/** The capability contract version the surface adapters normalize. */
export const HOST_CAPABILITY_CONTRACT_VERSION = 1;

/** Nothing observed — the tri-state every host fact starts from. */
const UNOBSERVED = 'unknown';

/** The adapter that may attest each surface. A surface with none fails closed. */
const SURFACE_ATTESTORS = Object.freeze({
  'claude-code': claudeAccessAttestations,
  codex: codexAccessAttestations,
});

/** Stable path identity: surface, transport, model and the requested effort. */
export function hostCapabilityPathId({ surfaceId, transportId, modelId, effort }) {
  return `${surfaceId}:${transportId}:${modelId}:${effort ?? 'none'}`;
}

/** What the capability evidence is pinned to: the inventory and the registry. */
export function hostCapabilityRevision(inventory) {
  return `host-capability:${inventory.revision}:surface-registry-${AGENT_SURFACE_REGISTRY_REVISION}`;
}

/**
 * The effort domain of every pinned model, keyed as `buildAccessGraph` expects,
 * so an attestation claiming an effort the model does not have fails loudly.
 */
export function inventoryEffortDomains(inventory) {
  const domains = {};
  for (const snapshot of inventory.snapshots) {
    for (const model of snapshot.models) {
      domains[`${snapshot.provider}:${model.modelId}`] = Object.freeze(
        model.effortAxis ? [...model.efforts] : [null],
      );
    }
  }
  return Object.freeze(domains);
}

/**
 * One control. The method is registry configuration; whether it is enforced, how
 * it wins against the environment, and what the host applied are host facts, so
 * an unobserved control reports `unknown` and fails verification on its own.
 */
function control(method, observed) {
  return Object.freeze({
    method,
    enforced: observed?.enforced ?? UNOBSERVED,
    precedence: observed?.precedence ?? UNOBSERVED,
    applied: observed?.applied ?? UNOBSERVED,
  });
}

/** One capability path. An undetected surface relays no host claim at all. */
function capabilityPath(pair, surface, transportId, routes) {
  const id = hostCapabilityPathId({
    surfaceId: surface.id, transportId, modelId: pair.modelId, effort: pair.effort,
  });
  const detected = pair.detectedSurface === true;
  const observed = detected ? routes?.[id] ?? null : null;
  const { enforcement } = surface.adapter;
  return Object.freeze({
    id,
    surfaceId: surface.id,
    providerId: pair.provider,
    modelId: pair.modelId,
    transportId,
    detected,
    callable: observed?.callable ?? UNOBSERVED,
    permitted: observed?.permitted ?? UNOBSERVED,
    model: control(enforcement.model, observed?.model),
    effort: control(enforcement.effort, observed?.effort),
  });
}

/**
 * One capability path per inventory pair and per registry transport of that
 * pair's surface. The transport list is read from the registry and never
 * inlined, so a surface-transport combination the registry does not list —
 * `claude-code` reaching the Claude CLI, today — is absent by construction
 * rather than by exclusion, and adding it stays a registry decision.
 */
export function buildHostCapabilityInventory({
  pairs,
  registry = AGENT_SURFACE_REGISTRY,
  hostEvidence = {},
} = {}) {
  if (!Array.isArray(pairs)) throw new TypeError('host capability pairs must be an array');
  const paths = [];
  for (const pair of pairs) {
    const surface = surfaceById(pair.surface, registry);
    if (!surface) {
      throw new Error(`the agent surface registry knows no surface: ${pair.surface}`);
    }
    for (const transportId of surface.adapter.transports) {
      paths.push(capabilityPath(pair, surface, transportId, hostEvidence[surface.id]?.routes));
    }
  }
  return Object.freeze({
    contractVersion: HOST_CAPABILITY_CONTRACT_VERSION,
    paths: Object.freeze(paths),
  });
}

/**
 * Attest the produced paths through each surface's own adapter, which stays the
 * judge of what its host proved. The remaining evidence fields are that
 * adapter's host envelope — the Codex adapter requires a dated `host` and reads
 * its `spawnSchema`, so a schema exposing no selector attests no control.
 */
export function attestHostCapabilities({ capabilities, hostEvidence = {}, revision = null } = {}) {
  const attestations = [];
  const unobservedSurfaces = [];
  for (const surfaceId of new Set(capabilities.paths.map((path) => path.surfaceId))) {
    const attest = SURFACE_ATTESTORS[surfaceId];
    if (!attest) throw new Error(`no surface adapter can attest the agent surface: ${surfaceId}`);
    const evidence = hostEvidence[surfaceId];
    if (!evidence) {
      unobservedSurfaces.push(surfaceId);
      continue;
    }
    const { routes, revision: pinned, expiresAt, ...envelope } = evidence;
    attestations.push(...attest({
      ...envelope,
      contractVersion: HOST_CAPABILITY_CONTRACT_VERSION,
      paths: capabilities.paths.filter((path) => path.surfaceId === surfaceId),
    }, { revision: pinned ?? revision, observedAt: evidence.observedAt, expiresAt }));
  }
  return Object.freeze({
    attestations: Object.freeze(attestations),
    unobservedSurfaces: Object.freeze(unobservedSurfaces),
  });
}

/**
 * Rebuild the Access graph from this host's observed capabilities and store it.
 * The stored revision is content-derived, so an unchanged rebuild writes nothing
 * and every availability a capability probe already recorded is carried forward.
 */
export async function refreshAccessGraph({
  file,
  inventory = null,
  registry = AGENT_SURFACE_REGISTRY,
  hostEvidence = {},
  commandAvailable,
  lockTimeoutMs,
} = {}) {
  const pinned = inventory ?? await loadRoutingInventory();
  const surfaces = await detectAgentSurfaces({ registry, commandAvailable });
  const capabilities = buildHostCapabilityInventory({
    pairs: presentInventory(pinned, surfaces).attestations,
    registry,
    hostEvidence,
  });
  const attested = attestHostCapabilities({
    capabilities,
    hostEvidence,
    revision: hostCapabilityRevision(pinned),
  });
  const stored = await reconcileAccessGraph({
    file,
    attestations: attested.attestations,
    effortDomains: inventoryEffortDomains(pinned),
    lockTimeoutMs,
  });
  return Object.freeze({
    ...stored,
    capabilities,
    detectedSurfaces: Object.freeze(surfaces.filter(({ detected }) => detected).map(({ id }) => id)),
    unobservedSurfaces: attested.unobservedSurfaces,
  });
}
