#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as p from '@clack/prompts';
import { init } from './commands/init.mjs';
import { update } from './commands/update.mjs';
import { diff } from './commands/diff.mjs';
import { uninstall } from './commands/uninstall.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const consumerRoot = process.cwd();

function stamp() {
  // backup suffix: YYYYMMDDTHHMMSS (no separators that collide with shells)
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

const args = process.argv.slice(2);
const cmd = args[0];
const force = args.includes('--force');
const yes = args.includes('--yes') || args.includes('-y');

p.intro('agent-workflow-kit');

try {
  if (cmd === 'init') {
    const r = await init({ kitRoot: KIT_ROOT, consumerRoot, force });
    p.note(
      `copied ${r.copied.length} · seeded ${r.seeded.length} stub(s)` +
        (r.skipped.length ? `\nskipped (pre-existing, use --force): ${r.skipped.join(', ')}` : ''),
      'init'
    );
    p.outro('Next: run /setup-workflow to fill the project layer + board profile. ' +
      'To enable the drift-guard hook, add .claude/hooks/drift-guard.py to your settings.json hooks.');
  } else if (cmd === 'diff') {
    const r = await diff({ kitRoot: KIT_ROOT, consumerRoot });
    printPlan(r);
    p.outro('Dry run — nothing written. Run `update` to apply.');
  } else if (cmd === 'update') {
    const decide = async (_action, path) => {
      if (yes) return true;
      const ok = await p.confirm({ message: `Upstream removed ${path} — delete it locally?` });
      return ok === true;
    };
    const r = await update({ kitRoot: KIT_ROOT, consumerRoot, now: stamp(), decide });
    printPlan(r);
    for (const c of r.conflicts) p.note(c.diff || '(binary/!text)', `conflict (backed up): ${c.path}`);
    p.outro(`updated ${r.updated.length} · added ${r.added.length} · ` +
      `conflicts ${r.conflicts.length} · deleted ${r.deleted.length}`);
  } else if (cmd === 'uninstall') {
    const ok = yes || (await p.confirm({ message: 'Remove kit-installed files?' })) === true;
    if (!ok) { p.cancel('Aborted.'); process.exit(0); }
    const r = await uninstall({ consumerRoot });
    p.outro(`removed ${r.removed.length} · retained (edited/referenced) ${r.retained.length}`);
  } else {
    p.note('Usage: agent-workflow-kit <init|update|diff|uninstall> [--force] [--yes]');
    p.outro('');
  }
} catch (err) {
  p.cancel(`Error: ${err.message}`);
  process.exit(1);
}

function printPlan(r) {
  const lines = [];
  for (const k of ['added', 'updated', 'userModified', 'unchanged', 'deleted', 'keptDeleted'])
    if (r[k]?.length) lines.push(`${k}: ${r[k].length}`);
  if (r.conflicts?.length) lines.push(`conflicts: ${r.conflicts.length}`);
  p.note(lines.join('\n') || 'no changes', 'plan');
}
