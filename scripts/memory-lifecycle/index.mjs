import {
  constants,
  copyFile,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

async function exists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function resolveCandidate(root, candidate) {
  if (isAbsolute(candidate)) return null;
  const normalized = normalize(candidate);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null;
  const absolute = resolve(root, normalized);
  const boundary = `${resolve(root)}${sep}`;
  return absolute.startsWith(boundary) ? absolute : null;
}

async function pathHasSymlink(root, candidatePath) {
  const rootStat = await exists(root);
  if (rootStat?.isSymbolicLink()) return true;

  const relativePath = relative(resolve(root), candidatePath);
  let current = resolve(root);
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    const stat = await exists(current);
    if (stat?.isSymbolicLink()) return true;
  }
  return false;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function planMemoryLifecycle({
  activeRoot,
  archiveRoot,
  candidates,
  approved = false,
}) {
  const actions = [];
  const seen = new Set();

  for (const candidateInput of candidates) {
    const candidate = typeof candidateInput === 'string'
      ? { path: candidateInput, enabled: true }
      : { enabled: true, ...candidateInput };
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);

    if (!candidate.enabled) {
      actions.push({
        path: candidate.path,
        action: 'skip',
        reason: 'candidate is disabled by consumer policy',
      });
      continue;
    }

    const activePath = resolveCandidate(activeRoot, candidate.path);
    const archivePath = resolveCandidate(archiveRoot, candidate.path);
    let action = 'refuse';
    let reason = 'outside configured roots';

    if (
      activePath
      && archivePath
      && !(await pathHasSymlink(activeRoot, activePath))
      && !(await pathHasSymlink(archiveRoot, archivePath))
    ) {
      const active = await exists(activePath);
      const archived = await exists(archivePath);
      if (active && archived) {
        const identical = active.isFile() && archived.isFile()
          && (await sha256(activePath)) === (await sha256(archivePath));
        action = identical ? 'preserve' : 'refuse';
        reason = identical
          ? 'active and archived memory already match'
          : 'active and archived memory collide';
      } else if (active) {
        action = 'preserve';
        reason = 'active memory already exists';
      } else if (archived && approved) {
        action = 'restore';
        reason = 'approved archived memory is available';
      } else if (archived) {
        action = 'refuse';
        reason = 'restore approval is required';
      } else {
        action = 'create';
        reason = 'memory does not exist';
      }
    } else if (activePath && archivePath) {
      reason = `symlink escape below ${dirname(activePath)}`;
    }

    actions.push({ path: candidate.path, action, reason });
  }

  return { dryRun: true, actions };
}

async function writeReceipt(receiptRoot, receipt) {
  await mkdir(receiptRoot, { recursive: true });
  const name = `memory-restore-${Date.now()}-${randomUUID()}.json`;
  const path = resolve(receiptRoot, name);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}

export async function executeMemoryLifecycle(options) {
  const plan = await planMemoryLifecycle(options);
  const verdicts = [];

  for (const item of plan.actions) {
    if (item.action !== 'restore') {
      verdicts.push({
        path: item.path,
        verdict: item.action === 'refuse' ? 'refused' : 'skipped',
        reason: item.reason,
      });
      continue;
    }

    const activePath = resolveCandidate(options.activeRoot, item.path);
    const archivePath = resolveCandidate(options.archiveRoot, item.path);
    const hash = await sha256(archivePath);
    await mkdir(dirname(activePath), { recursive: true });
    try {
      await copyFile(archivePath, activePath, constants.COPYFILE_EXCL);
      verdicts.push({ path: item.path, verdict: 'restored', sha256: hash });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      verdicts.push({
        path: item.path,
        verdict: 'refused',
        reason: 'active memory appeared before restore',
        sha256: hash,
      });
    }
  }

  const restored = verdicts.some(({ verdict }) => verdict === 'restored');
  const receiptPath = restored
    ? await writeReceipt(options.receiptRoot, {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        source: options.source,
        verdicts,
      })
    : null;

  return { verdicts, receiptPath };
}

async function readJsonIfPresent(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function runMemoryLifecycle({
  projectRoot = process.cwd(),
  profilePath = 'docs/agents/workflow-capabilities.json',
  apply = false,
} = {}) {
  const absoluteProfile = resolveCandidate(projectRoot, profilePath);
  if (!absoluteProfile || await pathHasSymlink(projectRoot, absoluteProfile)) {
    return {
      state: 'refused',
      dryRun: !apply,
      actions: [{ path: profilePath, action: 'refuse', reason: 'unsafe profile path' }],
    };
  }

  const profileDocument = await readJsonIfPresent(absoluteProfile);
  const capability = profileDocument?.value?.memoryLifecycle;
  if (!capability?.enabled) {
    return { state: 'disabled', dryRun: true, actions: [] };
  }

  const activeRoot = resolveCandidate(projectRoot, capability.activeRoot);
  const archiveRoot = resolveCandidate(projectRoot, capability.archiveRoot);
  const receiptRoot = resolveCandidate(projectRoot, capability.receiptRoot);
  if (!activeRoot || !archiveRoot || !receiptRoot) {
    return {
      state: 'refused',
      dryRun: !apply,
      actions: [{ path: 'memoryLifecycle', action: 'refuse', reason: 'configured root escapes project' }],
    };
  }

  const consumerManifest = await readJsonIfPresent(
    resolve(projectRoot, 'agent-workflow-kit.json'),
  );
  const source = {
    kitVersion: consumerManifest?.value?.kitVersion ?? 'unknown',
    bundleVersion: consumerManifest
      ? `sha256:${createHash('sha256').update(consumerManifest.raw).digest('hex')}`
      : 'unknown',
  };
  const options = {
    activeRoot,
    archiveRoot,
    receiptRoot,
    candidates: capability.memories ?? [],
    approved: capability.approvals?.restore === true,
    source,
  };
  if (apply) {
    return { state: 'applied', dryRun: false, ...await executeMemoryLifecycle(options) };
  }
  return { state: 'planned', ...await planMemoryLifecycle(options) };
}

async function main(argv) {
  const apply = argv.includes('--apply');
  const profileFlag = argv.indexOf('--profile');
  const profilePath = profileFlag >= 0 ? argv[profileFlag + 1] : undefined;
  const result = await runMemoryLifecycle({ apply, profilePath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
