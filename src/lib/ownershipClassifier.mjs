export const OwnershipState = Object.freeze({
  CLEAN_CORE: 'clean-core',
  PROJECT_EXTENSION: 'project-extension',
  CONTRIBUTION_BRIDGE: 'contribution-bridge',
  EXPLICIT_FORK: 'explicit-fork',
  AMBIGUOUS_COLLISION: 'ambiguous-collision',
});

const ROUTES = Object.freeze([
  { id: 'project-extension', action: 'move Project data to docs/agents/skills/<skill>.md' },
  { id: 'contribution-bridge', action: 'register a temporary contribution-bridge' },
  { id: 'explicit-fork', action: 'register an explicit-fork with its own update line' },
  { id: 'clean-core', action: 'explicitly replace the destination with Kit Core' },
]);

export function classifyOwnershipEvidence({
  path, packageEntry, installedEntry, destinationPresent, projectExtension,
}) {
  const evidence = {
    packageDeclared: Boolean(packageEntry),
    ledgerOrigin: installedEntry?.origin ?? 'absent',
    destination: destinationPresent ? 'present' : 'absent',
    projectExtension: projectExtension
      ? (projectExtension.invalid ? 'invalid' : `schema-v${projectExtension.schemaVersion}`)
      : 'absent',
  };
  if (projectExtension?.invalid) evidence.extensionDiagnostic = projectExtension.invalid;
  if (installedEntry?.origin === 'kit') {
    return { path, state: OwnershipState.CLEAN_CORE, evidence, routes: [] };
  }
  if (installedEntry?.origin === 'consumer') {
    const state = installedEntry.ownershipState ?? OwnershipState.EXPLICIT_FORK;
    if (![
      OwnershipState.PROJECT_EXTENSION,
      OwnershipState.CONTRIBUTION_BRIDGE,
      OwnershipState.EXPLICIT_FORK,
    ].includes(state)) {
      return { path, state: OwnershipState.AMBIGUOUS_COLLISION, evidence, routes: [...ROUTES] };
    }
    if (state === OwnershipState.PROJECT_EXTENSION
        && (!/^docs\/agents\/skills\/[a-z0-9-]+\.md$/.test(path)
          || !projectExtension || projectExtension.invalid)) {
      return { path, state: OwnershipState.AMBIGUOUS_COLLISION, evidence, routes: [...ROUTES] };
    }
    return { path, state, evidence, routes: [] };
  }
  if (projectExtension && !projectExtension.invalid) {
    return { path, state: OwnershipState.PROJECT_EXTENSION, evidence, routes: [
      { id: 'project-extension', action: 'keep the declared Project extension' },
      { id: 'clean-core', action: 'explicitly replace the destination with Kit Core' },
    ] };
  }
  return { path, state: OwnershipState.AMBIGUOUS_COLLISION, evidence, routes: [...ROUTES] };
}
