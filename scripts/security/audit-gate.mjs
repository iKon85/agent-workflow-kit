#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

function emptyCounts() {
  return Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
}

function normalizedCounts(input) {
  const counts = emptyCounts();
  for (const severity of SEVERITIES) {
    const value = Number(input?.[severity] ?? 0);
    if (!Number.isInteger(value) || value < 0) throw new Error('invalid vulnerability count');
    counts[severity] = value;
  }
  return counts;
}

function parseJson(input) {
  return JSON.parse(input);
}

function countsFromAdvisories(data) {
  const counts = emptyCounts();
  for (const advisories of Object.values(data)) {
    if (!Array.isArray(advisories)) throw new Error('invalid advisory collection');
    for (const advisory of advisories) {
      const severity = advisory?.severity;
      if (!SEVERITIES.includes(severity)) throw new Error('invalid advisory severity');
      counts[severity] += 1;
    }
  }
  return counts;
}

function parseAudit(manager, input) {
  let data;
  try {
    data = parseJson(input);
  } catch (error) {
    if (manager !== 'yarn') throw error;
    const events = input.trim().split(/\r?\n/).map(parseJson);
    const summary = events.find((event) => event?.type === 'auditSummary');
    if (!summary?.data?.vulnerabilities) throw error;
    return {
      counts: normalizedCounts(summary.data.vulnerabilities),
      data: summary,
    };
  }
  if (manager === 'npm' || manager === 'pnpm') {
    if (data?.error && typeof data.error === 'object') {
      return { counts: emptyCounts(), data };
    }
    if (!data?.metadata?.vulnerabilities) throw new Error('missing metadata.vulnerabilities');
    return { counts: normalizedCounts(data.metadata.vulnerabilities), data };
  }
  if (manager === 'yarn' || manager === 'bun') {
    if (data?.error && typeof data.error === 'object') {
      return { counts: emptyCounts(), data };
    }
    return { counts: countsFromAdvisories(data), data };
  }
  throw new Error(`unsupported package manager: ${manager}`);
}

export function auditCommand(manager) {
  const commands = {
    npm: ['npm', 'audit', '--omit=dev', '--json'],
    pnpm: ['pnpm', 'audit', '--prod', '--json'],
    yarn: ['yarn', 'npm', 'audit', '--environment', 'production', '--recursive', '--json'],
    bun: ['bun', 'audit', '--prod', '--json'],
  };
  if (!commands[manager]) throw new Error(`unsupported package manager: ${manager}`);
  return commands[manager];
}

export function evaluateAudit({
  manager,
  input,
  serviceOutage = 'warn',
  blockingSeverities = ['high', 'critical'],
}) {
  let parsed;
  try {
    parsed = parseAudit(manager, input);
  } catch (error) {
    return { status: 'malformed', exitCode: 2, message: error.message };
  }

  if (parsed.data?.error && typeof parsed.data.error === 'object') {
    return serviceOutage === 'block'
      ? { status: 'service-outage-blocked', exitCode: 3 }
      : { status: 'service-outage-warning', exitCode: 0 };
  }

  const isBlocking = blockingSeverities.some((severity) => parsed.counts[severity] > 0);
  return {
    status: isBlocking ? 'blocking-findings' : 'passed',
    exitCode: isBlocking ? 1 : 0,
    counts: parsed.counts,
  };
}

async function main() {
  const manager = process.argv[2];
  const serviceOutageArg = process.argv.find((arg) => arg.startsWith('--service-outage='));
  const serviceOutage = serviceOutageArg?.split('=', 2)[1] ?? 'warn';
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const verdict = evaluateAudit({ manager, input, serviceOutage });
  const output = JSON.stringify(verdict);
  (verdict.exitCode === 0 ? console.log : console.error)(output);
  process.exitCode = verdict.exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'malformed', message: error.message }));
    process.exitCode = 2;
  });
}
