import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from './hash.mjs';
import { lineDiff, writeAtomic } from './atomicWrite.mjs';
import { hookReferenced } from './settings.mjs';
import {
  CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME, emptyConsumerManifest,
  indexByPath, readManifest, writeManifest,
} from './manifest.mjs';

const exists = (path) => access(path).then(() => true, () => false);

/** Classify or apply one three-way reconcile inside a supplied root. */
export async function reconcile({ kitRoot, consumerRoot, decide = () => false, dryRun = false }) {
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  if (!pkg) throw new Error('kit package manifest not found');
  const consumer = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  if (!consumer) throw new Error('not initialised — run `init` first');

  const installedIdx = indexByPath(consumer, 'installed');
  const pkgIdx = indexByPath(pkg, 'files');
  const result = emptyResult();
  const nextInstalled = [];

  for (const file of pkg.files) {
    const dest = join(consumerRoot, file.path);
    const prior = installedIdx.get(file.path);
    const current = (await exists(dest)) ? await sha256File(dest) : null;
    if (!prior || current === null) {
      if (!dryRun) await writeAtomic(dest, await readFile(join(kitRoot, file.path)), file.mode);
      nextInstalled.push(entry(file, file.sha256));
      result.added.push(file.path);
      continue;
    }
    const userEdited = current !== prior.installedSha256;
    const upstreamChanged = file.sha256 !== prior.installedSha256;
    if (!userEdited && upstreamChanged) {
      if (!dryRun) await writeAtomic(dest, await readFile(join(kitRoot, file.path)), file.mode);
      nextInstalled.push(entry(file, file.sha256));
      result.updated.push(file.path);
    } else if (userEdited && upstreamChanged) {
      const incoming = await readFile(join(kitRoot, file.path), 'utf8');
      result.conflicts.push({ path: file.path, diff: lineDiff(await readFile(dest, 'utf8'), incoming) });
      nextInstalled.push(prior);
    } else if (userEdited) {
      nextInstalled.push(prior);
      result.userModified.push(file.path);
    } else {
      nextInstalled.push(prior);
      result.unchanged.push(file.path);
    }
  }

  for (const prior of consumer.installed) {
    if (pkgIdx.has(prior.path)) continue;
    const dest = join(consumerRoot, prior.path);
    const current = (await exists(dest)) ? await sha256File(dest) : null;
    const userEdited = current !== null && current !== prior.installedSha256;
    const referenced = prior.kind === 'hook' && (await hookReferenced(consumerRoot, prior.path));
    if (userEdited || referenced || !(await decide('delete', prior.path))) {
      nextInstalled.push(prior);
      result.keptDeleted.push(prior.path);
    } else {
      if (!dryRun && current !== null) await rm(dest);
      result.deleted.push(prior.path);
    }
  }

  if (!dryRun) {
    await writeManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME), {
      ...emptyConsumerManifest(pkg.kitVersion), installed: nextInstalled,
    });
  }
  return result;
}

function emptyResult() {
  return {
    unchanged: [], updated: [], conflicts: [], userModified: [],
    added: [], deleted: [], keptDeleted: [],
  };
}

function entry(file, installedSha256) {
  return {
    path: file.path, kind: file.kind, ownerSkill: file.ownerSkill, surface: file.surface,
    installedSha256, origin: 'kit',
  };
}
