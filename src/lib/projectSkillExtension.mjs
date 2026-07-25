import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { firstLineState } from './sentinel.mjs';

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MARKER_PREFIX = '<!-- agent-workflow-kit: project-extension/';
const MARKER = /^<!-- agent-workflow-kit: project-extension\/([^;]+); skill=([a-z0-9-]+) -->$/;

export function projectSkillExtensionPath(skill) {
  if (typeof skill !== 'string' || !SKILL_NAME.test(skill)) {
    throw new Error(`invalid Project extension skill identity: ${skill}`);
  }
  return `docs/agents/skills/${skill}.md`;
}

export async function inspectProjectSkillExtension({ root, skill }) {
  const path = projectSkillExtensionPath(skill);
  const absolute = join(root, path);
  let state;
  try {
    state = await lstat(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'inactive', reason: 'absent' };
    throw error;
  }
  if (!state.isFile()) {
    throw new Error(`Project extension is not a regular file: ${path}`);
  }
  const body = await readFile(absolute, 'utf8');
  const setupState = firstLineState(body);
  if (setupState === 'stub' || setupState === 'not-applicable') {
    return { state: 'inactive', reason: setupState };
  }
  const lines = body.split('\n').map((line) => line.trim());
  const markerLine = lines.find((line) => line.startsWith(MARKER_PREFIX));
  if (!markerLine) {
    if (!body.trim()) return { state: 'inactive', reason: 'empty' };
    return { state: 'active', schemaVersion: 0, path };
  }
  const match = MARKER.exec(markerLine);
  if (!match || match[1] !== 'v1') {
    throw new Error(
      `Project extension has unsupported schema at ${path}; ` +
      `expected project-extension/v1 for skill=${skill}`,
    );
  }
  if (match[2] !== skill) {
    throw new Error(
      `Project extension identity mismatch at ${path}; expected skill=${skill}, ` +
      `found skill=${match[2]}`,
    );
  }
  const content = lines.filter(
    (line) => line && line !== markerLine && !line.startsWith('<!-- setup-workflow:'),
  );
  if (!content.length) {
    throw new Error(`Project extension has no instructions after its v1 marker: ${path}`);
  }
  return { state: 'active', schemaVersion: 1, path };
}
