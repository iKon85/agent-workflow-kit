import { lstat } from 'node:fs/promises';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

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

export async function planMemoryLifecycle({
  activeRoot,
  archiveRoot,
  candidates,
  approved = false,
}) {
  const actions = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const activePath = resolveCandidate(activeRoot, candidate);
    const archivePath = resolveCandidate(archiveRoot, candidate);
    let action = 'refuse';
    let reason = 'outside configured roots';

    if (activePath && archivePath) {
      const active = await exists(activePath);
      const archived = await exists(archivePath);
      if (active) {
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
    }

    actions.push({ path: candidate, action, reason });
  }

  return { dryRun: true, actions };
}
