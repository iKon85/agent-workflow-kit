#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as p from '@clack/prompts';
import { init } from './commands/init.mjs';
import { renderUpdateFailure, update } from './commands/update.mjs';
import { diff } from './commands/diff.mjs';
import { uninstall } from './commands/uninstall.mjs';
import { setOwnership } from './commands/own.mjs';
import {
  beginContributionBridge, prepareContributionArtifact,
} from './lib/contributionBridge.mjs';
import {
  inspectContributionRouting,
} from './lib/contributionRouting.mjs';
import { CONSUMER_ORIGIN, KIT_ORIGIN } from './lib/manifest.mjs';
import { nonInteractiveUpdateDecision } from './lib/updateDecisions.mjs';
import { currentAgentSurface } from './lib/agentSurfaceRegistry.mjs';
import { createCommandAdapter } from '../scripts/release-state.mjs';
import { installedIdentityFromDir } from '../scripts/release-parity.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function stamp() {
  // backup suffix: YYYYMMDDTHHMMSS (no separators that collide with shells)
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
}

export async function runCli({
  argv = process.argv.slice(2),
  kitRoot = KIT_ROOT,
  consumerRoot = process.cwd(),
  hasTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  readUpdateRelease: releaseReader = readUpdateRelease,
  updateCommand = update,
} = {}) {
  const args = argv;
  const cmd = args[0];
  const force = args.includes('--force');
  const yes = args.includes('--yes') || args.includes('-y');
  const owned = args.includes('--owned');
  const keepDeleted = args.includes('--keep-deleted');
  const restoreDeleted = args.includes('--restore-deleted');
  const ownershipState = args.find((arg) => arg.startsWith('--as='))?.slice('--as='.length);
  let exitCode = 0;

  if (cmd === 'update' && keepDeleted && restoreDeleted) {
    process.stderr.write('Error: --keep-deleted and --restore-deleted are mutually exclusive.\n');
    return 1;
  }
  if (cmd === 'update' && !hasTTY && !yes) {
    process.stderr.write(
      'Error: interactive prompts need a TTY. For non-interactive update, pass --yes '
      + 'and optionally --keep-deleted or --restore-deleted.\n',
    );
    return 1;
  }

  p.intro('agent-workflow-kit');

  try {
  if (cmd === 'init') {
    const r = await init({
      kitRoot,
      consumerRoot,
      force,
      routingProfile: routingProfileOptions(yes),
    });
    p.note(
      `copied ${r.copied.length} · seeded ${r.seeded.length} stub(s)` +
        (r.skipped.length ? `\nskipped (pre-existing, use --force): ${r.skipped.join(', ')}` : ''),
      'init'
    );
    printRoutingProfile(r.routingProfile);
    p.outro('Next: run /setup-workflow to fill the project layer + board profile. ' +
      'To enable the drift-guard hook, add .claude/hooks/drift-guard.py to your settings.json hooks.');
  } else if (cmd === 'diff') {
    const r = await diff({ kitRoot, consumerRoot, owned });
    printPlan(r);
    p.outro('Dry run — nothing written. Run `update` to apply.');
  } else if (cmd === 'update') {
    const decide = (action, path, classification) => (
      decideUpdate(action, path, yes, classification, {
        deleted: keepDeleted ? 'keep' : restoreDeleted ? 'restore' : undefined,
      })
    );
    const releaseIdentities = await releaseReader();
    const r = await updateCommand({
      kitRoot,
      consumerRoot,
      now: stamp(),
      decide,
      releaseIdentities,
      routingProfile: routingProfileOptions(yes),
    });
    printPlan(r);
    printRoutingProfile(r.routingProfile);
    for (const c of r.conflicts) p.note(c.diff || '(binary/!text)', `conflict (not applied): ${c.path}`);
    if (r.state === 'failed') throw new Error(renderUpdateFailure(r));
    if (r.state === 'conflicted') {
      p.note(r.report.recommendation, 'recommendation');
      p.outro(
        `not applied · conflicts ${r.conflicts.length} · ` +
        `ownership collisions ${r.collisions.length}`,
      );
      exitCode = 2;
    } else if (r.status === 'current') {
      p.outro(`aktuell · unchanged ${r.unchanged.length} · local modifications ${r.userModified.length}`);
    } else {
      p.outro(`updated ${r.updated.length} · added ${r.added.length} · migrated ${r.migrated?.length ?? 0} · deleted ${r.deleted.length}`);
    }
  } else if (cmd === 'uninstall') {
    const ok = yes || (await p.confirm({ message: 'Remove kit-installed files?' })) === true;
    if (!ok) { p.cancel('Aborted.'); return 0; }
    const r = await uninstall({ consumerRoot });
    p.outro(`removed ${r.removed.length} · retained (edited/referenced) ${r.retained.length}`);
  } else if (cmd === 'contribute') {
    const action = args[1];
    const path = args[2];
    if (!['start', 'status', 'prepare'].includes(action) || !path) {
      throw new Error(
        'Usage: agent-workflow-kit contribute <start|status|prepare> <path> ' +
        '[--surface=retro|pre-update|guard] ' +
        '[--output=.agent-workflow-kit/contributions/<name>.json]',
      );
    }
    if (action === 'start') {
      await beginContributionBridge({ kitRoot, consumerRoot, path });
      p.outro(`${path} is now a contribution bridge; no remote was changed`);
    } else if (action === 'status') {
      const surface = args.find((arg) => arg.startsWith('--surface='))
        ?.slice('--surface='.length) ?? 'guard';
      const routing = await inspectContributionRouting({
        consumerRoot, path, surface,
      });
      p.note(
        [
          `lifecycle: ${routing.lifecycleState}`,
          `capability: ${routing.capabilityState}`,
          `routes: ${routing.routes.map(({ id }) => id).join(', ')}`,
          ...(routing.diagnostic ? [`diagnostic: ${routing.diagnostic}`] : []),
        ].join('\n'),
        `contribution routing (${routing.surface})`,
      );
      p.outro('read-only routing report; no local or remote state changed');
    } else {
      const output = args.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
      if (!output) throw new Error('contribute prepare requires --output=<path>');
      const routing = await inspectContributionRouting({
        consumerRoot, path, surface: 'guard',
      });
      if (!routing.routes.some(({ id }) => id === 'prepare-local')) {
        throw new Error(
          `local contribution preparation is unavailable: ${routing.capabilityState}` +
          (routing.diagnostic ? ` (${routing.diagnostic})` : ''),
        );
      }
      await prepareContributionArtifact({
        kitRoot, consumerRoot, path, output,
      });
      p.outro(`prepared local contribution artifact ${output}; no remote was changed`);
    }
  } else if (cmd === 'own' || cmd === 'disown') {
    if (!args[1]) {
      throw new Error(
        `Usage: agent-workflow-kit ${cmd} <path>` +
        (cmd === 'own' ? ' [--as=explicit-fork]' : ''),
      );
    }
    const origin = cmd === 'own' ? CONSUMER_ORIGIN : KIT_ORIGIN;
    if (origin === CONSUMER_ORIGIN && ownershipState === 'contribution-bridge') {
      await beginContributionBridge({ kitRoot, consumerRoot, path: args[1] });
    } else {
      await setOwnership({ consumerRoot, path: args[1], origin, ownershipState });
    }
    p.outro(`${args[1]} is now ${origin}-owned` +
      (origin === CONSUMER_ORIGIN ? ` (${ownershipState ?? 'explicit-fork'})` : ''));
  } else {
    p.note('Usage: agent-workflow-kit <init|update|diff|uninstall|own|disown|contribute> ' +
      '[<path>] [--force] [--yes] [--keep-deleted|--restore-deleted] [--owned] ' +
      '[--as=contribution-bridge|explicit-fork]');
    p.outro('');
  }
} catch (err) {
  p.cancel(`Error: ${err.message}`);
  return 1;
}
  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runCli();
}

function printPlan(r) {
  const lines = [];
  for (const k of [
    'added', 'updated', 'userModified', 'consumerOwned', 'unchanged',
    'deleted', 'keptDeleted', 'collisions', 'migrated',
    'bridgeRetired',
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

async function decideUpdate(action, path, yes, classification, choices = {}) {
  if (yes) return nonInteractiveUpdateDecision(action, choices);
  if (action === 'delete') {
    return (await p.confirm({ message: `Upstream removed ${path} — delete it locally?` })) === true;
  }
  if (action === 'collision') {
    const choice = await p.select({
      message: `${path} exists without ownership evidence. Choose an explicit route:`,
      options: [
        ...(classification?.state === 'project-extension'
          ? [{ value: 'project-extension', label: 'Keep as declared Project extension' }]
          : []),
        { value: 'contribution-bridge', label: 'Keep as temporary contribution bridge' },
        { value: 'explicit-fork', label: 'Keep as explicit fork' },
        { value: 'replace', label: 'Replace explicitly with Kit Core' },
      ],
    });
    if (p.isCancel(choice)) throw new Error(`collision decision cancelled for ${path}`);
    return choice;
  }
  throw new Error(`unknown update decision action: ${action}`);
}

function routingProfileOptions(yes) {
  return {
    currentSurface: currentAgentSurface(),
    prompt: yes ? undefined : promptRoutingProfile,
  };
}

function printRoutingProfile(result) {
  if (!result) return;
  const suffix = result.reasons?.length ? ` · ${result.reasons.join(', ')}` : '';
  p.note(`${result.status}${suffix}`, 'routing profile');
}

async function promptRoutingProfile(question) {
  if (question.kind === 'surfaces') {
    return ensurePrompt(await p.multiselect({
      message: question.message,
      options: question.options.map(({ id, label }) => ({ value: id, label })),
      initialValues: question.preselected,
      required: true,
    }), 'surface selection');
  }
  if (question.kind === 'autonomy') {
    return ensurePrompt(await p.select({
      message: question.message,
      options: question.options,
    }), 'switching choice');
  }
  if (question.kind === 'activation') {
    const draft = question.advancedDraft ? ' · advanced draft ready' : '';
    return ensurePrompt(await p.select({
      message: `${question.message}${draft}`,
      options: [
        { value: 'approve', label: 'Approve' },
        { value: 'safe-current-surface', label: 'Safe current surface' },
        { value: 'back', label: 'Back' },
        { value: 'advanced', label: 'Advanced' },
        { value: 'decline', label: 'Decline' },
      ],
    }), 'activation choice');
  }
  if (question.kind === 'advanced') {
    const optimization = ensurePrompt(await p.select({
      message: question.message,
      options: [
        { value: 'balanced', label: 'Balanced' },
        { value: 'quality', label: 'Quality' },
        { value: 'cost', label: 'Cost' },
      ],
      initialValue: question.draft?.optimization ?? 'balanced',
    }), 'advanced choice');
    return { ...question.draft, optimization };
  }
  if (question.kind === 'reconcile') {
    if (question.delta.type === 'missing-profile' || question.delta.type === 'invalid-profile') {
      return ensurePrompt(await p.select({
        message: question.message,
        options: [
          { value: 'review', label: 'Review routing choices now' },
          { value: 'decline', label: 'Not now' },
        ],
      }), 'routing migration choice');
    }
    const additions = question.delta.newSurfaces;
    if (additions.length) {
      const removed = question.delta.removedSurfaces.map(({ label }) => label);
      const change = [
        `new: ${additions.map(({ label }) => label).join(', ')}`,
        ...(removed.length ? [`unavailable: ${removed.join(', ')}`] : []),
      ].join(' · ');
      const addSurfaceIds = ensurePrompt(await p.multiselect({
        message: `Routing choices changed — ${change}`,
        options: additions.map(({ id, label }) => ({ value: id, label })),
        initialValues: [],
        required: false,
      }), 'routing reconcile choice');
      return { action: 'apply', addSurfaceIds };
    }
    const removed = question.delta.removedSurfaces.map(({ label }) => label).join(', ');
    const message = removed
      ? `Remove unavailable agent app from routing: ${removed}?`
      : 'Refresh the routing profile registry revision?';
    return ensurePrompt(await p.confirm({ message }), 'routing reconcile choice')
      ? { action: 'apply', addSurfaceIds: [] }
      : { action: 'decline' };
  }
  throw new Error(`unknown routing profile question: ${question.kind}`);
}

function ensurePrompt(value, label) {
  if (p.isCancel(value)) throw new Error(`${label} cancelled`);
  return value;
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
