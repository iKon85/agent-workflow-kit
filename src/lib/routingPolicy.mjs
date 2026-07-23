export const ROUTING_POLICY_VERSION = 1;

const POLICY_FIELDS = new Set([
  'schemaVersion',
  'revision',
  'allowedSurfaces',
  'allowedTransports',
  'switching',
  'optimization',
  'unreachable',
  'missingInfrastructure',
]);

const SWITCHING = ['automatic', 'ask', 'current-surface-only'];
const OPTIMIZATION = ['quality', 'balanced', 'cost'];
const UNREACHABLE = ['handoff', 'inherit', 'block'];
const MISSING_INFRASTRUCTURE = ['inherit', 'block'];

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

function stringList(value, field) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry !== '')) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value)];
}

function oneOf(value, values, field) {
  if (!values.includes(value)) throw new TypeError(`${field} must be one of: ${values.join(', ')}`);
  return value;
}

export function validateRoutingPolicy(input) {
  object(input, 'routing policy');
  for (const key of Object.keys(input)) {
    if (!POLICY_FIELDS.has(key)) throw new TypeError(`unknown routing policy field: ${key}`);
  }
  if (input.schemaVersion !== ROUTING_POLICY_VERSION) {
    throw new TypeError(`routing policy schemaVersion must be ${ROUTING_POLICY_VERSION}`);
  }
  return Object.freeze({
    schemaVersion: ROUTING_POLICY_VERSION,
    revision: string(input.revision, 'routing policy revision'),
    allowedSurfaces: Object.freeze(stringList(input.allowedSurfaces, 'allowedSurfaces')),
    allowedTransports: Object.freeze(stringList(input.allowedTransports, 'allowedTransports')),
    switching: oneOf(input.switching, SWITCHING, 'switching'),
    optimization: oneOf(input.optimization, OPTIMIZATION, 'optimization'),
    unreachable: oneOf(input.unreachable, UNREACHABLE, 'unreachable'),
    missingInfrastructure: oneOf(
      input.missingInfrastructure,
      MISSING_INFRASTRUCTURE,
      'missingInfrastructure',
    ),
  });
}
