export function nonInteractiveUpdateDecision(action) {
  if (action === 'delete') return true;
  if (action === 'collision') return undefined;
  throw new Error(`unknown update decision action: ${action}`);
}
