/**
 * The Route decision — the dispatch-time resolution of a Routing intent against
 * the current Evidence catalog, Access graph and Routing policy.
 *
 * v2 separates provenance from execution state, because one tagged union cannot
 * hold both facts: an evidence-backed candidate carries observation, source,
 * harness, score, freshness and cost, which a Standard route has none of, and an
 * approval-required candidate is neither executable nor blocked. The two axes
 * are therefore orthogonal — `origin: evidence | standard` and `state: ready |
 * approval-required | verification-required | blocked` — with a selected
 * candidate whose required fields follow the origin. `status` stays the
 * dispatch-facing axis and keeps the `inherit` and `handoff` fallbacks the
 * Routing policy owns, which `state` deliberately cannot express.
 *
 * The Model roster is authorization, not evidence. An Access path whose
 * model-and-effort pair the policy never authorized is refused with
 * `pair-not-authorized` before any executable ranking, whatever the evidence
 * says; the Evidence catalog itself is never filtered by it, so `bestOverall`
 * stays the evidence view.
 *
 * Ranking is cohort-bound and terminates. Only observations that share an axis
 * identity, a harness, an effort and a cost currency and unit are comparable;
 * inside one cohort a score difference smaller than the combined uncertainty is
 * no difference, so cost breaks that tie and never drives the ranking. Cohorts
 * are never compared with each other: when their winners disagree the outcome is
 * `ambiguous-evidence`, and the Standard route decides and says so.
 */
import {
  evidenceSelectionMatchesObservation,
  validateRoutingIntent,
} from './routingIntent.mjs';
import { validateEvidenceCatalog } from './routingCatalog.mjs';
import { accessPairKey, validateAccessGraph } from './routingAccessGraph.mjs';
import { validateRoutingPolicy } from './routingPolicy.mjs';
import { normalizeRosterModelId } from './routingProfile.mjs';

export const ROUTE_DECISION_VERSION = 2;

export const ROUTE_DECISION_ORIGINS = Object.freeze(['evidence', 'standard']);
/** What the selected candidate may do next. Pending states are not blocked. */
export const ROUTE_DECISION_STATES = Object.freeze([
  'ready', 'approval-required', 'verification-required', 'blocked',
]);
export const BEST_OVERALL_STATES = Object.freeze(['resolved', 'ambiguous', 'unavailable']);
export const ROUTE_APPROVAL_DECISIONS = Object.freeze(['granted', 'declined']);

const REQUIRED_INFRASTRUCTURE = ['catalog', 'accessGraph', 'policy'];
/** Every state that still carries a candidate, best runnable tier first. */
const CANDIDATE_TIERS = Object.freeze(
  ROUTE_DECISION_STATES.filter((state) => state !== 'blocked'),
);
const APPROVAL_FIELDS = new Set(['decision', 'authorizationId']);
const NO_EVIDENCE = Object.freeze({
  status: 'unavailable', route: null, cohorts: Object.freeze([]),
});

function missingDecision(missing, explicitFallback) {
  return Object.freeze({
    schemaVersion: ROUTE_DECISION_VERSION,
    status: explicitFallback === 'inherit' ? 'inherit' : 'blocked',
    reason: 'routing-infrastructure-missing',
    origin: null,
    state: 'blocked',
    missing: Object.freeze(missing),
    selected: null,
    approval: null,
    bestOverall: NO_EVIDENCE,
    bestExecutable: null,
    blockers: Object.freeze(missing.map((field) => `missing:${field}`)),
    revisions: Object.freeze({ catalog: null, accessGraph: null, policy: null }),
  });
}

/** A surface-switch authorization, recorded so a receipt can name it. */
function validateApproval(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('approval must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!APPROVAL_FIELDS.has(key)) throw new TypeError(`unknown approval field: ${key}`);
  }
  if (!ROUTE_APPROVAL_DECISIONS.includes(input.decision)) {
    throw new TypeError(`approval decision must be one of: ${ROUTE_APPROVAL_DECISIONS.join(', ')}`);
  }
  const authorizationId = input.authorizationId ?? null;
  if (authorizationId !== null
      && (typeof authorizationId !== 'string' || authorizationId.trim() === '')) {
    throw new TypeError('approval authorizationId must be a non-empty string');
  }
  return Object.freeze({ decision: input.decision, authorizationId });
}

/** The declared cohort: axis identity, harness, effort, cost currency and unit. */
function cohortKey(observation) {
  return JSON.stringify([
    observation.workload,
    observation.harness.id, observation.harness.version,
    observation.effort,
    observation.cost.currency, observation.cost.unit,
  ]);
}

function compareTie(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const delta = typeof left[index] === 'number'
      ? left[index] - right[index]
      : String(left[index]).localeCompare(String(right[index]));
    if (delta !== 0) return delta;
  }
  return 0;
}

const byScore = (left, right) =>
  right.score - left.score || left.cost - right.cost || compareTie(left.tie, right.tie);
const byCost = (left, right) => left.cost - right.cost || compareTie(left.tie, right.tie);

function rankedEntry(observation, { route, tie, value }) {
  return {
    cohort: cohortKey(observation),
    score: observation.score,
    spread: Math.max(0, observation.uncertainty.value),
    cost: observation.cost.amount,
    route,
    tie,
    value,
  };
}

/**
 * One cohort's winner. Every candidate whose score sits inside the combined
 * uncertainty of itself and the leader is indistinguishable from it, so the
 * cohort's identical cost unit breaks that tie before the deterministic key.
 */
function cohortWinner(entries) {
  const leader = [...entries].sort(byScore)[0];
  const band = entries.filter((entry) => leader.score - entry.score <= leader.spread + entry.spread);
  return [...band].sort(byCost)[0];
}

/**
 * Rank inside cohorts only. Several cohorts resolve when their winners nominate
 * the same route; otherwise nothing dominates and the evidence is ambiguous.
 */
function rankCohorts(entries) {
  const cohorts = new Map();
  for (const entry of entries) {
    const bucket = cohorts.get(entry.cohort);
    if (bucket) bucket.push(entry);
    else cohorts.set(entry.cohort, [entry]);
  }
  const winners = [...cohorts.keys()].sort().map((key) => cohortWinner(cohorts.get(key)));
  if (winners.length === 0) return { status: 'unavailable', winner: null, winners };
  const routes = new Set(winners.map((entry) => entry.route));
  return routes.size === 1
    ? { status: 'resolved', winner: winners[0], winners }
    : { status: 'ambiguous', winner: null, winners };
}

function observationRoute(observation) {
  return {
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
    reason: `${observation.workload} supported by ${observation.source.id}`,
  };
}

/** The dispatched identity always comes from the Access path, never the evidence. */
function pathIdentity(path) {
  return {
    providerId: path.providerId,
    modelId: path.modelId,
    effort: path.effort,
    surfaceId: path.surfaceId,
    transportId: path.transportId,
    accessPathId: path.id,
    enforcement: path.enforcement,
    capabilityEvidence: path.capabilityEvidence,
  };
}

const NO_PATH_IDENTITY = Object.freeze({
  providerId: null, surfaceId: null, transportId: null,
  accessPathId: null, enforcement: null, capabilityEvidence: null,
});

function evidenceCandidate({ observation, path, state }) {
  return Object.freeze({
    origin: 'evidence',
    state,
    ...observationRoute(observation),
    ...pathIdentity(path),
  });
}

function standardCandidate(route, workloadClass, path, state) {
  return Object.freeze({
    origin: 'standard',
    state,
    workloadClass,
    ...NO_PATH_IDENTITY,
    modelId: route.model,
    effort: route.effort,
    ...(path ? pathIdentity(path) : {}),
    reason: `standard-route:${workloadClass}`,
  });
}

const pairLabel = (path) => `${normalizeRosterModelId(path.modelId)}+${path.effort ?? 'none'}`;
const rosterKey = ({ model, effort }) => JSON.stringify([model, effort ?? null]);

function rosterAuthorizes(policy, path) {
  const key = rosterKey({ model: normalizeRosterModelId(path.modelId), effort: path.effort });
  return policy.roster.some((pair) => rosterKey(pair) === key);
}

const denied = (blocker) => ({ state: 'blocked', blocker });

function refusedPath(path, { policy, knownTransports, now }) {
  if (!knownTransports.has(path.transportId)) {
    return denied(`unknown-transport:${path.transportId}`);
  }
  if (Date.parse(path.capabilityEvidence.expiresAt) <= now) {
    return denied(`stale-capability-evidence:${path.id}`);
  }
  if (!policy.allowedSurfaces.includes(path.surfaceId)) {
    return denied(`surface-not-allowed:${path.surfaceId}`);
  }
  if (!policy.allowedTransports.includes(path.transportId)) {
    return denied(`transport-not-allowed:${path.transportId}`);
  }
  // The roster is a positive list: an unauthorized pair never reaches a ranking.
  if (!rosterAuthorizes(policy, path)) return denied(`pair-not-authorized:${pairLabel(path)}`);
  if (path.availability === 'unavailable') return denied(`route-unavailable:${path.id}`);
  return null;
}

/** Untested access verifies under supervision and stays blocked for an AFK run. */
function attestationState(path, { afk }) {
  if (path.availability === 'available') return null;
  if (afk) return denied(`afk-requires-attested-access:${path.id}`);
  return { state: 'verification-required', blocker: `access-unknown:${path.id}` };
}

/** Cross-surface autonomy: `ask` carries the candidate into an approval decision. */
function switchState(path, { policy, activeSurface, approval }) {
  if (path.surfaceId === activeSurface || policy.switching === 'automatic') return null;
  if (policy.switching === 'current-surface-only') {
    return denied(`surface-switch-disabled:${path.surfaceId}`);
  }
  if (approval?.decision === 'declined') return denied(`approval-declined:${path.surfaceId}`);
  if (approval?.decision === 'granted') return null;
  return {
    state: 'approval-required',
    blocker: `surface-switch-approval-required:${path.surfaceId}`,
  };
}

/**
 * One path's executable state. A refusal always wins; when both a surface
 * approval and an attestation are pending the approval is reported, because
 * approving an attested route costs less than probing an unattested one.
 */
function classifyPath(path, context) {
  const refused = refusedPath(path, context);
  if (refused) return refused;
  const attested = attestationState(path, context);
  if (attested?.state === 'blocked') return attested;
  const approval = switchState(path, context);
  if (approval?.state === 'blocked') return approval;
  return approval ?? attested ?? { state: 'ready', blocker: null };
}

function classifiedPath(path, context) {
  const classified = classifyPath(path, context);
  if (classified.blocker) context.blockers.add(classified.blocker);
  return classified;
}

const surfaceTie = (path, activeSurface) => [path.surfaceId === activeSurface ? 0 : 1, path.id];

/**
 * The candidates one observation and one Access path form. An observation ranks
 * a model, so it pairs with every path to that model; which effort is dispatched
 * stays the path's own attested pair, and the roster authorizes that pair.
 */
function candidateEntries(evidence, paths, context) {
  const entries = [];
  for (const observation of evidence) {
    for (const path of paths) {
      if (path.providerId !== observation.providerId || path.modelId !== observation.modelId) {
        continue;
      }
      const { state } = classifiedPath(path, context);
      if (state === 'blocked') continue;
      entries.push(rankedEntry(observation, {
        route: accessPairKey(path),
        tie: [...surfaceTie(path, context.activeSurface), observation.id],
        value: { observation, path, state },
      }));
    }
  }
  return entries;
}

/** The best runnable tier decides; a pending candidate never outranks a ready one. */
function tieredRanking(entries) {
  for (const state of CANDIDATE_TIERS) {
    const tier = entries.filter((entry) => entry.value.state === state);
    if (tier.length > 0) return rankCohorts(tier);
  }
  return rankCohorts([]);
}

/**
 * The Standard route for the resolved workload class. It authorizes nothing
 * while unresolved, and it is named even when no path can currently take it.
 */
function standardSelection(workloadClass, paths, context) {
  const route = context.policy.standardRoutes[workloadClass];
  if (!route || route.state !== 'configured') {
    context.blockers.add(`standard-route-unresolved:${workloadClass}`);
    return null;
  }
  const candidates = paths
    .filter((path) => normalizeRosterModelId(path.modelId) === route.model
      && (path.effort ?? null) === (route.effort ?? null))
    .map((path) => ({ path, ...classifiedPath(path, context) }))
    .sort((left, right) => compareTie(
      surfaceTie(left.path, context.activeSurface),
      surfaceTie(right.path, context.activeSurface),
    ));
  for (const state of CANDIDATE_TIERS) {
    const usable = candidates.find((entry) => entry.state === state);
    if (usable) return standardCandidate(route, workloadClass, usable.path, state);
  }
  context.blockers.add(`standard-route-unreachable:${route.model}+${route.effort ?? 'none'}`);
  return standardCandidate(route, workloadClass, null, 'blocked');
}

function noExecutableStatus(policy) {
  if (policy.unreachable === 'inherit') return 'inherit';
  if (policy.unreachable === 'handoff') return 'handoff';
  return 'blocked';
}

/** A pending decision is owed to a human; it never inherits or hands off silently. */
function decisionStatus(state, policy) {
  if (state === 'ready') return 'ready';
  if (state === 'blocked') return noExecutableStatus(policy);
  return 'blocked';
}

function decisionReason(selected, fallbackReason) {
  if (!selected) return 'no-executable-route';
  if (selected.origin === 'standard') return fallbackReason;
  return selected.state === 'ready' ? 'route-resolved' : selected.state;
}

function currentEvidenceFor(intent, catalog, now, blockers) {
  return catalog.observations.filter((entry) => {
    const matchesIntent = intent.evidenceSelection
      ? evidenceSelectionMatchesObservation(intent.evidenceSelection, entry.workload)
      : entry.workload === intent.workload;
    if (!matchesIntent) return false;
    if (Date.parse(entry.freshness.expiresAt) <= now) {
      blockers.add(`stale-catalog-evidence:${entry.id}`);
      return false;
    }
    return true;
  });
}

function evidenceView(evidence) {
  const ranking = rankCohorts(evidence.map((observation) => rankedEntry(observation, {
    route: JSON.stringify([observation.providerId, observation.modelId, observation.effort]),
    tie: [observation.id],
    value: observation,
  })));
  return Object.freeze({
    status: ranking.status,
    route: ranking.winner ? Object.freeze(observationRoute(ranking.winner.value)) : null,
    cohorts: Object.freeze(ranking.winners.map((entry) =>
      Object.freeze(observationRoute(entry.value)))),
  });
}

function validatedContext(input, { policy, intent, blockers }) {
  if (typeof input.activeSurface !== 'string' || input.activeSurface === '') {
    throw new TypeError('activeSurface must be a non-empty string');
  }
  if (!Array.isArray(input.knownTransports)
      || !input.knownTransports.every((entry) => typeof entry === 'string' && entry !== '')) {
    throw new TypeError('knownTransports must be an array of non-empty strings');
  }
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new TypeError('now must be an ISO timestamp');
  return {
    policy,
    activeSurface: input.activeSurface,
    knownTransports: new Set(input.knownTransports),
    now,
    afk: intent.autonomyRequirement === 'afk',
    approval: validateApproval(input.approval),
    blockers,
  };
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
  const blockers = new Set();
  const context = validatedContext(input, { policy, intent, blockers });

  const evidence = currentEvidenceFor(intent, catalog, context.now, blockers);
  const bestOverall = evidenceView(evidence);
  const ranking = tieredRanking(candidateEntries(evidence, accessGraph.paths, context));
  const fallbackReason = ranking.status === 'ambiguous' ? 'ambiguous-evidence' : 'no-evidence-route';
  const selected = ranking.winner
    ? evidenceCandidate(ranking.winner.value)
    : standardSelection(intent.workload, accessGraph.paths, context);
  const state = selected?.state ?? 'blocked';

  return Object.freeze({
    schemaVersion: ROUTE_DECISION_VERSION,
    status: decisionStatus(state, policy),
    reason: decisionReason(selected, fallbackReason),
    origin: selected?.origin ?? null,
    state,
    intent,
    selected,
    approval: context.approval,
    bestOverall,
    bestExecutable: state === 'ready' ? selected : null,
    blockers: Object.freeze([...blockers].sort()),
    revisions: Object.freeze({
      catalog: catalog.revision,
      accessGraph: accessGraph.revision,
      policy: policy.revision,
    }),
  });
}
