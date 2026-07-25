import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const PROJECT_SKILL_REGISTRY_PATH = 'docs/agents/skill-registry.json';
export const PROJECT_SKILL_REGISTRY_SCHEMA_VERSION = 1;

const CORE_ANNOTATION_FIELDS = new Set(['note']);
const SURFACES = new Set(['claude', 'codex']);
const SKILL_CLASSES = new Set(['generic', 'vendored', 'adapter', 'project-private']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compatibleSubset(prior, current) {
  if (isRecord(prior)) {
    return isRecord(current) && Object.entries(prior).every(
      ([key, value]) => key in current && compatibleSubset(value, current[key]),
    );
  }
  return isDeepStrictEqual(prior, current);
}

function corePart(declaration) {
  return Object.fromEntries(
    Object.entries(declaration).filter(([key]) => !CORE_ANNOTATION_FIELDS.has(key)),
  );
}

function annotations(declaration) {
  return Object.fromEntries(
    Object.entries(declaration).filter(([key]) => CORE_ANNOTATION_FIELDS.has(key)),
  );
}

function validateCore(core, label = 'Kit Core skill registry') {
  if (!isRecord(core) || core.schema_version !== 1
      || !isRecord(core.readiness) || !isRecord(core.readiness.capabilities)
      || !isRecord(core.skills)) {
    throw new Error(`${label} has an unsupported schema`);
  }
  for (const [name, declaration] of Object.entries(core.skills)) {
    for (const capability of [
      ...(declaration?.readiness?.required ?? []),
      ...Object.values(declaration?.readiness?.optionalBlocks ?? {}),
    ]) {
      if (!core.readiness.capabilities[capability]) {
        throw new Error(
          `candidate invariant schema: unknown readiness reference ${name}.${capability}`,
        );
      }
    }
  }
}

export function emptyProjectSkillRegistry(core) {
  validateCore(core);
  return {
    schemaVersion: PROJECT_SKILL_REGISTRY_SCHEMA_VERSION,
    coreSchemaVersion: core.schema_version,
    skills: {},
    annotations: {},
  };
}

function validateProjectSkill(name, declaration, capabilities) {
  if (!isRecord(declaration)
      || !SKILL_CLASSES.has(declaration.class)
      || typeof declaration.publish !== 'boolean'
      || !Array.isArray(declaration.surfaces)
      || declaration.surfaces.some((surface) => !SURFACES.has(surface))
      || new Set(declaration.surfaces).size !== declaration.surfaces.length) {
    throw new Error(`Project skill registry has an invalid local skill: ${name}`);
  }
  const readiness = declaration.readiness ?? {};
  if (!isRecord(readiness)
      || !Array.isArray(readiness.required ?? [])
      || !isRecord(readiness.optionalBlocks ?? {})) {
    throw new Error(`Project skill registry has invalid readiness: ${name}`);
  }
  for (const capability of [
    ...(readiness.required ?? []),
    ...Object.values(readiness.optionalBlocks ?? {}),
  ]) {
    if (!capabilities[capability]) {
      throw new Error(`Project skill registry references unknown capability: ${name}.${capability}`);
    }
  }
}

export function validateProjectSkillRegistry(core, registry) {
  validateCore(core);
  if (!isRecord(registry)
      || registry.schemaVersion !== PROJECT_SKILL_REGISTRY_SCHEMA_VERSION
      || registry.coreSchemaVersion !== core.schema_version
      || !isRecord(registry.skills)
      || !isRecord(registry.annotations)) {
    throw new Error('Project skill registry has an unsupported schema');
  }
  for (const [name, declaration] of Object.entries(registry.skills)) {
    if (core.skills[name]) {
      throw new Error(`Project skill registry collides with Kit Core: ${name}`);
    }
    validateProjectSkill(name, declaration, core.readiness.capabilities ?? {});
  }
  for (const [name, annotation] of Object.entries(registry.annotations)) {
    if (!core.skills[name] || !isRecord(annotation)
        || Object.keys(annotation).some((key) => !CORE_ANNOTATION_FIELDS.has(key))
        || Object.values(annotation).some((value) => typeof value !== 'string' || !value.trim())) {
      throw new Error(`Project skill registry has an invalid Core annotation: ${name}`);
    }
  }
  return registry;
}

export function composeSkillRegistry(core, registry) {
  validateProjectSkillRegistry(core, registry);
  const skills = Object.fromEntries(Object.entries(core.skills).map(([name, declaration]) => [
    name, { ...declaration, ...(registry.annotations[name] ?? {}) },
  ]));
  for (const [name, declaration] of Object.entries(registry.skills)) {
    skills[name] = declaration;
  }
  return { ...core, skills };
}

export function migrateLegacySkillRegistry({ legacyCore, nextCore }) {
  validateCore(legacyCore, 'Legacy mixed skill registry');
  validateCore(nextCore);
  if (!compatibleSubset(legacyCore.readiness, nextCore.readiness)) {
    throw new Error('Legacy mixed skill registry has ambiguous Core readiness changes');
  }
  const skills = {};
  const coreAnnotations = {};
  for (const [name, declaration] of Object.entries(legacyCore.skills)) {
    if (!nextCore.skills[name]) {
      skills[name] = declaration;
      continue;
    }
    if (!compatibleSubset(corePart(declaration), nextCore.skills[name])) {
      throw new Error(`Legacy mixed skill registry has ambiguous Kit Core changes: ${name}`);
    }
    const local = annotations(declaration);
    if (Object.keys(local).length) coreAnnotations[name] = local;
  }
  const registry = {
    schemaVersion: PROJECT_SKILL_REGISTRY_SCHEMA_VERSION,
    coreSchemaVersion: nextCore.schema_version,
    skills,
    annotations: coreAnnotations,
  };
  validateProjectSkillRegistry(nextCore, registry);
  return registry;
}

export async function readComposedSkillRegistry(root, core) {
  core ??= JSON.parse(await readFile(join(root, '.claude/skills/skill-manifest.json'), 'utf8'));
  let registry;
  try {
    registry = JSON.parse(await readFile(join(root, PROJECT_SKILL_REGISTRY_PATH), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return core;
    throw new Error(`Project skill registry is invalid: ${error.message}`, { cause: error });
  }
  return composeSkillRegistry(core, registry);
}
