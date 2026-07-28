import {
  evidenceWorkloadIdentity,
  validateEvidenceSelection,
} from './routingIntent.mjs';
import {
  FRONTEND_QUALITY_AXES,
  evidenceDomainsFor,
  evidenceIdentity,
  evidenceSourceClaim,
} from './routingCatalog.mjs';

// The frontend vocabulary is a strict subset of the researched taxonomy
// (docs/research/agent-task-taxonomy-benchmark-coverage.md §1.1): it reads its
// domains and quality axes from the catalog rather than restating them.
const FRONTEND_WORKLOADS = Object.freeze([
  'frontend-greenfield',
  'frontend-repository-repair',
]);
const FRONTEND_DOMAINS = new Set(evidenceDomainsFor(FRONTEND_WORKLOADS[0]));
const QUALITY_AXES = new Set(FRONTEND_QUALITY_AXES);

// Each source carries the three-part decisiveness test instead of a boolean, so
// a collapsed dimension is named rather than hidden (§4).
const frontendClaim = (sourceId, { workloads, axes }) => Object.freeze({
  workloads: Object.freeze(workloads),
  axes: Object.freeze(axes),
  ...evidenceSourceClaim(sourceId),
});

export const FRONTEND_SOURCE_CLAIMS = Object.freeze({
  'code-arena-webdev': frontendClaim('code-arena-webdev', {
    workloads: ['frontend-greenfield'],
    axes: ['visual-preference'],
  }),
  'openhands-frontend': frontendClaim('openhands-frontend', {
    workloads: ['frontend-repository-repair'],
    axes: ['functional'],
  }),
  vision2web: frontendClaim('vision2web', {
    workloads: ['frontend-greenfield'],
    axes: ['visual-fidelity', 'functional', 'responsive'],
  }),
  design2code: frontendClaim('design2code', {
    workloads: ['frontend-greenfield'],
    axes: ['visual-fidelity'],
  }),
});

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function plainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

export function classifyFrontendWorkload(input) {
  plainObject(input, 'frontend workload');
  const lifecycle = nonEmptyString(input.lifecycle, 'frontend workload lifecycle');
  const repositoryContext = nonEmptyString(
    input.repositoryContext,
    'frontend workload repositoryContext',
  );
  if (!Array.isArray(input.qualityAxes) || input.qualityAxes.length === 0) {
    throw new TypeError('frontend workload qualityAxes must be a non-empty array');
  }
  if (new Set(input.qualityAxes).size !== input.qualityAxes.length) {
    throw new TypeError('frontend workload qualityAxes must be unique');
  }
  for (const axis of input.qualityAxes) {
    if (!QUALITY_AXES.has(axis)) throw new TypeError(`unknown frontend quality axis: ${axis}`);
  }

  let workload;
  let supportedAxes;
  if (lifecycle === 'greenfield' && repositoryContext === 'isolated') {
    workload = 'frontend-greenfield';
    supportedAxes = FRONTEND_SOURCE_CLAIMS['code-arena-webdev'].axes;
  } else if (
    ['edit', 'repair'].includes(lifecycle)
    && repositoryContext === 'existing-repository'
  ) {
    workload = 'frontend-repository-repair';
    supportedAxes = FRONTEND_SOURCE_CLAIMS['openhands-frontend'].axes;
  } else {
    throw new TypeError(
      `unsupported frontend workload mapping: ${lifecycle}/${repositoryContext}`,
    );
  }

  const frontendDomain = input.frontendDomain ?? 'general';
  if (!FRONTEND_DOMAINS.has(frontendDomain)) {
    throw new TypeError(`unknown frontend domain: ${frontendDomain}`);
  }
  const evidenceAxes = input.qualityAxes.filter((axis) => supportedAxes.includes(axis));
  const unsupportedAxes = input.qualityAxes.filter((axis) => !supportedAxes.includes(axis));
  return Object.freeze({
    evidenceSelection: validateEvidenceSelection({
      workload,
      domain: frontendDomain,
      axes: evidenceAxes,
    }),
    repositoryContext,
    unsupportedAxes: Object.freeze(unsupportedAxes),
  });
}

export function frontendEvidenceWorkload({ workload, frontendDomain = 'general', axis }) {
  if (!FRONTEND_WORKLOADS.includes(workload)) {
    throw new TypeError(`unknown frontend evidence workload: ${workload}`);
  }
  if (!FRONTEND_DOMAINS.has(frontendDomain)) {
    throw new TypeError(`unknown frontend domain: ${frontendDomain}`);
  }
  if (!QUALITY_AXES.has(axis)) throw new TypeError(`unknown frontend quality axis: ${axis}`);
  evidenceIdentity({ workload, domain: frontendDomain, axis });
  return evidenceWorkloadIdentity({
    workload,
    domain: frontendDomain,
    axes: [axis],
  });
}

export function createFrontendRouteReason(observation) {
  plainObject(observation, 'frontend observation');
  const [workload, frontendDomain, axis, ...rest] =
    nonEmptyString(observation.workload, 'frontend observation workload').split(':');
  if (rest.length > 0 || !workload || !frontendDomain || !axis) {
    throw new TypeError('frontend observation workload must name workload, domain, and axis');
  }
  const sourceId = nonEmptyString(
    observation.source?.benchmark,
    'frontend observation source benchmark',
  );
  return `${workload} (${frontendDomain}) is supported on ${axis} by ${sourceId}`;
}

export function evaluateVision2WebReadiness(input) {
  plainObject(input, 'Vision2Web leaderboard');
  const season = nonEmptyString(input.season, 'Vision2Web season');
  const benchmarkVersion = nonEmptyString(
    input.benchmarkVersion,
    'Vision2Web benchmarkVersion',
  );
  if (!Array.isArray(input.results)) {
    throw new TypeError('Vision2Web results must be an array');
  }
  if (input.results.length === 0) {
    return Object.freeze({
      sourceId: 'vision2web',
      status: 'candidate',
      season,
      benchmarkVersion,
      observations: Object.freeze([]),
      reason: 'current-season-leaderboard-empty',
    });
  }
  return Object.freeze({
    sourceId: 'vision2web',
    status: 'awaiting-owner-adapter-validation',
    season,
    benchmarkVersion,
    observations: Object.freeze([]),
    reason: 'results-require-owner-adapter',
  });
}
