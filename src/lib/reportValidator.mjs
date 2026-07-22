const HASH_PATTERN = '^[0-9a-f]{40}$|^[0-9a-f]{64}$';

const stringArray = { type: 'array', items: { type: 'string' } };

export const RECON_REPORT_SCHEMA = {
  type: 'object',
  required: ['sliceId', 'plannedFiles', 'dependencyEdges'],
  additionalProperties: false,
  properties: {
    sliceId: { type: 'string', pattern: '^[0-9]+$' },
    plannedFiles: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'role'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          role: { type: 'string', enum: ['edit', 'consume', 'sharedMutable'] },
        },
      },
    },
    dependencyEdges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to'],
        additionalProperties: false,
        properties: {
          from: { type: 'string', pattern: '^[0-9]+$' },
          to: { type: 'string', pattern: '^[0-9]+$' },
        },
      },
    },
  },
};

export const BUILDER_REPORT_SCHEMA = {
  type: 'object',
  required: [
    'status', 'filesTouched', 'testDecisions', 'commands',
    'commitSha', 'stopItems', 'visualVerify',
  ],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['pass', 'stop'] },
    filesTouched: stringArray,
    testDecisions: stringArray,
    commands: {
      type: 'array',
      items: {
        type: 'object',
        required: ['command', 'exitCode', 'summary'],
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'integer' },
          summary: { type: 'string' },
        },
      },
    },
    commitSha: { anyOf: [{ type: 'string', pattern: HASH_PATTERN }, { type: 'null' }] },
    stopItems: stringArray,
    visualVerify: { type: 'string' },
  },
  oneOf: [
    {
      required: ['status', 'commitSha', 'stopItems'],
      properties: {
        status: { const: 'pass' },
        commitSha: { type: 'string', pattern: HASH_PATTERN },
        stopItems: { type: 'array', maxItems: 0 },
      },
    },
    {
      required: ['status', 'commitSha', 'stopItems'],
      properties: {
        status: { const: 'stop' },
        commitSha: { anyOf: [{ type: 'string', pattern: HASH_PATTERN }, { type: 'null' }] },
        stopItems: { type: 'array', minItems: 1 },
      },
    },
  ],
};

function valueHasType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function validateCombinators(value, schema, path) {
  const errors = [];
  if (schema.anyOf && !schema.anyOf.some((branch) => collectErrors(value, branch, path).length === 0)) {
    errors.push(`${path} must match at least one allowed schema`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => collectErrors(value, branch, path).length === 0).length;
    if (matches !== 1) errors.push(`${path} must match exactly one allowed schema`);
  }
  return errors;
}

function validateObject(value, schema, path) {
  const errors = [];
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) errors.push(`${path}.${key} is required`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${path}.${key} is not allowed`);
    }
  }
  for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(value, key)) errors.push(...collectErrors(value[key], childSchema, `${path}.${key}`));
  }
  return errors;
}

function collectErrors(value, schema, path = '$') {
  const errors = validateCombinators(value, schema, path);
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must equal ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} has an unsupported value`);
  if (schema.type && !valueHasType(value, schema.type)) return [...errors, `${path} must be ${schema.type}`];
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} has too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => errors.push(...collectErrors(item, schema.items, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    errors.push(...validateObject(value, schema, path));
  }
  return errors;
}

function validateSchema(value, schema) {
  const errors = collectErrors(value, schema);
  return { ok: errors.length === 0, errors };
}

export const validateReconReport = (report) => validateSchema(report, RECON_REPORT_SCHEMA);
export const validateBuilderReport = (report) => validateSchema(report, BUILDER_REPORT_SCHEMA);

function verifyCommit(report, gitFacts) {
  if (!['sha1', 'sha256'].includes(gitFacts?.objectFormat)) return ['gitFacts.objectFormat is unsupported'];
  if (report.commitSha === null) return [];
  const errors = [];
  const expectedLength = gitFacts.objectFormat === 'sha1' ? 40 : 64;
  if (report.commitSha.length !== expectedLength) {
    errors.push(`commitSha does not match ${gitFacts.objectFormat} object format`);
  }
  if (gitFacts.commitSha !== report.commitSha) errors.push('commit SHA does not match independently observed git facts');
  if (gitFacts.baseIsAncestorOfCommit !== true) {
    errors.push('integration base is not an ancestor of the builder commit');
  }
  return errors;
}

function verifyFilesAndCommands(report, gitFacts, allowlist, requiredCommands) {
  const errors = [];
  if (!Array.isArray(gitFacts?.changedFiles)) errors.push('gitFacts.changedFiles must be an array');
  else if (gitFacts.changedFiles.some((path) => !allowlist.includes(path))) {
    errors.push('git diff contains a path outside the allowlist');
  }
  const observedCommands = new Set(report.commands.map(({ command }) => command));
  for (const command of requiredCommands) {
    if (!observedCommands.has(command)) errors.push(`required command was not reported: ${command}`);
  }
  return errors;
}

export function semanticVerify(report, { gitFacts, allowlist = [], requiredCommands = [] } = {}) {
  const structural = validateBuilderReport(report);
  const errors = [...structural.errors];
  if (structural.ok) {
    if (report.status === 'pass' && report.commands.some(({ exitCode }) => exitCode !== 0)) {
      errors.push('PASS report contains a command with a nonzero exit');
    }
    errors.push(...verifyCommit(report, gitFacts));
    errors.push(...verifyFilesAndCommands(report, gitFacts, allowlist, requiredCommands));
  }
  return { ok: errors.length === 0, errors };
}
