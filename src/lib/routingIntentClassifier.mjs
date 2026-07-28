/**
 * Intent resolution — the first of the two stages a dispatch runs through.
 *
 * Stage one resolves *what the work is*: an explicit Routing intent stated in
 * the issue or the task wins, and only when none is stated does a
 * provider-neutral workflow classifier derive one. Stage two — route selection
 * against the Evidence catalog and the Standard route — happens elsewhere, in
 * the resolver, and never runs backwards: **a route is never an intent source.**
 * This module therefore knows nothing about models, efforts, surfaces or
 * transports, and rejects a caller that tries to feed one in, because a signal
 * named after a route would let a chosen model justify the intent that chose it.
 *
 * The classifier is a total, inspectable table over five declared workflow
 * signals. Four of them map one-to-one onto an intent dimension; `reasoning` is
 * the one dimension a workflow cannot state without opinionating, so it is
 * derived from what the unit produces and what a wrong answer costs.
 */
import {
  ROUTING_INTENT_VERSION,
  migrateRoutingIntent,
  parseRoutingIntent,
  validateRoutingIntent,
} from './routingIntent.mjs';

/** The provider-neutral facts a delegating workflow already knows about a unit. */
export const WORKFLOW_SIGNAL_VOCABULARY = Object.freeze({
  outcome: Object.freeze(['decision', 'implementation', 'transformation']),
  steps: Object.freeze(['single', 'several', 'session-spanning']),
  blastRadius: Object.freeze(['contained', 'shared', 'irreversible']),
  supervision: Object.freeze(['attended', 'unattended']),
  breadth: Object.freeze(['single-file', 'repository', 'cross-repository']),
});

const SIGNAL_DIMENSIONS = Object.freeze({
  outcome: Object.freeze({
    field: 'workload',
    values: Object.freeze({
      decision: 'judgment', implementation: 'development', transformation: 'mechanical',
    }),
  }),
  steps: Object.freeze({
    field: 'taskShape',
    values: Object.freeze({
      single: 'single-step', several: 'multi-step', 'session-spanning': 'long-horizon',
    }),
  }),
  blastRadius: Object.freeze({
    field: 'risk',
    values: Object.freeze({ contained: 'low', shared: 'moderate', irreversible: 'high' }),
  }),
  supervision: Object.freeze({
    field: 'autonomyRequirement',
    values: Object.freeze({ attended: 'supervised', unattended: 'afk' }),
  }),
  breadth: Object.freeze({
    field: 'contextNeed',
    values: Object.freeze({
      'single-file': 'focused', repository: 'repository', 'cross-repository': 'long-context',
    }),
  }),
});

/**
 * The vocabulary of the other stage. A signal named after any of these is not a
 * typo to correct but a route leaking into intent resolution, so it is named as
 * such rather than reported as an unknown field.
 */
const ROUTE_FIELDS = Object.freeze(new Set([
  'route', 'model', 'modelId', 'effort', 'provider', 'providerId',
  'surface', 'surfaceId', 'transport', 'transportId', 'accessPathId', 'pair',
]));

function plainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

/**
 * How much reasoning the unit is worth. Judgment work has no decisive evidence
 * and always reasons deeply; the other two escalate with the blast radius, so a
 * mechanical change that cannot be taken back stops being treated as mechanical.
 */
function derivedReasoning(workload, risk) {
  if (workload === 'judgment') return 'deep';
  if (workload === 'development') return risk === 'high' ? 'deep' : 'balanced';
  return risk === 'low' ? 'light' : 'balanced';
}

export function classifyWorkflowIntent(input) {
  plainObject(input, 'workflow signals');
  for (const field of Object.keys(input)) {
    if (ROUTE_FIELDS.has(field)) {
      throw new TypeError(`a route is never an intent source: ${field}`);
    }
    if (!(field in SIGNAL_DIMENSIONS)) throw new TypeError(`unknown workflow signal: ${field}`);
  }
  const document = { version: ROUTING_INTENT_VERSION };
  for (const [signal, { field, values }] of Object.entries(SIGNAL_DIMENSIONS)) {
    const mapped = Object.hasOwn(values, input[signal]) ? values[input[signal]] : undefined;
    if (mapped === undefined) {
      throw new TypeError(`${signal} must be one of: ${WORKFLOW_SIGNAL_VOCABULARY[signal].join(', ')}`);
    }
    document[field] = mapped;
  }
  document.reasoning = derivedReasoning(document.workload, document.risk);
  return validateRoutingIntent(document);
}

/**
 * The resolved Routing intent plus how it was resolved, so a Dispatch plan can
 * show that an intent was stated rather than guessed — and which dimensions a
 * migrated v1 intent never carried.
 */
export function resolveRoutingIntent(input) {
  plainObject(input, 'intent resolution input');
  const explicit = input.explicit ?? null;
  if (explicit !== null) {
    // A stated intent may be a document or the block an issue body carries; a
    // legacy one migrates and reports every dimension it could not have stated.
    const stated = typeof explicit === 'string'
      ? parseRoutingIntent(explicit)
      : migrateRoutingIntent(explicit);
    return Object.freeze({
      source: 'explicit', intent: stated.intent, defaulted: stated.defaulted,
    });
  }
  if (input.signals == null) {
    throw new TypeError('intent resolution needs an explicit intent or workflow signals');
  }
  return Object.freeze({
    source: 'classifier',
    intent: classifyWorkflowIntent(input.signals),
    defaulted: Object.freeze([]),
  });
}
