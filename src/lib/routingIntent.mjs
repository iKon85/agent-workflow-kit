export const ROUTING_INTENT_VERSION = 2;
export const ROUTING_INTENT_LEGACY_VERSION = 1;

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

export const ROUTING_TASK_SHAPES = Object.freeze([
  'single-step',
  'multi-step',
  'long-horizon',
]);

export const ROUTING_RISKS = Object.freeze([
  'low',
  'moderate',
  'high',
]);

export const ROUTING_AUTONOMY_REQUIREMENTS = Object.freeze([
  'supervised',
  'afk',
]);

export const ROUTING_CONTEXT_NEEDS = Object.freeze([
  'focused',
  'repository',
  'long-context',
]);

// A v1 intent proves nothing about the dimensions v2 adds, so the migration
// records every field it had to default. Autonomy is fail-closed — a migrated
// intent never claims an unattended run the user never authorized. The other
// three take the neutral middle of their scale so the migration neither
// inflates nor understates the work.
export const ROUTING_INTENT_MIGRATION_DEFAULTS = Object.freeze({
  taskShape: 'multi-step',
  risk: 'moderate',
  autonomyRequirement: 'supervised',
  contextNeed: 'repository',
});

const DIMENSIONS = Object.freeze([
  Object.freeze({ field: 'workload', key: 'routing-intent', allowed: ROUTING_WORKLOADS }),
  Object.freeze({ field: 'reasoning', key: 'reasoning-intent', allowed: ROUTING_REASONING }),
  Object.freeze({ field: 'taskShape', key: 'task-shape', allowed: ROUTING_TASK_SHAPES }),
  Object.freeze({ field: 'risk', key: 'risk', allowed: ROUTING_RISKS }),
  Object.freeze({
    field: 'autonomyRequirement',
    key: 'autonomy-requirement',
    allowed: ROUTING_AUTONOMY_REQUIREMENTS,
  }),
  Object.freeze({ field: 'contextNeed', key: 'context-need', allowed: ROUTING_CONTEXT_NEEDS }),
]);

const VERSION_KEY = 'intent-version';
const EVIDENCE_SELECTION_KEY = 'evidence-selection';
const FIELDS = new Set([
  'version',
  ...DIMENSIONS.map((dimension) => dimension.field),
  'evidenceSelection',
]);
const LEGACY_FIELDS = new Set(['version', 'workload', 'reasoning', 'evidenceSelection']);
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

function requireIntentDocument(input, allowedFields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('routing intent must be an object');
  }
  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) throw new TypeError(`unknown routing intent field: ${field}`);
  }
  return input;
}

export function validateRoutingIntent(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)
      && input.version === ROUTING_INTENT_LEGACY_VERSION) {
    return migrateRoutingIntent(input).intent;
  }
  requireIntentDocument(input, FIELDS);
  if (input.version !== ROUTING_INTENT_VERSION) {
    throw new TypeError(
      `routing intent version must be ${ROUTING_INTENT_LEGACY_VERSION} or ${ROUTING_INTENT_VERSION}`,
    );
  }
  const intent = { version: ROUTING_INTENT_VERSION };
  for (const { field, allowed } of DIMENSIONS) {
    intent[field] = requireEnum(input[field], allowed, field);
  }
  if (input.evidenceSelection !== undefined) {
    intent.evidenceSelection = validateEvidenceSelection(input.evidenceSelection);
  }
  return Object.freeze(intent);
}

export function migrateRoutingIntent(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)
      && input.version === ROUTING_INTENT_VERSION) {
    return Object.freeze({
      intent: validateRoutingIntent(input),
      fromVersion: ROUTING_INTENT_VERSION,
      defaulted: Object.freeze([]),
    });
  }
  requireIntentDocument(input, LEGACY_FIELDS);
  if (input.version !== ROUTING_INTENT_LEGACY_VERSION) {
    throw new TypeError(
      `routing intent version must be ${ROUTING_INTENT_LEGACY_VERSION} or ${ROUTING_INTENT_VERSION}`,
    );
  }
  // A v1 document cannot carry any v2 dimension, so every one of them is defaulted.
  const defaulted = Object.freeze(Object.keys(ROUTING_INTENT_MIGRATION_DEFAULTS));
  return Object.freeze({
    intent: validateRoutingIntent({
      ...input,
      version: ROUTING_INTENT_VERSION,
      ...ROUTING_INTENT_MIGRATION_DEFAULTS,
    }),
    fromVersion: ROUTING_INTENT_LEGACY_VERSION,
    defaulted,
  });
}

function serializeEvidenceSelection(selection) {
  for (const segment of [selection.workload, selection.domain, ...selection.axes]) {
    if (segment.includes(',')) {
      throw new TypeError('evidence selection axis must not contain a comma');
    }
  }
  return `${selection.workload}:${selection.domain}:${selection.axes.join(',')}`;
}

export function serializeRoutingIntent(input) {
  const intent = validateRoutingIntent(input);
  const lines = [`${VERSION_KEY}: ${intent.version}`];
  for (const { field, key } of DIMENSIONS) lines.push(`${key}: ${intent[field]}`);
  if (intent.evidenceSelection !== undefined) {
    lines.push(`${EVIDENCE_SELECTION_KEY}: ${serializeEvidenceSelection(intent.evidenceSelection)}`);
  }
  return lines.join('\n');
}

const ISSUE_KEYS = new Map([
  ...DIMENSIONS.map(({ key, field }) => [key, field]),
  [VERSION_KEY, 'version'],
  [EVIDENCE_SELECTION_KEY, 'evidenceSelection'],
]);
const INTENT_LINE = /^\s*([a-z][a-z-]*)\s*:\s*(\S.*?)\s*$/;
const WORKLOAD_KEY = DIMENSIONS[0].key;

// Only the one blank-line-delimited block that names the workload key is read,
// so an unrelated `risk:` line elsewhere in an issue body can never be mistaken
// for a Routing intent dimension.
function readIntentBlock(text) {
  if (typeof text !== 'string') throw new TypeError('routing intent block must be a string');
  const blocks = text.split(/\n[ \t]*\n/).filter((block) => block
    .split('\n')
    .some((line) => INTENT_LINE.exec(line)?.[1] === WORKLOAD_KEY));
  if (blocks.length === 0) {
    throw new TypeError(`routing intent block must name ${WORKLOAD_KEY}`);
  }
  if (blocks.length > 1) throw new TypeError('routing intent block must appear once');
  const document = {};
  for (const line of blocks[0].split('\n')) {
    const match = INTENT_LINE.exec(line);
    if (!match || !ISSUE_KEYS.has(match[1])) continue;
    const field = ISSUE_KEYS.get(match[1]);
    if (document[field] !== undefined) {
      throw new TypeError(`duplicate routing intent field: ${match[1]}`);
    }
    document[field] = match[2];
  }
  return document;
}

function parseEvidenceSelection(value) {
  const [workload, domain, axes, ...rest] = value.split(':');
  if (rest.length > 0 || !workload || !domain || !axes) {
    throw new TypeError(`${EVIDENCE_SELECTION_KEY} must name workload, domain, and axes`);
  }
  return { workload, domain, axes: axes.split(',') };
}

export function parseRoutingIntent(text) {
  const document = readIntentBlock(text);
  const version = document.version === undefined
    ? ROUTING_INTENT_LEGACY_VERSION
    : Number(document.version);
  const decoded = { ...document, version };
  if (document.evidenceSelection !== undefined) {
    decoded.evidenceSelection = parseEvidenceSelection(document.evidenceSelection);
  }
  return migrateRoutingIntent(decoded);
}
