import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { init } from '../src/commands/init.mjs';
import { update } from '../src/commands/update.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { verifyUpdateCandidate } from '../src/lib/verifyUpdateCandidate.mjs';
import { verifyChangedSyntax } from '../src/lib/verifyUpdateCandidateArtifacts.mjs';
import {
  PACKAGE_MANIFEST_NAME, readManifest, writeManifest,
} from '../src/lib/manifest.mjs';
import { cleanup, makeEmptyDir, makeKit } from './helpers.mjs';

const TOOL = 'scripts/kit-tool.mjs';
const DOC = 'docs/managed.md';
const exists = (path) => access(path).then(() => true, () => false);

function releaseIdentities(version = '0.1.0') {
  const identity = {
    name: '@ikon85/agent-workflow-kit',
    version,
    tarballIntegrity: 'sha512-fixture',
    manifestSha256: 'fixture-manifest',
  };
  return {
    installed: {
      name: identity.name,
      version,
      manifestSha256: identity.manifestSha256,
    },
    npm: { ...identity },
    github: { ...identity },
  };
}

async function bumpKit(kitRoot, path, content) {
  await writeFile(join(kitRoot, path), content);
  const pkg = await readManifest(join(kitRoot, PACKAGE_MANIFEST_NAME));
  pkg.files.find((entry) => entry.path === path).sha256 = sha256(content);
  await writeManifest(join(kitRoot, PACKAGE_MANIFEST_NAME), pkg);
}

test('a valid Kit candidate updates a broken Consumer without running its package scripts', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  const marker = join(consumer, 'consumer-test-ran');
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({
        scripts: {
          test: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.exit(99)"`,
        },
      }),
    );
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
    });

    assert.equal(result.state, 'applied');
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 2;\n');
    assert.equal(await exists(marker), false);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a valid Kit candidate preserves a locally modified Kit path while updating another path', async () => {
  const kit = await makeKit({
    [TOOL]: 'export const version = 1;\n',
    [DOC]: 'version 1\n',
  });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, TOOL), 'export const local = true;\n');
    await bumpKit(kit, DOC, 'version 2\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
    });

    assert.equal(result.state, 'applied', result.error);
    assert.deepEqual(result.userModified, [TOOL]);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const local = true;\n');
    assert.equal(await readFile(join(consumer, DOC), 'utf8'), 'version 2\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a verifier extension cannot tamper with a locally modified Kit path', async () => {
  const kit = await makeKit({
    [TOOL]: 'export const version = 1;\n',
    [DOC]: 'version 1\n',
  });
  const consumer = await makeEmptyDir();
  let extensionRan = false;
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, TOOL), 'export const local = true;\n');
    await bumpKit(kit, DOC, 'version 2\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot) => {
        extensionRan = true;
        await writeFile(join(candidateRoot, TOOL), 'tampered\n');
      },
    });

    assert.equal(extensionRan, true);
    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant artifact: hash mismatch.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const local = true;\n');
    assert.equal(await readFile(join(consumer, DOC), 'utf8'), 'version 1\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('an extension cannot mutate the trusted package or activation preview', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (_candidateRoot, context) => {
        context.pkg.files.length = 0;
        context.preview.updated.length = 0;
      },
    });

    assert.equal(result.state, 'applied');
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 2;\n');
    const ledger = await readManifest(join(consumer, 'agent-workflow-kit.json'));
    const tracked = ledger.installed.find(({ path }) => path === TOOL);
    assert.equal(tracked.origin, 'kit');
    assert.equal(tracked.installedSha256, sha256('export const version = 2;\n'));
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a missing manifest artifact blocks before Consumer mutation', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot, context) => {
        await rm(join(candidateRoot, TOOL));
        await verifyUpdateCandidate(candidateRoot, context);
      },
    });

    assert.equal(result.state, 'failed');
    assert.deepEqual(result.failure, { phase: 'verification', consumerState: 'unchanged' });
    assert.match(result.error, /candidate invariant artifact: missing.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a corrupt manifest artifact blocks before Consumer mutation', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot) => {
        await writeFile(join(candidateRoot, TOOL), 'tampered\n');
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant artifact: hash mismatch.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a Consumer-owned manifest path is verified against its ledger identity', async () => {
  const kit = await makeKit({
    [TOOL]: 'export const version = 1;\n',
    [DOC]: 'version 1\n',
  });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const manifest = await readManifest(manifestPath);
    manifest.installed.find(({ path }) => path === TOOL).origin = 'consumer';
    await writeManifest(manifestPath, manifest);
    await writeFile(join(consumer, TOOL), 'export const local = true;\n');
    const owned = await readManifest(manifestPath);
    owned.installed.find(({ path }) => path === TOOL).installedSha256 =
      sha256('export const local = true;\n');
    await writeManifest(manifestPath, owned);
    await bumpKit(kit, TOOL, 'export const version = 2;\n');
    await bumpKit(kit, DOC, 'version 2\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
    });

    assert.equal(result.state, 'applied');
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const local = true;\n');
    assert.equal(await readFile(join(consumer, DOC), 'utf8'), 'version 2\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a Kit-owned artifact with the wrong mode blocks before Consumer mutation', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot, context) => {
        await chmod(join(candidateRoot, TOOL), 0o755);
        await verifyUpdateCandidate(candidateRoot, context);
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant artifact: mode mismatch.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('an extra file outside the positive candidate allowlist blocks before mutation', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot, context) => {
        await writeFile(join(candidateRoot, 'unexpected.mjs'), 'export default true;\n');
        await verifyUpdateCandidate(candidateRoot, context);
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant artifact: extra unexpected\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('duplicate package-manifest paths fail the manifest invariant before mutation', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');
    const pkgPath = join(kit, PACKAGE_MANIFEST_NAME);
    const pkg = await readManifest(pkgPath);
    pkg.files.push({ ...pkg.files[0] });
    await writeManifest(pkgPath, pkg);

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant manifest: duplicate path.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('invalid changed Node syntax blocks without operational execution', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const = broken;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant syntax: Node parse failed.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('invalid changed Python and shell syntax blocks without operational execution', async () => {
  const fixtures = [
    ['scripts/kit-tool.py', 'value = 1\n', 'def broken(:\n', 'Python'],
    ['scripts/kit-tool.sh', 'value=1\n', 'if then\n', 'shell'],
  ];
  for (const [path, before, broken, language] of fixtures) {
    const kit = await makeKit({ [path]: before });
    const consumer = await makeEmptyDir();
    try {
      await init({ kitRoot: kit, consumerRoot: consumer });
      await bumpKit(kit, path, broken);

      const result = await update({
        kitRoot: kit,
        consumerRoot: consumer,
        releaseIdentities: releaseIdentities(),
      });

      assert.equal(result.state, 'failed', language);
      assert.match(
        result.error,
        new RegExp(`candidate invariant syntax: ${language} parse failed`),
      );
      assert.equal(await readFile(join(consumer, path), 'utf8'), before);
    } finally {
      await cleanup(kit, consumer);
    }
  }
});

test('generated and migrated scripts receive the same parse-only syntax check', async () => {
  const candidate = await makeEmptyDir();
  try {
    await writeFile(join(candidate, 'generated.sh'), 'if then\n');
    await writeFile(join(candidate, 'migrated.py'), 'def broken(:\n');

    await assert.rejects(
      verifyChangedSyntax(candidate, {
        added: [],
        updated: [],
        generated: ['generated.sh'],
        migrations: [{ path: 'migrated.py' }],
      }),
      /candidate invariant syntax: shell parse failed generated\.sh/,
    );
    await rm(join(candidate, 'generated.sh'));
    await assert.rejects(
      verifyChangedSyntax(candidate, {
        added: [],
        updated: [],
        generated: [],
        migrations: [{ path: 'migrated.py' }],
      }),
      /candidate invariant syntax: Python parse failed migrated\.py/,
    );
  } finally {
    await cleanup(candidate);
  }
});

test('a stale Kit-owned ledger entry cannot survive an approved deletion', async () => {
  const kit = await makeKit({
    [TOOL]: 'export const version = 1;\n',
    [DOC]: 'version 1\n',
  });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const manifestPath = join(consumer, 'agent-workflow-kit.json');
    const before = await readManifest(manifestPath);
    const stale = before.installed.find(({ path }) => path === TOOL);
    const pkgPath = join(kit, PACKAGE_MANIFEST_NAME);
    const pkg = await readManifest(pkgPath);
    pkg.files = pkg.files.filter(({ path }) => path !== TOOL);
    await writeManifest(pkgPath, pkg);
    await rm(join(kit, TOOL));
    await bumpKit(kit, DOC, 'version 2\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      decide: (action, path) => action === 'delete' && path === TOOL,
      verify: async (candidateRoot, context) => {
        const candidatePath = join(candidateRoot, 'agent-workflow-kit.json');
        const candidate = await readManifest(candidatePath);
        candidate.installed.push(stale);
        await writeManifest(candidatePath, candidate);
        await verifyUpdateCandidate(candidateRoot, context);
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant deletion: stale Kit ledger path.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
    assert.equal(await readFile(join(consumer, DOC), 'utf8'), 'version 1\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('an explicitly preserved legacy Kit path remains outside the bounded candidate', async () => {
  const kit = await makeKit({
    [TOOL]: 'export const version = 1;\n',
    [DOC]: 'version 1\n',
  });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    const pkgPath = join(kit, PACKAGE_MANIFEST_NAME);
    const pkg = await readManifest(pkgPath);
    pkg.files = pkg.files.filter(({ path }) => path !== TOOL);
    await writeManifest(pkgPath, pkg);
    await rm(join(kit, TOOL));
    await bumpKit(kit, DOC, 'version 2\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      decide: () => false,
    });

    assert.equal(result.state, 'applied');
    assert.deepEqual(result.keptDeleted, [TOOL]);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
    assert.equal(await readFile(join(consumer, DOC), 'utf8'), 'version 2\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a resumed candidate cannot promote a Kit path to Consumer ownership', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  const controller = new AbortController();
  let candidateRoot;
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');
    const interrupted = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      signal: controller.signal,
      onState: (state) => { if (state === 'verifying') controller.abort(); },
    });
    candidateRoot = interrupted.candidateRoot;
    assert.equal(interrupted.state, 'aborted');
    const candidateLedgerPath = join(candidateRoot, 'agent-workflow-kit.json');
    const candidateLedger = await readManifest(candidateLedgerPath);
    candidateLedger.installed.find(({ path }) => path === TOOL).origin = 'consumer';
    await writeManifest(candidateLedgerPath, candidateLedger);

    const resumed = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      resumeFrom: candidateRoot,
    });

    assert.equal(resumed.state, 'failed');
    assert.match(resumed.error, /candidate invariant ownership: invalid ledger entry.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
    const ledger = await readManifest(join(consumer, 'agent-workflow-kit.json'));
    assert.equal(ledger.installed.find(({ path }) => path === TOOL).origin, 'kit');
    candidateRoot = null;
  } finally {
    await cleanup(kit, consumer);
    if (candidateRoot) await cleanup(candidateRoot);
  }
});

test('an incoherent generated agent mirror blocks the protocol group before mutation', async () => {
  const skillManifest = `${JSON.stringify({
    schema_version: 1,
    readiness: { contractVersion: 1, capabilities: {} },
    skills: {
      demo: {
        class: 'generic',
        publish: true,
        surfaces: ['claude', 'codex'],
        provenance: 'own',
      },
    },
  }, null, 2)}\n`;
  const source = '---\nname: demo\ndescription: stable\n---\n\n# Demo\n\nVersion one.\n';
  const kit = await makeKit({
    '.claude/skills/skill-manifest.json': skillManifest,
    '.claude/skills/demo/SKILL.md': source,
    '.agents/skills/demo/SKILL.md': source,
  });
  const consumer = await makeEmptyDir();
  try {
    const packagePath = join(kit, PACKAGE_MANIFEST_NAME);
    const packageManifest = await readManifest(packagePath);
    packageManifest.files.find(({ path }) => path ===
      '.claude/skills/skill-manifest.json').kind = 'doc';
    await writeManifest(packagePath, packageManifest);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(
      kit,
      '.claude/skills/demo/SKILL.md',
      '---\nname: demo-drifted\ndescription: stable\n---\n\n# Demo\n\nVersion one.\n',
    );

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant protocol: mirror content mismatch demo\/SKILL\.md/);
    assert.equal(await readFile(join(consumer, '.claude/skills/demo/SKILL.md'), 'utf8'), source);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('unresolved legacy skill conflicts are reported before candidate protocol validation', async () => {
  const skillManifest = `${JSON.stringify({
    schema_version: 1,
    readiness: { contractVersion: 1, capabilities: {} },
    skills: {
      demo: {
        class: 'generic',
        publish: true,
        surfaces: ['claude', 'codex'],
        provenance: 'own',
      },
    },
  }, null, 2)}\n`;
  const original = '---\nname: demo\ndescription: stable\n---\n\n# Demo\n\nVersion one.\n';
  const legacyConflict = [
    '---',
    'name: demo',
    '# <!-- mirror-xform:start legacy -->',
    'description: locally adapted',
    '# <!-- mirror-xform:end -->',
    '---',
    '',
    '# Demo',
    '',
    'Local legacy bytes.',
    '',
  ].join('\n');
  const incoming = '---\nname: demo\ndescription: current\n---\n\n# Demo\n\nVersion two.\n';
  const kit = await makeKit({
    '.claude/skills/skill-manifest.json': skillManifest,
    '.claude/skills/demo/SKILL.md': original,
    '.agents/skills/demo/SKILL.md': original,
  });
  const consumer = await makeEmptyDir();
  try {
    const packagePath = join(kit, PACKAGE_MANIFEST_NAME);
    const packageManifest = await readManifest(packagePath);
    packageManifest.files.find(({ path }) => path ===
      '.claude/skills/skill-manifest.json').kind = 'doc';
    await writeManifest(packagePath, packageManifest);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await writeFile(join(consumer, '.claude/skills/demo/SKILL.md'), legacyConflict);
    await writeFile(join(consumer, '.agents/skills/demo/SKILL.md'), legacyConflict);
    await bumpKit(kit, '.claude/skills/demo/SKILL.md', incoming);
    await bumpKit(kit, '.agents/skills/demo/SKILL.md', incoming);

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
    });

    assert.equal(result.state, 'conflicted');
    assert.deepEqual(
      result.conflicts.map(({ path }) => path).sort(),
      ['.agents/skills/demo/SKILL.md', '.claude/skills/demo/SKILL.md'],
    );
    assert.equal(result.error, undefined);
    assert.equal(
      await readFile(join(consumer, '.claude/skills/demo/SKILL.md'), 'utf8'),
      legacyConflict,
    );
    assert.equal(
      await readFile(join(consumer, '.agents/skills/demo/SKILL.md'), 'utf8'),
      legacyConflict,
    );
  } finally {
    await cleanup(kit, consumer);
  }
});

test('an unknown readiness reference blocks as a schema invariant before mutation', async () => {
  const initial = {
    schema_version: 1,
    readiness: {
      contractVersion: 1,
      capabilities: {
        projectDocs: {
          evidence: { type: 'nonempty', paths: ['docs/project.md'] },
        },
      },
    },
    skills: {
      demo: {
        class: 'generic',
        publish: true,
        surfaces: ['claude'],
        provenance: 'own',
        readiness: { required: ['projectDocs'] },
      },
    },
  };
  const manifestPath = '.claude/skills/skill-manifest.json';
  const source = '---\nname: demo\n---\n\n# Demo\n';
  const kit = await makeKit({
    [manifestPath]: `${JSON.stringify(initial, null, 2)}\n`,
    '.claude/skills/demo/SKILL.md': source,
  });
  const consumer = await makeEmptyDir();
  try {
    const packagePath = join(kit, PACKAGE_MANIFEST_NAME);
    const packageManifest = await readManifest(packagePath);
    packageManifest.files.find(({ path }) => path === manifestPath).kind = 'doc';
    await writeManifest(packagePath, packageManifest);
    await init({ kitRoot: kit, consumerRoot: consumer });
    const invalid = structuredClone(initial);
    invalid.skills.demo.readiness.required = ['missingCapability'];
    await bumpKit(kit, manifestPath, `${JSON.stringify(invalid, null, 2)}\n`);

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
    });

    assert.equal(result.state, 'failed');
    assert.match(
      result.error,
      /candidate invariant schema: unknown readiness reference demo\.missingCapability/,
    );
    assert.equal(await readFile(join(consumer, manifestPath), 'utf8'),
      `${JSON.stringify(initial, null, 2)}\n`);
  } finally {
    await cleanup(kit, consumer);
  }
});

test('candidate ledger readiness metadata must match the trusted readiness contract', async () => {
  const manifestPath = '.claude/skills/skill-manifest.json';
  const readinessManifest = {
    schema_version: 1,
    readiness: {
      contractVersion: 1,
      capabilities: {
        decisionOnly: {
          allowNotApplicable: false,
          evidence: { type: 'sentinel', paths: ['docs/agents/decision.md'] },
        },
      },
    },
    skills: {},
  };
  for (const corruption of [
    { readinessContractVersion: 999, readinessDecisions: { ghost: 'pending' } },
    { readinessContractVersion: 1, readinessDecisions: { decisionOnly: 'not-applicable' } },
  ]) {
    const kit = await makeKit({
      [TOOL]: 'export const version = 1;\n',
      [manifestPath]: `${JSON.stringify(readinessManifest, null, 2)}\n`,
    });
    const consumer = await makeEmptyDir();
    try {
      const packagePath = join(kit, PACKAGE_MANIFEST_NAME);
      const packageManifest = await readManifest(packagePath);
      packageManifest.files.find(({ path }) => path === manifestPath).kind = 'doc';
      await writeManifest(packagePath, packageManifest);
      await init({ kitRoot: kit, consumerRoot: consumer });
      await bumpKit(kit, TOOL, 'export const version = 2;\n');
      const ledgerBefore = await readFile(join(consumer, 'agent-workflow-kit.json'));

      const result = await update({
        kitRoot: kit,
        consumerRoot: consumer,
        releaseIdentities: releaseIdentities(),
        verify: async (candidateRoot) => {
          const ledgerPath = join(candidateRoot, 'agent-workflow-kit.json');
          const ledger = await readManifest(ledgerPath);
          await writeManifest(ledgerPath, { ...ledger, ...corruption });
        },
      });

      assert.equal(result.state, 'failed');
      assert.match(
        result.error,
        /candidate invariant schema: Consumer ledger readiness references are invalid/,
      );
      assert.deepEqual(await readFile(join(consumer, 'agent-workflow-kit.json')), ledgerBefore);
      assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
    } finally {
      await cleanup(kit, consumer);
    }
  }
});

test('candidate ledger cannot omit prior decisions or Consumer extensions', async () => {
  const manifestPath = '.claude/skills/skill-manifest.json';
  const readinessManifest = {
    schema_version: 1,
    readiness: {
      contractVersion: 1,
      capabilities: {
        decisionOnly: {
          evidence: { type: 'sentinel', paths: ['docs/agents/decision.md'] },
        },
      },
    },
    skills: {},
  };
  const kit = await makeKit({
    [TOOL]: 'export const version = 1;\n',
    [manifestPath]: `${JSON.stringify(readinessManifest, null, 2)}\n`,
  });
  const consumer = await makeEmptyDir();
  try {
    const packagePath = join(kit, PACKAGE_MANIFEST_NAME);
    const packageManifest = await readManifest(packagePath);
    packageManifest.files.find(({ path }) => path === manifestPath).kind = 'doc';
    await writeManifest(packagePath, packageManifest);
    await init({ kitRoot: kit, consumerRoot: consumer });
    const ledgerPath = join(consumer, 'agent-workflow-kit.json');
    const prior = await readManifest(ledgerPath);
    prior.readinessDecisions = { decisionOnly: 'pending' };
    prior.consumerExtension = { keep: true };
    await writeManifest(ledgerPath, prior);
    await bumpKit(kit, TOOL, 'export const version = 2;\n');
    const ledgerBefore = await readFile(ledgerPath);

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot) => {
        const candidateLedgerPath = join(candidateRoot, 'agent-workflow-kit.json');
        const candidateLedger = await readManifest(candidateLedgerPath);
        candidateLedger.readinessDecisions = {};
        delete candidateLedger.consumerExtension;
        await writeManifest(candidateLedgerPath, candidateLedger);
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(
      result.error,
      /candidate invariant schema: Consumer ledger metadata differs from trusted prior state/,
    );
    assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('overlapping transaction actions block before activation', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot, context) => {
        context.preview.deleted.push(TOOL);
        await verifyUpdateCandidate(candidateRoot, context);
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant transaction: overlapping action.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a migration cannot overlap another activation action', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot, context) => {
        context.preview.migrations.push({
          path: TOOL,
          beforeSha256: sha256('export const version = 1;\n'),
          afterSha256: sha256('export const version = 2;\n'),
        });
        await verifyUpdateCandidate(candidateRoot, context);
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant transaction: overlapping action.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('malformed collision preconditions block before activation', async () => {
  const kit = await makeKit({ [TOOL]: 'export const version = 1;\n' });
  const consumer = await makeEmptyDir();
  try {
    await init({ kitRoot: kit, consumerRoot: consumer });
    await bumpKit(kit, TOOL, 'export const version = 2;\n');

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot, context) => {
        context.preview.collisionResolutions.push({
          path: TOOL,
          outcome: 'replace',
          destinationSha256: 'not-a-hash',
        });
        await verifyUpdateCandidate(candidateRoot, context);
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(result.error, /candidate invariant transaction: invalid collision resolution.*scripts\/kit-tool\.mjs/);
    assert.equal(await readFile(join(consumer, TOOL), 'utf8'), 'export const version = 1;\n');
  } finally {
    await cleanup(kit, consumer);
  }
});

test('a corrupted generated project stub blocks the transaction before activation', async () => {
  const manifestPath = '.claude/skills/skill-manifest.json';
  const oldManifest = {
    schema_version: 1,
    readiness: { contractVersion: 1, capabilities: {} },
    skills: {},
  };
  const nextManifest = structuredClone(oldManifest);
  nextManifest.readiness.capabilities.issueTracker = {
    evidence: {
      type: 'sentinel',
      paths: ['docs/agents/issue-tracker.md'],
      allowLegacy: true,
    },
  };
  const kit = await makeKit({
    [TOOL]: 'export const version = 1;\n',
    [manifestPath]: `${JSON.stringify(oldManifest, null, 2)}\n`,
  });
  const consumer = await makeEmptyDir();
  try {
    const packagePath = join(kit, PACKAGE_MANIFEST_NAME);
    const packageManifest = await readManifest(packagePath);
    packageManifest.files.find(({ path }) => path === manifestPath).kind = 'doc';
    await writeManifest(packagePath, packageManifest);
    await init({ kitRoot: kit, consumerRoot: consumer });
    await rm(join(consumer, 'docs/agents/issue-tracker.md'));
    await bumpKit(kit, manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);

    const result = await update({
      kitRoot: kit,
      consumerRoot: consumer,
      releaseIdentities: releaseIdentities(),
      verify: async (candidateRoot, context) => {
        await writeFile(
          join(candidateRoot, 'docs/agents/issue-tracker.md'),
          'corrupted generated evidence\n',
        );
        await verifyUpdateCandidate(candidateRoot, context);
      },
    });

    assert.equal(result.state, 'failed');
    assert.match(
      result.error,
      /candidate invariant transaction: generated hash mismatch.*docs\/agents\/issue-tracker\.md/,
    );
    assert.equal(await exists(join(consumer, 'docs/agents/issue-tracker.md')), false);
  } finally {
    await cleanup(kit, consumer);
  }
});
