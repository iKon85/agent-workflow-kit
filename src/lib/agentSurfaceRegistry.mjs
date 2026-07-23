import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export const AGENT_SURFACE_REGISTRY_REVISION = 1;

export const AGENT_SURFACE_REGISTRY = Object.freeze([
  Object.freeze({
    id: 'claude-code',
    label: 'Claude Code',
    command: 'claude',
    activeEnvironment: Object.freeze(['CLAUDE_CODE_ENTRYPOINT']),
    adapter: Object.freeze({
      providers: Object.freeze(['anthropic']),
      transports: Object.freeze(['native', 'codex-cli']),
      enforcement: Object.freeze({ model: 'named-agent', effort: 'named-agent' }),
    }),
  }),
  Object.freeze({
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    activeEnvironment: Object.freeze(['CODEX_THREAD_ID']),
    adapter: Object.freeze({
      providers: Object.freeze(['openai']),
      transports: Object.freeze(['native', 'claude-cli']),
      enforcement: Object.freeze({ model: 'per-spawn', effort: 'per-spawn' }),
    }),
  }),
]);

async function commandOnPath(command, env = process.env) {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (await access(join(directory, command)).then(() => true, () => false)) return true;
  }
  return false;
}

export async function detectAgentSurfaces({
  registry = AGENT_SURFACE_REGISTRY,
  commandAvailable = commandOnPath,
} = {}) {
  return Promise.all(registry.map(async (surface) => Object.freeze({
    id: surface.id,
    label: surface.label,
    detected: await commandAvailable(surface.command),
    adapter: surface.adapter,
  })));
}

export function surfaceById(id, registry = AGENT_SURFACE_REGISTRY) {
  return registry.find((surface) => surface.id === id);
}

export function currentAgentSurface({
  registry = AGENT_SURFACE_REGISTRY,
  env = process.env,
} = {}) {
  return registry.find((surface) =>
    surface.activeEnvironment.some((name) => typeof env[name] === 'string' && env[name] !== ''))?.id;
}
