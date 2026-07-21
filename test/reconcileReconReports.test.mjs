import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileReconReports } from '../src/lib/reconcileReconReports.mjs';

const report = (sliceId, plannedFiles, dependencyEdges = []) => ({
  sliceId, plannedFiles, dependencyEdges,
});

test('ordered editors reconcile as one overlap and preserve dependency order', () => {
  const result = reconcileReconReports([
    report('170', [
      { path: 'src/lib/bundle.mjs', role: 'edit' },
      { path: 'src/lib/reconcileReconReports.mjs', role: 'edit' },
    ], [
      { from: '170', to: '173' },
      { from: '170', to: '173' },
    ]),
    report('173', [{ path: 'src/lib/bundle.mjs', role: 'edit' }], [
      { from: '173', to: '174' },
    ]),
    report('174', [{ path: 'src/lib/bundle.mjs', role: 'edit' }]),
  ]);

  assert.deepEqual(result, {
    editOwners: [
      { path: 'src/lib/bundle.mjs', sliceIds: ['170', '173', '174'] },
      { path: 'src/lib/reconcileReconReports.mjs', sliceIds: ['170'] },
    ],
    overlaps: [
      { path: 'src/lib/bundle.mjs', editors: ['170', '173', '174'] },
    ],
    dependencyEdges: [
      { from: '170', to: '173' },
      { from: '173', to: '174' },
    ],
  });
});

test('edit plus consume or shared mention is not an edit overlap', () => {
  const result = reconcileReconReports([
    report('170', [{ path: 'src/lib/bundle.mjs', role: 'edit' }]),
    report('173', [{ path: 'src/lib/bundle.mjs', role: 'consume' }]),
    report('174', [{ path: 'src/lib/bundle.mjs', role: 'sharedMutable' }]),
  ]);
  assert.deepEqual(result.overlaps, []);
});

test('unordered multiple edit owners hard-fail', () => {
  assert.throws(
    () => reconcileReconReports([
      report('170', [{ path: 'src/lib/bundle.mjs', role: 'edit' }]),
      report('173', [{ path: 'src/lib/bundle.mjs', role: 'edit' }]),
    ]),
    /src\/lib\/bundle\.mjs.*edit owners.*not totally ordered/i,
  );
});

test('shared-mutable paths require exactly one edit owner', () => {
  assert.throws(
    () => reconcileReconReports([
      report('170', [{ path: 'src/lib/bundle.mjs', role: 'sharedMutable' }]),
      report('173', [{ path: 'src/lib/bundle.mjs', role: 'consume' }]),
    ]),
    /src\/lib\/bundle\.mjs.*exactly one edit owner.*found 0/i,
  );
  assert.throws(
    () => reconcileReconReports([
      report('170', [{ path: 'src/lib/bundle.mjs', role: 'edit' }], [
        { from: '170', to: '173' },
      ]),
      report('173', [{ path: 'src/lib/bundle.mjs', role: 'edit' }]),
      report('174', [{ path: 'src/lib/bundle.mjs', role: 'sharedMutable' }]),
    ]),
    /src\/lib\/bundle\.mjs.*exactly one edit owner.*found 170, 173/i,
  );
});

test('dependency graph rejects unknown endpoints, self edges, and cycles', () => {
  const cases = [
    ['unknown endpoint', [
      report('170', [], [{ from: '170', to: '999' }]),
    ], /unknown slice.*999/i],
    ['self edge', [
      report('170', [], [{ from: '170', to: '170' }]),
    ], /self dependency.*170/i],
    ['cycle', [
      report('170', [], [{ from: '170', to: '173' }]),
      report('173', [], [{ from: '173', to: '170' }]),
    ], /cycle/i],
  ];
  for (const [label, reports, message] of cases) {
    assert.throws(() => reconcileReconReports(reports), message, label);
  }
});

test('duplicate report slice IDs hard-fail', () => {
  assert.throws(
    () => reconcileReconReports([report('170', []), report('170', [])]),
    /duplicate recon report.*170/i,
  );
});
