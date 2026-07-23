export const ROUTING_INTENT_VERSION = 1;

export const ROUTING_WORKLOADS = Object.freeze([
  'judgment',
  'development',
  'mechanical',
]);

export const ROUTING_REASONING = Object.freeze([
  'deep',
  'balanced',
  'light',
]);

const FIELDS = new Set(['version', 'workload', 'reasoning', 'evidenceSelection']);
const EVIDENCE_SELECTION_FIELDS = new Set(['workload', 'domain', 'axes']);

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function requireIdentitySegment(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes(':')) {
    throw new TypeError(`${field} must be a non-empty string without colons`);
  }
  return value;
}

export function validateEvidenceSelection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('evidence selection must be an object');
  }
  for (const field of Object.keys(input)) {
    if (!EVIDENCE_SELECTION_FIELDS.has(field)) {
      throw new TypeError(`unknown evidence selection field: ${field}`);
    }
  }
  if (!Array.isArray(input.axes) || input.axes.length === 0) {
    throw new TypeError('evidence selection axes must be a non-empty array');
  }
  const axes = input.axes.map((axis) =>
    requireIdentitySegment(axis, 'evidence selection axis'));
  if (new Set(axes).size !== axes.length) {
    throw new TypeError('evidence selection axes must be unique');
  }
  return Object.freeze({
    workload: requireIdentitySegment(input.workload, 'evidence selection workload'),
    domain: requireIdentitySegment(input.domain, 'evidence selection domain'),
    axes: Object.freeze(axes),
  });
}

export function evidenceWorkloadIdentity(input) {
  const selection = validateEvidenceSelection(input);
  if (selection.axes.length !== 1) {
    throw new TypeError('evidence workload identity requires exactly one axis');
  }
  return `${selection.workload}:${selection.domain}:${selection.axes[0]}`;
}

export function evidenceSelectionMatchesObservation(input, observationWorkload) {
  const selection = validateEvidenceSelection(input);
  if (typeof observationWorkload !== 'string') return false;
  const [workload, domain, axis, ...rest] = observationWorkload.split(':');
  if (rest.length > 0 || !workload || !domain || !axis) return false;
  return selection.workload === workload
    && selection.domain === domain
    && selection.axes.includes(axis);
}

export function validateRoutingIntent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('routing intent must be an object');
  }
  for (const field of Object.keys(input)) {
    if (!FIELDS.has(field)) throw new TypeError(`unknown routing intent field: ${field}`);
  }
  if (input.version !== ROUTING_INTENT_VERSION) {
    throw new TypeError(`routing intent version must be ${ROUTING_INTENT_VERSION}`);
  }
  const intent = {
    version: ROUTING_INTENT_VERSION,
    workload: requireEnum(input.workload, ROUTING_WORKLOADS, 'workload'),
    reasoning: requireEnum(input.reasoning, ROUTING_REASONING, 'reasoning'),
  };
  if (input.evidenceSelection !== undefined) {
    intent.evidenceSelection = validateEvidenceSelection(input.evidenceSelection);
  }
  return Object.freeze(intent);
}
