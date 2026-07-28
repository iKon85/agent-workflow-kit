#!/usr/bin/env node
import { realpathSync } from 'node:fs';
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
import { sanitizeReadinessText } from './lib/updateCandidate.mjs';
import { renderRequiredMigration } from './lib/consumerMigrations.mjs';
import { currentAgentSurface, surfaceById } from './lib/agentSurfaceRegistry.mjs';
import { routingProfilePath } from './lib/routingProfile.mjs';
import { createCommandAdapter } from '../scripts/release-state.mjs';
import { installedIdentityFromDir } from '../scripts/release-parity.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Declared before the self-invocation below: `runCli` renders the plan during
// module evaluation, so a later `const` would be in its temporal dead zone.
const READINESS_STATE_PHRASE = {
  missing: 'not configured yet',
  pending: 'deferred as pending',
  invalid: 'present but not valid',
  'not-applicable': 'recorded as not applicable',
};

// Declared here for the same reason: `promptRoutingProfile` runs inside
// `runCli`, i.e. during module evaluation, so these tables must be initialized
// before the self-invocation below.

/** What choosing an option means, per routing prompt. */
const ROUTING_HINTS = {
  autonomy: {
    automatic: 'the Kit may move a task to another selected app on its own',
    ask: 'the Kit proposes a switch and waits for your confirmation',
    'current-surface-only': 'every task stays in the app it started in',
  },
  activation: {
    approve: 'store this routing profile exactly as summarized above',
    'safe-current-surface': 'store it, but keep every task in the current app',
    back: 'answer the app and switching questions again',
    advanced: 'add optional preferences to the draft before anything is stored',
    decline: 'store nothing; the Kit asks again on the next update',
  },
  advanced: {
    balanced: 'note a preference for a balance of quality and cost',
    quality: 'note a preference for the strongest model even when it costs more',
    cost: 'note a preference for the cheaper model when it can do the job',
  },
  reconcile: {
    review: 'answer the routing questions now and store an updated profile',
    decline: 'change nothing now; the Kit asks again on the next update',
  },
};

/** Option labels the routing question does not carry itself. */
const ROUTING_LABELS = {
  activation: {
    approve: 'Approve',
    'safe-current-surface': 'Safe current surface',
    back: 'Back',
    advanced: 'Advanced',
    decline: 'Decline',
  },
  advanced: { balanced: 'Balanced', quality: 'Quality', cost: 'Cost' },
  reconcile: { review: 'Review routing choices now', decline: 'Not now' },
};

const ADVANCED_OPTIMIZATIONS = ['balanced', 'quality', 'cost'];
const RECONCILE_MIGRATION_ACTIONS = ['review', 'decline'];
/** The answer that nominates no Standard route for a workload class. */
const NO_STANDARD_ROUTE = 'none';

const ROUTING_PAYLOADS = {
  surfaces: surfacesPayload,
  transports: transportsPayload,
  autonomy: autonomyPayload,
  roster: rosterPayload,
  'standard-route': standardRoutePayload,
  activation: activationPayload,
  advanced: advancedPayload,
  reconcile: reconcilePayload,
};

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
  // Machine-readable rendering of the same update record the interactive run prints.
  const jsonReport = cmd === 'update' && args.includes('--json');
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

  if (!jsonReport) p.intro('agent-workflow-kit');

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
    printRoutingProfile(r.routingProfile, consumerRoot);
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
    if (jsonReport) {
      process.stdout.write(`${JSON.stringify(updateDocument(r), null, 2)}\n`);
      if (r.state === 'failed') return 1;
      return r.state === 'conflicted' ? 2 : 0;
    }
    printPlan(r);
    printRoutingProfile(r.routingProfile, consumerRoot);
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
  if (jsonReport) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: UPDATE_DOCUMENT_SCHEMA_VERSION, state: 'failed', error: err.message,
    }, null, 2)}\n`);
    return 1;
  }
  p.cancel(`Error: ${err.message}`);
  return 1;
}
  return exitCode;
}

const UPDATE_DOCUMENT_SCHEMA_VERSION = 1;

/** The single structured update record; `printPlan` renders the same source. */
function updateDocument(r) {
  return {
    schemaVersion: UPDATE_DOCUMENT_SCHEMA_VERSION,
    state: r.state,
    status: r.status ?? null,
    report: r.report,
    ...(r.error ? { error: renderUpdateFailure(r) } : {}),
  };
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
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
      ['newlyBlocked', 'newly blocked'],
    ]) {
      lines.push(`${label}: ${r.availability[key].join(', ') || 'none'}`);
    }
    lines.push(...renderReadinessAvailability(r.availability));
  }
  for (const action of r.requiredMigrations ?? []) {
    lines.push(renderRequiredMigration(action));
    lines.push(`  ${action.consequence} ${action.remediation}`);
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

/**
 * Render unresolved readiness in plain terms — one sentence naming the
 * capability and its state, one next step. Every line comes from the readiness
 * catalog, so a new capability reads correctly without a code change; the
 * legacy `capability:state` list stays the fallback for an older record.
 */
export function renderReadinessAvailability(availability) {
  const entries = availability?.unresolved;
  if (!Array.isArray(entries) || !entries.length) {
    return [`still unresolved: ${availability?.stillUnresolved?.join(', ') || 'none'}`];
  }
  const lines = ['still unresolved:'];
  for (const entry of entries) {
    const subject = sanitizeReadinessText(entry.title) ?? entry.capability;
    const phrase = READINESS_STATE_PHRASE[entry.state] ?? entry.state;
    const evidence = (entry.evidencePaths ?? [])
      .map(sanitizeReadinessText).filter(Boolean).join(', ');
    lines.push(`  ${subject} is ${phrase}${evidence ? ` (evidence: ${evidence})` : ''}.`);
    const remedy = sanitizeReadinessText(entry.remedy);
    if (remedy) lines.push(`    next step: ${remedy}`);
  }
  return lines;
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

function printRoutingProfile(result, consumerRoot) {
  const note = routingResultNote(result, consumerRoot);
  if (note) p.note(note, 'routing profile');
}

/**
 * The routing outcome in the terms a user can act on: what was decided, why,
 * which profile it produced, and the user-local file that now holds it.
 */
export function routingResultNote(result, consumerRoot, profileRoot) {
  if (!result) return null;
  const lines = [`status: ${result.status}`];
  if (result.reasons?.length) lines.push(`reasons: ${result.reasons.join(', ')}`);
  if (result.profile) {
    lines.push(`agent apps: ${surfaceLabels(result.profile.selectedSurfaces)}`);
    lines.push(`transports: ${describeTransports(result.profile.authorizedTransports)}`);
    lines.push(`switching: ${describeSwitching(result.profile.switching)}`);
    lines.push(`model roster: ${describeRoster(result.profile.roster)}`);
    lines.push(`standard routes: ${describeStandardRoutes(result.profile.standardRoutes)}`);
  }
  lines.push(`profile file: ${routingProfilePath(consumerRoot, profileRoot)}`);
  return lines.join('\n');
}

/**
 * The exact payload a routing question renders as — every option carries a
 * hint saying what choosing it means, so no prompt asks a user to guess.
 */
export function routingPromptPayload(question) {
  const build = ROUTING_PAYLOADS[question?.kind];
  if (!build) throw new Error(`unknown routing profile question: ${question?.kind}`);
  return build(question);
}

/** An option the Kit cannot explain is a bug, not a silently bare label. */
function hintedOptions(kind, options) {
  return options.map(({ value, label }) => {
    const hint = ROUTING_HINTS[kind]?.[value];
    if (!hint) throw new Error(`missing routing prompt hint: ${kind}.${value}`);
    return { value, label: label ?? value, hint };
  });
}

function labelledOptions(kind, values) {
  return values.map((value) => ({ value, label: ROUTING_LABELS[kind]?.[value] ?? value }));
}

function surfacesPayload(question) {
  const preselected = new Set(question.preselected ?? []);
  return {
    control: 'multiselect',
    label: 'surface selection',
    message: question.message,
    options: question.options.map(({ id, label }) => ({
      value: id,
      label,
      hint: preselected.has(id)
        ? `preselected — selecting it lets the Kit route work to ${label}`
        : `not preselected — select it only if you actually use ${label}`,
    })),
    initialValues: question.preselected,
    required: true,
  };
}

function autonomyPayload(question) {
  return {
    control: 'select',
    label: 'switching choice',
    message: question.message,
    options: hintedOptions('autonomy', question.options ?? []),
  };
}

/** Prompt-side identity for a `(surface, transport)` authorization. */
const transportValue = ({ surface, transport }) => `${surface}/${transport}`;
/** Prompt-side identity for a model-and-effort pair; the label is the readable half. */
const pairValue = ({ model, effort }) => `${model}/${effort ?? ''}`;
const pairText = ({ model, effort }) => sanitizeReadinessText(
  `${model} · ${effort ?? 'no effort axis'}`,
) ?? model;

/**
 * Authorizing an app is not authorizing it to drive another app's command line,
 * so every transport says which of the two it is.
 */
function transportsPayload(question) {
  const preselected = new Set((question.preselected ?? []).map(transportValue));
  const options = (question.options ?? []).map((option) => {
    const app = sanitizeReadinessText(option.surfaceLabel) ?? option.surface;
    return {
      value: transportValue(option),
      label: `${app} · ${option.transport}`,
      hint: option.native
        ? `${app} may drive its own runtime`
        : `lets ${app} drive the ${option.transport} command line — selecting the app does not`,
    };
  });
  return {
    control: 'multiselect',
    label: 'transport authorization',
    message: question.message,
    options,
    initialValues: options.filter(({ value }) => preselected.has(value)).map(({ value }) => value),
    required: false,
  };
}

/**
 * The inventory can list dozens of pairs, so the roster question is grouped per
 * agent app — detected apps first — and says how much it is showing. It also
 * says what leaving a pair out means, because that answer is durable.
 */
function rosterPayload(question) {
  const groups = question.groups ?? [];
  const options = {};
  for (const group of groups) {
    const app = sanitizeReadinessText(group.label) ?? group.surface;
    options[app] = group.pairs.map((pair) => ({
      value: pairValue(pair),
      label: pairText(pair),
      hint: group.detected
        ? `${app} is installed here — selecting the pair authorizes it`
        : `${app} is not installed here — authorizing it is still your choice`,
    }));
  }
  return {
    control: 'groupmultiselect',
    label: 'roster choice',
    message: `${question.message} (${question.total} pairs across ${groups.length} agent apps; `
      + 'a pair you leave out is recorded as declined and is not asked again)',
    options,
    initialValues: (question.preselected ?? []).map(pairValue),
    required: false,
  };
}

function standardRoutePayload(question) {
  const options = (question.options ?? []).map((pair) => ({
    value: pairValue(pair),
    label: pairText(pair),
    hint: `${question.workload} work uses this pair when no evidence covers the intent`,
  }));
  options.push({
    value: NO_STANDARD_ROUTE,
    label: 'Leave unset',
    hint: `no Standard route for ${question.workload} work — the class blocks instead of guessing`,
  });
  return {
    control: 'select',
    label: 'standard route choice',
    message: question.message,
    options,
    initialValue: question.current ? pairValue(question.current) : NO_STANDARD_ROUTE,
    maxItems: question.pageSize,
  };
}

function activationPayload(question) {
  return {
    control: 'select',
    label: 'activation choice',
    message: `${question.message}\n${activationSummary(question)}`,
    options: hintedOptions('activation', labelledOptions('activation', question.actions ?? [])),
  };
}

/** What the activation review is actually reviewing. */
function activationSummary(question) {
  return [
    `agent apps: ${surfaceLabels(question.selectedSurfaces)}`,
    `transports: ${describeTransports(question.authorizedTransports)}`,
    `switching: ${describeSwitching(question.switching)}`,
    `model roster: ${describeRoster(question.roster)}`,
    `standard routes: ${describeStandardRoutes(question.standardRoutes)}`,
    `advanced draft: ${describeDraft(question.advancedDraft)}`,
  ].join('\n');
}

function describeTransports(transports) {
  const rendered = (transports ?? []).map(({ surface, transport }) =>
    `${sanitizeReadinessText(surfaceById(surface)?.label ?? surface) ?? surface} · ${transport}`);
  return sanitizeReadinessText(rendered.join(', ')) || 'none';
}

function describeRoster(roster) {
  if (!Array.isArray(roster) || !roster.length) return 'none';
  const counted = ['admitted', 'declined', 'withdrawn']
    .map((state) => [state, roster.filter((entry) => entry.state === state).length])
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${state}`);
  return counted.join(' · ') || 'none';
}

function describeStandardRoutes(routes) {
  if (!routes || typeof routes !== 'object') return 'none';
  const rendered = Object.entries(routes).map(([workload, entry]) => {
    if (!entry) return `${workload}: unset`;
    return `${workload}: ${pairText(entry)}${entry.state === 'unresolved' ? ' (unresolved)' : ''}`;
  });
  return sanitizeReadinessText(rendered.join(' · ')) || 'none';
}

function surfaceLabels(ids) {
  const labels = (ids ?? [])
    .map((id) => sanitizeReadinessText(surfaceById(id)?.label ?? id))
    .filter(Boolean);
  return labels.join(', ') || 'none';
}

function describeSwitching(value) {
  const name = sanitizeReadinessText(value) ?? 'unknown';
  const hint = ROUTING_HINTS.autonomy[value];
  return hint ? `${name} — ${hint}` : name;
}

function describeDraft(draft) {
  if (!draft || typeof draft !== 'object') return 'none';
  const rendered = Object.entries(draft)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' · ');
  return sanitizeReadinessText(rendered) ?? 'none';
}

function advancedPayload(question) {
  return {
    control: 'select',
    label: 'advanced choice',
    message: `${question.message} — kept as an optional note`,
    options: hintedOptions('advanced', labelledOptions('advanced', ADVANCED_OPTIMIZATIONS)),
    initialValue: question.draft?.optimization ?? 'balanced',
  };
}

/** What the roster and the Standard routes still owe an answer on, if anything. */
function rosterWork(delta) {
  const roster = delta.roster ?? {};
  return ['pending', 'withdrawn', 'reopenable', 'unresolvedRoutes']
    .some((key) => (roster[key] ?? []).length > 0);
}

function reconcilePayload(question) {
  const delta = question.delta;
  if (delta.type === 'missing-profile' || delta.type === 'invalid-profile') {
    return {
      control: 'select',
      label: 'routing migration choice',
      message: question.message,
      options: hintedOptions(
        'reconcile', labelledOptions('reconcile', RECONCILE_MIGRATION_ACTIONS),
      ),
    };
  }
  if (delta.newSurfaces.length) return reconcileAdditionsPayload(delta);
  const removed = delta.removedSurfaces.map(({ label }) => label).join(', ');
  if (!removed && rosterWork(delta)) return reconcileRosterPayload(question, delta);
  return {
    control: 'confirm',
    label: 'routing reconcile choice',
    message: removed
      ? `Remove unavailable agent app from routing: ${removed}?`
      : 'Refresh the routing profile registry revision?',
    active: 'Apply the change to the stored routing profile',
    inactive: 'Leave the stored routing profile as it is',
  };
}

/** A roster-only change names what moved before it asks whether to review it. */
function reconcileRosterPayload(question, delta) {
  const roster = delta.roster ?? {};
  const change = [
    ['new pairs', roster.pending], ['pairs no longer offered', roster.withdrawn],
    ['pairs available again', roster.reopenable],
  ].filter(([, pairs]) => (pairs ?? []).length)
    .map(([label, pairs]) => `${label}: ${pairs.map(pairText).join(', ')}`);
  for (const { workload } of roster.unresolvedRoutes ?? []) {
    change.push(`${workload} has no authorized Standard route any more`);
  }
  return {
    control: 'select',
    label: 'routing roster choice',
    // Sanitized per line: collapsing the whole block would flatten the list.
    message: [question.message, ...change.map(sanitizeReadinessText).filter(Boolean)].join('\n'),
    options: hintedOptions('reconcile', labelledOptions('reconcile', RECONCILE_MIGRATION_ACTIONS)),
  };
}

function reconcileAdditionsPayload(delta) {
  const removed = delta.removedSurfaces.map(({ label }) => label);
  const change = [
    `new: ${delta.newSurfaces.map(({ label }) => label).join(', ')}`,
    ...(removed.length ? [`unavailable: ${removed.join(', ')}`] : []),
  ].join(' · ');
  return {
    control: 'multiselect',
    label: 'routing reconcile choice',
    message: `Routing choices changed — ${change}`,
    options: delta.newSurfaces.map(({ id, label }) => ({
      value: id,
      label,
      hint: `newly available — select it to let the Kit route work to ${label}`,
    })),
    initialValues: [],
    required: false,
  };
}

async function promptRoutingProfile(question) {
  const { control, label, ...payload } = routingPromptPayload(question);
  const answer = ensurePrompt(await askRouting(control, payload), label);
  return decodeRoutingAnswer(question, answer);
}

function askRouting(control, payload) {
  if (control === 'multiselect') return p.multiselect(payload);
  if (control === 'groupmultiselect') return p.groupMultiselect(payload);
  if (control === 'confirm') return p.confirm(payload);
  return p.select(payload);
}

/** Map prompt values back onto the very objects the question offered. */
function decodeSelected(offered, identity, answer) {
  const known = new Map(offered.map((option) => [identity(option), option]));
  return (Array.isArray(answer) ? answer : [answer])
    .map((value) => known.get(value))
    .filter(Boolean);
}

/** The answer shape `routingProfile` expects back, per question. */
function decodeRoutingAnswer(question, answer) {
  if (question.kind === 'advanced') return { ...question.draft, optimization: answer };
  if (question.kind === 'transports') {
    return decodeSelected(question.options ?? [], transportValue, answer)
      .map(({ surface, transport }) => ({ surface, transport }));
  }
  if (question.kind === 'roster') {
    const pairs = (question.groups ?? []).flatMap(({ pairs: group }) => group);
    return decodeSelected(pairs, pairValue, answer);
  }
  if (question.kind === 'standard-route') {
    return decodeSelected(question.options ?? [], pairValue, answer)[0] ?? null;
  }
  if (question.kind !== 'reconcile') return answer;
  const delta = question.delta;
  if (delta.type === 'missing-profile' || delta.type === 'invalid-profile') return answer;
  if (delta.newSurfaces.length) return { action: 'apply', addSurfaceIds: answer };
  if (!delta.removedSurfaces.length && rosterWork(delta)) {
    return answer === 'review' ? { action: 'apply', addSurfaceIds: [] } : { action: 'decline' };
  }
  return answer === true ? { action: 'apply', addSurfaceIds: [] } : { action: 'decline' };
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
