import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from './hash.mjs';
import { lineDiff, writeAtomic } from './atomicWrite.mjs';
import { hookReferenced } from './settings.mjs';
import { validateConsumerFile } from './consumerPath.mjs';
import {
  CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME, emptyConsumerManifest,
  CONSUMER_INSTALL_ROLE, CONSUMER_ORIGIN, KIT_ORIGIN, filesForInstallRole,
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
  const packageIdx = indexByPath(pkg, 'files');
  const installable = filesForInstallRole(pkg);
  const pkgIdx = indexByPath({ files: installable }, 'files');
  const result = emptyResult();
  const nextInstalled = [];

  for (const file of installable) {
    const dest = join(consumerRoot, file.path);
    const prior = installedIdx.get(file.path);
    if (prior?.origin === CONSUMER_ORIGIN) {
      nextInstalled.push(withInstallRole(prior));
      result.consumerOwned.push(file.path);
      continue;
    }
    const present = await exists(dest);
    if (!prior && present) {
      await validateConsumerFile(consumerRoot, file.path);
      const decision = await decide('collision', file.path);
      if (decision === false || decision === null || decision === undefined) {
        if (dryRun) {
          result.collisions.push(file.path);
          continue;
        }
        throw new Error(`collision decision required for ${file.path}`);
      }
      if (decision !== 'keep-as-owned' && decision !== 'replace') {
        throw new Error(`collision decision for ${file.path} must be keep-as-owned or replace`);
      }
      const destinationSha256 = await sha256File(dest);
      result.collisionResolutions.push({
        path: file.path, outcome: decision, destinationSha256,
      });
      if (decision === 'keep-as-owned') {
        nextInstalled.push(entry(file, destinationSha256, CONSUMER_ORIGIN));
        result.consumerOwned.push(file.path);
      } else {
        if (!dryRun) await writeAtomic(dest, await readFile(join(kitRoot, file.path)), file.mode);
        nextInstalled.push(entry(file, file.sha256));
        result.added.push(file.path);
      }
      continue;
    }
    const current = present ? await sha256File(dest) : null;
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
      nextInstalled.push(withInstallRole(prior));
    } else if (userEdited) {
      nextInstalled.push(withInstallRole(prior));
      result.userModified.push(file.path);
    } else {
      nextInstalled.push(withInstallRole(prior));
      result.unchanged.push(file.path);
    }
  }

  for (const prior of consumer.installed) {
    if (pkgIdx.has(prior.path)) continue;
    if (prior.origin === CONSUMER_ORIGIN) {
      nextInstalled.push(withInstallRole(prior));
      result.consumerOwned.push(prior.path);
      continue;
    }
    const dest = join(consumerRoot, prior.path);
    const current = (await exists(dest)) ? await sha256File(dest) : null;
    const userEdited = current !== null && current !== prior.installedSha256;
    const referenced = prior.kind === 'hook' && (await hookReferenced(consumerRoot, prior.path));
    if (userEdited || referenced || !(await decide('delete', prior.path))) {
      const packageEntry = packageIdx.get(prior.path);
      nextInstalled.push(withInstallRole(
        prior,
        packageEntry?.installRole ?? prior.installRole ?? CONSUMER_INSTALL_ROLE,
      ));
      result.keptDeleted.push(prior.path);
    } else {
      if (!dryRun && current !== null) await rm(dest);
      result.deleted.push(prior.path);
    }
  }

  result.manifestChanged = consumer.installRole !== CONSUMER_INSTALL_ROLE ||
    nextInstalled.some((next) => installedIdx.get(next.path)?.installRole !== next.installRole);

  if (!dryRun) {
    await writeManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME), {
      ...emptyConsumerManifest(pkg.kitVersion), installed: nextInstalled,
    });
  }
  return result;
}

function emptyResult() {
  return {
    unchanged: [], updated: [], conflicts: [], collisions: [], collisionResolutions: [], userModified: [],
    added: [], deleted: [], keptDeleted: [], consumerOwned: [], manifestChanged: false,
  };
}

function entry(file, installedSha256, origin = KIT_ORIGIN) {
  return {
    path: file.path, kind: file.kind, ownerSkill: file.ownerSkill, surface: file.surface,
    installedSha256, origin, installRole: CONSUMER_INSTALL_ROLE,
  };
}

function withInstallRole(installed, installRole = CONSUMER_INSTALL_ROLE) {
  return { ...installed, installRole };
}
