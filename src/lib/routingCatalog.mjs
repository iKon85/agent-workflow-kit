export const EVIDENCE_CATALOG_VERSION = 1;
export const UNKNOWN_EFFORT = 'unknown';

// Taxonomy — docs/research/agent-task-taxonomy-benchmark-coverage.md §1. The
// identity stays `workload:domain:axis`, and the frontend vocabulary is a strict
// subset of it: the generalization is additive.
const FRONTEND_WORKLOADS = Object.freeze(['frontend-greenfield', 'frontend-repository-repair']);

export const EVIDENCE_WORKLOADS = Object.freeze([
  ...FRONTEND_WORKLOADS,
  'repository-repair', 'repository-comprehension', 'code-transformation', 'test-authoring',
  'greenfield-application', 'algorithmic-synthesis', 'terminal-operations', 'tool-orchestration',
  'knowledge-deliverable', 'architecture-reasoning', 'long-horizon-autonomy',
  'long-context-operation',
]);

// A domain segment exists only where the owner publishes a separate score for it
// (§1.3); everything else stays `general`, so no aggregate is laundered.
const FRONTEND_DOMAINS = Object.freeze([
  'general', 'reference-design', 'marketing', 'analytics',
  'product', 'game', 'simulation', 'editor',
]);
const GENERAL_DOMAIN = Object.freeze(['general']);
const TOOL_ORCHESTRATION_DOMAINS = Object.freeze([
  'general', 'airline', 'retail', 'telecom', 'banking',
]);
// Four axes stay frontend-scoped (§1.4); `functional` is the general
// executable-verifier axis, exactly how `openhands-frontend` already uses it.
const FRONTEND_SCOPED_AXES = Object.freeze([
  'visual-fidelity', 'visual-preference', 'accessibility', 'responsive',
]);
const GENERAL_AXES = Object.freeze([
  'functional', 'rubric-quality', 'answer-accuracy', 'blind-preference',
  'policy-adherence', 'time-horizon', 'context-retention',
]);
export const EVIDENCE_AXES = Object.freeze([...GENERAL_AXES, ...FRONTEND_SCOPED_AXES]);
export const FRONTEND_QUALITY_AXES = Object.freeze(['functional', ...FRONTEND_SCOPED_AXES]);

// Owners publish cost per attempted task or per whole run (§6); a per-success
// figure is Kit-derived and says so. Currency stays its own field, so `USD` plus
// `attempt` is the researched `usd-per-attempt`.
export const EVIDENCE_COST_UNITS = Object.freeze(['attempt', 'run', 'success-derived']);
const DERIVED_COST_UNIT = 'success-derived';

function requireWorkload(workload) {
  if (!EVIDENCE_WORKLOADS.includes(workload)) {
    throw new TypeError(`unknown evidence workload: ${workload}`);
  }
  return FRONTEND_WORKLOADS.includes(workload);
}

export function evidenceDomainsFor(workload) {
  if (requireWorkload(workload)) return FRONTEND_DOMAINS;
  return workload === 'tool-orchestration' ? TOOL_ORCHESTRATION_DOMAINS : GENERAL_DOMAIN;
}

export function evidenceAxesFor(workload) {
  return requireWorkload(workload) ? EVIDENCE_AXES : GENERAL_AXES;
}

export function evidenceIdentity({ workload, domain = 'general', axis }) {
  if (!evidenceDomainsFor(workload).includes(domain)) {
    throw new TypeError(`evidence domain ${domain} is not scored separately for ${workload}`);
  }
  if (!evidenceAxesFor(workload).includes(axis)) {
    throw new TypeError(`evidence axis ${axis} is not defined for ${workload}`);
  }
  return `${workload}:${domain}:${axis}`;
}

export function parseEvidenceIdentity(identity) {
  string(identity, 'evidence identity');
  const [workload, domain, axis, ...rest] = identity.split(':');
  if (rest.length > 0 || !workload || !domain || !axis) {
    throw new TypeError(`evidence identity must name workload, domain, and axis: ${identity}`);
  }
  evidenceIdentity({ workload, domain, axis });
  return Object.freeze({ workload, domain, axis });
}

// The three-part decisiveness test (§0, §4): a source is decisive only when it
// measures the exact triple and preserves effort and harness identity, and a
// false flag names the collapsed dimension rather than hiding it in a boolean.
// `freshness.maxAgeDays` is a Kit-side policy per source: almost no owner
// publishes a cadence (§7.8), so the expiry is the Kit's decision, never read
// from the owner.
function sourceClaim(sourceId, flags, maxAgeDays, reason) {
  const [measuresTriple, preservesEffort, preservesHarness] = flags;
  const dimensions = ['triple', 'effort', 'harness'];
  return Object.freeze({
    sourceId,
    measuresTriple,
    preservesEffort,
    preservesHarness,
    collapsedDimensions: Object.freeze(dimensions.filter((_, index) => !flags[index])),
    freshness: Object.freeze({ maxAgeDays, basis: 'kit-policy' }),
    reason,
  });
}

// [sourceId, [measuresTriple, preservesEffort, preservesHarness], maxAgeDays, reason]
const SOURCE_CLAIM_ROWS = Object.freeze([
  ['deepswe', [true, true, true], 30, 'Every row names effort, harness and run config.'],
  ['artificial-analysis-coding-agents', [true, false, true], 30,
    'The Coding Agent Index runs each agent on its default reasoning effort settings.'],
  ['openhands-evaluation', [true, false, true], 60,
    'The harness is named per row, but reasoning effort is not a reported dimension.'],
  ['code-arena-webdev', [true, false, true], 30,
    'Per-domain boards with the harness in the model label, but no reasoning-effort column.'],
  ['openhands-frontend', [true, false, true], 60, 'Names its SDK harness, not the effort.'],
  ['benchlm', [false, false, false], 7, 'An aggregator: no triple, no effort, no harness.'],
  ['vision2web', [true, false, false], 30,
    "The active season's leaderboard is empty, so no row preserves harness or effort."],
  ['design2code', [true, false, false], 30, 'A static artifact: no harness, no effort.'],
]);

export const EVIDENCE_SOURCE_CLAIMS = Object.freeze(Object.fromEntries(
  SOURCE_CLAIM_ROWS.map((row) => [row[0], sourceClaim(...row)]),
));

export function evidenceSourceClaim(sourceId) {
  const claim = EVIDENCE_SOURCE_CLAIMS[sourceId];
  if (!claim) throw new TypeError(`unknown evidence source: ${sourceId}`);
  return claim;
}

export function isDecisiveEvidence(claim) {
  object(claim, 'evidence claim');
  return claim.measuresTriple && claim.preservesEffort && claim.preservesHarness;
}

export function evidenceFreshness({ sourceId, observedAt }) {
  const { freshness } = evidenceSourceClaim(sourceId);
  const observed = Date.parse(timestamp(observedAt, 'observedAt'));
  const window = freshness.maxAgeDays * 24 * 60 * 60 * 1000;
  return Object.freeze({
    observedAt,
    expiresAt: new Date(observed + window).toISOString(),
    maxAgeDays: freshness.maxAgeDays,
    basis: freshness.basis,
  });
}

export function assertPublishedEffort({ sourceId, effort }) {
  const { preservesEffort } = evidenceSourceClaim(sourceId);
  string(effort, `${sourceId} effort`);
  if (!preservesEffort && effort !== UNKNOWN_EFFORT) {
    throw new TypeError(`${sourceId} does not preserve reasoning effort: effort must be `
      + `${UNKNOWN_EFFORT}, found ${effort}`);
  }
  if (preservesEffort && effort === UNKNOWN_EFFORT) {
    throw new TypeError(`${sourceId} preserves reasoning effort: a row must name it`);
  }
  return effort;
}

export function assertCostUnit(unit, field = 'cost.unit') {
  if (!EVIDENCE_COST_UNITS.includes(unit)) {
    throw new TypeError(`${field} must be one of: ${EVIDENCE_COST_UNITS.join(', ')}`);
  }
  return unit;
}

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

function number(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`);
  return value;
}

function timestamp(value, field) {
  string(value, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return value;
}

const clone = (value) => structuredClone(value);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const identity = ({ providerId, modelId }) => `${providerId}:${modelId}`;

function validateModel(model, index) {
  object(model, `models[${index}]`);
  const field = `models[${index}]`;
  return {
    providerId: string(model.providerId, `${field}.providerId`),
    modelId: string(model.modelId, `${field}.modelId`),
  };
}

// A taxonomy identity is checked against the researched vocabulary; a colon-free
// workload is a legacy aggregate that can never satisfy an evidence selection.
const isTaxonomyIdentity = (workload) => workload.includes(':');

function validateWorkloadIdentity(value, field) {
  const workload = string(value, field);
  if (isTaxonomyIdentity(workload)) parseEvidenceIdentity(workload);
  return workload;
}

// An observation claiming a taxonomy identity carries the whole taxonomy
// contract, cost unit included; a legacy aggregate keeps its free-form unit.
function validateCost(cost, field, taxonomy) {
  if (number(cost.amount, `${field}.amount`) < 0) {
    throw new TypeError(`${field}.amount must be non-negative`);
  }
  string(cost.currency, `${field}.currency`);
  if (!taxonomy) return string(cost.unit, `${field}.unit`);
  assertCostUnit(cost.unit, `${field}.unit`);
  if ((cost.derived === true) !== (cost.unit === DERIVED_COST_UNIT)) {
    throw new TypeError(
      `${field}: a per-completed-task value is Kit-derived and must carry derived: true`,
    );
  }
  return cost.unit;
}

function validateObservation(entry, index, knownModels) {
  const field = `observations[${index}]`;
  object(entry, field);
  const observation = {
    id: string(entry.id, `${field}.id`),
    providerId: string(entry.providerId, `${field}.providerId`),
    modelId: string(entry.modelId, `${field}.modelId`),
    effort: string(entry.effort, `${field}.effort`),
    workload: validateWorkloadIdentity(entry.workload, `${field}.workload`),
    harness: clone(object(entry.harness, `${field}.harness`)),
    score: number(entry.score, `${field}.score`),
    source: clone(object(entry.source, `${field}.source`)),
    uncertainty: clone(object(entry.uncertainty, `${field}.uncertainty`)),
    freshness: clone(object(entry.freshness, `${field}.freshness`)),
    cost: clone(object(entry.cost, `${field}.cost`)),
  };
  string(observation.harness.id, `${field}.harness.id`);
  string(observation.harness.version, `${field}.harness.version`);
  for (const key of ['owner', 'id', 'url', 'benchmark', 'version', 'snapshotHash']) {
    string(observation.source[key], `${field}.source.${key}`);
  }
  string(observation.uncertainty.kind, `${field}.uncertainty.kind`);
  number(observation.uncertainty.value, `${field}.uncertainty.value`);
  const observedAt = timestamp(observation.freshness.observedAt, `${field}.freshness.observedAt`);
  const expiresAt = timestamp(observation.freshness.expiresAt, `${field}.freshness.expiresAt`);
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) {
    throw new TypeError(`${field}.freshness.expiresAt must follow observedAt`);
  }
  validateCost(observation.cost, `${field}.cost`, isTaxonomyIdentity(observation.workload));
  if (!knownModels.has(identity(observation))) {
    throw new TypeError(`${field} references an unknown model`);
  }
  return observation;
}

export function validateEvidenceCatalog(input) {
  object(input, 'evidence catalog');
  if (input.schemaVersion !== EVIDENCE_CATALOG_VERSION) {
    throw new TypeError(`evidence catalog schemaVersion must be ${EVIDENCE_CATALOG_VERSION}`);
  }
  const revision = string(input.revision, 'evidence catalog revision');
  if (!Array.isArray(input.models)) throw new TypeError('evidence catalog models must be an array');
  if (!Array.isArray(input.observations)) {
    throw new TypeError('evidence catalog observations must be an array');
  }
  const models = input.models.map(validateModel);
  const modelIds = new Set();
  for (const model of models) {
    const key = identity(model);
    if (modelIds.has(key)) throw new TypeError(`duplicate evidence model: ${key}`);
    modelIds.add(key);
  }
  const observations = input.observations.map((entry, index) =>
    validateObservation(entry, index, modelIds));
  const observationIds = new Set();
  for (const entry of observations) {
    if (observationIds.has(entry.id)) {
      throw new TypeError(`duplicate evidence observation: ${entry.id}`);
    }
    observationIds.add(entry.id);
  }
  return deepFreeze({ schemaVersion: EVIDENCE_CATALOG_VERSION, revision, models, observations });
}
