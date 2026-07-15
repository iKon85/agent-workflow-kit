import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateCensus } from './index.mjs';

test('activation requires a callable verifier before staging or swapping', async () => {
  for (const verify of [undefined, 'not-callable']) {
    const root = await mkdtemp(join(tmpdir(), 'awk-census-transaction-'));
    const activePath = join(root, 'active.json');
    const previous = '{"generation":"previous"}\n';
    await writeFile(activePath, previous);
    let swapped = false;
    try {
      await assert.rejects(
        activateCensus({
          activePath,
          candidate: { generation: 'next' },
          renameCandidate: async () => { swapped = true; },
          verify,
        }),
        /callable verifier/,
      );
      assert.equal(await readFile(activePath, 'utf8'), previous);
      await assert.rejects(readFile(`${activePath}.candidate`), { code: 'ENOENT' });
      await assert.rejects(readFile(`${activePath}.lock`), { code: 'ENOENT' });
      assert.equal(swapped, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('verify failure preserves active bytes and a second run can succeed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awk-census-transaction-'));
  const activePath = join(root, 'active.json');
  const previous = '{"generation":"previous"}\n';
  await writeFile(activePath, previous);
  try {
    await assert.rejects(
      activateCensus({
        activePath,
        candidate: { generation: 'next' },
        verify: async () => { throw new Error('fixture verify failure'); },
      }),
      (error) => error.state === 'failed',
    );
    assert.equal(await readFile(activePath, 'utf8'), previous);

    const result = await activateCensus({
      activePath,
      candidate: { generation: 'next' },
      verify: async ({ generation }) => generation === 'next',
    });
    assert.equal(result.state, 'current');
    assert.equal(await readFile(activePath, 'utf8'), '{"generation":"next"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('swap failure preserves active bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awk-census-transaction-'));
  const activePath = join(root, 'active.json');
  const previous = '{"generation":"previous"}\n';
  await writeFile(activePath, previous);
  try {
    await assert.rejects(
      activateCensus({
        activePath,
        candidate: { generation: 'next' },
        renameCandidate: async () => { throw new Error('fixture swap failure'); },
        verify: async () => true,
      }),
      (error) => error.state === 'failed',
    );
    assert.equal(await readFile(activePath, 'utf8'), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing local lock reports updating without touching active bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'awk-census-transaction-'));
  const activePath = join(root, 'active.json');
  const previous = '{"generation":"previous"}\n';
  await writeFile(activePath, previous);
  await writeFile(`${activePath}.lock`, 'held\n');
  try {
    await assert.rejects(
      activateCensus({
        activePath,
        candidate: { generation: 'next' },
        verify: async () => true,
      }),
      (error) => error.state === 'updating',
    );
    assert.equal(await readFile(activePath, 'utf8'), previous);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
