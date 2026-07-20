#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstLineState } from '../src/lib/sentinel.mjs';
import { CONSUMER_MANIFEST_NAME, readManifest, writeManifest } from '../src/lib/manifest.mjs';

const SOURCE_MANIFEST = '.claude/skills/skill-manifest.json';
const DECISIONS = new Set(['pending', 'not-applicable']);

async function readText(root, path) {
  try { return await readFile(join(root, path), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sentinelVerdict(text, allowLegacy) {
  if (text === null) return 'absent';
  const state = firstLineState(text);
  const content = text.split('\n').slice(1).join('\n').trim();
  if (state === 'filled') return content ? 'valid' : 'invalid';
  if (state === null && allowLegacy && text.trim()) return 'valid';
  return 'invalid';
}

function nonemptyVerdict(text) {
  return text === null ? 'absent' : (text.trim() ? 'valid' : 'invalid');
}

function jsonValue(text, required) {
  if (text === null) return 'absent';
  try {
    let value = JSON.parse(text);
    for (const key of required ?? []) value = value?.[key];
    return value === undefined || value === null ? 'invalid' : value;
  } catch { return 'invalid'; }
}

function jsonVerdict(text, evidence) {
  if (evidence.validator === 'project-release') {
    if (text === null) return 'absent';
    let profile;
    try { profile = JSON.parse(text); } catch { return 'invalid'; }
    const value = profile.schemaVersion === 1 ? profile.projectRelease : null;
    const files = value?.versionFiles;
    const tag = value?.tagPrefix;
    return Array.isArray(files) && files.length > 0
      && files.every((path) => typeof path === 'string' && path.trim())
      && (tag === undefined || typeof tag === 'string') ? 'valid' : 'invalid';
  }
  const value = jsonValue(text, evidence.required);
  if (['absent', 'invalid'].includes(value)) return value;
  if (!(evidence.required?.length) && typeof value === 'object'
      && !Array.isArray(value) && Object.keys(value).length === 0) return 'invalid';
  return 'valid';
}

function fencedJsonAfter(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const match = /```json\s*([\s\S]*?)```/.exec(text.slice(start + marker.length));
  if (!match) return 'invalid';
  try { return JSON.parse(match[1]); } catch { return 'invalid'; }
}

function boardVerdict(text) {
  if (text === null) return 'absent';
  const profile = fencedJsonAfter(text, '<!-- board-sync:profile -->');
  if (!profile || profile === 'invalid') return 'invalid';
  const status = profile.fields?.status;
  const required = [profile.repo, profile.project?.owner, profile.project?.number,
    profile.project?.nodeId, status?.id, status?.options, status?.roles,
    profile.fields?.wave, profile.fields?.cluster, profile.labels];
  return required.every(Boolean) ? 'valid' : 'invalid';
}

async function runbookVerdict(root, evidence) {
  const layer = await readText(root, evidence.paths[0]);
  const layerState = sentinelVerdict(layer, evidence.allowLegacy);
  if (layerState !== 'valid') return layerState;
  const paths = [...layer.matchAll(/`([^`\n]+\.md)`/g)].map((match) => match[1]);
  for (const path of paths) {
    if (path.includes('template')) continue;
    const runbook = await readText(root, path);
    if (runbook?.trim() && !runbook.includes('<placeholder>')) return 'valid';
  }
  return 'invalid';
}

function section(text, heading) {
  if (text === null) return null;
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

async function prodVerdict(root, paths) {
  const bodies = [];
  for (const path of paths) {
    const text = await readText(root, path);
    if (text === null) continue;
    const body = section(text, '## Prod');
    bodies.push(body);
  }
  if (!bodies.length) return 'absent';
  if (bodies.every((body) => body === null)) return 'absent';
  if (bodies.some((body) => !body)) return 'invalid';
  return bodies.every((body) => body === bodies[0]) ? 'valid' : 'invalid';
}

async function evidenceVerdict(root, evidence) {
  if (evidence.type === 'prod-section') return prodVerdict(root, evidence.paths);
  if (evidence.type === 'runbook-reference') return runbookVerdict(root, evidence);
  const verdicts = await Promise.all((evidence.paths ?? []).map(async (path) => {
    const text = await readText(root, path);
    if (evidence.type === 'sentinel') return sentinelVerdict(text, evidence.allowLegacy);
    if (evidence.type === 'json') return jsonVerdict(text, evidence);
    if (evidence.type === 'board-profile') return boardVerdict(text);
    return nonemptyVerdict(text);
  }));
  if (verdicts.some((value) => value === 'invalid')) return 'invalid';
  if (verdicts.some((value) => value === 'valid')) return 'valid';
  return 'absent';
}

export async function evaluateCapability({ root, capability, decision }) {
  const evidence = await evidenceVerdict(root, capability.evidence);
  if (evidence === 'invalid') return { state: 'invalid', clearDecision: false };
  if (evidence === 'valid') return { state: 'ready', clearDecision: Boolean(decision) };
  if (decision === 'pending') return { state: 'pending', clearDecision: false };
  if (decision === 'not-applicable' && capability.allowNotApplicable) {
    return { state: 'not-applicable', clearDecision: false };
  }
  return { state: 'missing', clearDecision: false };
}

async function loadManifest(root) {
  const body = await readText(root, SOURCE_MANIFEST);
  if (body === null) throw new Error(`readiness manifest not found: ${SOURCE_MANIFEST}`);
  return JSON.parse(body);
}

export async function checkSkill({ root, skill, manifest }) {
  manifest ??= await loadManifest(root);
  const declaration = manifest.skills?.[skill]?.readiness;
  if (!declaration) throw new Error(`skill has no readiness declaration: ${skill}`);
  const consumer = await readManifest(join(root, CONSUMER_MANIFEST_NAME));
  const decisions = consumer?.readinessDecisions ?? {};
  const names = new Set([
    ...(declaration.required ?? []), ...Object.values(declaration.optionalBlocks ?? {}),
  ]);
  const capabilities = {};
  for (const name of names) {
    const catalogEntry = manifest.readiness?.capabilities?.[name];
    if (!catalogEntry) throw new Error(`unknown readiness capability: ${name}`);
    capabilities[name] = await evaluateCapability({
      root, capability: catalogEntry, decision: decisions[name],
    });
  }
  const requiredBlocked = (declaration.required ?? []).some(
    (name) => capabilities[name].state !== 'ready',
  );
  const activeBlocks = [];
  const inactiveBlocks = [];
  for (const [block, name] of Object.entries(declaration.optionalBlocks ?? {})) {
    (capabilities[name].state === 'ready' ? activeBlocks : inactiveBlocks).push(block);
  }
  const invalid = Object.values(capabilities).some(({ state }) => state === 'invalid');
  const verdict = requiredBlocked ? 'blocked' : (inactiveBlocks.length || invalid ? 'degraded' : 'ready');
  return { contractVersion: manifest.readiness.contractVersion, verdict, capabilities, activeBlocks, inactiveBlocks };
}

async function changeDecision(root, capability, value) {
  const path = join(root, CONSUMER_MANIFEST_NAME);
  const manifest = await readManifest(path);
  if (!manifest) throw new Error('not initialised — run `init` first');
  const readiness = (await loadManifest(root)).readiness;
  const catalog = readiness.capabilities;
  if (!catalog[capability]) throw new Error(`unknown readiness capability: ${capability}`);
  if (value && !DECISIONS.has(value)) throw new Error(`invalid readiness decision: ${value}`);
  if (value === 'not-applicable' && !catalog[capability].allowNotApplicable) {
    throw new Error(`${capability} does not allow not-applicable`);
  }
  const decisions = { ...(manifest.readinessDecisions ?? {}) };
  if (value) decisions[capability] = value; else delete decisions[capability];
  await writeManifest(path, {
    ...manifest, readinessContractVersion: readiness.contractVersion, readinessDecisions: decisions,
  });
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

async function main(args = process.argv.slice(2)) {
  const root = resolve(option(args, '--root', process.cwd()));
  if (args[0] === 'check') {
    const result = await checkSkill({ root, skill: option(args, '--skill') });
    console.log(JSON.stringify(result, null, args.includes('--json') ? 2 : 0));
    return;
  }
  if (args[0] === 'decision' && args[1] === 'set') return changeDecision(root, args[2], args[3]);
  if (args[0] === 'decision' && args[1] === 'clear') return changeDecision(root, args[2], null);
  throw new Error('usage: readiness check --skill <name> [--json] [--root <path>] | decision <set|clear> <capability> [value]');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`readiness: ${error.message}`); process.exitCode = 1; });
}
