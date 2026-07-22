import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  capabilityAdapter,
  classifyCapabilities,
  selectOrchestrationReference,
} from '../src/lib/capabilityMatrix.mjs';

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
