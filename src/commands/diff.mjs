import { update } from './update.mjs';

/** Dry-run of `update`: classifies what an update would do, writes nothing. */
export async function diff({ kitRoot, consumerRoot }) {
  return update({ kitRoot, consumerRoot, now: 'dry', dryRun: true });
}
