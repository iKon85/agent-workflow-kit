export function nonInteractiveUpdateDecision(action, choices = {}) {
  if (action === 'delete') return choices.deleted !== 'restore';
  if (action === 'collision') return undefined;
  throw new Error(`unknown update decision action: ${action}`);
}
