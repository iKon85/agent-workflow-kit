import { adaptClaudeRoutingInventory } from '../capabilityMatrix.mjs';
import {
  attestAccessPath,
  capabilityPathMatchesPair,
  selectCapabilityPath,
} from '../routingAccessGraph.mjs';

const MODEL_SELECTORS = ['model'];
const EFFORT_SELECTORS = ['effort', 'reasoning_effort', 'model_reasoning_effort'];

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

function timestamp(value, field) {
  string(value, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function schemaProperties(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  if (!schema.properties || typeof schema.properties !== 'object'
      || Array.isArray(schema.properties)) return {};
  return schema.properties;
}

function hasSelector(properties, selectors) {
  return selectors.some((selector) =>
    Object.prototype.hasOwnProperty.call(properties, selector));
}

function uncontrolled(control) {
  return {
    ...control,
    method: 'none',
    enforced: false,
    precedence: 'uncontrolled',
    applied: undefined,
  };
}

function applySpawnSchemaEvidence(path, properties) {
  const candidate = { ...path };
  if (path?.model?.method === 'per-spawn'
      && !hasSelector(properties, MODEL_SELECTORS)) {
    candidate.model = uncontrolled(path.model);
  }
  if (path?.effort?.method === 'per-spawn'
      && !hasSelector(properties, EFFORT_SELECTORS)) {
    candidate.effort = uncontrolled(path.effort);
  }
  return candidate;
}

function appliedRoute(path, requestedRoute) {
  return Object.freeze({
    ...requestedRoute,
    modelId: path.model.applied,
    effort: path.effort.applied,
  });
}

function mismatchReason(path, requested, applied) {
  for (const field of ['modelId', 'effort']) {
    if (requested[field] === applied[field]) continue;
    const control = field === 'modelId' ? path.model : path.effort;
    if (control.precedence === 'environment-over-agent-definition') {
      return `environment precedence mismatch: ${field === 'modelId' ? 'model' : field}`;
    }
    return `applied route mismatch: ${field}`;
  }
  return null;
}

export function adaptCodexRoutingInventory(inventory) {
  const source = object(inventory, 'Codex host attestation');
  timestamp(source.observedAt, 'Codex host attestation observedAt');
  const host = object(source.host, 'Codex host attestation host');
  string(host.id, 'Codex host attestation host.id');
  string(host.version, 'Codex host attestation host.version');
  const properties = schemaProperties(source.spawnSchema);
  const paths = Array.isArray(source.paths)
    ? source.paths
      .filter((path) => path?.surfaceId === 'codex')
      .map((path) => applySpawnSchemaEvidence(path, properties))
    : [];
  return adaptClaudeRoutingInventory({
    contractVersion: source.contractVersion,
    paths,
  });
}

/**
 * Attest the Codex surface's access paths for the Access-graph builder. A host
 * whose spawn schema exposes no selector attests no control, so the path never
 * becomes a dispatchable Access-graph path.
 */
export function codexAccessAttestations(inventory, dates) {
  return Object.freeze(adaptCodexRoutingInventory(inventory).paths
    .map((path) => attestAccessPath(path, dates)));
}

export function createCodexRoutingAdapter({ inventory, dispatchers = {} }) {
  const capabilities = adaptCodexRoutingInventory(inventory);
  return Object.freeze({
    async prepare(requestedRoute) {
      const path = selectCapabilityPath(capabilities.paths, requestedRoute);
      if (!path) throw new Error('Codex route capability is not attested');
      if (!path.verified) throw new Error(path.verificationFailures.join('; '));
      if (!capabilityPathMatchesPair(path, requestedRoute)) {
        throw new Error(
          `access pair is not attested: ${requestedRoute.modelId}+${requestedRoute.effort}`,
        );
      }
      const invoke = dispatchers[path.transportId];
      if (typeof invoke !== 'function') {
        throw new Error(`transport has no approved dispatcher: ${path.transportId}`);
      }
      const applied = appliedRoute(path, requestedRoute);
      const mismatch = mismatchReason(path, requestedRoute, applied);
      const enforcement = Object.freeze({
        model: path.model.method,
        effort: path.effort.method,
      });
      return Object.freeze({
        appliedRoute: applied,
        enforcement,
        precedence: Object.freeze({
          model: path.model.precedence,
          effort: path.effort.precedence,
        }),
        mismatchReason: mismatch,
        dispatch: () => invoke(Object.freeze({ route: applied, enforcement })),
      });
    },
  });
}
