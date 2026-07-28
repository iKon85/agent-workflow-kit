import { readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { adaptClaudeRoutingInventory } from '../capabilityMatrix.mjs';
import {
  attestAccessPath,
  capabilityPathMatchesPair,
  selectCapabilityPath,
} from '../routingAccessGraph.mjs';

const MODEL_SELECTORS = ['model'];
const EFFORT_SELECTORS = ['effort', 'reasoning_effort', 'model_reasoning_effort'];

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function string(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function timestamp(value, field) {
  string(value, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return value;
}

function schemaProperties(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};
  if (!schema.properties || typeof schema.properties !== 'object'
      || Array.isArray(schema.properties)) return {};
  return schema.properties;
}

function hasSelector(properties, selectors) {
  return selectors.some((selector) =>
    Object.prototype.hasOwnProperty.call(properties, selector));
}

function uncontrolled(control) {
  return {
    ...control,
    method: 'none',
    enforced: false,
    precedence: 'uncontrolled',
    applied: undefined,
  };
}

function applySpawnSchemaEvidence(path, properties) {
  const candidate = { ...path };
  if (path?.model?.method === 'per-spawn'
      && !hasSelector(properties, MODEL_SELECTORS)) {
    candidate.model = uncontrolled(path.model);
  }
  if (path?.effort?.method === 'per-spawn'
      && !hasSelector(properties, EFFORT_SELECTORS)) {
    candidate.effort = uncontrolled(path.effort);
  }
  return candidate;
}

function appliedRoute(path, requestedRoute) {
  return Object.freeze({
    ...requestedRoute,
    modelId: path.model.applied,
    effort: path.effort.applied,
  });
}

function mismatchReason(path, requested, applied) {
  for (const field of ['modelId', 'effort']) {
    if (requested[field] === applied[field]) continue;
    const control = field === 'modelId' ? path.model : path.effort;
    if (control.precedence === 'environment-over-agent-definition') {
      return `environment precedence mismatch: ${field === 'modelId' ? 'model' : field}`;
    }
    return `applied route mismatch: ${field}`;
  }
  return null;
}

/**
 * `codex × native` — the in-session Codex spawn primitive. The dated host
 * inventory (2026-07-23, `.codex/agents/README.md`) exposes `task_name`,
 * `message` and `fork_turns` and no per-spawn model or effort selector, so it
 * can start a task but never prove a differentiated pair was applied. Attested
 * unavailable rather than bridged.
 */
export const CODEX_NATIVE_UNAVAILABLE = Object.freeze({
  surfaceId: 'codex',
  transportId: 'native',
  reason: 'spawn-schema-exposes-no-model-or-effort-selector',
  detail: 'the native spawn schema carries task_name, message and fork_turns only',
  evidence: 'codex-host-inventory',
  observedAt: '2026-07-23',
});

/**
 * The Codex host as a bridged child process. The applied pair lives in the
 * rollout file's `turn_context`, which the client writes — strictly stronger
 * than an argv echo, strictly weaker than Claude's server-returned model, so the
 * attestation is `client-attested` and a receipt must not claim otherwise. The
 * `--json` event stream carries neither model nor effort, and `--ephemeral`
 * destroys the rollout file altogether, so it is forbidden here.
 */
export const CODEX_CLI_HOST = Object.freeze({
  transportId: 'codex-cli',
  command: 'codex',
  /** OpenAI models live under the `codex` surface of the pinned inventory. */
  inventorySurface: 'codex',
  attestationStrength: 'client-attested',
  forbiddenArgs: Object.freeze(['--ephemeral']),
  buildArgv({ modelId, effort, cwd }) {
    const argv = ['exec', '--json', '--model', modelId, '--cd', cwd];
    if (effort !== null) argv.push('-c', `model_reasoning_effort="${effort}"`);
    argv.push('-');
    return Object.freeze(argv);
  },
  degraded(result) {
    return codexRunDegraded(result?.stdout);
  },
  readApplied({ home, result }) {
    const threadId = codexThreadId(result?.stdout);
    return threadId === null ? null : readCodexAppliedPair({ home, threadId });
  },
});

function* codexEvents(stdout) {
  for (const line of String(stdout ?? '').split('\n')) {
    if (line.trim() === '') continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

/** The durable run identity Codex announces on its own event stream. */
export function codexThreadId(stdout) {
  for (const event of codexEvents(stdout)) {
    if (event?.type !== 'thread.started') continue;
    const id = event.thread_id ?? event.payload?.thread_id;
    if (typeof id === 'string' && id !== '') return id;
  }
  return null;
}

/**
 * Codex emits a soft `item.completed` metadata error before a hard failure. A
 * consumer reading only the terminal status would take that degraded run for a
 * clean one, so the bridge treats it as a failed dispatch.
 */
export function codexRunDegraded(stdout) {
  for (const event of codexEvents(stdout)) {
    if (event?.type !== 'item.completed') continue;
    if (/Model metadata for .+ not found/i.test(JSON.stringify(event))) return true;
  }
  return false;
}

/** Read the applied pair out of the dated `rollout-…-<threadId>.jsonl` session file. */
export async function readCodexAppliedPair({ home, threadId }) {
  const root = join(home, '.codex', 'sessions');
  let entries;
  try {
    entries = await readdir(root, { recursive: true });
  } catch {
    return null;
  }
  const file = entries.find((entry) => entry.endsWith(`-${threadId}.jsonl`)
    && basename(entry).startsWith('rollout-'));
  if (file === undefined) return null;
  let raw;
  try {
    raw = await readFile(join(root, file), 'utf8');
  } catch {
    return null;
  }
  let modelId = null;
  let effort = null;
  for (const event of codexEvents(raw)) {
    if (event?.type !== 'turn_context') continue;
    if (typeof event.payload?.model === 'string') modelId = event.payload.model;
    effort = typeof event.payload?.effort === 'string' ? event.payload.effort : null;
  }
  return modelId === null ? null : Object.freeze({ modelId, effort, runId: threadId });
}

export function adaptCodexRoutingInventory(inventory) {
  const source = object(inventory, 'Codex host attestation');
  timestamp(source.observedAt, 'Codex host attestation observedAt');
  const host = object(source.host, 'Codex host attestation host');
  string(host.id, 'Codex host attestation host.id');
  string(host.version, 'Codex host attestation host.version');
  const properties = schemaProperties(source.spawnSchema);
  const paths = Array.isArray(source.paths)
    ? source.paths
      .filter((path) => path?.surfaceId === 'codex')
      .map((path) => applySpawnSchemaEvidence(path, properties))
    : [];
  return adaptClaudeRoutingInventory({
    contractVersion: source.contractVersion,
    paths,
  });
}

/**
 * Attest the Codex surface's access paths for the Access-graph builder. A host
 * whose spawn schema exposes no selector attests no control, so the path never
 * becomes a dispatchable Access-graph path.
 */
export function codexAccessAttestations(inventory, dates) {
  return Object.freeze(adaptCodexRoutingInventory(inventory).paths
    .map((path) => attestAccessPath(path, dates)));
}

export function createCodexRoutingAdapter({ inventory, dispatchers = {} }) {
  const capabilities = adaptCodexRoutingInventory(inventory);
  return Object.freeze({
    async prepare(requestedRoute) {
      const path = selectCapabilityPath(capabilities.paths, requestedRoute);
      if (!path) throw new Error('Codex route capability is not attested');
      if (!path.verified) throw new Error(path.verificationFailures.join('; '));
      if (!capabilityPathMatchesPair(path, requestedRoute)) {
        throw new Error(
          `access pair is not attested: ${requestedRoute.modelId}+${requestedRoute.effort}`,
        );
      }
      const invoke = dispatchers[path.transportId];
      if (typeof invoke !== 'function') {
        throw new Error(`transport has no approved dispatcher: ${path.transportId}`);
      }
      const applied = appliedRoute(path, requestedRoute);
      const mismatch = mismatchReason(path, requestedRoute, applied);
      const enforcement = Object.freeze({
        model: path.model.method,
        effort: path.effort.method,
      });
      return Object.freeze({
        appliedRoute: applied,
        enforcement,
        precedence: Object.freeze({
          model: path.model.precedence,
          effort: path.effort.precedence,
        }),
        mismatchReason: mismatch,
        dispatch: () => invoke(Object.freeze({ route: applied, enforcement })),
      });
    },
  });
}
