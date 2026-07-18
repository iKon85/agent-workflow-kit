import { update } from './update.mjs';
import { ownedDiff } from '../lib/ownedDiff.mjs';

/** Dry-run of `update`: classifies what an update would do, writes nothing. */
export async function diff({ kitRoot, consumerRoot, owned = false }) {
  const preview = await update({ kitRoot, consumerRoot, now: 'dry', dryRun: true });
  if (!owned) return preview;
  return { ...preview, ownedDiffs: await ownedDiff({ kitRoot, consumerRoot }) };
}
