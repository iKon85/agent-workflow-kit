import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptClaudeRoutingInventory,
  capabilityAdapter,
  classifyCapabilities,
  selectOrchestrationReference,
} from '../src/lib/capabilityMatrix.mjs';
import { dispatchResolvedRoute } from '../src/lib/routeDispatcher.mjs';
import {
  ACCESS_GRAPH_VERSION,
  buildAccessGraph,
} from '../src/lib/routingAccessGraph.mjs';
import {
  claudeAccessAttestations,
  createClaudeRoutingAdapter,
} from '../src/lib/routingAdapters/claude.mjs';
import {
  adaptCodexRoutingInventory,
  codexAccessAttestations,
  createCodexRoutingAdapter,
} from '../src/lib/routingAdapters/codex.mjs';

const workflowSchema = {
  type: 'object',
};

const nativeTools = [
  { name: 'spawn_agent', schema: {}, callable: true, permitted: true, capabilities: ['spawn'] },
  { name: 'wait_agent', schema: {}, callable: true, permitted: true, capabilities: ['wait'] },
  { name: 'list_agents', schema: {}, callable: true, permitted: true, capabilities: ['aggregate'] },
];

function inventory(overrides = {}) {
  return {
    contractVersion: 1,
    tools: nativeTools,
    effectiveConcurrency: 2,
    threadCapacity: 2,
    ...overrides,
  };
}

test('literal callable and permitted Workflow with every primitive selects Path A', () => {
  const adapted = capabilityAdapter.claude(inventory({
    tools: [
      ...nativeTools,
      {
        name: 'Workflow', schema: workflowSchema, callable: true, permitted: true,
        capabilities: ['namedPhases', 'runIdentity', 'runtimeOutputValidation', 'journal', 'resume'],
      },
    ],
  }));

  assert.equal(classifyCapabilities(adapted), 'A');
  assert.deepEqual(selectOrchestrationReference(adapted), {
    path: 'A',
    kind: 'reference',
    value: 'references/dispatch-workflow.md',
  });
});

test('partial, deferred, disabled, and namespaced Workflow evidence falls to Path B', () => {
  const cases = {
    partial: {
      name: 'Workflow', schema: workflowSchema, callable: true, permitted: true,
      capabilities: ['namedPhases', 'runIdentity', 'runtimeOutputValidation', 'journal'],
    },
    deferred: {
      name: 'Workflow', schema: workflowSchema, callable: 'unknown', permitted: true,
      capabilities: ['namedPhases', 'runIdentity', 'runtimeOutputValidation', 'journal', 'resume'],
    },
    disabled: {
      name: 'Workflow', schema: workflowSchema, callable: false, permitted: true,
      capabilities: ['namedPhases', 'runIdentity', 'runtimeOutputValidation', 'journal', 'resume'],
    },
    namespaced: {
      name: 'claude.Workflow', schema: workflowSchema, callable: true, permitted: true,
      capabilities: ['namedPhases', 'runIdentity', 'runtimeOutputValidation', 'journal', 'resume'],
    },
  };

  for (const [label, workflow] of Object.entries(cases)) {
    assert.equal(
      classifyCapabilities(inventory({ tools: [...nativeTools, workflow] })),
      'B',
      label,
    );
  }
});

test('incomplete native evidence and effective concurrency below two falls to Path C', () => {
  const cases = {
    partial: inventory({ tools: nativeTools.slice(0, 2) }),
    disabled: inventory({
      tools: nativeTools.map((tool) => tool.name === 'wait_agent' ? { ...tool, permitted: false } : tool),
    }),
    lowConcurrency: inventory({ effectiveConcurrency: 1 }),
    unknownConcurrency: inventory({ effectiveConcurrency: 'unknown' }),
    unknownCapacity: inventory({ threadCapacity: 'unknown' }),
  };

  for (const [label, subject] of Object.entries(cases)) {
    assert.equal(classifyCapabilities(subject), 'C', label);
  }
});

test('adapters normalize missing evidence to unknown without ambient discovery', () => {
  for (const adapter of [capabilityAdapter.claude, capabilityAdapter.codex]) {
    const adapted = adapter({ contractVersion: 1, tools: [{ name: 'Workflow' }] });
    assert.deepEqual(adapted, {
      contractVersion: 1,
      tools: [{
        name: 'Workflow',
        schema: 'unknown',
        callable: 'unknown',
        permitted: 'unknown',
        capabilities: 'unknown',
      }],
      effectiveConcurrency: 'unknown',
      threadCapacity: 'unknown',
    });
    assert.equal(classifyCapabilities(adapted), 'C');
  }
});

test('the codex host inventory proven by spike #171 fails closed to Path C', () => {
  // codex-cli 0.144.6: ALL_TOOLS exposed name and description only -- no tool
  // schema, no callable/permitted flags, no threadCapacity. Native spawn/wait
  // exist and concurrency is >= 2, but that alone must never prove Path B.
  const adapted = capabilityAdapter.codex({
    contractVersion: 1,
    tools: [
      { name: 'spawn_agent', description: 'start a subagent' },
      { name: 'wait_agent', description: 'wait for running subagents' },
      { name: 'list_agents', description: 'list subagent status' },
    ],
    effectiveConcurrency: 4,
  });

  for (const tool of adapted.tools) {
    assert.equal(tool.schema, 'unknown');
    assert.equal(tool.callable, 'unknown');
    assert.equal(tool.permitted, 'unknown');
    assert.equal(tool.capabilities, 'unknown');
  }
  assert.equal(adapted.threadCapacity, 'unknown');
  assert.equal(classifyCapabilities(adapted), 'C');
  assert.deepEqual(selectOrchestrationReference(adapted), {
    path: 'C', kind: 'inline', value: 'path-c',
  });
});

test('a codex host with complete native evidence routes to Path B, never Path A', () => {
  // Dormant until a future host supplies the complete normalized inventory.
  const adapted = capabilityAdapter.codex(inventory());

  assert.equal(classifyCapabilities(adapted), 'B');
  const target = selectOrchestrationReference(adapted);
  assert.equal(target.value, 'references/dispatch-subagents.md');
  assert.notEqual(target.value, 'references/dispatch-workflow.md');
});

test('an unsupported inventory contract version cannot prove capabilities', () => {
  const adapted = capabilityAdapter.claude(inventory({ contractVersion: 2 }));
  assert.equal(classifyCapabilities(adapted), 'C');
});

test('null and array schemas cannot prove Path A or Path B', () => {
  const workflowCapabilities = [
    'namedPhases', 'runIdentity', 'runtimeOutputValidation', 'journal', 'resume',
  ];
  for (const schema of [null, []]) {
    const workflow = {
      name: 'Workflow', schema, callable: true, permitted: true,
      capabilities: workflowCapabilities,
    };
    const invalidNativeTools = nativeTools.map((tool) => ({ ...tool, schema }));

    assert.equal(classifyCapabilities(inventory({ tools: [workflow] })), 'C');
    assert.equal(classifyCapabilities(inventory({ tools: invalidNativeTools })), 'C');
  }
});

test('selector returns exactly one discriminated target for every path', () => {
  const workflow = {
    name: 'Workflow', schema: workflowSchema, callable: true, permitted: true,
    capabilities: ['namedPhases', 'runIdentity', 'runtimeOutputValidation', 'journal', 'resume'],
  };
  const subjects = [
    inventory({ tools: [...nativeTools, workflow] }),
    inventory(),
    inventory({ effectiveConcurrency: 'unknown' }),
  ];

  assert.deepEqual(subjects.map(selectOrchestrationReference), [
    { path: 'A', kind: 'reference', value: 'references/dispatch-workflow.md' },
    { path: 'B', kind: 'reference', value: 'references/dispatch-subagents.md' },
    { path: 'C', kind: 'inline', value: 'path-c' },
  ]);
});

function routingFixture({
  transportId = 'claude-native',
  allowedTransports = [transportId],
  unreachable = 'block',
  surfaceId = 'claude',
  providerId = transportId === 'codex-exec' ? 'openai' : 'anthropic',
  enforcementMethod = transportId === 'codex-exec' ? 'per-spawn' : 'named-agent',
} = {}) {
  const route = {
    providerId,
    modelId: transportId === 'codex-exec' ? 'coding-model' : 'reasoning-model',
    effort: 'high',
    surfaceId,
    transportId,
  };
  return {
    route,
    resolverInput: {
      intent: { version: 1, workload: 'development', reasoning: 'deep' },
      catalog: {
        schemaVersion: 1,
        revision: 'catalog-7',
        models: [{ providerId: route.providerId, modelId: route.modelId }],
        observations: [{
          id: 'observation-1',
          providerId: route.providerId,
          modelId: route.modelId,
          effort: route.effort,
          workload: 'development',
          harness: { id: 'fixture', version: '1' },
          score: 0.9,
          source: {
            owner: 'fixture', id: 'fixture', url: 'https://example.invalid/evidence',
            benchmark: 'fixture', version: '1', snapshotHash: 'hash-1',
          },
          uncertainty: { kind: 'interval', value: 0.1 },
          freshness: {
            observedAt: '2026-07-01T00:00:00.000Z',
            expiresAt: '2026-08-01T00:00:00.000Z',
          },
          cost: { amount: 1, currency: 'USD', unit: 'task' },
        }],
      },
      accessGraph: {
        schemaVersion: ACCESS_GRAPH_VERSION,
        revision: 'access-4',
        paths: [{
          id: `path-${transportId}`,
          providerId: route.providerId,
          modelId: route.modelId,
          effort: route.effort,
          surfaceId: route.surfaceId,
          transportId: route.transportId,
          availability: 'available',
          enforcement: { model: enforcementMethod, effort: enforcementMethod },
          capabilityEvidence: {
            revision: 'capability-3',
            observedAt: '2026-07-01T00:00:00.000Z',
            expiresAt: '2026-08-01T00:00:00.000Z',
          },
          attestation: {
            result: 'available',
            failureKind: null,
            probeId: 'capability-probe:minimal',
            authorizationId: 'probe-authorization-1',
            observedAt: '2026-07-01T00:00:00.000Z',
            expiresAt: '2026-08-01T00:00:00.000Z',
          },
        }],
      },
      policy: {
        schemaVersion: 1,
        revision: 'policy-9',
        allowedSurfaces: [surfaceId],
        allowedTransports,
        switching: 'automatic',
        optimization: 'quality',
        unreachable,
        missingInfrastructure: 'block',
      },
      activeSurface: surfaceId,
      knownTransports: [...new Set(['claude-native', 'codex-exec', transportId])],
      now: '2026-07-23T12:00:00.000Z',
    },
  };
}

function codexInventory(route, {
  method = 'per-spawn',
  precedence = 'explicit-argument',
  spawnProperties = {
    task_name: {},
    message: {},
    fork_turns: {},
    model: {},
    reasoning_effort: {},
  },
  detected = true,
  callable = true,
  permitted = true,
} = {}) {
  return {
    contractVersion: 1,
    observedAt: '2026-07-23T12:00:00.000Z',
    host: { id: 'codex-cli', version: '0.144.6' },
    spawnSchema: { type: 'object', properties: spawnProperties },
    paths: [{
      id: 'codex-native',
      ...route,
      detected,
      callable,
      permitted,
      model: { method, enforced: true, precedence, applied: route.modelId },
      effort: { method, enforced: true, precedence, applied: route.effort },
    }],
  };
}

test('Codex explicit-spawn AFK dispatch proves model and effort through receipt v2', async () => {
  const { route, resolverInput } = routingFixture({
    surfaceId: 'codex',
    providerId: 'openai',
    transportId: 'codex-native',
    enforcementMethod: 'per-spawn',
  });
  let invoked = 0;
  const adapter = createCodexRoutingAdapter({
    inventory: codexInventory(route),
    dispatchers: {
      'codex-native': async () => {
        invoked += 1;
        return { taskId: 'codex-native-1' };
      },
    },
  });

  const result = await dispatchResolvedRoute({
    executionId: 'execution-codex-native',
    afk: true,
    resolverInput,
    adapter,
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });

  assert.equal(invoked, 1);
  assert.equal(result.receipt.schemaVersion, 2);
  assert.equal(result.receipt.status, 'dispatched');
  assert.deepEqual(result.receipt.enforcement, { model: 'per-spawn', effort: 'per-spawn' });
  assert.deepEqual(result.receipt.precedence, {
    model: 'explicit-argument',
    effort: 'explicit-argument',
  });
  assert.deepEqual(result.receipt.revisions, {
    catalog: 'catalog-7', accessGraph: 'access-4', policy: 'policy-9',
  });
});

test('Codex named custom-agent and session-default routes preserve their precedence', async () => {
  for (const [method, precedence] of [
    ['named-agent', 'agent-definition-over-environment'],
    ['session-default', 'session-default'],
  ]) {
    const { route, resolverInput } = routingFixture({
      surfaceId: 'codex',
      providerId: 'openai',
      transportId: `codex-${method}`,
      enforcementMethod: method,
    });
    const result = await dispatchResolvedRoute({
      executionId: `execution-${method}`,
      afk: true,
      resolverInput,
      adapter: createCodexRoutingAdapter({
        inventory: codexInventory(route, {
          method,
          precedence,
          spawnProperties: { task_name: {}, message: {}, fork_turns: {} },
        }),
        dispatchers: {
          [route.transportId]: async () => ({ taskId: `task-${method}` }),
        },
      }),
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });

    assert.equal(result.receipt.status, 'dispatched', method);
    assert.deepEqual(result.receipt.enforcement, { model: method, effort: method });
    assert.deepEqual(result.receipt.precedence, { model: precedence, effort: precedence });
  }
});

test('Codex unavailable routes block before native spawn', async () => {
  const { route, resolverInput } = routingFixture({
    surfaceId: 'codex',
    providerId: 'openai',
    transportId: 'codex-native',
    enforcementMethod: 'per-spawn',
  });
  let invoked = 0;
  const result = await dispatchResolvedRoute({
    executionId: 'execution-codex-unavailable',
    afk: true,
    resolverInput,
    adapter: createCodexRoutingAdapter({
      inventory: codexInventory(route, { detected: false }),
      dispatchers: {
        'codex-native': async () => {
          invoked += 1;
          return { taskId: 'must-not-run' };
        },
      },
    }),
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });

  assert.equal(result.receipt.status, 'blocked');
  assert.equal(result.receipt.reason, 'transport is not detected');
  assert.equal(invoked, 0);
});

test('the selector-less current Codex host cannot claim differentiated AFK enforcement', async () => {
  const { route, resolverInput } = routingFixture({
    surfaceId: 'codex',
    providerId: 'openai',
    transportId: 'codex-native',
    enforcementMethod: 'per-spawn',
  });
  const currentHost = codexInventory(route, {
    spawnProperties: { task_name: {}, message: {}, fork_turns: {} },
  });
  const attested = adaptCodexRoutingInventory(currentHost);
  assert.equal(attested.paths[0].verified, false);
  assert.ok(attested.paths[0].verificationFailures.includes('model control is not enforced'));
  assert.ok(attested.paths[0].verificationFailures.includes('effort control is not enforced'));

  let invoked = 0;
  const result = await dispatchResolvedRoute({
    executionId: 'execution-current-codex-host',
    afk: true,
    resolverInput,
    adapter: createCodexRoutingAdapter({
      inventory: currentHost,
      dispatchers: {
        'codex-native': async () => {
          invoked += 1;
          return { taskId: 'must-not-run' };
        },
      },
    }),
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });

  assert.equal(result.receipt.status, 'blocked');
  assert.equal(result.receipt.reason, 'model control is not enforced');
  assert.equal(result.receipt.appliedRoute, null);
  assert.equal(invoked, 0);
});

test('Codex capabilities require a dated host attestation and ignore foreign surfaces', () => {
  const { route } = routingFixture({
    surfaceId: 'codex',
    providerId: 'openai',
    transportId: 'codex-native',
    enforcementMethod: 'per-spawn',
  });
  assert.throws(
    () => adaptCodexRoutingInventory({ ...codexInventory(route), observedAt: undefined }),
    /observedAt/,
  );
  const adapted = adaptCodexRoutingInventory({
    ...codexInventory(route),
    paths: [{ ...codexInventory(route).paths[0], surfaceId: 'claude' }],
  });
  assert.deepEqual(adapted.paths, []);
});

const CAPABILITY_DATES = Object.freeze({
  revision: 'capability-r1',
  observedAt: '2026-07-28T00:00:00.000Z',
  expiresAt: '2026-07-29T00:00:00.000Z',
});

function pairInventory(route, efforts) {
  return {
    contractVersion: 1,
    observedAt: CAPABILITY_DATES.observedAt,
    host: { id: 'codex-cli', version: '0.144.6' },
    spawnSchema: {
      type: 'object',
      properties: { task_name: {}, message: {}, model: {}, reasoning_effort: {} },
    },
    paths: efforts.map((effort) => ({
      id: `${route.transportId}:${route.modelId}:${effort}`,
      ...route,
      detected: true,
      callable: true,
      permitted: true,
      model: {
        method: 'per-spawn',
        enforced: true,
        precedence: 'explicit-argument',
        applied: route.modelId,
      },
      effort: {
        method: 'per-spawn',
        enforced: true,
        precedence: 'explicit-argument',
        applied: effort,
      },
    })),
  };
}

test('a surface adapter resolves only the exact model-and-effort pair', async () => {
  for (const [surfaceId, transportId, createAdapter] of [
    ['claude', 'claude-native', createClaudeRoutingAdapter],
    ['codex', 'codex-native', createCodexRoutingAdapter],
  ]) {
    const route = {
      providerId: 'anthropic',
      modelId: 'reasoning-model',
      effort: 'low',
      surfaceId,
      transportId,
    };
    const adapter = createAdapter({
      inventory: pairInventory(route, ['high', 'low']),
      dispatchers: { [transportId]: async () => ({ taskId: 'pair-1' }) },
    });

    const prepared = await adapter.prepare(route);
    assert.equal(prepared.appliedRoute.effort, 'low', surfaceId);
    assert.equal(prepared.mismatchReason, null, surfaceId);

    await assert.rejects(
      () => adapter.prepare({ ...route, effort: 'medium' }),
      /access pair is not attested: reasoning-model\+medium/,
      surfaceId,
    );
  }
});

test('surface adapters attest dated access paths for the graph builder', () => {
  const route = {
    providerId: 'anthropic',
    modelId: 'reasoning-model',
    surfaceId: 'claude',
    transportId: 'claude-native',
  };
  const attestations = claudeAccessAttestations(
    pairInventory(route, ['high', 'low']),
    CAPABILITY_DATES,
  );

  assert.deepEqual(attestations.map(({ effort }) => effort), ['high', 'low']);
  assert.deepEqual(attestations[0].enforcement, { model: 'per-spawn', effort: 'per-spawn' });
  assert.deepEqual(attestations[0].capabilityEvidence, {
    revision: CAPABILITY_DATES.revision,
    observedAt: CAPABILITY_DATES.observedAt,
    expiresAt: CAPABILITY_DATES.expiresAt,
  });
  assert.equal(attestations[0].attested, true);

  const graph = buildAccessGraph({ attestations });
  assert.equal(graph.schemaVersion, ACCESS_GRAPH_VERSION);
  assert.deepEqual(graph.paths.map(({ effort }) => effort), ['high', 'low']);
  assert.deepEqual(
    [...new Set(graph.paths.map(({ availability }) => availability))],
    ['unknown'],
    'detection is never authorization',
  );

  const codexRoute = { ...route, surfaceId: 'codex', transportId: 'codex-native', providerId: 'openai' };
  const selectorLess = pairInventory(codexRoute, ['high']);
  selectorLess.spawnSchema = { type: 'object', properties: { task_name: {}, message: {} } };
  const unattested = codexAccessAttestations(selectorLess, CAPABILITY_DATES);
  assert.equal(unattested[0].attested, false);
  assert.ok(unattested[0].attestationFailures.includes('effort control is not enforced'));
  assert.deepEqual(buildAccessGraph({ attestations: unattested }).paths, []);
  assert.deepEqual(
    codexAccessAttestations(pairInventory(route, ['high']), CAPABILITY_DATES),
    [],
    'a foreign surface never attests a Codex access path',
  );
});

test('Claude routing inventory attests only proved controls and preserves environment precedence', () => {
  const adapted = adaptClaudeRoutingInventory({
    contractVersion: 1,
    paths: [{
      id: 'native',
      surfaceId: 'claude',
      providerId: 'anthropic',
      modelId: 'reasoning-model',
      transportId: 'claude-native',
      detected: true,
      callable: true,
      permitted: true,
      model: {
        method: 'named-agent',
        enforced: true,
        precedence: 'agent-definition-over-environment',
        applied: 'reasoning-model',
      },
      effort: {
        method: 'named-agent',
        enforced: true,
        precedence: 'agent-definition-over-environment',
        applied: 'high',
      },
    }, {
      id: 'detected-only',
      surfaceId: 'claude',
      providerId: 'openai',
      modelId: 'coding-model',
      transportId: 'codex-exec',
      detected: true,
    }],
  });

  assert.equal(adapted.paths[0].verified, true);
  assert.equal(adapted.paths[0].model.precedence, 'agent-definition-over-environment');
  assert.equal(adapted.paths[1].verified, false);
});

test('Claude routing precedence is closed and environment overrides require observed applied values', () => {
  const adapted = adaptClaudeRoutingInventory({
    contractVersion: 1,
    paths: [{
      id: 'arbitrary',
      surfaceId: 'claude',
      providerId: 'anthropic',
      modelId: 'reasoning-model',
      transportId: 'claude-native',
      detected: true,
      callable: true,
      permitted: true,
      model: { method: 'named-agent', enforced: true, precedence: 'whatever' },
      effort: { method: 'named-agent', enforced: true, precedence: 'whatever' },
    }, {
      id: 'override-without-applied',
      surfaceId: 'claude',
      providerId: 'anthropic',
      modelId: 'reasoning-model',
      transportId: 'claude-native',
      detected: true,
      callable: true,
      permitted: true,
      model: {
        method: 'named-agent',
        enforced: true,
        precedence: 'environment-over-agent-definition',
      },
      effort: {
        method: 'named-agent',
        enforced: true,
        precedence: 'agent-definition-over-environment',
        applied: 'high',
      },
    }],
  });

  assert.equal(adapted.paths[0].verified, false);
  assert.ok(adapted.paths[0].verificationFailures.includes('model environment precedence is unverified'));
  assert.equal(adapted.paths[1].verified, false);
  assert.ok(adapted.paths[1].verificationFailures.includes('model applied value is unverified'));
});

test('Claude-native AFK dispatch proves model and effort and emits revisions', async () => {
  const { route, resolverInput } = routingFixture();
  let invoked = 0;
  const adapter = createClaudeRoutingAdapter({
    inventory: {
      contractVersion: 1,
      paths: [{
        id: 'native',
        ...route,
        detected: true,
        callable: true,
        permitted: true,
        model: { method: 'named-agent', enforced: true, precedence: 'agent-definition-over-environment', applied: route.modelId },
        effort: { method: 'named-agent', enforced: true, precedence: 'agent-definition-over-environment', applied: route.effort },
      }],
    },
    dispatchers: { 'claude-native': async () => { invoked += 1; return { taskId: 'native-1' }; } },
  });

  const result = await dispatchResolvedRoute({
    executionId: 'execution-native',
    afk: true,
    resolverInput,
    adapter,
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });

  assert.equal(invoked, 1);
  assert.equal(result.receipt.status, 'dispatched');
  assert.deepEqual(result.receipt.enforcement, { model: 'named-agent', effort: 'named-agent' });
  assert.deepEqual(result.receipt.precedence, {
    model: 'agent-definition-over-environment',
    effort: 'agent-definition-over-environment',
  });
  assert.deepEqual(result.receipt.revisions, {
    catalog: 'catalog-7', accessGraph: 'access-4', policy: 'policy-9',
  });
});

test('approved Claude-to-Codex transport dispatches but detected unapproved transport blocks', async () => {
  const approved = routingFixture({ transportId: 'codex-exec' });
  let invoked = 0;
  const adapter = createClaudeRoutingAdapter({
    inventory: {
      contractVersion: 1,
      paths: [{
        id: 'codex',
        ...approved.route,
        detected: true,
        callable: true,
        permitted: true,
        model: { method: 'per-spawn', enforced: true, precedence: 'explicit-argument', applied: approved.route.modelId },
        effort: { method: 'per-spawn', enforced: true, precedence: 'explicit-argument', applied: approved.route.effort },
      }],
    },
    dispatchers: { 'codex-exec': async () => { invoked += 1; return { taskId: 'codex-1' }; } },
  });
  const dispatched = await dispatchResolvedRoute({
    executionId: 'execution-codex',
    afk: true,
    resolverInput: approved.resolverInput,
    adapter,
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });
  assert.equal(dispatched.receipt.status, 'dispatched');

  const denied = routingFixture({ transportId: 'codex-exec', allowedTransports: [] });
  const blocked = await dispatchResolvedRoute({
    executionId: 'execution-denied',
    afk: true,
    resolverInput: denied.resolverInput,
    adapter,
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });
  assert.equal(blocked.receipt.status, 'blocked');
  assert.match(blocked.receipt.reason, /transport-not-allowed/);
  assert.equal(invoked, 1);
});

test('environment override, applied route mismatch, and unenforced effort block before spawn', async () => {
  const { route, resolverInput } = routingFixture();
  for (const [label, path] of Object.entries({
    override: {
      ...route,
      model: { method: 'named-agent', enforced: true, precedence: 'environment-over-agent-definition', applied: 'other-model' },
      effort: { method: 'named-agent', enforced: true, precedence: 'agent-definition-over-environment', applied: route.effort },
    },
    effort: {
      ...route,
      model: { method: 'named-agent', enforced: true, precedence: 'agent-definition-over-environment', applied: route.modelId },
      effort: { method: 'none', enforced: false, precedence: 'uncontrolled', applied: route.effort },
    },
  })) {
    let invoked = 0;
    const adapter = createClaudeRoutingAdapter({
      inventory: {
        contractVersion: 1,
        paths: [{
          id: label, detected: true, callable: true, permitted: true, ...path,
        }],
      },
      dispatchers: { 'claude-native': async () => { invoked += 1; } },
    });
    const result = await dispatchResolvedRoute({
      executionId: `execution-${label}`,
      afk: true,
      resolverInput,
      adapter,
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });
    assert.equal(result.receipt.status, 'blocked', label);
    assert.match(result.receipt.reason, label === 'override' ? /environment.*model/i : /effort/i);
    if (label === 'override') {
      assert.equal(result.receipt.appliedRoute.modelId, 'other-model');
      assert.equal(result.receipt.precedence.model, 'environment-over-agent-definition');
    }
    assert.equal(invoked, 0);
  }
});

test('concurrent routing profile mutation blocks before spawn', async () => {
  const { resolverInput } = routingFixture();
  let invoked = 0;
  const adapter = {
    async prepare(requestedRoute) {
      resolverInput.policy.revision = 'policy-mutated';
      return {
        appliedRoute: requestedRoute,
        enforcement: { model: 'named-agent', effort: 'named-agent' },
        dispatch: async () => { invoked += 1; },
      };
    },
  };
  const result = await dispatchResolvedRoute({
    executionId: 'execution-concurrent',
    afk: true,
    resolverInput,
    adapter,
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });
  assert.equal(result.receipt.status, 'blocked');
  assert.match(result.receipt.reason, /concurrent routing profile mutation/);
  assert.equal(invoked, 0);
});

test('secret-bearing concurrent revisions map to a constant receipt reason', async () => {
  const { resolverInput } = routingFixture();
  const secret = 'secret-revision-value';
  const adapter = {
    async prepare(requestedRoute) {
      resolverInput.policy.revision = secret;
      return {
        appliedRoute: requestedRoute,
        enforcement: { model: 'named-agent', effort: 'named-agent' },
        precedence: {
          model: 'agent-definition-over-environment',
          effort: 'agent-definition-over-environment',
        },
        dispatch: async () => ({ taskId: 'must-not-run' }),
      };
    },
  };
  const result = await dispatchResolvedRoute({
    executionId: 'execution-secret-revision',
    afk: true,
    resolverInput,
    adapter,
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });
  assert.equal(result.receipt.reason, 'concurrent routing profile mutation');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('adapter mismatch diagnostics cannot inject secrets into a blocked receipt', async () => {
  const { resolverInput } = routingFixture();
  const secret = 'secret-adapter-diagnostic';
  const result = await dispatchResolvedRoute({
    executionId: 'execution-secret-mismatch',
    afk: true,
    resolverInput,
    adapter: {
      async prepare(requestedRoute) {
        return {
          appliedRoute: requestedRoute,
          enforcement: { model: 'named-agent', effort: 'named-agent' },
          precedence: {
            model: 'agent-definition-over-environment',
            effort: 'agent-definition-over-environment',
          },
          mismatchReason: secret,
          dispatch: async () => ({ taskId: 'must-not-run' }),
        };
      },
    },
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });
  assert.equal(result.receipt.reason, 'dispatch adapter rejected route');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('unreachable handoff, inherit, and block policy outcomes do not spawn', async () => {
  for (const unreachable of ['handoff', 'inherit', 'block']) {
    const fixture = routingFixture({ allowedTransports: [], unreachable });
    const result = await dispatchResolvedRoute({
      executionId: `execution-${unreachable}`,
      afk: false,
      resolverInput: fixture.resolverInput,
      adapter: { prepare: async () => { throw new Error('must not prepare'); } },
      dispatchedAt: '2026-07-23T12:00:01.000Z',
    });
    const expectedStatus = unreachable === 'block' ? 'blocked' : unreachable;
    assert.equal(result.decision.status, expectedStatus);
    assert.equal(result.receipt.status, 'blocked');
    assert.match(result.receipt.reason, new RegExp(`^${expectedStatus}:`));
  }
});

test('receipt and output never expose injected secret fixture values', async () => {
  const { route, resolverInput } = routingFixture();
  const secret = 'token-secret-fixture';
  const adapter = createClaudeRoutingAdapter({
    inventory: {
      contractVersion: 1,
      ignoredSecret: secret,
      paths: [{
        id: 'native', ...route, detected: true, callable: true, permitted: true,
        model: { method: 'named-agent', enforced: true, precedence: 'agent-definition-over-environment', applied: route.modelId },
        effort: { method: 'named-agent', enforced: true, precedence: 'agent-definition-over-environment', applied: route.effort },
      }],
    },
    dispatchers: { 'claude-native': async () => ({ taskId: 'safe', diagnostic: secret }) },
  });
  const result = await dispatchResolvedRoute({
    executionId: 'execution-safe',
    afk: true,
    resolverInput,
    adapter,
    dispatchedAt: '2026-07-23T12:00:01.000Z',
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});
