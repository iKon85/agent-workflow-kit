const UNKNOWN = 'unknown';

const PATH_A_CAPABILITIES = [
  'namedPhases',
  'runIdentity',
  'runtimeOutputValidation',
  'journal',
  'resume',
];

const PATH_B_TOOLS = [
  ['spawn_agent', 'spawn'],
  ['wait_agent', 'wait'],
  ['list_agents', 'aggregate'],
];

const TARGETS = Object.freeze({
  A: Object.freeze({ path: 'A', kind: 'reference', value: 'references/dispatch-workflow.md' }),
  B: Object.freeze({ path: 'B', kind: 'reference', value: 'references/dispatch-subagents.md' }),
  C: Object.freeze({ path: 'C', kind: 'inline', value: 'path-c' }),
});

function triState(value) {
  return typeof value === 'boolean' ? value : UNKNOWN;
}

function capacity(value) {
  return Number.isInteger(value) && value >= 0 ? value : UNKNOWN;
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  return {
    name: typeof tool.name === 'string' ? tool.name : UNKNOWN,
    schema: tool.schema && typeof tool.schema === 'object' && !Array.isArray(tool.schema)
      ? tool.schema
      : UNKNOWN,
    callable: triState(tool.callable),
    permitted: triState(tool.permitted),
    capabilities: Array.isArray(tool.capabilities)
      && tool.capabilities.every((item) => typeof item === 'string')
      ? [...new Set(tool.capabilities)]
      : UNKNOWN,
  };
}

function adaptInventory(inventory) {
  const source = inventory && typeof inventory === 'object' ? inventory : {};
  const validContract = source.contractVersion === 1;
  return {
    contractVersion: 1,
    tools: validContract && Array.isArray(source.tools)
      ? source.tools.map(normalizeTool).filter(Boolean)
      : [],
    effectiveConcurrency: validContract ? capacity(source.effectiveConcurrency) : UNKNOWN,
    threadCapacity: validContract ? capacity(source.threadCapacity) : UNKNOWN,
  };
}

export const capabilityAdapter = Object.freeze({
  claude: adaptInventory,
  codex: adaptInventory,
});

const ROUTE_IDENTITY_FIELDS = [
  'id',
  'surfaceId',
  'providerId',
  'modelId',
  'transportId',
];

const ROUTE_ENFORCEMENT_METHODS = [
  'per-spawn',
  'named-agent',
  'session-default',
  'none',
];

const ROUTE_PRECEDENCE = [
  'explicit-argument',
  'agent-definition-over-environment',
  'environment-over-agent-definition',
  'session-default',
];

function routingControl(control) {
  const source = control && typeof control === 'object' && !Array.isArray(control)
    ? control
    : {};
  return {
    method: ROUTE_ENFORCEMENT_METHODS.includes(source.method) ? source.method : UNKNOWN,
    enforced: triState(source.enforced),
    precedence: ROUTE_PRECEDENCE.includes(source.precedence)
      ? source.precedence
      : UNKNOWN,
    applied: typeof source.applied === 'string' && source.applied !== ''
      ? source.applied
      : UNKNOWN,
  };
}

function routingPath(path) {
  const source = path && typeof path === 'object' && !Array.isArray(path) ? path : {};
  const normalized = Object.fromEntries(ROUTE_IDENTITY_FIELDS.map((field) => [
    field,
    typeof source[field] === 'string' && source[field] !== '' ? source[field] : UNKNOWN,
  ]));
  normalized.detected = triState(source.detected);
  normalized.callable = triState(source.callable);
  normalized.permitted = triState(source.permitted);
  normalized.model = routingControl(source.model);
  normalized.effort = routingControl(source.effort);
  const failures = [];
  if (ROUTE_IDENTITY_FIELDS.some((field) => normalized[field] === UNKNOWN)) {
    failures.push('route identity is incomplete');
  }
  if (normalized.detected !== true) failures.push('transport is not detected');
  if (normalized.callable !== true) failures.push('transport is not callable');
  if (normalized.permitted !== true) failures.push('transport is not permitted');
  for (const field of ['model', 'effort']) {
    if (normalized[field].enforced !== true || normalized[field].method === 'none'
        || normalized[field].method === UNKNOWN) {
      failures.push(`${field} control is not enforced`);
    }
    if (normalized[field].precedence === UNKNOWN) {
      failures.push(`${field} environment precedence is unverified`);
    }
    if (normalized[field].applied === UNKNOWN) {
      failures.push(`${field} applied value is unverified`);
    }
  }
  normalized.verified = failures.length === 0;
  normalized.verificationFailures = failures;
  return Object.freeze(normalized);
}

export function adaptClaudeRoutingInventory(inventory) {
  const source = inventory && typeof inventory === 'object' && !Array.isArray(inventory)
    ? inventory
    : {};
  return Object.freeze({
    contractVersion: 1,
    paths: source.contractVersion === 1 && Array.isArray(source.paths)
      ? Object.freeze(source.paths.map(routingPath))
      : Object.freeze([]),
  });
}

function proves(tool, capability) {
  return tool?.callable === true
    && tool.permitted === true
    && tool.schema !== UNKNOWN
    && Array.isArray(tool.capabilities)
    && tool.capabilities.includes(capability);
}

function supportsPathA(inventory) {
  const workflow = inventory.tools.find(({ name }) => name === 'Workflow');
  return PATH_A_CAPABILITIES.every((capability) => proves(workflow, capability));
}

function supportsPathB(inventory) {
  if (inventory.effectiveConcurrency === UNKNOWN || inventory.effectiveConcurrency < 2) return false;
  if (inventory.threadCapacity === UNKNOWN || inventory.threadCapacity < 2) return false;
  return PATH_B_TOOLS.every(([name, capability]) =>
    inventory.tools.some((tool) => tool.name === name && proves(tool, capability)));
}

export function classifyCapabilities(inventory) {
  const normalized = adaptInventory(inventory);
  if (supportsPathA(normalized)) return 'A';
  if (supportsPathB(normalized)) return 'B';
  return 'C';
}

export function selectOrchestrationReference(inventory) {
  return TARGETS[classifyCapabilities(inventory)];
}
