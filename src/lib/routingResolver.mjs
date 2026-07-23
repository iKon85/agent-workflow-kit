import { validateRoutingIntent } from './routingIntent.mjs';
import { validateEvidenceCatalog } from './routingCatalog.mjs';
import { validateAccessGraph } from './routingAccessGraph.mjs';
import { validateRoutingPolicy } from './routingPolicy.mjs';

export const ROUTE_DECISION_VERSION = 1;

const REQUIRED_INFRASTRUCTURE = ['catalog', 'accessGraph', 'policy'];

function missingDecision(missing, explicitFallback) {
  return Object.freeze({
    schemaVersion: ROUTE_DECISION_VERSION,
    status: explicitFallback === 'inherit' ? 'inherit' : 'blocked',
    reason: 'routing-infrastructure-missing',
    missing: Object.freeze(missing),
    bestOverall: null,
    bestExecutable: null,
    blockers: Object.freeze(missing.map((field) => `missing:${field}`)),
    revisions: Object.freeze({ catalog: null, accessGraph: null, policy: null }),
  });
}

function compareCandidates(optimization) {
  return (left, right) => {
    if (optimization === 'cost') {
      return left.cost.amount - right.cost.amount || right.score - left.score;
    }
    if (optimization === 'balanced') {
      const leftValue = left.score / (1 + left.cost.amount);
      const rightValue = right.score / (1 + right.cost.amount);
      return rightValue - leftValue || right.score - left.score;
    }
    return right.score - left.score || left.cost.amount - right.cost.amount;
  };
}

function observationRoute(observation) {
  return Object.freeze({
    observationId: observation.id,
    providerId: observation.providerId,
    modelId: observation.modelId,
    effort: observation.effort,
    workload: observation.workload,
    harness: observation.harness,
    score: observation.score,
    source: observation.source,
    uncertainty: observation.uncertainty,
    freshness: observation.freshness,
    cost: observation.cost,
  });
}

function executableRoute(observation, path) {
  return Object.freeze({
    ...observationRoute(observation),
    accessPathId: path.id,
    surfaceId: path.surfaceId,
    transportId: path.transportId,
    enforcement: path.enforcement,
    capabilityEvidence: path.capabilityEvidence,
  });
}

function pathAllowed(path, policy, activeSurface, knownTransports, now, blockers) {
  if (!knownTransports.has(path.transportId)) {
    blockers.add(`unknown-transport:${path.transportId}`);
    return false;
  }
  if (Date.parse(path.capabilityEvidence.expiresAt) <= now) {
    blockers.add(`stale-capability-evidence:${path.id}`);
    return false;
  }
  if (path.availability !== 'available') {
    blockers.add(`route-${path.availability}:${path.id}`);
    return false;
  }
  if (!policy.allowedSurfaces.includes(path.surfaceId)) {
    blockers.add(`surface-not-allowed:${path.surfaceId}`);
    return false;
  }
  if (!policy.allowedTransports.includes(path.transportId)) {
    blockers.add(`transport-not-allowed:${path.transportId}`);
    return false;
  }
  if (path.surfaceId !== activeSurface) {
    if (policy.switching === 'current-surface-only') {
      blockers.add(`surface-switch-disabled:${path.surfaceId}`);
      return false;
    }
    if (policy.switching === 'ask') {
      blockers.add(`surface-switch-approval-required:${path.surfaceId}`);
      return false;
    }
  }
  return true;
}

function noExecutableStatus(policy) {
  if (policy.unreachable === 'inherit') return 'inherit';
  if (policy.unreachable === 'handoff') return 'handoff';
  return 'blocked';
}

export function resolveRoute(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('route resolution input must be an object');
  }
  const missing = REQUIRED_INFRASTRUCTURE.filter((field) => input[field] == null);
  if (missing.length > 0) return missingDecision(missing, input.missingInfrastructure);

  const intent = validateRoutingIntent(input.intent);
  const catalog = validateEvidenceCatalog(input.catalog);
  const accessGraph = validateAccessGraph(input.accessGraph);
  const policy = validateRoutingPolicy(input.policy);
  if (typeof input.activeSurface !== 'string' || input.activeSurface === '') {
    throw new TypeError('activeSurface must be a non-empty string');
  }
  if (!Array.isArray(input.knownTransports)
      || !input.knownTransports.every((entry) => typeof entry === 'string' && entry !== '')) {
    throw new TypeError('knownTransports must be an array of non-empty strings');
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new TypeError('now must be an ISO timestamp');

  const blockers = new Set();
  const currentEvidence = catalog.observations.filter((entry) => {
    if (entry.workload !== intent.workload) return false;
    if (Date.parse(entry.freshness.expiresAt) <= now) {
      blockers.add(`stale-catalog-evidence:${entry.id}`);
      return false;
    }
    return true;
  });
  const rankedOverall = [...currentEvidence].sort(compareCandidates(policy.optimization));
  const bestOverall = rankedOverall.length > 0 ? observationRoute(rankedOverall[0]) : null;

  const knownTransports = new Set(input.knownTransports);
  const executable = [];
  for (const evidence of currentEvidence) {
    for (const path of accessGraph.paths) {
      if (path.providerId !== evidence.providerId || path.modelId !== evidence.modelId) continue;
      if (!pathAllowed(path, policy, input.activeSurface, knownTransports, now, blockers)) continue;
      executable.push({ evidence, path });
    }
  }
  executable.sort((left, right) =>
    compareCandidates(policy.optimization)(left.evidence, right.evidence)
      || Number(right.path.surfaceId === input.activeSurface)
        - Number(left.path.surfaceId === input.activeSurface)
      || left.path.id.localeCompare(right.path.id));
  const bestExecutable = executable.length > 0
    ? executableRoute(executable[0].evidence, executable[0].path)
    : null;
  const status = bestExecutable ? 'ready' : noExecutableStatus(policy);
  return Object.freeze({
    schemaVersion: ROUTE_DECISION_VERSION,
    status,
    reason: bestExecutable ? 'route-resolved' : 'no-executable-route',
    intent,
    bestOverall,
    bestExecutable,
    blockers: Object.freeze([...blockers].sort()),
    revisions: Object.freeze({
      catalog: catalog.revision,
      accessGraph: accessGraph.revision,
      policy: policy.revision,
    }),
  });
}
