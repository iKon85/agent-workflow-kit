import { adaptClaudeRoutingInventory } from '../capabilityMatrix.mjs';
import {
  attestAccessPath,
  capabilityPathMatchesPair,
  selectCapabilityPath,
} from '../routingAccessGraph.mjs';

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

/**
 * Attest the Claude surface's access paths for the Access-graph builder. The
 * attestation carries capability facts and their observation dates only —
 * authorization stays with the Routing profile and the capability probe.
 */
export function claudeAccessAttestations(inventory, dates) {
  return Object.freeze(adaptClaudeRoutingInventory(inventory).paths
    .map((path) => attestAccessPath(path, dates)));
}

export function createClaudeRoutingAdapter({ inventory, dispatchers = {} }) {
  const capabilities = adaptClaudeRoutingInventory(inventory);
  return Object.freeze({
    async prepare(requestedRoute) {
      const path = selectCapabilityPath(capabilities.paths, requestedRoute);
      if (!path) throw new Error('Claude route capability is not attested');
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
      return Object.freeze({
        appliedRoute: applied,
        enforcement: Object.freeze({
          model: path.model.method,
          effort: path.effort.method,
        }),
        precedence: Object.freeze({
          model: path.model.precedence,
          effort: path.effort.precedence,
        }),
        mismatchReason: mismatch,
        dispatch: () => invoke(Object.freeze({
          route: applied,
          enforcement: Object.freeze({
            model: path.model.method,
            effort: path.effort.method,
          }),
        })),
      });
    },
  });
}
