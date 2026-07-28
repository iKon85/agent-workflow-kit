import { readFile } from 'node:fs/promises';
import { validateConsumerFile } from './consumerPath.mjs';
import { compareSemver, parseSemver } from './semver.mjs';

/**
 * Required consumer migrations are declarative, versioned data — never prose.
 * A release that forces the consumer to commit a decision registers it here;
 * `update` detects and reports the outstanding action but never performs it.
 */
export const CONSUMER_MIGRATION_SCHEMA_VERSION = 1;
const REGISTRY_URL = new URL('../consumer-migrations.json', import.meta.url);
const DETECTORS = new Set(['json-key']);
const ADVISORY_KINDS = new Set(['retired-key']);
const TEXT_FIELDS = ['id', 'title', 'workflow', 'decision', 'consequence', 'remediation'];

let shipped;

function text(value, field, id) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`consumer migration registry: ${field} must be a non-empty string (${id})`);
  }
  return value;
}

function assertSafeRelativePath(path, id) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')
      || path.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`consumer migration registry: unsafe consumer path ${path} (${id})`);
  }
  return path;
}

function validateDetector(detect, id) {
  if (!detect || typeof detect !== 'object' || Array.isArray(detect)) {
    throw new Error(`consumer migration registry: detect is required (${id})`);
  }
  if (!DETECTORS.has(detect.type)) {
    throw new Error(`consumer migration registry: unsupported detector ${detect.type} (${id})`);
  }
  if (!Array.isArray(detect.key) || !detect.key.length
      || detect.key.some((segment) => typeof segment !== 'string' || !segment)) {
    throw new Error(`consumer migration registry: detect.key must name the decision (${id})`);
  }
  return Object.freeze({
    type: detect.type,
    path: assertSafeRelativePath(detect.path, id),
    key: Object.freeze([...detect.key]),
  });
}

/** Reject a registry that could not be evaluated deterministically or safely. */
export function validateConsumerMigrationRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('consumer migration registry: document must be an object');
  }
  if (registry.schemaVersion !== CONSUMER_MIGRATION_SCHEMA_VERSION) {
    throw new Error(
      `consumer migration registry: unsupported schemaVersion ${registry.schemaVersion}`,
    );
  }
  if (!Array.isArray(registry.migrations)) {
    throw new Error('consumer migration registry: migrations must be an array');
  }
  const seen = new Set();
  const migrations = registry.migrations.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('consumer migration registry: each migration must be an object');
    }
    const id = text(entry.id, 'id', entry.id);
    if (seen.has(id)) throw new Error(`consumer migration registry: duplicate migration id ${id}`);
    seen.add(id);
    parseSemver(entry.requiredFrom);
    for (const field of TEXT_FIELDS) text(entry[field], field, id);
    return Object.freeze({
      id,
      requiredFrom: entry.requiredFrom,
      title: entry.title,
      workflow: entry.workflow,
      decision: entry.decision,
      consequence: entry.consequence,
      remediation: entry.remediation,
      detect: validateDetector(entry.detect, id),
    });
  });
  const advisories = (registry.advisories ?? []).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('consumer migration registry: each advisory must be an object');
    }
    const id = text(entry.id, 'id', entry.id);
    if (seen.has(id)) throw new Error(`consumer migration registry: duplicate entry id ${id}`);
    seen.add(id);
    if (!ADVISORY_KINDS.has(entry.kind)) {
      throw new Error(`consumer migration registry: unsupported advisory kind ${entry.kind} (${id})`);
    }
    parseSemver(entry.retiredIn);
    return Object.freeze({
      id,
      kind: entry.kind,
      retiredIn: entry.retiredIn,
      detect: validateDetector(entry.detect, id),
    });
  });
  return Object.freeze({
    schemaVersion: registry.schemaVersion,
    migrations: Object.freeze(migrations),
    advisories: Object.freeze(advisories),
  });
}

/** The registry travels with the kit code that evaluates it, not with the consumer. */
export async function readShippedConsumerMigrationRegistry() {
  shipped ??= validateConsumerMigrationRegistry(JSON.parse(await readFile(REGISTRY_URL, 'utf8')));
  return shipped;
}

async function readConsumerJson(consumerRoot, path) {
  let resolved;
  try {
    resolved = await validateConsumerFile(consumerRoot, path);
  } catch (error) {
    if (error.message.startsWith('unsafe consumer path (not a regular file)')) {
      return { reason: 'missing-file' };
    }
    throw error;
  }
  try {
    return { document: JSON.parse(await readFile(resolved, 'utf8')) };
  } catch {
    return { reason: 'unreadable-file' };
  }
}

function hasDecision(document, key) {
  let node = document;
  for (const segment of key) {
    if (!node || typeof node !== 'object' || Array.isArray(node)
        || !Object.prototype.hasOwnProperty.call(node, segment)) return false;
    node = node[segment];
  }
  return true;
}

async function detect(consumerRoot, migration) {
  const { document, reason } = await readConsumerJson(consumerRoot, migration.detect.path);
  if (reason) return reason;
  return hasDecision(document, migration.detect.key) ? null : 'missing-decision';
}

async function detectPresent(consumerRoot, advisory) {
  const { document, reason } = await readConsumerJson(consumerRoot, advisory.detect.path);
  if (reason) return false;
  return hasDecision(document, advisory.detect.key);
}

/**
 * Report every registered migration the consumer still owes for `kitVersion`.
 * Read-only by construction: an outstanding decision is named, never written —
 * inventing a cleanup pattern would hand the tool deletion authority.
 */
export async function evaluateConsumerMigrations({ consumerRoot, kitVersion, registry }) {
  const source = registry ? validateConsumerMigrationRegistry(registry)
    : await readShippedConsumerMigrationRegistry();
  const pending = [];
  for (const migration of source.migrations) {
    if (compareSemver(kitVersion, migration.requiredFrom) < 0) continue;
    const reason = await detect(consumerRoot, migration);
    if (!reason) continue;
    pending.push({
      id: migration.id,
      state: 'pending',
      reason,
      requiredFrom: migration.requiredFrom,
      title: migration.title,
      workflow: migration.workflow,
      path: migration.detect.path,
      decision: migration.decision,
      consequence: migration.consequence,
      remediation: migration.remediation,
    });
  }
  return pending;
}

/**
 * Report obsolete consumer-owned configuration without mutating it. Advisory
 * evaluation is fail-open: absent or unreadable project-layer evidence cannot
 * prove that a retired key is present.
 */
export async function evaluateConsumerAdvisories({ consumerRoot, kitVersion, registry }) {
  const source = registry ? validateConsumerMigrationRegistry(registry)
    : await readShippedConsumerMigrationRegistry();
  const advisories = [];
  for (const advisory of source.advisories) {
    if (compareSemver(kitVersion, advisory.retiredIn) < 0) continue;
    if (!(await detectPresent(consumerRoot, advisory))) continue;
    advisories.push({
      id: advisory.id,
      state: 'advisory',
      kind: advisory.kind,
      retiredIn: advisory.retiredIn,
      path: advisory.detect.path,
      key: advisory.detect.key.join('.'),
    });
  }
  return advisories;
}

/** One rendering of the shared record, used by every human-facing update surface. */
export function renderRequiredMigration({ id, workflow, path, decision }) {
  return `required migration: ${id} · ${workflow} · ${path} · ${decision}`;
}

export function renderConsumerAdvisory({ key, retiredIn }) {
  return `update advisory: ${key} is no longer read since ${retiredIn}; `
    + 'the key is consumer-owned and safe to delete.';
}
