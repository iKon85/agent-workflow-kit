import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

const CLAUDE_SKILL = resolve('.claude/skills/setup-workflow/SKILL.md');
const CODEX_SKILL = resolve('.agents/skills/setup-workflow/SKILL.md');

async function documentedHook() {
  const skill = await readFile(CLAUDE_SKILL, 'utf8');
  const match = skill.match(/```json kit-origin-edit-hook-settings\n([\s\S]*?)\n```/);
  assert.ok(match, 'missing executable kit-origin Edit/Write settings entry');
  return JSON.parse(match[1]);
}

function closingIndex(raw, start, open, close) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index;
  }
  return -1;
}

function findContainer(raw, key, expected, open, close, from = 0, to = raw.length) {
  const property = /"(?:\\.|[^"\\])*"\s*:/g;
  const matches = [];
  property.lastIndex = from;
  for (let match = property.exec(raw); match && match.index < to; match = property.exec(raw)) {
    const token = match[0].slice(0, match[0].lastIndexOf(':')).trim();
    if (JSON.parse(token) !== key) continue;
    let start = property.lastIndex;
    while (/\s/.test(raw[start])) start += 1;
    if (raw[start] !== open) continue;
    const end = closingIndex(raw, start, open, close);
    if (end < 0 || end >= to) continue;
    if (isDeepStrictEqual(JSON.parse(raw.slice(start, end + 1)), expected)) matches.push({ start, end });
  }
  return matches.length === 1 ? matches[0] : null;
}

function insertMember(raw, closeIndex, member, hasMembers) {
  let insertion = closeIndex;
  while (insertion > 0 && /\s/.test(raw[insertion - 1])) insertion -= 1;
  return `${raw.slice(0, insertion)}${hasMembers ? ',' : ''}${member}${raw.slice(insertion)}`;
}

function appendHookText(raw, settings, entry) {
  const compactEntry = JSON.stringify(entry);
  if (!Object.hasOwn(settings, 'hooks')) {
    const close = raw.trimEnd().length - 1;
    if (raw[close] !== '}') return null;
    return insertMember(raw, close, `"hooks":{"PreToolUse":[${compactEntry}]}`, Object.keys(settings).length > 0);
  }
  const hooks = findContainer(raw, 'hooks', settings.hooks, '{', '}');
  if (!hooks) return null;
  if (!Object.hasOwn(settings.hooks, 'PreToolUse')) {
    return insertMember(raw, hooks.end, `"PreToolUse":[${compactEntry}]`, Object.keys(settings.hooks).length > 0);
  }
  const preToolUse = findContainer(
    raw, 'PreToolUse', settings.hooks.PreToolUse, '[', ']', hooks.start, hooks.end,
  );
  if (!preToolUse) return null;
  return insertMember(raw, preToolUse.end, compactEntry, settings.hooks.PreToolUse.length > 0);
}

async function activate(root) {
  const settingsPath = join(root, '.claude/settings.json');
  await mkdir(join(root, '.claude'), { recursive: true });
  let raw;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') return { settingsPath, status: 'skipped' };
  }
  let settings = {};
  try {
    if (raw !== undefined) settings = JSON.parse(raw);
  } catch {
    return { settingsPath, status: 'skipped' };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return { settingsPath, status: 'skipped' };
  }
  const hasHooks = Object.hasOwn(settings, 'hooks');
  if (hasHooks && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    return { settingsPath, status: 'skipped' };
  }
  const hasPreToolUse = hasHooks && Object.hasOwn(settings.hooks, 'PreToolUse');
  if (hasPreToolUse && !Array.isArray(settings.hooks.PreToolUse)) {
    return { settingsPath, status: 'skipped' };
  }
  const entry = await documentedHook();
  const command = entry.hooks[0].command;
  const alreadyPresent = hasPreToolUse && settings.hooks.PreToolUse.some((group) =>
    group?.hooks?.some((hook) => hook?.command === command));
  if (alreadyPresent) return { settingsPath, status: 'already active' };
  const updated = raw === undefined
    ? `${JSON.stringify({ hooks: { PreToolUse: [entry] } }, null, 2)}\n`
    : appendHookText(raw, settings, entry);
  if (updated === null) return { settingsPath, status: 'skipped' };
  await writeFile(settingsPath, updated);
  return { settingsPath, status: 'activated' };
}

test('setup activation creates fresh settings and is byte-idempotent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awkit-origin-activation-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { settingsPath: path, status } = await activate(root);
  assert.equal(status, 'activated');
  const first = await readFile(path);
  assert.equal((await activate(root)).status, 'already active');
  assert.deepEqual(await readFile(path), first);
  const settings = JSON.parse(first);
  assert.deepEqual(settings.hooks.PreToolUse, [await documentedHook()]);
});

test('setup activation appends minimally and preserves initialized consumer settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awkit-origin-activation-existing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude'), { recursive: true });
  const original = `{
    "consumerKey" : {"untouched" : [ "yes" ]},
    "hooks" : {
      "PreToolUse" : [
        {"matcher":"Bash","hooks":[{"type":"command","command":"consumer-command","timeout":7}]}
      ],
      "Stop" : [{"hooks":[{"type":"command","command":"consumer-stop"}]}]
    }
}\n`;
  const path = join(root, '.claude/settings.json');
  await writeFile(path, original);
  assert.equal((await activate(root)).status, 'activated');
  const first = await readFile(path, 'utf8');
  const entry = JSON.stringify(await documentedHook());
  const expected = original.replace('\n      ],\n', `,${entry}\n      ],\n`);
  assert.equal(first, expected, 'activation reformatted consumer-owned settings');
  assert.equal((await activate(root)).status, 'already active');
  assert.equal(await readFile(path, 'utf8'), first);
  const settings = JSON.parse(first);
  assert.deepEqual(settings.consumerKey, { untouched: ['yes'] });
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: 'consumer-stop' }] }]);
  assert.deepEqual(settings.hooks.PreToolUse[0], {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'consumer-command', timeout: 7 }],
  });
  assert.deepEqual(settings.hooks.PreToolUse[1], await documentedHook());
});

test('setup activation skips consumer-owned settings conflicts byte-identically', async (t) => {
  const cases = [
    ['invalid JSON', '{consumer-owned'],
    ['non-object hooks', `${JSON.stringify({ consumerKey: 'keep', hooks: 'consumer-owned' }, null, 2)}\n`],
    ['non-array PreToolUse', `${JSON.stringify({
      consumerKey: 'keep',
      hooks: { PreToolUse: { consumerOwned: true } },
    }, null, 2)}\n`],
  ];
  for (const [name, contents] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'awkit-origin-activation-conflict-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '.claude'), { recursive: true });
    const path = join(root, '.claude/settings.json');
    await writeFile(path, contents);
    const result = await activate(root);
    assert.equal(result.status, 'skipped', name);
    assert.equal(await readFile(path, 'utf8'), contents, `${name} bytes changed`);
  }
});

test('setup-workflow activation contract is mirrored exactly', async () => {
  assert.equal(await readFile(CODEX_SKILL, 'utf8'), await readFile(CLAUDE_SKILL, 'utf8'));
});
