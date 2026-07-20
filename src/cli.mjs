#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as p from '@clack/prompts';
import { init } from './commands/init.mjs';
import { renderUpdateFailure, update } from './commands/update.mjs';
import { diff } from './commands/diff.mjs';
import { uninstall } from './commands/uninstall.mjs';
import { setOwnership } from './commands/own.mjs';
import { CONSUMER_ORIGIN, KIT_ORIGIN } from './lib/manifest.mjs';
import { createCommandAdapter } from '../scripts/release-state.mjs';
import { installedIdentityFromDir } from '../scripts/release-parity.mjs';

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
const owned = args.includes('--owned');

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
    const r = await diff({ kitRoot: KIT_ROOT, consumerRoot, owned });
    printPlan(r);
    p.outro('Dry run — nothing written. Run `update` to apply.');
  } else if (cmd === 'update') {
    const decide = (action, path) => decideUpdate(action, path, yes);
    const releaseIdentities = await readUpdateRelease();
    const r = await update({
      kitRoot: KIT_ROOT, consumerRoot, now: stamp(), decide, releaseIdentities,
    });
    printPlan(r);
    for (const c of r.conflicts) p.note(c.diff || '(binary/!text)', `conflict (not applied): ${c.path}`);
    if (r.state === 'failed') throw new Error(renderUpdateFailure(r));
    if (r.state === 'conflicted') {
      p.note(r.report.recommendation, 'recommendation');
      p.outro(`not applied · conflicts ${r.conflicts.length}`);
      process.exitCode = 2;
    } else if (r.status === 'current') {
      p.outro(`aktuell · unchanged ${r.unchanged.length} · local modifications ${r.userModified.length}`);
    } else {
      p.outro(`updated ${r.updated.length} · added ${r.added.length} · deleted ${r.deleted.length}`);
    }
  } else if (cmd === 'uninstall') {
    const ok = yes || (await p.confirm({ message: 'Remove kit-installed files?' })) === true;
    if (!ok) { p.cancel('Aborted.'); process.exit(0); }
    const r = await uninstall({ consumerRoot });
    p.outro(`removed ${r.removed.length} · retained (edited/referenced) ${r.retained.length}`);
  } else if (cmd === 'own' || cmd === 'disown') {
    if (!args[1]) throw new Error(`Usage: agent-workflow-kit ${cmd} <path>`);
    const origin = cmd === 'own' ? CONSUMER_ORIGIN : KIT_ORIGIN;
    await setOwnership({ consumerRoot, path: args[1], origin });
    p.outro(`${args[1]} is now ${origin}-owned`);
  } else {
    p.note('Usage: agent-workflow-kit <init|update|diff|uninstall|own|disown> [<path>] [--force] [--yes] [--owned]');
    p.outro('');
  }
} catch (err) {
  p.cancel(`Error: ${err.message}`);
  process.exit(1);
}

function printPlan(r) {
  const lines = [];
  for (const k of [
    'added', 'updated', 'userModified', 'consumerOwned', 'unchanged',
    'deleted', 'keptDeleted', 'collisions',
  ])
    if (r[k]?.length) lines.push(`${k}: ${r[k].length}`);
  if (r.conflicts?.length) lines.push(`conflicts: ${r.conflicts.length}`);
  if (r.availability) {
    for (const [key, label] of [
      ['newlyAvailable', 'newly available'], ['newlyDegraded', 'newly degraded'],
      ['newlyBlocked', 'newly blocked'], ['stillUnresolved', 'still unresolved'],
    ]) {
      lines.push(`${label}: ${r.availability[key].join(', ') || 'none'}`);
    }
  }
  for (const owned of r.ownedDiffs ?? []) {
    lines.push(`${owned.state} ${owned.path}`);
    if (owned.binary) {
      lines.push(`  local: ${owned.local.size} bytes sha256:${owned.local.sha256}`);
      lines.push(`  upstream: ${owned.upstream.size} bytes sha256:${owned.upstream.sha256}`);
    } else if (owned.diff) {
      lines.push(owned.diff);
    }
  }
  p.note(lines.join('\n') || 'no changes', 'plan');
}

async function decideUpdate(action, path, yes) {
  if (action === 'delete') {
    if (yes) return true;
    return (await p.confirm({ message: `Upstream removed ${path} — delete it locally?` })) === true;
  }
  if (action === 'collision') {
    if (yes) return 'replace';
    const choice = await p.select({
      message: `${path} already exists but is not tracked. Choose its ownership:`,
      options: [
        { value: 'keep-as-owned', label: 'Keep existing file as consumer-owned' },
        { value: 'replace', label: 'Replace with kit file' },
      ],
    });
    if (p.isCancel(choice)) throw new Error(`collision decision cancelled for ${path}`);
    return choice;
  }
  throw new Error(`unknown update decision action: ${action}`);
}

async function readUpdateRelease() {
  const adapter = await createCommandAdapter({
    repoRoot: KIT_ROOT,
    env: { ...process.env, GH_REPO: 'iKon85/agent-workflow-kit' },
  });
  try {
    // Re-packing an unpacked install is never byte-identical to the registry
    // tarball — the installed copy proves itself by content identity instead.
    const installed = await installedIdentityFromDir(KIT_ROOT);
    return { installed, npm: await adapter.npm(installed), github: await adapter.github(installed) };
  } finally {
    await adapter.dispose();
  }
}
