import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DISPATCH_JOURNAL_MODE,
  DISPATCH_JOURNAL_VERSION,
  IDEMPOTENT_DISPATCH_SURFACES,
  appendDispatchJournalEntry,
  dispatchIdempotencyKey,
  journalEntryForReceipt,
  planDispatchRecovery,
  pruneDispatchJournal,
  readDispatchJournal,
  validateDispatchJournalEntry,
} from '../src/lib/dispatchJournal.mjs';
import { createDispatchReceipt } from '../src/lib/dispatchReceipt.mjs';

const CWD = '/home/agent/.worktrees/312-receipts-journal';
const SESSION = '6f1a2b3c-0000-4000-8000-0123456789ab';

async function journalRoot() {
  return mkdtemp(join(tmpdir(), 'awkit-journal-'));
}

function preparedEntry(overrides = {}) {
  return {
    phase: 'prepared',
    executionId: 'execution-1',
    surfaceId: 'claude',
    transportId: 'claude-native',
    cwd: CWD,
    idempotencyKey: dispatchIdempotencyKey({ surfaceId: 'claude', cwd: CWD, sessionId: SESSION }),
    authorizationId: 'plan-authorization-1',
    recordedAt: '2026-07-28T10:00:00.000Z',
    ...overrides,
  };
}

const revisions = {
  catalog: 'catalog-7',
  accessGraph: 'access-4',
  policy: 'policy-9',
};

const inheritedRoute = {
  providerId: 'anthropic',
  modelId: 'reasoning-model',
  effort: 'high',
  surfaceId: 'claude',
  transportId: 'claude-native',
};

test('the journal is owner-only and append-only under a lock', async () => {
  const root = await journalRoot();
  try {
    const file = join(root, 'nested', 'dispatch-journal.jsonl');
    await appendDispatchJournalEntry(file, preparedEntry());
    const afterFirst = await readFile(file, 'utf8');
    assert.equal((await stat(file)).mode & 0o777, DISPATCH_JOURNAL_MODE);

    await Promise.all([2, 3, 4, 5].map((index) => appendDispatchJournalEntry(file, preparedEntry({
      executionId: `execution-${index}`,
    }))));

    const content = await readFile(file, 'utf8');
    assert.ok(content.startsWith(afterFirst), 'an append never rewrites earlier bytes');
    const { entries, damaged } = await readDispatchJournal(file);
    assert.deepEqual(damaged, []);
    assert.equal(entries.length, 5);
    assert.deepEqual(
      [...entries.map((entry) => entry.executionId)].sort(),
      ['execution-1', 'execution-2', 'execution-3', 'execution-4', 'execution-5'],
    );
    assert.equal(entries[0].schemaVersion, DISPATCH_JOURNAL_VERSION);

    await mkdir(`${file}.lock`);
    await assert.rejects(
      appendDispatchJournalEntry(file, preparedEntry({ executionId: 'execution-locked' }), {
        lockTimeoutMs: 20,
      }),
      /dispatch journal is locked/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the journal schema is redacted: no task data, no oversized or control-character values', () => {
  assert.throws(
    () => validateDispatchJournalEntry({ ...preparedEntry(), prompt: 'implement slice 22c' }),
    /dispatch journal entry must carry no consumer task data: prompt/,
  );
  assert.throws(
    () => validateDispatchJournalEntry(preparedEntry({ phase: 'spawned' })),
    /dispatch journal entry phase must be one of/,
  );
  assert.throws(
    () => validateDispatchJournalEntry(preparedEntry({ cwd: 'x'.repeat(513) })),
    /dispatch journal entry cwd exceeds the redacted length limit/,
  );
  assert.throws(
    () => validateDispatchJournalEntry({
      ...preparedEntry({ phase: 'blocked' }),
      reason: 'transport is not\ndetected',
    }),
    /dispatch journal entry reason must carry no control characters/,
  );
  assert.throws(
    () => validateDispatchJournalEntry(preparedEntry({ taskId: 'task-1' })),
    /dispatch journal entry taskId is recorded on a dispatched entry only/,
  );
  assert.throws(
    () => validateDispatchJournalEntry(preparedEntry({ reason: 'blocked for a reason' })),
    /dispatch journal entry reason is recorded on a terminal entry only/,
  );
});

test('a crash mid-append quarantines the damaged line and keeps every readable entry', async () => {
  const root = await journalRoot();
  try {
    const file = join(root, 'dispatch-journal.jsonl');
    await appendDispatchJournalEntry(file, preparedEntry());
    await appendDispatchJournalEntry(file, preparedEntry({
      phase: 'dispatched', executionId: 'execution-1', taskId: 'task-1',
    }));
    // A process that died mid-write leaves a truncated final line.
    await writeFile(file, '{"phase":"prepared","exec', { flag: 'a' });

    const { entries, damaged } = await readDispatchJournal(file);
    assert.equal(entries.length, 2);
    assert.equal(damaged.length, 1);
    assert.deepEqual(Object.keys(damaged[0]).sort(), ['bytes', 'line']);
    assert.equal(damaged[0].line, 3);
    assert.ok(!JSON.stringify(damaged).includes('"exec'), 'a damaged line is counted, not echoed');

    // Damage of unknown identity cannot prove a fresh execution is clear.
    assert.deepEqual(planDispatchRecovery({
      entries, damaged, executionId: 'execution-fresh', surfaceId: 'claude',
    }), {
      state: 'blocked-pending-reconciliation', reason: 'journal-damaged', entry: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retention drops aged terminal entries, keeps indeterminate ones, and reconciles damage', async () => {
  const root = await journalRoot();
  try {
    const file = join(root, 'dispatch-journal.jsonl');
    const old = '2026-06-01T00:00:00.000Z';
    await appendDispatchJournalEntry(file, preparedEntry({ recordedAt: old }));
    await appendDispatchJournalEntry(file, preparedEntry({
      phase: 'dispatched', taskId: 'task-1', recordedAt: old,
    }));
    await appendDispatchJournalEntry(file, preparedEntry({
      executionId: 'execution-indeterminate', recordedAt: old,
    }));
    await appendDispatchJournalEntry(file, preparedEntry({ executionId: 'execution-recent' }));

    const now = Date.parse('2026-07-28T10:00:00.000Z');
    const pruned = await pruneDispatchJournal(file, { retainMs: 7 * 24 * 60 * 60 * 1000, now });
    assert.equal(pruned.dropped, 2);
    assert.equal(pruned.kept, 2);
    assert.equal((await stat(file)).mode & 0o777, DISPATCH_JOURNAL_MODE);

    const { entries } = await readDispatchJournal(file);
    assert.deepEqual(entries.map((entry) => entry.executionId), [
      'execution-indeterminate', 'execution-recent',
    ]);

    await writeFile(file, '{"phase":"prep', { flag: 'a' });
    await assert.rejects(
      pruneDispatchJournal(file, { retainMs: 1, now }),
      /dispatch journal has damaged entries: reconcile with dropDamaged/,
    );
    const reconciled = await pruneDispatchJournal(file, {
      retainMs: 7 * 24 * 60 * 60 * 1000, now, dropDamaged: true,
    });
    assert.equal(reconciled.damagedDropped, 1);
    assert.deepEqual((await readDispatchJournal(file)).damaged, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an indeterminate prepared entry retries only against a same-cwd Claude idempotency key', () => {
  assert.deepEqual(IDEMPOTENT_DISPATCH_SURFACES, ['claude']);
  const key = dispatchIdempotencyKey({ surfaceId: 'claude', cwd: CWD, sessionId: SESSION });
  assert.equal(typeof key, 'string');
  // Proven scope: the key is `(cwd, session-id)`, not the session id alone.
  assert.notEqual(dispatchIdempotencyKey({
    surfaceId: 'claude', cwd: '/home/agent/other', sessionId: SESSION,
  }), key);
  // Codex exposes no caller-assignable thread id at all.
  assert.equal(dispatchIdempotencyKey({ surfaceId: 'codex', cwd: CWD, sessionId: SESSION }), null);
  assert.equal(dispatchIdempotencyKey({ surfaceId: 'claude', cwd: CWD, sessionId: null }), null);

  const entries = [validateDispatchJournalEntry(preparedEntry())];
  assert.deepEqual(planDispatchRecovery({
    entries, executionId: 'execution-1', surfaceId: 'claude', idempotencyKey: key,
  }), { state: 'retry-idempotent', reason: 'idempotency-key-reserved', entry: entries[0] });

  for (const [label, plan] of Object.entries({
    'a different working directory': {
      surfaceId: 'claude',
      idempotencyKey: dispatchIdempotencyKey({
        surfaceId: 'claude', cwd: '/home/agent/other', sessionId: SESSION,
      }),
      expected: 'idempotency-key-scope-mismatch',
    },
    'no pre-assigned key': {
      surfaceId: 'claude', idempotencyKey: null, expected: 'no-idempotency-key-recorded',
    },
  })) {
    assert.deepEqual(planDispatchRecovery({
      entries, executionId: 'execution-1', surfaceId: plan.surfaceId,
      idempotencyKey: plan.idempotencyKey,
    }), {
      state: 'blocked-pending-reconciliation', reason: plan.expected, entry: entries[0],
    }, label);
  }

  const codexEntries = [validateDispatchJournalEntry(preparedEntry({
    surfaceId: 'codex', transportId: 'codex-exec', idempotencyKey: null,
  }))];
  assert.deepEqual(planDispatchRecovery({
    entries: codexEntries, executionId: 'execution-1', surfaceId: 'codex', idempotencyKey: null,
  }), {
    state: 'blocked-pending-reconciliation',
    reason: 'no-idempotency-key-on-surface:codex',
    entry: codexEntries[0],
  });
});

test('a settled execution never dispatches again and an unrecorded one is clear', () => {
  const prepared = validateDispatchJournalEntry(preparedEntry());
  const dispatched = validateDispatchJournalEntry(preparedEntry({
    phase: 'dispatched', taskId: 'task-1', recordedAt: '2026-07-28T10:00:01.000Z',
  }));
  assert.deepEqual(planDispatchRecovery({
    entries: [prepared, dispatched], executionId: 'execution-1', surfaceId: 'claude',
  }), { state: 'settled', reason: 'already-recorded:dispatched', entry: dispatched });

  assert.deepEqual(planDispatchRecovery({
    entries: [prepared, dispatched], executionId: 'execution-2', surfaceId: 'claude',
  }), { state: 'clear', reason: 'no-indeterminate-entry', entry: null });
});

test('every receipt kind maps to exactly one terminal journal entry', () => {
  const context = { cwd: CWD, idempotencyKey: null };
  const routed = journalEntryForReceipt(createDispatchReceipt({
    executionId: 'execution-routed',
    status: 'dispatched',
    afk: true,
    requestedRoute: inheritedRoute,
    appliedRoute: inheritedRoute,
    enforcement: { model: 'named-agent', effort: 'named-agent' },
    precedence: {
      model: 'agent-definition-over-environment',
      effort: 'agent-definition-over-environment',
    },
    revisions,
    authorizationId: 'plan-authorization-1',
    dispatchedAt: '2026-07-28T10:00:00.000Z',
  }), { ...context, taskId: 'task-1' });
  assert.equal(routed.phase, 'dispatched');
  assert.equal(routed.taskId, 'task-1');
  assert.equal(routed.surfaceId, 'claude');
  assert.equal(routed.authorizationId, 'plan-authorization-1');

  const inherited = journalEntryForReceipt(createDispatchReceipt({
    kind: 'inherited-dispatch',
    executionId: 'execution-inherited',
    afk: false,
    appliedRoute: inheritedRoute,
    enforcement: { model: 'session-default', effort: 'session-default' },
    attestation: {
      source: 'session-transcript',
      model: 'reasoning-model',
      effort: 'high',
      observedAt: '2026-07-28T09:59:00.000Z',
    },
    revisions,
    dispatchedAt: '2026-07-28T10:00:00.000Z',
  }), context);
  assert.equal(inherited.phase, 'dispatched');

  const handoff = journalEntryForReceipt(createDispatchReceipt({
    kind: 'handoff',
    executionId: 'execution-handoff',
    afk: false,
    requestedRoute: inheritedRoute,
    handoff: { to: 'user' },
    revisions,
    dispatchedAt: '2026-07-28T10:00:00.000Z',
    reason: 'blocked:no-executable-route',
  }), context);
  assert.equal(handoff.phase, 'handed-off');
  assert.equal(handoff.reason, 'blocked:no-executable-route');

  const blocked = journalEntryForReceipt(createDispatchReceipt({
    executionId: 'execution-blocked',
    status: 'blocked',
    afk: true,
    revisions,
    dispatchedAt: '2026-07-28T10:00:00.000Z',
    reason: 'transport is not detected',
  }), { ...context, surfaceId: 'claude', transportId: 'claude-native' });
  assert.equal(blocked.phase, 'blocked');
  assert.equal(blocked.reason, 'transport is not detected');

  assert.throws(
    () => journalEntryForReceipt(createDispatchReceipt({
      executionId: 'execution-unrouted',
      status: 'blocked',
      afk: true,
      revisions,
      dispatchedAt: '2026-07-28T10:00:00.000Z',
      reason: 'transport is not detected',
    }), context),
    /dispatch journal entry surfaceId must be a non-empty string/,
  );
});
