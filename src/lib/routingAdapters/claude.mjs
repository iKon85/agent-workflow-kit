import { adaptClaudeRoutingInventory } from '../capabilityMatrix.mjs';

function matchesRoute(path, route) {
  return ['surfaceId', 'providerId', 'modelId', 'transportId']
    .every((field) => path[field] === route[field]);
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

export function createClaudeRoutingAdapter({ inventory, dispatchers = {} }) {
  const capabilities = adaptClaudeRoutingInventory(inventory);
  return Object.freeze({
    async prepare(requestedRoute) {
      const path = capabilities.paths.find((candidate) => matchesRoute(candidate, requestedRoute));
      if (!path) throw new Error('Claude route capability is not attested');
      if (!path.verified) throw new Error(path.verificationFailures.join('; '));
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
