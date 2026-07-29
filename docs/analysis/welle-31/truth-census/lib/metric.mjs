#!/usr/bin/env node
// The one number (#380 §6): refuted planning claims / eligible planning claims.
//
// The metric is defined over MEANINGS and mapped onto today's carriers by a
// versioned translation layer, so a v1.0.0 rename moves the carrier without
// zeroing the metric. It is computed only over the OBSERVABLE denominator, and
// the report carries the unobserved-claim bound next to it.
//
// Headline, fixed in advance: **size-weighted pooled ratio over the long-tail
// (+90 d) window**. Secondary: immediate (+14 d), per-program median,
// multiplicity. Zero-denominator programs are `n/a` and excluded from both.
//
// Inputs are read-only `gh` responses; each is recorded with its exact argv,
// fetch time, row count and sha256 (the bodies themselves are not copied into
// the repository — the digest pins them).
//
// Usage: node lib/metric.mjs --issues <path> --prs <path>
// Writes: metric.json

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE = path.resolve(import.meta.dirname, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const issuesPath = arg('--issues', '/tmp/w31/issues.json');
const prsPath = arg('--prs', '/tmp/w31/prs.json');
const issuesRaw = readFileSync(issuesPath, 'utf8');
const prsRaw = readFileSync(prsPath, 'utf8');
const issues = JSON.parse(issuesRaw);
const prs = JSON.parse(prsRaw);

const DAY = 86400000;
const WINDOWS = { immediate: 14 * DAY, longTail: 90 * DAY };

// --- semantic event mapping v1 ---------------------------------------------
const MAPPING = {
  version: 1,
  meanings: {
    M1: {
      meaning: 'a slice was declared executable without further decision',
      eligibleCarrier: 'issue carrying the AFK-readiness label `ready-for-agent`',
      refutationCarrier: 'the slice\'s own body carries a `plan_revision` beyond r1 (the plan was re-cut after publication), or a `type:followup` issue names it',
    },
    M2: {
      meaning: 'the slices under this anchor were declared independent and completely decomposed',
      eligibleCarrier: 'issue carrying `type:cluster` or `type:program` with at least one child naming it',
      refutationCarrier: 'a `type:followup` issue naming the anchor, created after the anchor opened, or the anchor\'s own `plan_revision` beyond r1',
    },
    M3: {
      meaning: 'this slice\'s blast radius is the declared primary set',
      eligibleCarrier: '`## Blast-Radius` block with a readable primary estimate AND a merged pull request that closes the issue',
      refutationCarrier: 'the merged pull request changed more than 2x the estimate — the kit\'s own STOP threshold',
    },
    M4: {
      meaning: 'planning for this anchor is complete',
      eligibleCarrier: 'a closed anchor (`type:cluster` / `type:program`)',
      refutationCarrier: 'a `type:followup` issue naming the anchor, created after the anchor closed',
    },
  },
  observabilityLoss: [
    'removing the `ready-for-agent` label removes the M1 denominator, not the failures it counts',
    'removing the `plan_revision` marker removes the M1/M2 refutation carrier',
    'removing the `## Blast-Radius` block removes the M3 claim entirely',
    'removing `type:followup` removes the only cross-anchor refutation carrier (M2 and M4)',
    'no carrier exists today for "the assumption a sibling slice carried was toppled" — `ANNAHMEN.md` is gitignored by design, so that meaning is unobservable and is counted in the unobserved bound, never as a zero',
  ],
};

const label = (issue, name) => issue.labels.some((l) => l.name === name);
const ts = (value) => (value ? Date.parse(value) : null);
const planRevision = (body) => {
  const m = (body ?? '').match(/plan_revision:\**\s*r(\d+)/i);
  return m ? Number(m[1]) : null;
};
const anchorOf = (body) => {
  const m = (body ?? '').match(/parent-prd:\s*#(\d+)/i) ?? (body ?? '').match(/Part of:?\s*(?:Welle \d+ · )?(?:Anchor )?#(\d+)/i);
  return m ? Number(m[1]) : null;
};

// The declared blast radius is Primary + Transitive: a slice that names three
// primary files and four transitive ones claimed seven, not three. Counting
// only Primary would manufacture refutations, which is the failure mode this
// whole anchor is about.
function countLine(line) {
  if (!line) return { count: 0, explicit: false };
  const range = line.match(/(\d+)\s*[–\-—]\s*(\d+)\s*(files|Dateien)/i);
  if (range) return { count: Number(range[2]), explicit: true };
  const single = line.match(/[~≈]\s*(\d+)\s*(files|Dateien)/i);
  if (single) return { count: Number(single[1]), explicit: true };
  const paths = line.split(/,|·/).map((p) => p.trim())
    .filter((p) => /[\w-]+\.[\w]{1,5}\b|\//.test(p));
  return { count: paths.length, explicit: false };
}

function blastRadiusEstimate(body) {
  const block = (body ?? '').match(/## Blast-Radius[\s\S]{0,600}/);
  if (!block) return null;
  const primary = countLine((block[0].match(/\*\*Primary:\*\*(.*)/) ?? [])[1]);
  const transitive = countLine((block[0].match(/\*\*Transitive:\*\*(.*)/) ?? [])[1]);
  const total = primary.count + transitive.count;
  return total > 0 ? { total, primary: primary.count, transitive: transitive.count } : null;
}

// followup -> the issue numbers it names
const followups = issues.filter((i) => label(i, 'type:followup')).map((i) => ({
  number: i.number,
  createdAt: ts(i.createdAt),
  names: [...new Set([...(`${i.title} ${i.body ?? ''}`.match(/#(\d+)/g) ?? []).map((s) => Number(s.slice(1)))])],
}));
const followupsNaming = (number) => followups.filter((f) => f.names.includes(number) && f.number !== number);

// issue -> the merged PR that closes it, and ONLY when that PR closes exactly
// one issue. A wave-landing PR that closes ten slices changes the union of ten
// blast radii; charging all of it against each slice's estimate would
// manufacture refutations wholesale (measured: 67 changed files attributed to
// ten separate 1-3 file estimates). Multi-issue PRs are not observable at slice
// resolution and are counted in the unobserved bound, never as refutations.
const prByIssue = new Map();
let multiIssuePrClaims = 0;
for (const pr of prs) {
  const refs = pr.closingIssuesReferences ?? [];
  if (refs.length !== 1) { multiIssuePrClaims += refs.length; continue; }
  if (!prByIssue.has(refs[0].number)) prByIssue.set(refs[0].number, pr);
}

const claims = [];
for (const issue of issues) {
  const created = ts(issue.createdAt);
  const closed = ts(issue.closedAt);
  const revision = planRevision(issue.body);
  const program = anchorOf(issue.body) ?? (label(issue, 'type:cluster') || label(issue, 'type:program') ? issue.number : null);
  const named = followupsNaming(issue.number);

  const push = (meaning, refutedAt) => claims.push({
    meaning, issue: issue.number, program: program ?? 'unattributed', observedAt: created,
    refutedAt: refutedAt ?? null,
  });

  if (label(issue, 'ready-for-agent')) {
    // M1: the re-cut is dated by the first followup naming it; a plan_revision
    // beyond r1 has no timestamp of its own, so it is dated at the issue's own
    // close (the latest moment it can have happened) — the conservative choice.
    const byRevision = revision !== null && revision > 1 ? (closed ?? Date.now()) : null;
    const byFollowup = named.length ? Math.min(...named.map((f) => f.createdAt)) : null;
    const at = [byRevision, byFollowup].filter((v) => v !== null);
    push('M1', at.length ? Math.min(...at) : null);
  }
  if (label(issue, 'type:cluster') || label(issue, 'type:program')) {
    const children = issues.filter((c) => anchorOf(c.body) === issue.number);
    if (children.length) {
      const byRevision = revision !== null && revision > 1 ? (closed ?? Date.now()) : null;
      const after = named.filter((f) => f.createdAt > created);
      const at = [byRevision, after.length ? Math.min(...after.map((f) => f.createdAt)) : null].filter((v) => v !== null);
      push('M2', at.length ? Math.min(...at) : null);
    }
    if (closed) {
      const after = named.filter((f) => f.createdAt > closed);
      push('M4', after.length ? Math.min(...after.map((f) => f.createdAt)) : null);
    }
  }
  const estimate = blastRadiusEstimate(issue.body);
  const pr = prByIssue.get(issue.number);
  if (estimate && pr && typeof pr.changedFiles === 'number') {
    claims.push({
      meaning: 'M3', issue: issue.number, program: program ?? 'unattributed', observedAt: created,
      refutedAt: pr.changedFiles > 2 * estimate.total ? ts(pr.mergedAt) : null,
      estimate: estimate.total, estimateParts: estimate, changedFiles: pr.changedFiles,
    });
  }
}

function ratio(subset, window) {
  const eligible = subset.length;
  const refuted = subset.filter((c) => c.refutedAt !== null && (c.refutedAt - c.observedAt) <= window).length;
  return { eligible, refuted, ratio: eligible ? Number((refuted / eligible).toFixed(4)) : null };
}

const perProgram = {};
for (const claim of claims) {
  perProgram[claim.program] ??= [];
  perProgram[claim.program].push(claim);
}
const programRows = Object.entries(perProgram).map(([program, subset]) => ({
  program,
  ...ratio(subset, WINDOWS.longTail),
  immediate: ratio(subset, WINDOWS.immediate).ratio,
}));
const withDenominator = programRows.filter((r) => r.eligible > 0);
const naPrograms = programRows.filter((r) => r.eligible === 0).length;
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(4));
};

const headline = ratio(claims, WINDOWS.longTail);
const immediate = ratio(claims, WINDOWS.immediate);
const byMeaning = Object.fromEntries(['M1', 'M2', 'M3', 'M4'].map((m) => [
  m, ratio(claims.filter((c) => c.meaning === m), WINDOWS.longTail),
]));

// Multiplicity: refutation EVENTS, not distinct claims — recurrence is signal.
const events = claims.filter((c) => c.refutedAt !== null).length;
const multiplicity = {
  refutationEvents: events,
  refutedClaims: headline.refuted,
  followupsNamingAnAnchorOrSlice: followups.filter((f) => f.names.length).length,
  meanEventsPerRefutedClaim: headline.refuted ? Number((events / headline.refuted).toFixed(2)) : null,
};

// Unobserved-claim bound: transient planning conversation leaves no record.
// f = the unobserved share of the TRUE claim population. Two bounds per f:
// the unobserved claims are never refuted (low) or always refuted (high).
const sensitivity = [0.1, 0.25, 0.5].map((f) => ({
  unobservedShare: f,
  low: Number((headline.ratio * (1 - f)).toFixed(4)),
  observedPointEstimate: headline.ratio,
  high: Number((headline.ratio * (1 - f) + f).toFixed(4)),
}));

// Safety incidents on the predeclared definition (#380 §6). Counted over the
// same population, by searching the recorded corpus for each class. A hit is a
// candidate, not a confirmed incident; a zero means "no record found", which is
// the only thing this evidence can carry.
const INCIDENT_CLASSES = {
  'tracked work lost': /\b(lost (tracked )?work|work was lost|lost commits?|commits? (were )?lost|data loss)\b/i,
  'protected branch bypassed': /\b(force[- ]push(ed)?( to)? (main|master)|bypass(ed)? (the )?(branch )?protection|--no-verify (was|used) on main|admin merge)\b/i,
  'wrong artifact published': /\b(wrong (artifact|version|package) (was )?published|published the wrong|unpublish(ed)?|deprecat(e|ed) the (bad|wrong) version)\b/i,
  'consumer files overwritten without backup': /\b(overwrote|overwritten) [^.]{0,40}(without (a )?backup|silently)\b/i,
};
const corpus = [
  ...issues.map((i) => ({ kind: 'issue', number: i.number, at: ts(i.createdAt), text: `${i.title}\n${i.body ?? ''}` })),
  ...prs.map((p) => ({ kind: 'pr', number: p.number, at: ts(p.mergedAt), text: `${p.title}\n${p.body ?? ''}` })),
];
const safetyIncidents = Object.fromEntries(Object.entries(INCIDENT_CLASSES).map(([name, re]) => [name, {
  candidates: corpus.filter((c) => re.test(c.text)).map((c) => `${c.kind}#${c.number}`),
}]));
// Positive control for the scanner: a synthetic text that must match.
const scannerControl = Object.fromEntries(Object.entries(INCIDENT_CLASSES).map(([name, re]) => [name, re.test({
  'tracked work lost': 'the branch was deleted and we lost tracked work',
  'protected branch bypassed': 'someone force-pushed to main',
  'wrong artifact published': 'we published the wrong version and had to unpublish',
  'consumer files overwritten without backup': 'update overwrote the consumer file without a backup',
}[name])]));

const digest = (text) => createHash('sha256').update(text).digest('hex');
const payload = {
  schema: 'welle-31/truth-census/metric/v1',
  headlineDefinition: 'size-weighted pooled ratio of refuted to eligible planning claims over the long-tail (+90 d) window; pooled = sum(refuted)/sum(eligible), so a 30-slice program weighs 15x a 2-slice wave',
  mapping: MAPPING,
  inputs: [
    {
      argv: 'gh issue list --repo iKon85/agent-workflow-kit --state all --limit 500 --json number,title,state,createdAt,closedAt,labels,body',
      rows: issues.length,
      sha256: digest(issuesRaw),
      note: 'bodies are not copied into the repository; the digest pins the response',
    },
    {
      argv: 'gh pr list --repo iKon85/agent-workflow-kit --state merged --limit 500 --json number,mergedAt,createdAt,body,changedFiles,closingIssuesReferences,title',
      rows: prs.length,
      sha256: digest(prsRaw),
    },
  ],
  headline,
  immediate,
  byMeaning,
  perProgram: {
    programs: withDenominator.length,
    naExcluded: naPrograms,
    medianRatio: median(withDenominator.map((r) => r.ratio)),
    rows: programRows.sort((a, b) => b.eligible - a.eligible),
  },
  multiplicity,
  unobservedClaimBound: {
    why: 'the metric can only count a claim that left a record. Transient planning conversation, a decision made and revised inside one session, and a toppled assumption carried in the gitignored `ANNAHMEN.md` leave none.',
    multiIssuePrClaimsDropped: multiIssuePrClaims,
    sensitivity,
    reading: 'at an unobserved share of 50%, the true ratio lies between half the observed ratio and the observed ratio plus one half — the metric is a floor with a wide ceiling, not a measurement of "every claim"',
  },
  safetyFloor: {
    window: '+90 d, the same window as the headline',
    population: { issues: issues.length, mergedPullRequests: prs.length },
    classes: safetyIncidents,
    scannerPositiveControl: scannerControl,
    reading: 'a candidate is a text match, not a confirmed incident; none of the four classes has a mechanical detector in this repository, so a zero counts the absence of a RECORD, never the absence of the event (#205)',
  },
  claims,
};
writeFileSync(path.join(BASE, 'metric.json'), `${JSON.stringify(payload, null, 1)}\n`);
console.log('headline (+90d, pooled):', headline);
console.log('immediate (+14d):', immediate);
console.log('by meaning:', JSON.stringify(byMeaning));
console.log('programs:', withDenominator.length, 'n/a excluded:', naPrograms, 'median:', payload.perProgram.medianRatio);
console.log('multiplicity:', multiplicity);
console.log('safety-incident candidates:', Object.fromEntries(Object.entries(safetyIncidents).map(([k, v]) => [k, v.candidates.length])));
console.log('scanner positive control:', scannerControl);
