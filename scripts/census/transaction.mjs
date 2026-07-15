import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class CensusTransactionError extends Error {
  constructor(message, state, cause) {
    super(message, { cause });
    this.name = 'CensusTransactionError';
    this.state = state;
  }
}
async function acquireLock(lockPath) {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, 'wx');
    await handle.close();
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new CensusTransactionError(`census update already locked: ${lockPath}`, 'updating', error);
    }
    throw error;
  }
}

/** Stage, verify, then atomically replace the active census while holding a local lock. */
export async function activateCensus({
  activePath,
  candidate,
  verify,
  lockPath = `${activePath}.lock`,
  stagePath = `${activePath}.candidate`,
  renameCandidate = rename,
}) {
  if (typeof verify !== 'function') {
    throw new TypeError('census activation requires a callable verifier');
  }
  await acquireLock(lockPath);
  try {
    const serialized = `${JSON.stringify(candidate)}\n`;
    await writeFile(stagePath, serialized, 'utf8');
    const verified = await verify(candidate, { activePath, stagePath });
    if (verified === false) throw new Error('census candidate verification returned false');
    await renameCandidate(stagePath, activePath);
    return { activePath, state: 'current' };
  } catch (error) {
    await rm(stagePath, { force: true });
    throw new CensusTransactionError(`census activation failed: ${error.message}`, 'failed', error);
  } finally {
    await rm(lockPath, { force: true });
  }
}
