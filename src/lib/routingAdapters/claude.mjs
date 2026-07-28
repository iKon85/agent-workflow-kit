import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { adaptClaudeRoutingInventory } from '../capabilityMatrix.mjs';
import {
  attestAccessPath,
  capabilityPathMatchesPair,
  selectCapabilityPath,
} from '../routingAccessGraph.mjs';

/**
 * `claude-code × native` — the in-session Agent primitive. It can enforce a
 * model, but it has no effort axis at all and reports no applied pair, so it can
 * never produce an honest applied-effort receipt. Attested unavailable rather
 * than bridged; the dated verify-spike carries the recorded evidence.
 */
export const CLAUDE_NATIVE_UNAVAILABLE = Object.freeze({
  surfaceId: 'claude-code',
  transportId: 'native',
  reason: 'effort-axis-absent',
  detail: 'the in-session Agent primitive enforces a model but exposes no effort '
    + 'parameter and returns no applied pair',
  evidence: 'verify-spike-18c',
  observedAt: '2026-07-27',
});

/**
 * The Claude host as a bridged child process. Model and effort are enforced per
 * spawn and read back from the persisted session transcript, whose
 * `message.model` is server-returned — the strongest attestation either host
 * offers. `--output-format json` omits effort entirely, so the transcript, not
 * stdout, is the readback channel.
 *
 * The Claude CLI silently ignores an unknown `--effort` and runs at its default,
 * so the effort is validated against the model's own domain before the spawn and
 * compared against the transcript after it.
 */
export const CLAUDE_CLI_HOST = Object.freeze({
  transportId: 'claude-cli',
  command: 'claude',
  /** Anthropic models live under the `claude-code` surface of the pinned inventory. */
  inventorySurface: 'claude-code',
  attestationStrength: 'provider-attested',
  forbiddenArgs: Object.freeze([]),
  buildArgv({ modelId, effort, runId }) {
    const argv = ['--print', '--model', modelId, '--session-id', runId,
      '--output-format', 'json'];
    if (effort !== null) argv.push('--effort', effort);
    return Object.freeze(argv);
  },
  degraded() {
    return false;
  },
  readApplied({ home, cwd, runId }) {
    return readClaudeAppliedPair({ home, cwd, runId });
  },
});

/** Claude's project directory name: the absolute cwd with `/` and `.` as `-`. */
export function claudeProjectSlug(cwd) {
  return resolve(cwd).replace(/[/.]/g, '-');
}

/**
 * Read the applied pair out of `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`:
 * the last server-returned `message.model` and the last top-level `effort`.
 */
export async function readClaudeAppliedPair({ home, cwd, runId }) {
  let raw;
  try {
    raw = await readFile(
      join(home, '.claude', 'projects', claudeProjectSlug(cwd), `${runId}.jsonl`), 'utf8',
    );
  } catch {
    return null;
  }
  let modelId = null;
  let effort = null;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record?.message?.model === 'string') modelId = record.message.model;
    if (typeof record?.effort === 'string') effort = record.effort;
  }
  return modelId === null ? null : Object.freeze({ modelId, effort, runId });
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
 * Attest the Claude surface's access paths for the Access-graph builder. The
 * attestation carries capability facts and their observation dates only —
 * authorization stays with the Routing profile and the capability probe.
 */
export function claudeAccessAttestations(inventory, dates) {
  return Object.freeze(adaptClaudeRoutingInventory(inventory).paths
    .map((path) => attestAccessPath(path, dates)));
}

export function createClaudeRoutingAdapter({ inventory, dispatchers = {} }) {
  const capabilities = adaptClaudeRoutingInventory(inventory);
  return Object.freeze({
    async prepare(requestedRoute) {
      const path = selectCapabilityPath(capabilities.paths, requestedRoute);
      if (!path) throw new Error('Claude route capability is not attested');
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
      return Object.freeze({
        appliedRoute: applied,
        enforcement: Object.freeze({
          model: path.model.method,
          effort: path.effort.method,
        }),
        precedence: Object.freeze({
          model: path.model.precedence,
          effort: path.effort.precedence,
        }),
        mismatchReason: mismatch,
        dispatch: () => invoke(Object.freeze({
          route: applied,
          enforcement: Object.freeze({
            model: path.model.method,
            effort: path.effort.method,
          }),
        })),
      });
    },
  });
}
