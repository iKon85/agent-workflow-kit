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
