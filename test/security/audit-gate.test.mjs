import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCommand, evaluateAudit } from '../../scripts/security/audit-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('npm and pnpm metadata block high or critical production findings', () => {
  const input = JSON.stringify({
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    },
  });
  for (const manager of ['npm', 'pnpm']) {
    assert.deepEqual(evaluateAudit({ manager, input }), {
      status: 'blocking-findings',
      exitCode: 1,
      counts: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    });
  }
});

test('low findings pass while malformed audit data fails closed', () => {
  const low = evaluateAudit({
    manager: 'npm',
    input: JSON.stringify({
      metadata: {
        vulnerabilities: { info: 0, low: 2, moderate: 0, high: 0, critical: 0 },
      },
    }),
  });
  assert.equal(low.status, 'passed');
  assert.equal(low.exitCode, 0);
  assert.deepEqual(evaluateAudit({ manager: 'npm', input: '{broken' }).exitCode, 2);
});

test('service outage policy is explicit and independent from malformed data', () => {
  const input = JSON.stringify({ error: { code: 'EAI_AGAIN' } });
  assert.deepEqual(evaluateAudit({ manager: 'pnpm', input }), {
    status: 'service-outage-warning',
    exitCode: 0,
  });
  assert.deepEqual(evaluateAudit({ manager: 'pnpm', input, serviceOutage: 'block' }), {
    status: 'service-outage-blocked',
    exitCode: 3,
  });
});

test('yarn and bun raw advisory schemas normalize to the same severity verdict', () => {
  const rawAdvisories = JSON.stringify({
    packageA: [{ severity: 'moderate' }],
    packageB: [{ severity: 'critical' }],
  });
  for (const manager of ['yarn', 'bun']) {
    const verdict = evaluateAudit({ manager, input: rawAdvisories });
    assert.equal(verdict.status, 'blocking-findings');
    assert.equal(verdict.counts.moderate, 1);
    assert.equal(verdict.counts.critical, 1);
  }
});

test('each package-manager adapter audits production dependencies and emits JSON', () => {
  assert.deepEqual(auditCommand('npm'), ['npm', 'audit', '--omit=dev', '--json']);
  assert.deepEqual(auditCommand('pnpm'), ['pnpm', 'audit', '--prod', '--json']);
  assert.deepEqual(auditCommand('yarn'), [
    'yarn', 'npm', 'audit', '--environment', 'production', '--recursive', '--json',
  ]);
  assert.deepEqual(auditCommand('bun'), ['bun', 'audit', '--prod', '--json']);
});

test('Yarn Classic JSON-lines audit summaries remain supported', () => {
  const input = [
    JSON.stringify({
      type: 'auditAdvisory',
      data: { advisory: { severity: 'high' } },
    }),
    JSON.stringify({
      type: 'auditSummary',
      data: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
      },
    }),
  ].join('\n');
  const verdict = evaluateAudit({ manager: 'yarn', input });
  assert.equal(verdict.status, 'blocking-findings');
  assert.equal(verdict.counts.high, 1);
});

test('frozen Testreporter pnpm fixture preserves the historic non-blocking boundary', () => {
  const input = readFileSync(join(HERE, 'fixtures/testreporter-pnpm-audit.json'), 'utf8');
  const verdict = evaluateAudit({ manager: 'pnpm', input });
  assert.equal(verdict.status, 'passed');
  assert.equal(verdict.counts.low, 3);
  assert.equal(verdict.counts.moderate, 2);
});
