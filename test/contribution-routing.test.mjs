import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  inspectContributionRouting,
} from '../src/lib/contributionRouting.mjs';
import {
  CONSUMER_MANIFEST_NAME,
} from '../src/lib/manifest.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { cleanup, makeEmptyDir } from './helpers.mjs';

const CORE = 'scripts/example-core.mjs';
const BASE = sha256('export const value = 1;\n');
const LOCAL = sha256('export const value = 2;\n');

async function consumerWithBridge(capability) {
  const root = await makeEmptyDir();
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'docs/agents'), { recursive: true });
  await writeFile(join(root, CORE), 'export const value = 2;\n');
  await writeFile(join(root, CONSUMER_MANIFEST_NAME), `${JSON.stringify({
    kitVersion: '0.35.0',
    installed: [{
      path: CORE,
      kind: 'script',
      installedSha256: LOCAL,
      origin: 'consumer',
      installRole: 'consumer',
      ownershipState: 'contribution-bridge',
      contributionBridge: {
        schemaVersion: 1,
        baseKitVersion: '0.35.0',
        baseSha256: BASE,
        localSha256: LOCAL,
      },
    }],
  }, null, 2)}\n`);
  if (capability !== undefined) {
    await writeFile(
      join(root, 'docs/agents/workflow-capabilities.json'),
      `${JSON.stringify({ contributionRouting: capability }, null, 2)}\n`,
    );
  }
  return root;
}

test('missing capability fails closed to generic preserve and fork guidance', async () => {
  const consumer = await consumerWithBridge();
  try {
    const result = await inspectContributionRouting({
      consumerRoot: consumer,
      path: CORE,
      surface: 'pre-update',
      resolveRemote: async () => {
        throw new Error('identity must not be probed without explicit configuration');
      },
    });
    assert.equal(result.lifecycleState, 'contribution-bridge');
    assert.equal(result.capabilityState, 'missing');
    assert.deepEqual(result.routes, [
      { id: 'preserve', remoteMutation: false },
      { id: 'explicit-fork', remoteMutation: false },
    ]);
  } finally {
    await cleanup(consumer);
  }
});

test('verified repository capability adds local preparation and approval-gated upstream', async () => {
  const consumer = await consumerWithBridge({
    schemaVersion: 1,
    enabled: true,
    upstream: {
      repository: 'iKon85/agent-workflow-kit',
      remote: 'kit-upstream',
    },
    workflows: {
      prepareLocal: true,
      upstreamPullRequest: {
        enabled: true,
        requiresExplicitApproval: true,
      },
    },
  });
  try {
    const result = await inspectContributionRouting({
      consumerRoot: consumer,
      path: CORE,
      surface: 'retro',
      resolveRemote: async (remote) => {
        assert.equal(remote, 'kit-upstream');
        return 'git@github.com:iKon85/agent-workflow-kit.git';
      },
    });
    assert.equal(result.capabilityState, 'ready');
    assert.equal(result.repository, 'iKon85/agent-workflow-kit');
    assert.deepEqual(result.routes, [
      { id: 'preserve', remoteMutation: false },
      { id: 'explicit-fork', remoteMutation: false },
      { id: 'prepare-local', remoteMutation: false },
      {
        id: 'upstream-pull-request',
        remoteMutation: true,
        requiresExplicitApproval: true,
      },
    ]);
  } finally {
    await cleanup(consumer);
  }
});

test('default capability verification reads the configured local Git remote', async () => {
  const consumer = await consumerWithBridge({
    schemaVersion: 1,
    enabled: true,
    upstream: {
      repository: 'iKon85/agent-workflow-kit',
      remote: 'kit-upstream',
    },
    workflows: {
      prepareLocal: true,
      upstreamPullRequest: {
        enabled: true,
        requiresExplicitApproval: true,
      },
    },
  });
  try {
    for (const args of [
      ['init'],
      ['remote', 'add', 'kit-upstream', 'git@github.com:iKon85/agent-workflow-kit.git'],
    ]) {
      const result = spawnSync('git', args, { cwd: consumer, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const result = await inspectContributionRouting({
      consumerRoot: consumer, path: CORE, surface: 'guard',
    });
    assert.equal(result.capabilityState, 'ready');
    assert.ok(result.routes.some(({ id }) => id === 'prepare-local'));
  } finally {
    await cleanup(consumer);
  }
});

test('contradictory or unverifiable capability fails closed without maintainer routes', async () => {
  for (const [capability, remoteUrl] of [
    [{
      schemaVersion: 1,
      enabled: true,
      upstream: {
        repository: 'iKon85/agent-workflow-kit',
        remote: 'kit-upstream',
      },
      workflows: {
        prepareLocal: true,
        upstreamPullRequest: {
          enabled: true,
          requiresExplicitApproval: false,
        },
      },
    }, 'git@github.com:iKon85/agent-workflow-kit.git'],
    [{
      schemaVersion: 1,
      enabled: true,
      upstream: {
        repository: 'iKon85/agent-workflow-kit',
        remote: 'kit-upstream',
      },
      workflows: {
        prepareLocal: true,
        upstreamPullRequest: {
          enabled: true,
          requiresExplicitApproval: true,
        },
      },
    }, 'https://github.com/example/not-the-kit.git'],
  ]) {
    const consumer = await consumerWithBridge(capability);
    try {
      const result = await inspectContributionRouting({
        consumerRoot: consumer,
        path: CORE,
        surface: 'guard',
        resolveRemote: async () => remoteUrl,
      });
      assert.equal(result.capabilityState, 'invalid');
      assert.deepEqual(result.routes.map(({ id }) => id), ['preserve', 'explicit-fork']);
      assert.match(result.diagnostic, /explicit approval|required upstream|remote/i);
    } finally {
      await cleanup(consumer);
    }
  }
});

test('retro, pre-update, and guard report one shared lifecycle and route decision', async () => {
  const consumer = await consumerWithBridge({
    schemaVersion: 1,
    enabled: true,
    upstream: {
      repository: 'iKon85/agent-workflow-kit',
      remote: 'kit-upstream',
    },
    workflows: {
      prepareLocal: true,
      upstreamPullRequest: {
        enabled: true,
        requiresExplicitApproval: true,
      },
    },
  });
  try {
    const reports = await Promise.all(
      ['retro', 'pre-update', 'guard'].map((surface) => inspectContributionRouting({
        consumerRoot: consumer,
        path: CORE,
        surface,
        resolveRemote: async () => 'https://github.com/iKon85/agent-workflow-kit',
      })),
    );
    assert.deepEqual(
      reports.map(({ surface: _surface, ...decision }) => decision),
      [reports[0], reports[0], reports[0]].map(({ surface: _surface, ...decision }) => decision),
    );
    assert.deepEqual(reports.map(({ surface }) => surface), ['retro', 'pre-update', 'guard']);
  } finally {
    await cleanup(consumer);
  }
});

test('setup, update, retro, and the CLI consume the shared route contract', async () => {
  const [setup, update, retro, cli, claudeSchema, codexSchema] = await Promise.all([
    readFile('.claude/skills/setup-workflow/SKILL.md', 'utf8'),
    readFile('.claude/skills/kit-update/SKILL.md', 'utf8'),
    readFile('.claude/skills/retro/SKILL.md', 'utf8'),
    readFile('src/cli.mjs', 'utf8'),
    readFile('.claude/skills/setup-workflow/contribution-routing.md', 'utf8'),
    readFile('.agents/skills/setup-workflow/contribution-routing.md', 'utf8'),
  ]);
  assert.match(setup, /contribution-routing\.md/);
  assert.match(update, /contribute status <path> --surface=pre-update/);
  assert.match(retro, /contribute status <path>[\s\S]*--surface=retro/);
  assert.match(cli, /inspectContributionRouting\(/);
  assert.equal(claudeSchema, codexSchema);
  assert.doesNotMatch(
    `${setup}\n${update}\n${retro}\n${claudeSchema}`,
    /process\.env\.(?:USER|USERNAME)|os\.userInfo|gh api user/,
  );
});
