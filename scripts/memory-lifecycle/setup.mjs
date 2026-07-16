import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PROFILE_PATH = 'docs/agents/workflow-capabilities.json';
const TEMPLATE_NAMES = [
  'meta_decision_layer_choice.md',
  'meta_memory_lifecycle.md',
];

function contained(root, path) {
  if (isAbsolute(path)) return null;
  const normalized = normalize(path);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null;
  const absolute = resolve(root, normalized);
  return relative(resolve(root), absolute).split(sep)[0] === '..' ? null : absolute;
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function hasSymlink(root, path) {
  let current = resolve(root);
  const segments = relative(current, path).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = resolve(current, segment);
    if ((await lstatIfPresent(current))?.isSymbolicLink()) return true;
  }
  return false;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

function defaultCapability() {
  return {
    enabled: true,
    activeRoot: '.memory/active',
    archiveRoot: '.memory/archive',
    receiptRoot: '.memory/receipts',
    approvals: { restore: false, prune: false },
    memories: TEMPLATE_NAMES.map((path) => ({ path, enabled: true })),
    templatesSeeded: true,
  };
}

export async function setupMemoryLifecycle({
  projectRoot = process.cwd(),
  templateRoot = join(projectRoot, 'assets', 'memory-templates'),
  decision,
} = {}) {
  const profilePath = resolve(projectRoot, PROFILE_PATH);
  if (await hasSymlink(projectRoot, profilePath)) {
    throw new Error('memoryLifecycle profile path contains a symlink');
  }
  const profile = await readJson(profilePath);
  const existing = profile?.memoryLifecycle;

  if (decision !== 'enable') {
    return {
      state: existing?.enabled ? 'enabled' : 'disabled',
      seeded: [],
      adopted: [],
    };
  }

  const capability = {
    ...defaultCapability(),
    ...existing,
    enabled: true,
    approvals: {
      restore: false,
      prune: false,
      ...existing?.approvals,
    },
    templatesSeeded: true,
  };
  const activeRoot = contained(projectRoot, capability.activeRoot);
  if (!activeRoot) throw new Error('memoryLifecycle.activeRoot must stay inside the project');
  if (await hasSymlink(projectRoot, activeRoot)) {
    throw new Error('memoryLifecycle.activeRoot contains a symlink');
  }

  const shouldSeed = existing?.templatesSeeded !== true;
  const sources = shouldSeed
    ? await Promise.all(TEMPLATE_NAMES.map(async (name) => ({
        name,
        content: await readFile(join(templateRoot, name)),
      })))
    : [];
  const seeded = [];
  const adopted = [];
  const destinations = sources.map(({ name, ...source }) => ({
    ...source,
    name,
    destination: contained(activeRoot, name),
  }));
  for (const { destination } of destinations) {
    if (await hasSymlink(activeRoot, destination)) {
      throw new Error('memory policy destination contains a symlink');
    }
  }
  for (const { content, destination } of destinations) {
    await mkdir(dirname(destination), { recursive: true });
    try {
      await writeFile(destination, content, { flag: 'wx' });
      seeded.push(relative(projectRoot, destination));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      adopted.push(relative(projectRoot, destination));
    }
  }

  await writeJsonAtomic(profilePath, {
    schemaVersion: 1,
    ...profile,
    memoryLifecycle: capability,
  });
  return { state: 'enabled', seeded, adopted };
}

export const MEMORY_POLICY_TEMPLATES = Object.freeze([...TEMPLATE_NAMES]);

async function main(argv) {
  const result = await setupMemoryLifecycle({
    decision: argv.includes('--enable') ? 'enable' : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
