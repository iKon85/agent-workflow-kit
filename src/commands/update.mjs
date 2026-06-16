import { readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from '../lib/hash.mjs';
import { writeAtomic, backupFile, lineDiff } from '../lib/atomicWrite.mjs';
import { hookReferenced } from '../lib/settings.mjs';
import {
  readManifest, writeManifest, emptyConsumerManifest,
  PACKAGE_MANIFEST_NAME, CONSUMER_MANIFEST_NAME, indexByPath,
} from '../lib/manifest.mjs';

const exists = (p) => access(p).then(() => true, () => false);

/**
 * Reconcile an installed consumer against the current kit (three-way: installed
 * hash vs current file = user edit?, vs package desired = upstream change?).
 *  - unmodified + upstream changed → atomic overwrite (`updated`)
 *  - user-edited + upstream changed → timestamped backup + diff, NOT clobbered (`conflicts`)
 *  - user-edited + upstream same → left as-is (`userModified`)
 *  - new upstream file → installed (`added`)
 *  - upstream-removed + unmodified → offered for deletion via `decide` (`deleted`/`keptDeleted`)
 *  - a hook file referenced by the consumer's settings is never auto-deleted (R3#7)
 * `dryRun` classifies without writing (powers `diff`). `now` = backup stamp.
 */
export async function update({ kitRoot, consumerRoot, now, decide = () => false, dryRun = false }) {
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  if (!pkg) throw new Error('kit package manifest not found');
  const consumer = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  if (!consumer) throw new Error('not initialised — run `init` first');

  const installedIdx = indexByPath(consumer, 'installed');
  const pkgIdx = indexByPath(pkg, 'files');
  const res = { unchanged: [], updated: [], conflicts: [], userModified: [], added: [], deleted: [], keptDeleted: [] };
  const nextInstalled = [];

  for (const f of pkg.files) {
    const dest = join(consumerRoot, f.path);
    const prior = installedIdx.get(f.path);
    const cur = (await exists(dest)) ? await sha256File(dest) : null;

    if (!prior || cur === null) {
      if (!dryRun) await writeAtomic(dest, await readFile(join(kitRoot, f.path)), f.mode);
      nextInstalled.push(entry(f, f.sha256));
      res.added.push(f.path);
      continue;
    }
    const userEdited = cur !== prior.installedSha256;
    const upstreamChanged = f.sha256 !== prior.installedSha256;

    if (!userEdited && upstreamChanged) {
      if (!dryRun) await writeAtomic(dest, await readFile(join(kitRoot, f.path)), f.mode);
      nextInstalled.push(entry(f, f.sha256));
      res.updated.push(f.path);
    } else if (userEdited && upstreamChanged) {
      const incoming = await readFile(join(kitRoot, f.path), 'utf8');
      const diff = lineDiff(await readFile(dest, 'utf8'), incoming);
      if (!dryRun) await backupFile(dest, now);
      nextInstalled.push(prior); // keep installed-hash baseline; file stays user's
      res.conflicts.push({ path: f.path, diff });
    } else if (userEdited) {
      nextInstalled.push(prior);
      res.userModified.push(f.path);
    } else {
      nextInstalled.push(prior);
      res.unchanged.push(f.path);
    }
  }

  // upstream-removed files (in consumer manifest, gone from package)
  for (const prior of consumer.installed) {
    if (pkgIdx.has(prior.path)) continue;
    const dest = join(consumerRoot, prior.path);
    const cur = (await exists(dest)) ? await sha256File(dest) : null;
    const userEdited = cur !== null && cur !== prior.installedSha256;
    const referenced = prior.kind === 'hook' && (await hookReferenced(consumerRoot, prior.path));
    if (userEdited || referenced || !(await decide('delete', prior.path))) {
      nextInstalled.push(prior);
      res.keptDeleted.push(prior.path);
    } else {
      if (!dryRun && cur !== null) await rm(dest);
      res.deleted.push(prior.path);
    }
  }

  if (!dryRun) {
    await writeManifest(
      join(consumerRoot, CONSUMER_MANIFEST_NAME),
      { ...emptyConsumerManifest(pkg.kitVersion), installed: nextInstalled }
    );
  }
  return res;
}

function entry(f, sha) {
  return { path: f.path, kind: f.kind, ownerSkill: f.ownerSkill, surface: f.surface, installedSha256: sha, origin: 'kit' };
}
