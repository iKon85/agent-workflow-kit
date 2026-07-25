import {
  lstat, readFile,
} from 'node:fs/promises';
import {
  isAbsolute, join, normalize, resolve,
} from 'node:path';
import { lineDiff, writeAtomic } from './atomicWrite.mjs';
import { validateConsumerFile } from './consumerPath.mjs';
import { sha256File } from './hash.mjs';
import {
  CONSUMER_MANIFEST_NAME, CONSUMER_ORIGIN, KIT_ORIGIN, PACKAGE_MANIFEST_NAME,
  readManifest, writeManifest,
} from './manifest.mjs';

export const CONTRIBUTION_BRIDGE_SCHEMA_VERSION = 1;
export const CONTRIBUTION_ARTIFACT_KIND = 'agent-workflow-kit/contribution';
const HASH = /^[a-f0-9]{64}$/;
const OUTPUT = /^\.agent-workflow-kit\/contributions\/[a-zA-Z0-9._-]+\.json$/;

export function validateContributionBridge(entry) {
  const bridge = entry?.contributionBridge;
  if (entry?.origin !== CONSUMER_ORIGIN
      || entry?.ownershipState !== 'contribution-bridge'
      || !bridge
      || bridge.schemaVersion !== CONTRIBUTION_BRIDGE_SCHEMA_VERSION
      || typeof bridge.baseKitVersion !== 'string'
      || !bridge.baseKitVersion
      || !HASH.test(bridge.baseSha256 ?? '')
      || !HASH.test(bridge.localSha256 ?? '')
      || bridge.baseSha256 === bridge.localSha256
      || entry.installedSha256 !== bridge.localSha256) {
    throw new Error(`invalid contribution bridge metadata: ${entry?.path ?? 'unknown path'}`);
  }
  return bridge;
}

export async function beginContributionBridge({ kitRoot, consumerRoot, path }) {
  const { pkg, manifest, desired, tracked } = await loadCoreIdentity({
    kitRoot, consumerRoot, path,
  });
  if (tracked.origin !== KIT_ORIGIN || tracked.ownershipState !== undefined) {
    throw new Error(`contribution bridge requires clean Kit ownership: ${path}`);
  }
  if (manifest.kitVersion !== pkg.kitVersion
      || tracked.installedSha256 !== desired.sha256
      || await sha256File(join(kitRoot, path)) !== desired.sha256) {
    throw new Error(`stale upstream base for contribution bridge: ${path}`);
  }
  const localSha256 = await sha256File(await validateConsumerFile(consumerRoot, path));
  if (localSha256 === desired.sha256) {
    throw new Error(`contribution bridge has no local Core change: ${path}`);
  }
  const bridge = {
    schemaVersion: CONTRIBUTION_BRIDGE_SCHEMA_VERSION,
    baseKitVersion: pkg.kitVersion,
    baseSha256: desired.sha256,
    localSha256,
  };
  const next = {
    ...manifest,
    installed: manifest.installed.map((entry) => entry.path === path ? {
      ...entry,
      installedSha256: localSha256,
      origin: CONSUMER_ORIGIN,
      ownershipState: 'contribution-bridge',
      contributionBridge: bridge,
    } : entry),
  };
  await writeManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME), next);
  return { path, state: 'contribution-bridge', bridge };
}

export async function prepareContributionArtifact({
  kitRoot, consumerRoot, path, output,
}) {
  const { pkg, desired, tracked } = await loadCoreIdentity({
    kitRoot, consumerRoot, path,
  });
  const bridge = validateContributionBridge(tracked);
  if (pkg.kitVersion !== bridge.baseKitVersion
      || desired.sha256 !== bridge.baseSha256
      || await sha256File(join(kitRoot, path)) !== bridge.baseSha256) {
    throw new Error(`stale upstream base for contribution bridge: ${path}`);
  }
  const localPath = await validateConsumerFile(consumerRoot, path);
  if (await sha256File(localPath) !== bridge.localSha256) {
    throw new Error(`contribution bridge changed after classification: ${path}`);
  }
  const base = await readFile(join(kitRoot, path));
  const local = await readFile(localPath);
  const baseText = strictUtf8(base, path);
  const localText = strictUtf8(local, path);
  const artifact = {
    schemaVersion: CONTRIBUTION_BRIDGE_SCHEMA_VERSION,
    kind: CONTRIBUTION_ARTIFACT_KIND,
    coreIdentity: {
      path,
      baseKitVersion: bridge.baseKitVersion,
      baseSha256: bridge.baseSha256,
      localSha256: bridge.localSha256,
    },
    diff: {
      format: 'line-diff-v1',
      text: lineDiff(baseText, localText),
    },
  };
  const destination = await validateArtifactOutput(consumerRoot, output);
  const content = `${JSON.stringify(artifact, null, 2)}\n`;
  try {
    const existing = await readFile(destination, 'utf8');
    if (existing !== content) {
      throw new Error(`contribution artifact already exists with different content: ${output}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeAtomic(destination, content, 0o600);
  }
  return { output, artifact };
}

async function loadCoreIdentity({ kitRoot, consumerRoot, path }) {
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  const manifest = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  if (!pkg) throw new Error('kit package manifest not found');
  if (!manifest) throw new Error('not initialised — run `init` first');
  const desired = pkg.files?.find((entry) => (
    entry.path === path && (entry.installRole ?? 'consumer') === 'consumer'
  ));
  if (!desired || (desired.origin ?? KIT_ORIGIN) !== KIT_ORIGIN) {
    throw new Error(`not declared Kit Core: ${path}`);
  }
  const tracked = manifest.installed?.find((entry) => entry.path === path);
  if (!tracked) throw new Error(`not declared Kit Core in Consumer ledger: ${path}`);
  return { pkg, manifest, desired, tracked };
}

function strictUtf8(bytes, path) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) {
    throw new Error(`binary Kit Core requires an Explicit fork: ${path}`);
  }
  return text;
}

async function validateArtifactOutput(consumerRoot, output) {
  if (typeof output !== 'string'
      || isAbsolute(output)
      || normalize(output) !== output
      || !OUTPUT.test(output)) {
    throw new Error(`unsafe contribution artifact path: ${output}`);
  }
  const root = resolve(consumerRoot);
  let current = root;
  for (const segment of output.split('/').slice(0, -1)) {
    current = join(current, segment);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`unsafe contribution artifact path: ${output}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  const destination = join(root, output);
  try {
    const entry = await lstat(destination);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`unsafe contribution artifact path: ${output}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return destination;
}
