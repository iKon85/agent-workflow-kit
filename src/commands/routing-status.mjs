/**
 * `routing status` — what would be dispatched for one Routing intent, and why.
 *
 * The command answers a question; it never dispatches and never writes a routing
 * document. It composes the Routing profile, derives the Routing policy, reads
 * the Access graph and the Evidence catalog, and resolves the Route decision the
 * dispatcher would resolve — so a human and a skill read the same answer.
 *
 * Two facts stay separate in the output, because they answer different
 * questions: the Evidence catalog's `bestOverall` says which model the evidence
 * ranks first, and `bestExecutable` says what this machine could actually run
 * right now. A pick is either evidence-backed or a Standard route, and the
 * document says which, so nothing reads as evidence that is not.
 *
 * The surface is attested by the environment, never guessed. An explicit
 * `--surface` fills the gap when no attestation identifies the surface, and a
 * conflict between the two is rejected rather than resolved in either direction:
 * preferring one would silently answer for a surface the caller is not on.
 *
 * Every outcome has its own exit code and every diagnostic is redacted, so a
 * skill can branch on the code and a terminal never learns where a user's files
 * live.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AGENT_SURFACE_REGISTRY, currentAgentSurface, surfaceById,
} from '../lib/agentSurfaceRegistry.mjs';
import { readAccessGraphDocument } from '../lib/routingAccessGraphStore.mjs';
import { validateEvidenceCatalog } from '../lib/routingCatalog.mjs';
import { parseRoutingIntent } from '../lib/routingIntent.mjs';
import { readComposedRoutingProfile, routingProfileStorageRoot } from '../lib/routingProfile.mjs';
import { deriveRoutingPolicy } from '../lib/routingProfilePolicy.mjs';
import {
  ROUTE_DECISION_ORIGINS, ROUTE_DECISION_STATES, resolveRoute,
} from '../lib/routingResolver.mjs';
import { sanitizeReadinessText } from '../lib/safeText.mjs';

export const ROUTING_STATUS_DOCUMENT_VERSION = 1;

/** Where the two routing documents this command reads live, beside the profile. */
export const ACCESS_GRAPH_FILE = 'access-graph.json';
export const EVIDENCE_CATALOG_FILE = 'evidence-catalog.json';

const INVALID_REQUEST = 'invalid-request';

/**
 * One code per outcome, stable across runs: a skill branches on the number.
 * Every Route decision state keeps its own code — a pending decision is not a
 * blocked one — plus a rejected request and an internal failure.
 */
export const ROUTING_STATUS_EXIT_CODES = Object.freeze({
  ready: 0,
  [INVALID_REQUEST]: 1,
  blocked: 2,
  'approval-required': 3,
  'verification-required': 4,
  failed: 5,
});

/** What one origin means, in the words the output uses. */
const ROUTE_ORIGINS = Object.freeze({
  evidence: Object.freeze({ label: 'evidence-backed', evidenceBacked: true }),
  standard: Object.freeze({ label: 'standard route', evidenceBacked: false }),
});

export function routingStatusExitCode(outcome) {
  const code = ROUTING_STATUS_EXIT_CODES[outcome];
  if (code === undefined) throw new TypeError(`unknown routing status outcome: ${outcome}`);
  return code;
}

export function routeOrigin(origin) {
  if (origin === null || origin === undefined) return { label: 'no route', evidenceBacked: false };
  const known = ROUTE_ORIGINS[origin];
  if (!known) throw new TypeError(`unknown route decision origin: ${origin}`);
  return known;
}

// A resolver that grows a state or an origin must be given a code and a label
// here rather than falling through to a wrong exit code or a silent label.
for (const state of ROUTE_DECISION_STATES) routingStatusExitCode(state);
for (const origin of ROUTE_DECISION_ORIGINS) routeOrigin(origin);

/** Two or more path segments: the shape a filesystem path takes in a message. */
const PATH_LIKE = /(?:[A-Za-z]:)?(?:[\\/][\w.@+~%-]+){2,}/g;
const DIAGNOSTIC_LIMIT = 200;

/**
 * A diagnostic reaches a terminal and a skill's log verbatim, so it carries no
 * control characters, no filesystem location and no unbounded payload.
 */
export function redactDiagnostic(value) {
  const text = sanitizeReadinessText(value instanceof Error ? value.message : String(value ?? ''));
  if (!text) return 'no detail';
  return text.replace(PATH_LIKE, '<path>').slice(0, DIAGNOSTIC_LIMIT);
}

const diagnostic = (code, detail) => ({ code, detail: redactDiagnostic(detail) });

/** `--flag=value` and `--flag value` both name the same value. */
function flagValue(argv, name) {
  const inline = argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] ?? '' : null;
}

const knownTransports = (registry = AGENT_SURFACE_REGISTRY) =>
  [...new Set(registry.flatMap((surface) => surface.adapter.transports))];

const surfaceIds = (registry = AGENT_SURFACE_REGISTRY) => registry.map(({ id }) => id).join(', ');

/**
 * The surface the decision is resolved for. Attestation is evidence and an
 * explicit flag is a claim: the claim fills a gap, and a claim that contradicts
 * the evidence stops the run instead of overruling it either way.
 */
function resolveSurface(argv, env, diagnostics) {
  const attested = currentAgentSurface({ env }) ?? null;
  const explicit = flagValue(argv, 'surface');
  if (explicit !== null && !surfaceById(explicit)) {
    diagnostics.push(diagnostic('unknown-surface', `${explicit} is no known agent surface `
      + `(${surfaceIds()})`));
    return null;
  }
  if (explicit && attested && explicit !== attested) {
    diagnostics.push(diagnostic('surface-conflict', `--surface=${explicit} contradicts the `
      + `attested surface ${attested}`));
    return null;
  }
  if (attested) return { id: attested, source: 'attested' };
  if (explicit) return { id: explicit, source: 'explicit' };
  diagnostics.push(diagnostic('surface-required', 'no environment attestation identifies the '
    + `agent surface: pass --surface=<${surfaceIds()}>`));
  return null;
}

async function readIntent(file, diagnostics) {
  if (!file) {
    diagnostics.push(diagnostic('intent-file-required', 'pass --intent-file=<file> carrying a '
      + 'serialized Routing intent'));
    return null;
  }
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    diagnostics.push(diagnostic('intent-file-unreadable', `${file}: ${error.message}`));
    return null;
  }
  try {
    return parseRoutingIntent(text);
  } catch (error) {
    diagnostics.push(diagnostic('intent-file-invalid', `${file}: ${error.message}`));
    return null;
  }
}

/** A stored document that is simply not there yet is a state, not a failure. */
async function loadDocument({ file, name, read }, diagnostics) {
  try {
    const document = await read(file);
    if (document) return document;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      diagnostics.push(diagnostic(`${name}-unreadable`, `${file}: ${error.message}`));
      return null;
    }
  }
  diagnostics.push(diagnostic(`${name}-missing`, `no ${name} document is stored yet`));
  return null;
}

async function loadPolicy(options, diagnostics) {
  const { profileRoot, consumerRoot, identity, runGit } = options;
  try {
    const profile = await readComposedRoutingProfile({
      profileRoot, projectRoot: consumerRoot, identity, runGit,
    });
    if (!profile.composed) {
      diagnostics.push(diagnostic('routing-profile-missing', profile.reasons.join(', ')));
      return null;
    }
    return deriveRoutingPolicy({
      composed: profile.composed,
      globalGeneration: profile.global.generation,
      projectGeneration: profile.project?.generation ?? null,
    });
  } catch (error) {
    diagnostics.push(diagnostic('routing-profile-unusable', error.message));
    return null;
  }
}

/** Everything the resolver needs, each part missing on its own terms. */
async function loadRoutingWorld(options, diagnostics) {
  const storage = routingProfileStorageRoot(options.profileRoot);
  return {
    policy: await loadPolicy(options, diagnostics),
    accessGraph: await loadDocument({
      file: join(storage, ACCESS_GRAPH_FILE),
      name: 'access-graph',
      read: async (file) => (await readAccessGraphDocument(file))?.graph ?? null,
    }, diagnostics),
    catalog: await loadDocument({
      file: join(storage, EVIDENCE_CATALOG_FILE),
      name: 'evidence-catalog',
      read: async (file) => validateEvidenceCatalog(JSON.parse(await readFile(file, 'utf8'))),
    }, diagnostics),
  };
}

/** The published per-attempt figure, as-is: the Kit derives no per-task cost. */
function costPerTask(decision) {
  const cost = decision?.selected?.cost;
  if (!cost) return null;
  return { amount: cost.amount, currency: cost.currency, unit: cost.unit };
}

/** One key set, whatever the outcome — a machine reads the same shape every time. */
function statusDocument({ outcome, surface = null, intent = null, decision = null, diagnostics }) {
  const origin = routeOrigin(decision?.origin ?? null);
  return {
    schemaVersion: ROUTING_STATUS_DOCUMENT_VERSION,
    outcome,
    exitCode: routingStatusExitCode(outcome),
    surface,
    intent: intent?.intent ?? null,
    intentMigration: intent
      ? { fromVersion: intent.fromVersion, defaulted: [...intent.defaulted] }
      : null,
    status: decision?.status ?? null,
    reason: decision?.reason ?? null,
    origin: decision?.origin ?? null,
    state: decision?.state ?? null,
    evidenceBacked: origin.evidenceBacked,
    selected: decision?.selected ?? null,
    bestOverall: decision?.bestOverall ?? null,
    bestExecutable: decision?.bestExecutable ?? null,
    costPerTask: costPerTask(decision),
    blockers: decision ? [...decision.blockers] : [],
    revisions: decision?.revisions ?? null,
    diagnostics,
  };
}

/** An unexpected failure still answers in the machine shape, redacted. */
export function routingStatusFailure(detail) {
  return statusDocument({
    outcome: 'failed', diagnostics: [diagnostic('routing-status-failed', detail)],
  });
}

const answer = (document, json) => ({ document, json, exitCode: document.exitCode });

/**
 * Resolve the Route decision for one intent. Every recoverable problem becomes a
 * redacted diagnostic plus an outcome, so a caller never has to parse an
 * exception to learn what happened.
 */
export async function routingStatus(options = {}) {
  const { argv = [], env = process.env, now = new Date().toISOString() } = options;
  const json = argv.includes('--json');
  const diagnostics = [];
  const surface = resolveSurface(argv, env, diagnostics);
  const intent = await readIntent(flagValue(argv, 'intent-file'), diagnostics);
  if (!surface || !intent) {
    return answer(statusDocument({ outcome: INVALID_REQUEST, surface, intent, diagnostics }), json);
  }
  const world = await loadRoutingWorld(options, diagnostics);
  try {
    const decision = resolveRoute({
      ...world,
      intent: intent.intent,
      activeSurface: surface.id,
      knownTransports: knownTransports(),
      now,
    });
    return answer(statusDocument({
      outcome: decision.state, surface, intent, decision, diagnostics,
    }), json);
  } catch (error) {
    diagnostics.push(diagnostic('route-decision-failed', error.message));
    return answer(statusDocument({ outcome: 'failed', surface, intent, diagnostics }), json);
  }
}
