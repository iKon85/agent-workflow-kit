import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fingerprintCensus, sha256 } from './fingerprint.mjs';
import { CENSUS_VERDICTS, resolveCensusState } from './state.mjs';

const exec = promisify(execFile);
const EVIDENCE_PARTS = new Set(['docs', 'test', 'tests', '__tests__']);
const EXCLUDED_PARTS = new Set([
  '.git', '.next', 'build', 'coverage', 'dist', 'generated', 'node_modules', 'vendor',
]);
const CONFIG_NAMES = new Set([
  'package.json', 'tsconfig.json', 'vite.config.js', 'vite.config.mjs',
  'vite.config.ts', 'next.config.js', 'next.config.mjs', 'Dockerfile',
]);

function pathParts(path) {
  return path.split('/');
}

function isEvidence(path) {
  const parts = pathParts(path);
  return parts.some((part) => EVIDENCE_PARTS.has(part))
    || /(?:^|\.)test\.[^.]+$/.test(path)
    || /(?:^|\.)spec\.[^.]+$/.test(path)
    || /(?:^|\/)README(?:\.[^/]*)?$/.test(path);
}

function isSecret(path) {
  return pathParts(path).some((part) => {
    const name = part.toLowerCase();
    return name === '.env' || name.startsWith('.env.')
      || /^(?:secrets?|credentials?)(?:[._-]|$)/.test(name)
      || /private[-_.]?key/.test(name);
  });
}

function isExcluded(path) {
  return pathParts(path).some((part) => EXCLUDED_PARTS.has(part));
}

function isProduct(path) {
  const parts = pathParts(path);
  if (CONFIG_NAMES.has(parts.at(-1))) return true;
  return parts.some((part) => ['src', 'app', 'apps', 'lib', 'packages'].includes(part));
}

function familyFor(path, kind) {
  if (kind === 'config') return 'production-config';
  const parts = pathParts(path);
  const rootIndex = parts.findIndex((part) => ['src', 'app', 'apps', 'lib', 'packages'].includes(part));
  const packageRoot = ['apps', 'packages'].includes(parts[rootIndex]);
  return parts.slice(0, Math.min(rootIndex + (packageRoot ? 2 : 1), parts.length)).join('/');
}

async function gitPaths(repoRoot, args) {
  const { stdout } = await exec('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return stdout.split('\0').filter(Boolean).sort();
}

async function gitIgnoredPaths(repoRoot, paths) {
  if (!paths.length) return new Set();
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['check-ignore', '--no-index', '-z', '--stdin'], { cwd: repoRoot });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && code !== 1) return reject(new Error(`git check-ignore exited ${code}`));
      resolve(new Set(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean)));
    });
    child.stdin.end(`${paths.join('\0')}\0`);
  });
}

async function regularContainedPath(repoRoot, realRepoRoot, path) {
  const candidate = resolve(repoRoot, path);
  const lexicalRelative = relative(resolve(repoRoot), candidate);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    return null;
  }
  let stats;
  let canonical;
  try {
    stats = await lstat(candidate);
    // Symlinks, including links that resolve inside the repository, are excluded.
    // Only a regular file whose canonical path remains inside the repository may be read.
    if (!stats.isFile()) return null;
    canonical = await realpath(candidate);
  } catch {
    return null;
  }
  const canonicalRelative = relative(realRepoRoot, canonical);
  if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
    return null;
  }
  return candidate;
}

function behaviorSummary(entries) {
  const verdicts = new Set(Object.values(CENSUS_VERDICTS));
  return entries.map(({ name, status }) => {
    if (typeof name !== 'string' || !name) throw new TypeError('behavior family requires a name');
    if (!verdicts.has(status)) throw new TypeError(`invalid behavior family verdict: ${status}`);
    return { name, status, type: 'behavior' };
  }).sort((left, right) => {
    const leftKey = `${left.name}\0${left.status}`;
    const rightKey = `${right.name}\0${right.status}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function surfaceSummary(entries, openPaths) {
  const statuses = new Map(entries.map(({ family }) => [family, CENSUS_VERDICTS.covered]));
  for (const path of openPaths) {
    if (isProduct(path) && !isExcluded(path) && !isSecret(path)) {
      const kind = CONFIG_NAMES.has(pathParts(path).at(-1)) ? 'config' : 'source';
      statuses.set(familyFor(path, kind), CENSUS_VERDICTS.open);
    }
  }
  return [...statuses].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  )).map(([name, status]) => ({
    name, status, type: 'surface',
  }));
}

export async function scanCensus({
  repoRoot,
  behaviorFamilies = [],
  enabled = false,
  hasActive = false,
  readText = (path) => readFile(path, 'utf8'),
}) {
  const realRepoRoot = await realpath(repoRoot);
  const tracked = await gitPaths(repoRoot, ['ls-files', '-z']);
  const untracked = await gitPaths(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);
  const ignored = await gitIgnoredPaths(repoRoot, tracked);
  const denominator = [];
  const evidence = [];
  const openPaths = [...untracked];
  for (const path of tracked) {
    if (ignored.has(path) || isSecret(path) || isExcluded(path)) continue;
    const target = isEvidence(path) ? evidence : isProduct(path) ? denominator : null;
    if (!target) continue;
    const readablePath = await regularContainedPath(repoRoot, realRepoRoot, path);
    if (!readablePath) {
      if (target === denominator) openPaths.push(path);
      continue;
    }
    let content;
    try {
      content = await readText(readablePath);
    } catch {
      if (target === denominator) openPaths.push(path);
      continue;
    }
    const kind = CONFIG_NAMES.has(pathParts(path).at(-1)) ? 'config' : 'source';
    target.push({ family: familyFor(path, kind), hash: sha256(content), kind, path });
  }
  const families = {
    surfaces: surfaceSummary(denominator, openPaths),
    behaviors: behaviorSummary(behaviorFamilies),
  };
  const result = { denominator, evidence, families };
  const hasOpen = [...families.surfaces, ...families.behaviors]
    .some(({ status }) => status === CENSUS_VERDICTS.open);
  return {
    ...result,
    fingerprints: fingerprintCensus(result),
    state: resolveCensusState({ enabled, hasActive, hasOpen }),
  };
}
