import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from 'lib/hash.mjs';
import { hookReferenced } from 'lib/settings.mjs';
import { writeManifest, readManifest, emptyConsumerManifest, CONSUMER_MANIFEST_NAME } from 'lib/manifest.mjs';

const exists = (p) => access(p).then(() => true, () => false);

/**
 * Remove kit-installed files. User-edited files and hook files still referenced
 * by settings are retained (Codex R1#11 / R3#7). If anything is retained, the
 * manifest is kept with those entries marked `orphanedByUninstall`; on a fully
 * clean uninstall the manifest is removed.
 */
export async function uninstall({ consumerRoot }) {
  const consumer = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  if (!consumer) throw new Error('not initialised — nothing to uninstall');

  const res = { removed: [], retained: [] };
  const retainedEntries = [];

  for (const e of consumer.installed) {
    const dest = join(consumerRoot, e.path);
    if (!(await exists(dest))) continue; // already gone
    const userEdited = (await sha256File(dest)) !== e.installedSha256;
    const referenced = e.kind === 'hook' && (await hookReferenced(consumerRoot, e.path));
    if (userEdited || referenced) {
      retainedEntries.push({ ...e, orphanedByUninstall: true });
      res.retained.push(e.path);
    } else {
      await rm(dest);
      res.removed.push(e.path);
    }
  }

  const manifestPath = join(consumerRoot, CONSUMER_MANIFEST_NAME);
  if (retainedEntries.length) {
    await writeManifest(manifestPath, { ...emptyConsumerManifest(consumer.kitVersion), installed: retainedEntries });
  } else {
    await rm(manifestPath, { force: true });
  }
  return res;
}
