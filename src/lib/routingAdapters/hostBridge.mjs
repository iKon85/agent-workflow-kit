/**
 * The host bridge — the security boundary between a Route decision and the host
 * process that actually runs it.
 *
 * Every `(surface, transport)` pair in the agent-surface registry is accounted
 * for exactly once: it is either bridged to a host command, or it carries a
 * dated unavailable attestation. The census fails closed, so a transport added
 * to the registry without either cannot quietly become undispatchable.
 *
 * The boundary itself is fixed, not per-call policy:
 *
 * - Invocation is `execFile`-style — a bare command plus an argv array. No shell
 *   string is ever constructed, and a command that is not a bare binary name is
 *   refused.
 * - **Task text never rides in argv.** It goes to the child's stdin, because an
 *   argv element is readable in the process list and bounded by argument-size
 *   limits. A guard rejects argv that contains the task text.
 * - The model-and-effort pair is schema-validated against the pinned inventory
 *   before the spawn, and read back from the host's own record after it. A
 *   surface that silently substitutes a default cannot pass.
 * - cwd is bounded to the authorized workspace.
 * - The child environment is an explicit allowlist, never the credential-rich
 *   parent.
 * - Every failure is reduced to a closed reason before it can reach a log or a
 *   Dispatch receipt.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AGENT_SURFACE_REGISTRY } from '../agentSurfaceRegistry.mjs';
import {
  CLAUDE_CLI_HOST,
  CLAUDE_NATIVE_UNAVAILABLE,
  createClaudeRoutingAdapter,
} from './claude.mjs';
import {
  CODEX_CLI_HOST,
  CODEX_NATIVE_UNAVAILABLE,
  createCodexRoutingAdapter,
} from './codex.mjs';

export const HOST_BRIDGE_VERSION = 1;

/** The only environment names a bridged child inherits from its parent. */
export const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR',
]);

/** The closed set of reasons a bridge failure may name. */
export const BRIDGE_FAILURE_REASONS = Object.freeze([
  'host bridge pair is not in the pinned inventory',
  'host bridge effort is outside the model effort domain',
  'host bridge cwd is outside the authorized workspace',
  'host bridge refuses a shell invocation',
  'host bridge refuses task text in argv',
  'host bridge refuses an argument that destroys the readback channel',
  'host bridge has no adapter for the agent surface',
  'host bridge child exited with a failure',
  'host bridge run was degraded by the host',
  'host bridge could not read back the applied pair',
  'host bridge applied pair differs from the requested pair',
]);

const BRIDGED_HOSTS = Object.freeze([CLAUDE_CLI_HOST, CODEX_CLI_HOST]);
const UNAVAILABLE_TRANSPORTS = Object.freeze([
  CLAUDE_NATIVE_UNAVAILABLE, CODEX_NATIVE_UNAVAILABLE,
]);
const ADAPTER_FACTORIES = Object.freeze({
  'claude-code': createClaudeRoutingAdapter,
  codex: createCodexRoutingAdapter,
});

const BARE_COMMAND = /^[A-Za-z0-9._-]+$/;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

/** Reduce any error to its closed reason; nothing else survives to a log. */
export function redactBridgeError(error) {
  const message = error instanceof Error ? error.message : '';
  return new Error(BRIDGE_FAILURE_REASONS.find((reason) => message.startsWith(reason))
    ?? 'host bridge rejected the dispatch');
}

/** The child inherits allowlisted names only — never an inherited parent env. */
export function childEnvironment(parentEnv = {}, allowlist = CHILD_ENV_ALLOWLIST) {
  const child = {};
  for (const name of allowlist) {
    const value = parentEnv?.[name];
    if (typeof value === 'string' && value !== '') child[name] = value;
  }
  return Object.freeze(child);
}

/** The child runs inside the authorized worktree or it does not run. */
export function assertBoundedCwd(cwd, workspaceRoot) {
  if (typeof cwd !== 'string' || cwd === '' || typeof workspaceRoot !== 'string'
      || workspaceRoot === '') {
    throw new Error('host bridge cwd is outside the authorized workspace');
  }
  const target = resolve(cwd);
  const step = relative(resolve(workspaceRoot), target);
  if (step !== '' && (step.startsWith('..') || isAbsolute(step))) {
    throw new Error('host bridge cwd is outside the authorized workspace');
  }
  return target;
}

/** argv carries validated controls only: no shell, no task text, no readback loss. */
export function assertArgvSafe(host, argv, taskText) {
  if (typeof host?.command !== 'string' || !BARE_COMMAND.test(host.command)
      || !Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) {
    throw new Error('host bridge refuses a shell invocation');
  }
  const task = typeof taskText === 'string' ? taskText.trim() : '';
  if (task !== '' && argv.some((item) => item.includes(task))) {
    throw new Error('host bridge refuses task text in argv');
  }
  if ((host.forbiddenArgs ?? []).some((flag) => argv.includes(flag))) {
    throw new Error('host bridge refuses an argument that destroys the readback channel');
  }
  return argv;
}

/**
 * The roster identification rule. One host reports one model under several
 * forms (`opus`, `opus[1m]`, `claude-opus-5`, `claude-opus-5[1m]`), so an
 * observed id counts as identified only when the pinned inventory lists it as an
 * identifier of exactly one model. An unlisted form is never guessed.
 */
export function canonicalModelId(inventory, surface, observed) {
  if (typeof observed !== 'string' || observed === '') return null;
  for (const snapshot of inventory?.snapshots ?? []) {
    if (snapshot.surface !== surface) continue;
    for (const model of snapshot.models ?? []) {
      if (model.modelId === observed || (model.identifiers ?? []).includes(observed)) {
        return model.modelId;
      }
    }
  }
  return null;
}

/**
 * Validate a requested pair against the pinned inventory. The surface is the
 * host being driven, not the dispatching surface: a Codex session bridging to
 * the Claude host must name an Anthropic pair.
 */
export function requireInventoryPair(inventory, surface, route) {
  const modelId = canonicalModelId(inventory, surface, route?.modelId);
  if (modelId === null) throw new Error('host bridge pair is not in the pinned inventory');
  const effort = route?.effort ?? null;
  const match = (inventory?.pairs ?? []).find((pair) => pair.surface === surface
    && pair.modelId === modelId && (pair.effort ?? null) === effort);
  if (match === undefined) {
    throw new Error('host bridge effort is outside the model effort domain');
  }
  return Object.freeze({ surface, provider: match.provider, modelId, effort });
}

function assertAppliedPair(inventory, host, requested, applied) {
  const modelId = canonicalModelId(inventory, host.inventorySurface, applied?.modelId);
  if (modelId === null || typeof applied?.runId !== 'string' || applied.runId === '') {
    throw new Error('host bridge could not read back the applied pair');
  }
  if (modelId !== requested.modelId || (applied.effort ?? null) !== requested.effort) {
    throw new Error('host bridge applied pair differs from the requested pair');
  }
}

/** The default runner: `execFile` argv, `shell` off, task text on stdin. */
function spawnChild(command, argv, { cwd, env, stdin, timeoutMs }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(command, argv, { cwd, env, shell: false, timeout: timeoutMs },
      (error, stdout, stderr) => (error
        ? rejectPromise(new Error('host bridge child exited with a failure'))
        : resolvePromise({ stdout, stderr })));
    child.stdin?.end(stdin ?? '');
  });
}

async function runBridgedDispatch(host, context, route) {
  const pair = requireInventoryPair(context.routingInventory, host.inventorySurface, route);
  const cwd = assertBoundedCwd(context.cwd, context.workspaceRoot);
  const argv = host.buildArgv({ ...pair, runId: context.runId, cwd });
  assertArgvSafe(host, argv, context.task);
  let result;
  try {
    result = await context.runChild(host.command, argv, {
      cwd,
      env: childEnvironment(context.env),
      stdin: context.task,
      timeoutMs: context.timeoutMs,
    });
  } catch {
    throw new Error('host bridge child exited with a failure');
  }
  if (host.degraded(result)) throw new Error('host bridge run was degraded by the host');
  const applied = await host.readApplied({ home: context.home, cwd, runId: context.runId, result });
  assertAppliedPair(context.routingInventory, host, pair, applied);
  return Object.freeze({
    taskId: applied.runId,
    appliedPair: pair,
    attestationStrength: host.attestationStrength,
  });
}

function bridgeContext(options) {
  return Object.freeze({
    routingInventory: options.routingInventory,
    task: options.task,
    cwd: options.cwd ?? process.cwd(),
    workspaceRoot: options.workspaceRoot ?? options.cwd ?? process.cwd(),
    home: options.home ?? homedir(),
    env: options.env ?? process.env,
    runId: options.runId ?? randomUUID(),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    runChild: options.runChild ?? spawnChild,
  });
}

/**
 * The census: one entry per registry `(surface, transport)` pair, each bridged
 * or attested unavailable. A pair with neither — or with both — throws.
 */
export function hostTransportCensus({ registry = AGENT_SURFACE_REGISTRY } = {}) {
  const entries = [];
  for (const surface of registry) {
    for (const transportId of surface.adapter?.transports ?? []) {
      const host = BRIDGED_HOSTS.find((bridge) => bridge.transportId === transportId);
      const attestation = UNAVAILABLE_TRANSPORTS.find((entry) =>
        entry.surfaceId === surface.id && entry.transportId === transportId);
      if ((host === undefined) === (attestation === undefined)) {
        throw new Error(
          `host bridge census is undecided for ${surface.id}/${transportId}`,
        );
      }
      entries.push(Object.freeze(host
        ? {
          surfaceId: surface.id, transportId, status: 'bridged',
          command: host.command, attestationStrength: host.attestationStrength,
          reason: null, evidence: null, observedAt: null,
        }
        : {
          surfaceId: surface.id, transportId, status: 'unavailable',
          command: null, attestationStrength: null,
          reason: attestation.reason,
          evidence: attestation.evidence,
          observedAt: attestation.observedAt,
        }));
    }
  }
  return Object.freeze(entries);
}

/**
 * The dispatcher map a surface adapter consumes: one entry per bridged transport
 * of that surface. An attested-unavailable transport gets no entry, so the
 * adapter refuses it as a transport with no approved dispatcher.
 *
 * The map is bound to exactly one task text, because that text is handed to the
 * child's stdin and never to argv.
 */
export function createHostBridgeDispatchers(options) {
  const context = bridgeContext(options);
  const dispatchers = {};
  for (const entry of hostTransportCensus({ registry: options.registry })) {
    if (entry.surfaceId !== options.surfaceId || entry.status !== 'bridged') continue;
    const host = BRIDGED_HOSTS.find((bridge) => bridge.transportId === entry.transportId);
    dispatchers[entry.transportId] = async ({ route }) => {
      try {
        return await runBridgedDispatch(host, context, route);
      } catch (error) {
        throw redactBridgeError(error);
      }
    };
  }
  return Object.freeze(dispatchers);
}

/** A surface routing adapter whose approved dispatchers are the host bridges. */
export function createBridgedRoutingAdapter(options) {
  const factory = ADAPTER_FACTORIES[options?.surfaceId];
  if (factory === undefined) {
    throw new Error('host bridge has no adapter for the agent surface');
  }
  return factory({
    inventory: options.capabilityInventory,
    dispatchers: createHostBridgeDispatchers(options),
  });
}
