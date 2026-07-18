import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lineDiff } from './atomicWrite.mjs';
import { validateConsumerFile } from './consumerPath.mjs';
import { sha256 } from './hash.mjs';
import {
  CONSUMER_MANIFEST_NAME, CONSUMER_ORIGIN, PACKAGE_MANIFEST_NAME, indexByPath, readManifest,
} from './manifest.mjs';

/** Describe on demand how current package entries differ from consumer-owned paths. */
export async function ownedDiff({ kitRoot, consumerRoot }) {
  const consumer = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  const packageByPath = indexByPath(pkg, 'files');
  const results = [];

  for (const installed of consumer.installed.filter(({ origin }) => origin === CONSUMER_ORIGIN)) {
    const current = packageByPath.get(installed.path);
    let localPath;
    try {
      localPath = await validateConsumerFile(consumerRoot, installed.path);
    } catch (error) {
      if (error.message === `unsafe consumer path (not a regular file): ${installed.path}` &&
          await isMissing(join(consumerRoot, installed.path))) {
        results.push({ path: installed.path, state: 'missing-locally' });
        continue;
      }
      if (error.message.startsWith('unsafe consumer path')) {
        results.push({ path: installed.path, state: 'unsafe-path' });
        continue;
      }
      throw error;
    }
    if (!current) {
      results.push({ path: installed.path, state: 'removed-upstream' });
      continue;
    }
    const local = await readFile(localPath);
    let packagePath;
    try {
      packagePath = await validateConsumerFile(kitRoot, current.path);
    } catch (error) {
      if (error.message.startsWith('unsafe consumer path')) {
        results.push({ path: installed.path, state: 'unsafe-path' });
        continue;
      }
      throw error;
    }
    const upstream = await readFile(packagePath);
    if (local.equals(upstream)) {
      results.push({ path: installed.path, state: 'identical' });
      continue;
    }
    if (isBinary(local) || isBinary(upstream)) {
      results.push({
        path: installed.path,
        state: 'changed-upstream',
        binary: true,
        local: { size: local.length, sha256: sha256(local) },
        upstream: { size: upstream.length, sha256: sha256(upstream) },
      });
      continue;
    }
    results.push({
      path: installed.path,
      state: 'changed-upstream',
      binary: false,
      diff: lineDiff(local.toString('utf8'), upstream.toString('utf8')),
    });
  }
  return results;
}

async function isMissing(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function isBinary(bytes) {
  if (bytes.includes(0)) return true;
  const text = bytes.toString('utf8');
  return !Buffer.from(text, 'utf8').equals(bytes);
}
