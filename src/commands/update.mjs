import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertReleaseParity } from '../../scripts/release-parity.mjs';
import { activateCandidate, stageConsumer, verifyCandidate } from '../lib/updateCandidate.mjs';
import { reconcile } from '../lib/updateReconcile.mjs';
import {
  CONSUMER_MANIFEST_NAME, PACKAGE_MANIFEST_NAME, readManifest,
} from '../lib/manifest.mjs';

const RELEASE_NAME = '@ikon85/agent-workflow-kit';

/**
 * Transactionally reconcile a consumer with a parity-proven kit release.
 * checking -> preview/awaiting_decision -> staging -> verifying -> terminal state.
 */
export async function update(options) {
  const {
    kitRoot, consumerRoot, decide = () => false, dryRun = false,
    releaseIdentities, verify = verifyCandidate, signal, onState = () => {}, resumeFrom,
  } = options;
  const history = [];
  const transition = async (state) => { history.push(state); await onState(state); };

  await transition('checking');
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  if (!pkg) throw new Error('kit package manifest not found');
  if (!dryRun) verifyRelease(releaseIdentities, pkg.kitVersion);
  const consumerManifestPath = join(consumerRoot, CONSUMER_MANIFEST_NAME);
  if (!await readManifest(consumerManifestPath)) {
    throw new Error('not initialised — run `init` first');
  }
  const consumerManifestBefore = await readFile(consumerManifestPath);

  const decisions = new Map();
  const choose = async (_action, path) => {
    if (!decisions.has(path)) decisions.set(path, await decide('delete', path));
    return decisions.get(path);
  };
  const preview = await reconcile({ kitRoot, consumerRoot, decide: choose, dryRun: true });
  await transition('preview');
  if (preview.deleted.length || preview.keptDeleted.length) await transition('awaiting_decision');
  if (dryRun) return { ...preview, state: 'preview', history };
  if (preview.conflicts.length) return terminal(preview, 'conflicted', history, transition);
  if (!hasUpstreamDelta(preview)) {
    return { ...await terminal(preview, 'applied', history, transition), status: 'current' };
  }
  return applyTransaction({
    kitRoot, consumerRoot, pkg, preview, decisions, verify, signal, resumeFrom,
    consumerManifestBefore, history, transition,
  });
}

async function applyTransaction(context) {
  const {
    kitRoot, consumerRoot, pkg, preview, decisions, verify, signal, resumeFrom,
    consumerManifestBefore, history, transition,
  } = context;
  let candidateRoot = resumeFrom;
  let keepCandidate = false;
  try {
    await transition('staging');
    if (!candidateRoot) {
      candidateRoot = await stageConsumer(consumerRoot);
      await reconcile({
        kitRoot, consumerRoot: candidateRoot,
        decide: (_action, path) => decisions.get(path) === true,
      });
    }
    await transition('verifying');
    const abort = async () => {
      keepCandidate = true;
      return { ...await terminal(preview, 'aborted', history, transition), candidateRoot };
    };
    if (signal?.aborted) return abort();
    await verify(candidateRoot);
    if (signal?.aborted) return abort();
    await activateCandidate({
      candidateRoot, consumerRoot, pkg, preview, consumerManifestBefore,
    });
    return { ...await terminal(preview, 'applied', history, transition), status: 'updated' };
  } catch (error) {
    return { ...await terminal(preview, 'failed', history, transition), error: error.message };
  } finally {
    if (candidateRoot && !keepCandidate) await rm(candidateRoot, { recursive: true, force: true });
  }
}

function verifyRelease(identities, kitVersion) {
  const release = assertReleaseParity(identities);
  if (release.name !== RELEASE_NAME) throw new Error(`invalid release origin: ${release.name}`);
  if (release.version !== kitVersion) {
    throw new Error(`release version ${release.version} does not match kit ${kitVersion}`);
  }
}

function hasUpstreamDelta(result) {
  return result.added.length + result.updated.length + result.deleted.length > 0;
}

async function terminal(result, state, history, transition) {
  await transition(state);
  return {
    ...result,
    state,
    history,
    report: {
      unchanged: result.unchanged.length,
      added: result.added.length,
      updated: result.updated.length,
      deleted: result.deleted.length,
      localModified: result.userModified.length,
      conflicts: result.conflicts.length,
      keptDeleted: result.keptDeleted.length,
      paths: {
        added: result.added,
        updated: result.updated,
        deleted: result.deleted,
        localModified: result.userModified,
        conflicts: result.conflicts.map(({ path }) => path),
        keptDeleted: result.keptDeleted,
      },
      recommendation: result.conflicts.length
        ? 'Review each named conflict; keep the local file or apply the incoming diff manually.'
        : null,
    },
  };
}

export { verifyCandidate } from '../lib/updateCandidate.mjs';
