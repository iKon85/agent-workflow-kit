import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTING_INTENT_VERSION,
  serializeRoutingIntent,
} from '../src/lib/routingIntent.mjs';
import {
  WORKFLOW_SIGNAL_VOCABULARY,
  classifyWorkflowIntent,
  resolveRoutingIntent,
} from '../src/lib/routingIntentClassifier.mjs';

const SIGNALS = Object.freeze({
  outcome: 'implementation',
  steps: 'several',
  blastRadius: 'shared',
  supervision: 'attended',
  breadth: 'repository',
});

const signals = (overrides = {}) => ({ ...SIGNALS, ...overrides });

const EXPLICIT = Object.freeze({
  version: ROUTING_INTENT_VERSION,
  workload: 'judgment',
  reasoning: 'deep',
  taskShape: 'long-horizon',
  risk: 'high',
  autonomyRequirement: 'supervised',
  contextNeed: 'long-context',
});

test('the workflow classifier derives every v2 dimension from provider-neutral signals', () => {
  assert.deepEqual(classifyWorkflowIntent(SIGNALS), {
    version: ROUTING_INTENT_VERSION,
    workload: 'development',
    reasoning: 'balanced',
    taskShape: 'multi-step',
    risk: 'moderate',
    autonomyRequirement: 'supervised',
    contextNeed: 'repository',
  });

  // Every declared signal value maps onto exactly one intent dimension value.
  const mapped = {
    outcome: ['workload', { decision: 'judgment', implementation: 'development', transformation: 'mechanical' }],
    steps: ['taskShape', { single: 'single-step', several: 'multi-step', 'session-spanning': 'long-horizon' }],
    blastRadius: ['risk', { contained: 'low', shared: 'moderate', irreversible: 'high' }],
    supervision: ['autonomyRequirement', { attended: 'supervised', unattended: 'afk' }],
    breadth: ['contextNeed', { 'single-file': 'focused', repository: 'repository', 'cross-repository': 'long-context' }],
  };
  for (const [signal, [dimension, table]] of Object.entries(mapped)) {
    assert.deepEqual(Object.keys(table), [...WORKFLOW_SIGNAL_VOCABULARY[signal]], signal);
    for (const [value, expected] of Object.entries(table)) {
      assert.equal(
        classifyWorkflowIntent(signals({ [signal]: value }))[dimension],
        expected,
        `${signal}=${value}`,
      );
    }
  }
});

test('reasoning is derived from what the work produces and what a wrong answer costs', () => {
  const reasoning = (outcome, blastRadius) =>
    classifyWorkflowIntent(signals({ outcome, blastRadius })).reasoning;

  // Judgment is deep whatever the blast radius; the other two escalate with it.
  assert.deepEqual(
    ['contained', 'shared', 'irreversible'].map((radius) => reasoning('decision', radius)),
    ['deep', 'deep', 'deep'],
  );
  assert.deepEqual(
    ['contained', 'shared', 'irreversible'].map((radius) => reasoning('implementation', radius)),
    ['balanced', 'balanced', 'deep'],
  );
  assert.deepEqual(
    ['contained', 'shared', 'irreversible'].map((radius) => reasoning('transformation', radius)),
    ['light', 'balanced', 'balanced'],
  );
});

test('an explicit intent resolves first and the classifier never runs', () => {
  const contradicting = signals({ outcome: 'transformation', steps: 'single' });

  const explicit = resolveRoutingIntent({ explicit: EXPLICIT, signals: contradicting });
  assert.equal(explicit.source, 'explicit');
  assert.deepEqual(explicit.intent, EXPLICIT);
  assert.deepEqual(explicit.defaulted, []);

  // The same explicit intent serialized into an issue body is still explicit.
  const fromIssue = resolveRoutingIntent({
    explicit: `## Routing intent\n\n${serializeRoutingIntent(EXPLICIT)}\n\nsomething else\n`,
    signals: contradicting,
  });
  assert.equal(fromIssue.source, 'explicit');
  assert.deepEqual(fromIssue.intent, EXPLICIT);

  // Only without one does the classifier decide.
  const classified = resolveRoutingIntent({ signals: contradicting });
  assert.equal(classified.source, 'classifier');
  assert.equal(classified.intent.workload, 'mechanical');
  assert.equal(classified.intent.taskShape, 'single-step');
});

test('an explicit v1 intent migrates and names the dimensions it had to default', () => {
  const resolved = resolveRoutingIntent({
    explicit: { version: 1, workload: 'mechanical', reasoning: 'light' },
  });
  assert.equal(resolved.source, 'explicit');
  assert.equal(resolved.intent.version, ROUTING_INTENT_VERSION);
  assert.equal(resolved.intent.autonomyRequirement, 'supervised');
  assert.deepEqual(resolved.defaulted, ['taskShape', 'risk', 'autonomyRequirement', 'contextNeed']);
});

test('a route is never an intent source', () => {
  for (const field of [
    'route', 'model', 'modelId', 'effort', 'provider', 'providerId',
    'surface', 'surfaceId', 'transport', 'transportId', 'accessPathId', 'pair',
  ]) {
    assert.throws(
      () => classifyWorkflowIntent({ ...SIGNALS, [field]: 'opus' }),
      /a route is never an intent source/,
      field,
    );
    assert.throws(
      () => resolveRoutingIntent({ signals: { ...SIGNALS, [field]: 'opus' } }),
      /a route is never an intent source/,
      field,
    );
  }

  // The classifier produces an intent and nothing that looks like a route.
  assert.deepEqual(Object.keys(classifyWorkflowIntent(SIGNALS)).sort(), [
    'autonomyRequirement', 'contextNeed', 'reasoning', 'risk',
    'taskShape', 'version', 'workload',
  ]);
});

test('the classifier fails closed on an unknown, missing, or empty signal', () => {
  assert.throws(() => classifyWorkflowIntent({ ...SIGNALS, urgency: 'high' }),
    /unknown workflow signal: urgency/);
  assert.throws(() => classifyWorkflowIntent({ ...SIGNALS, outcome: 'refactoring' }),
    /outcome must be one of: decision, implementation, transformation/);
  const { breadth: _omitted, ...incomplete } = SIGNALS;
  assert.throws(() => classifyWorkflowIntent(incomplete),
    /breadth must be one of: single-file, repository, cross-repository/);
  assert.throws(() => classifyWorkflowIntent(null), /workflow signals must be an object/);
  assert.throws(() => resolveRoutingIntent({}),
    /intent resolution needs an explicit intent or workflow signals/);
  assert.throws(() => resolveRoutingIntent(null), /intent resolution input must be an object/);
});
