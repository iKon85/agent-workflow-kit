import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OwnershipState, classifyOwnershipEvidence,
} from '../src/lib/ownershipClassifier.mjs';
import { nonInteractiveUpdateDecision } from '../src/lib/updateDecisions.mjs';

test('ownership evidence distinguishes every Core, extension, bridge, fork, and ambiguous state', () => {
  const path = '.claude/skills/tdd/SKILL.md';
  const packageEntry = { path };
  assert.equal(classifyOwnershipEvidence({
    path, packageEntry, installedEntry: { path, origin: 'kit' }, destinationPresent: true,
  }).state, OwnershipState.CLEAN_CORE);
  assert.equal(classifyOwnershipEvidence({
    path: 'docs/agents/skills/tdd.md',
    packageEntry: { path: 'docs/agents/skills/tdd.md' },
    destinationPresent: true,
    projectExtension: { schemaVersion: 1 },
  }).state, OwnershipState.PROJECT_EXTENSION);
  assert.equal(classifyOwnershipEvidence({
    path, packageEntry,
    installedEntry: { path, origin: 'consumer', ownershipState: 'contribution-bridge' },
    destinationPresent: true,
  }).state, OwnershipState.CONTRIBUTION_BRIDGE);
  assert.equal(classifyOwnershipEvidence({
    path, packageEntry,
    installedEntry: { path, origin: 'consumer', ownershipState: 'explicit-fork' },
    destinationPresent: true,
  }).state, OwnershipState.EXPLICIT_FORK);
  const ambiguous = classifyOwnershipEvidence({
    path, packageEntry, destinationPresent: true,
  });
  assert.equal(ambiguous.state, OwnershipState.AMBIGUOUS_COLLISION);
  assert.deepEqual(ambiguous.evidence, {
    packageDeclared: true,
    ledgerOrigin: 'absent',
    destination: 'present',
    projectExtension: 'absent',
  });
  assert.deepEqual(
    ambiguous.routes.map(({ id }) => id),
    ['project-extension', 'contribution-bridge', 'explicit-fork', 'clean-core'],
  );
});

test('non-interactive confirmation accepts safe deletion but never interprets ownership', () => {
  assert.equal(nonInteractiveUpdateDecision('delete'), true);
  assert.equal(nonInteractiveUpdateDecision('collision'), undefined);
  assert.throws(() => nonInteractiveUpdateDecision('unknown'), /unknown update decision/);
});
