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

const FIELDS = new Set(['version', 'workload', 'reasoning']);

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
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
  return Object.freeze({
    version: ROUTING_INTENT_VERSION,
    workload: requireEnum(input.workload, ROUTING_WORKLOADS, 'workload'),
    reasoning: requireEnum(input.reasoning, ROUTING_REASONING, 'reasoning'),
  });
}
