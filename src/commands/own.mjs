import { join } from 'node:path';
import { validateConsumerFile } from '../lib/consumerPath.mjs';
import {
  CONSUMER_MANIFEST_NAME, readManifest, withOrigin, writeManifest,
} from '../lib/manifest.mjs';
import { sha256File } from '../lib/hash.mjs';

/** Mark one tracked consumer file as kit- or consumer-owned. */
export async function setOwnership({ consumerRoot, path, origin, ownershipState }) {
  if (origin === 'consumer' && ownershipState === 'contribution-bridge') {
    throw new Error('contribution bridge requires `contribute start` with Kit provenance');
  }
  const manifestPath = join(consumerRoot, CONSUMER_MANIFEST_NAME);
  const manifest = await readManifest(manifestPath);
  if (!manifest) throw new Error('not initialised — run `init` first');
  const validatedOwnership = withOrigin(manifest, path, origin, ownershipState);
  await validateConsumerFile(consumerRoot, path);
  const installedSha256 = origin === 'consumer'
    ? await sha256File(join(consumerRoot, path)) : undefined;
  const next = installedSha256
    ? withOrigin(manifest, path, origin, ownershipState, installedSha256)
    : validatedOwnership;
  await writeManifest(manifestPath, next);
  return { path, origin, ownershipState: origin === 'consumer'
    ? (ownershipState ?? 'explicit-fork') : undefined };
}
