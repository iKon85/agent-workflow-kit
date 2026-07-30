import { access, lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256File } from './hash.mjs';
import { lineDiff, writeAtomic } from './atomicWrite.mjs';
import { hookReferenced } from './settings.mjs';
import { validateConsumerFile } from './consumerPath.mjs';
import { validateContributionBridge } from './contributionBridge.mjs';
import { inspectProjectSkillExtension } from './projectSkillExtension.mjs';
import {
  OwnershipState, classifyOwnershipEvidence,
} from './ownershipClassifier.mjs';
import {
  CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME, emptyConsumerManifest,
  CONSUMER_INSTALL_ROLE, CONSUMER_ORIGIN, KIT_ORIGIN, filesForInstallRole,
  indexByPath, readManifest, writeManifest,
  readReadinessContract,
} from './manifest.mjs';

const exists = (path) => access(path).then(() => true, () => false);

/** Classify or apply one three-way reconcile inside a supplied root. */
export async function reconcile({ kitRoot, consumerRoot, decide = () => false, dryRun = false }) {
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  if (!pkg) throw new Error('kit package manifest not found');
  const consumer = await readManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME));
  if (!consumer) throw new Error('not initialised — run `init` first');
  const readiness = await readReadinessContract(kitRoot);

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
      const destinationPresent = await exists(dest);
      const bridge = prior.ownershipState === OwnershipState.CONTRIBUTION_BRIDGE
        ? contributionBridgeEvidence(prior) : null;
      const classification = classifyOwnershipEvidence({
        path: file.path,
        packageEntry: file,
        installedEntry: prior,
        destinationPresent,
        projectExtension: prior.ownershipState === OwnershipState.PROJECT_EXTENSION
          ? await projectExtensionEvidence(consumerRoot, file.path) : null,
        contributionBridge: bridge,
      });
      result.ownershipStates.push(classification);
      if (classification.state === OwnershipState.AMBIGUOUS_COLLISION) {
        result.conflicts.push({
          path: file.path,
          kind: 'ownership-lifecycle',
          diff: 'Consumer lifecycle metadata does not match its declared path/schema.',
        });
      }
      if (classification.state === OwnershipState.CONTRIBUTION_BRIDGE) {
        if (destinationPresent) {
          await validateConsumerFile(consumerRoot, file.path);
          const current = await sha256File(dest);
          if (current === file.sha256 && current === bridge.localSha256) {
            if (!dryRun) {
              await writeAtomic(dest, await readFile(join(kitRoot, file.path)), file.mode);
            }
            nextInstalled.push(entry(file, file.sha256));
            result.bridgeRetired.push(file.path);
            continue;
          }
        }
      }
      let retained = withInstallRole(prior);
      if (destinationPresent && [
        OwnershipState.EXPLICIT_FORK, OwnershipState.PROJECT_EXTENSION,
      ].includes(classification.state)) {
        await validateConsumerFile(consumerRoot, file.path);
        retained = { ...retained, installedSha256: await sha256File(dest) };
      }
      nextInstalled.push(retained);
      result.consumerOwned.push(file.path);
      continue;
    }
    const present = await exists(dest);
    if (!prior && present) {
      await validateConsumerFile(consumerRoot, file.path);
      const classification = classifyOwnershipEvidence({
        path: file.path,
        packageEntry: file,
        destinationPresent: true,
        projectExtension: await projectExtensionEvidence(consumerRoot, file.path),
      });
      result.ownershipStates.push(classification);
      const decision = await decide('collision', file.path);
      if (decision === false || decision === null || decision === undefined) {
        if (dryRun) {
          result.collisions.push(file.path);
          continue;
        }
        throw new Error(`collision decision required for ${file.path}`);
      }
      const allowed = [
        'keep-as-owned', 'project-extension', 'contribution-bridge', 'explicit-fork', 'replace',
      ];
      if (!allowed.includes(decision)
          || (decision === 'project-extension'
            && classification.state !== OwnershipState.PROJECT_EXTENSION)) {
        throw new Error(
          `collision decision for ${file.path} must select a valid explicit ownership route`,
        );
      }
      const destinationSha256 = await sha256File(dest);
      const resolvedState = decision === 'replace' ? OwnershipState.CLEAN_CORE
        : (decision === 'keep-as-owned' ? OwnershipState.EXPLICIT_FORK : decision);
      const resolution = {
        path: file.path, outcome: decision, destinationSha256,
      };
      if (!['replace', 'keep-as-owned'].includes(decision)) {
        resolution.ownershipState = resolvedState;
      }
      result.collisionResolutions.push(resolution);
      if (decision !== 'replace') {
        const lifecycle = resolvedState === OwnershipState.CONTRIBUTION_BRIDGE ? {
          contributionBridge: {
            schemaVersion: 1,
            baseKitVersion: pkg.kitVersion,
            baseSha256: file.sha256,
            localSha256: destinationSha256,
          },
        } : {};
        nextInstalled.push(entry(
          file, destinationSha256, CONSUMER_ORIGIN, resolvedState, lifecycle,
        ));
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
    const currentMode = (await lstat(dest)).mode & 0o777;
    const upstreamChanged = file.sha256 !== prior.installedSha256
      || currentMode !== file.mode
      || packageMetadataChanged(file, prior);
    if (userEdited) {
      // An in-place edit of an `origin=kit` path is not a fork: the ledger
      // records no ownership for it, so the full new version activates here and
      // the local bytes survive as a backup the summary names. `own` (and the
      // other explicit ownership states, handled above) is how a Consumer holds
      // a fork; an undeclared edit is a change the Consumer is offered a route
      // for, never a silent one and never a blocked update. The record is also
      // what activation's destination-race check reads, so it is written for
      // every edited path — including one whose bytes already match the
      // incoming version, where activation then needs no backup at all.
      const incoming = await readFile(join(kitRoot, file.path));
      const localText = await readFile(dest, 'utf8');
      if (!dryRun) await writeAtomic(dest, incoming, file.mode);
      nextInstalled.push(entry(file, file.sha256));
      result.updated.push(file.path);
      result.overwritten.push({
        path: file.path,
        localSha256: current,
        mode: currentMode,
        diff: lineDiff(localText, incoming.toString('utf8')),
      });
    } else if (upstreamChanged) {
      if (!dryRun) await writeAtomic(dest, await readFile(join(kitRoot, file.path)), file.mode);
      nextInstalled.push(entry(file, file.sha256));
      result.updated.push(file.path);
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

  result.manifestChanged = consumer.kitVersion !== pkg.kitVersion ||
    consumer.installRole !== CONSUMER_INSTALL_ROLE ||
    result.bridgeRetired.length > 0 ||
    nextInstalled.some((next) => installedIdx.get(next.path)?.installRole !== next.installRole);

  if (!dryRun) {
    await writeManifest(join(consumerRoot, CONSUMER_MANIFEST_NAME), {
      ...emptyConsumerManifest(pkg.kitVersion, consumer, readiness), installed: nextInstalled,
    });
  }
  return result;
}

function emptyResult() {
  return {
    unchanged: [], updated: [], conflicts: [], collisions: [], collisionResolutions: [],
    overwritten: [],
    ownershipStates: [],
    bridgeRetired: [],
    added: [], deleted: [], keptDeleted: [], consumerOwned: [], manifestChanged: false,
  };
}

function contributionBridgeEvidence(installed) {
  try {
    return validateContributionBridge(installed);
  } catch (error) {
    return { invalid: error.message };
  }
}

function entry(file, installedSha256, origin = KIT_ORIGIN, ownershipState, lifecycle = {}) {
  const result = {
    path: file.path, kind: file.kind, ownerSkill: file.ownerSkill, surface: file.surface,
    installedSha256, origin, installRole: CONSUMER_INSTALL_ROLE, ...lifecycle,
  };
  if (ownershipState) result.ownershipState = ownershipState;
  return result;
}

function withInstallRole(installed, installRole = CONSUMER_INSTALL_ROLE) {
  return { ...installed, installRole };
}

function packageMetadataChanged(file, installed) {
  return ['kind', 'ownerSkill', 'surface'].some(
    (key) => (file[key] ?? null) !== (installed[key] ?? null),
  );
}

async function projectExtensionEvidence(consumerRoot, path) {
  const match = /^docs\/agents\/skills\/([a-z0-9-]+)\.md$/.exec(path);
  if (!match) return null;
  try {
    const result = await inspectProjectSkillExtension({ root: consumerRoot, skill: match[1] });
    return result.state === 'active' ? result : null;
  } catch (error) {
    return { invalid: error.message };
  }
}
