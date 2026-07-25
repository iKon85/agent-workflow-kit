import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { validateContributionBridge } from './contributionBridge.mjs';
import {
  CONSUMER_MANIFEST_NAME, readManifest,
} from './manifest.mjs';

export const CONTRIBUTION_CAPABILITY_PATH = 'docs/agents/workflow-capabilities.json';
export const CONTRIBUTION_ROUTING_SCHEMA_VERSION = 1;
const SURFACES = new Set(['retro', 'pre-update', 'guard']);
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REMOTE = /^[A-Za-z0-9._-]+$/;
const execFile = promisify(execFileCallback);

const GENERIC_ROUTES = Object.freeze([
  Object.freeze({ id: 'preserve', remoteMutation: false }),
  Object.freeze({ id: 'explicit-fork', remoteMutation: false }),
]);

export async function inspectContributionRouting({
  consumerRoot, path, surface, resolveRemote = defaultResolveRemote(consumerRoot),
}) {
  if (!SURFACES.has(surface)) {
    throw new Error(`unknown contribution routing surface: ${surface}`);
  }
  const manifest = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  const tracked = manifest?.installed?.find((entry) => entry.path === path);
  const bridge = validateContributionBridge(tracked);
  const lifecycle = {
    surface,
    path,
    lifecycleState: 'contribution-bridge',
    baseKitVersion: bridge.baseKitVersion,
    routes: GENERIC_ROUTES.map((route) => ({ ...route })),
  };
  const loaded = await readCapability(consumerRoot);
  if (loaded.state !== 'present') {
    return {
      ...lifecycle,
      capabilityState: loaded.state,
      ...(loaded.diagnostic ? { diagnostic: loaded.diagnostic } : {}),
    };
  }
  const validated = validateCapability(loaded.value);
  if (!validated.ok) {
    return {
      ...lifecycle,
      capabilityState: 'invalid',
      diagnostic: validated.diagnostic,
    };
  }
  if (!validated.enabled) {
    return { ...lifecycle, capabilityState: 'disabled' };
  }
  let remoteUrl;
  try {
    remoteUrl = await resolveRemote(validated.remote);
  } catch {
    return {
      ...lifecycle,
      capabilityState: 'invalid',
      diagnostic: 'configured contribution remote is not verifiable',
    };
  }
  if (repositoryFromRemote(remoteUrl) !== validated.repository.toLowerCase()) {
    return {
      ...lifecycle,
      capabilityState: 'invalid',
      diagnostic: 'configured contribution remote does not match required upstream',
    };
  }
  return {
    ...lifecycle,
    capabilityState: 'ready',
    repository: validated.repository,
    routes: [
      ...lifecycle.routes,
      { id: 'prepare-local', remoteMutation: false },
      {
        id: 'upstream-pull-request',
        remoteMutation: true,
        requiresExplicitApproval: true,
      },
    ],
  };
}

async function readCapability(consumerRoot) {
  try {
    const raw = await readFile(join(consumerRoot, CONTRIBUTION_CAPABILITY_PATH), 'utf8');
    const profile = JSON.parse(raw);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return { state: 'invalid', diagnostic: 'workflow capability profile must be an object' };
    }
    if (profile.contributionRouting === undefined) return { state: 'missing' };
    return { state: 'present', value: profile.contributionRouting };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', diagnostic: 'workflow capability profile is unreadable or invalid' };
  }
}

function validateCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('contribution routing capability must be an object');
  }
  if (value.schemaVersion !== CONTRIBUTION_ROUTING_SCHEMA_VERSION) {
    return invalid('unsupported contribution routing capability schema');
  }
  if (typeof value.enabled !== 'boolean') {
    return invalid('contribution routing enabled must be boolean');
  }
  if (!value.enabled) return { ok: true, enabled: false };
  const repository = value.upstream?.repository;
  const remote = value.upstream?.remote;
  if (!REPOSITORY.test(repository ?? '') || !REMOTE.test(remote ?? '')) {
    return invalid('contribution routing requires an explicit upstream repository and remote');
  }
  if (value.workflows?.prepareLocal !== true) {
    return invalid('enabled contribution routing requires local preparation');
  }
  const pullRequest = value.workflows?.upstreamPullRequest;
  if (pullRequest?.enabled !== true || pullRequest.requiresExplicitApproval !== true) {
    return invalid('upstream pull request route requires explicit approval');
  }
  return { ok: true, enabled: true, repository, remote };
}

function invalid(diagnostic) {
  return { ok: false, diagnostic };
}

function repositoryFromRemote(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\.git$/, '');
  const match = trimmed.match(
    /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+)$/,
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function defaultResolveRemote(consumerRoot) {
  return async (remote) => {
    const { stdout } = await execFile(
      'git', ['-C', consumerRoot, 'remote', 'get-url', remote],
      { timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return stdout.trim();
  };
}
