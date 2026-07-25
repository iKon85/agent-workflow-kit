import { join } from 'node:path';
import { validateConsumerFile } from '../lib/consumerPath.mjs';
import {
  CONSUMER_MANIFEST_NAME, readManifest, withOrigin, writeManifest,
} from '../lib/manifest.mjs';

/** Mark one tracked consumer file as kit- or consumer-owned. */
export async function setOwnership({ consumerRoot, path, origin, ownershipState }) {
  const manifestPath = join(consumerRoot, CONSUMER_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  if (!manifest) throw new Error('not initialised — run `init` first');
  const next = withOrigin(manifest, path, origin, ownershipState);
  await validateConsumerFile(consumerRoot, path);
  await writeManifest(manifestPath, next);
  return { path, origin, ownershipState: origin === 'consumer'
    ? (ownershipState ?? 'explicit-fork') : undefined };
}
