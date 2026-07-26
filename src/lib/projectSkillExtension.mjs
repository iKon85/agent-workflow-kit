import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { firstLineState } from './sentinel.mjs';

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const MARKER_PREFIX = '<!-- agent-workflow-kit: project-extension/';
const MARKER = /^<!-- agent-workflow-kit: project-extension\/([^;]+); skill=([a-z0-9-]+) -->$/;

function meaningfulSectionBody(lines) {
  const body = lines.join('\n').replace(/<!--[\s\S]*?-->/g, '');
  const content = [];
  let fence = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const delimiter = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter && !fence) {
      fence = { character: delimiter[0], length: delimiter.length };
      continue;
    }
    if (fence && new RegExp(`^\\${fence.character}{${fence.length},}\\s*$`).test(line)) {
      fence = null;
      continue;
    }
    if (line && !/^#{1,6}\s+/.test(line)) content.push(line);
  }
  const meaningful = content
    .filter((line) =>
      !/^(?:TODO|TBD)(?:[.!:]*)$/i.test(line)
      && !/^<\/?[^>\n]+>$/.test(line)
      && !/^<(?:placeholder|fill|configure|add)(?:\s+[^>]*)?>[.!:]*$/i.test(line)
      && !/^(?:Run|Use|Configure|Add|Replace)\s+`?<[^>]+>`?[.!:]*$/i.test(line))
    .join('\n');
  return meaningful.trim();
}

function sectionBodies(body, path) {
  const sections = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (sections.has(heading[1])) {
        throw new Error(`Project extension has duplicate section ${heading[1]} at ${path}`);
      }
      current = [];
      sections.set(heading[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return sections;
}

export function validateProjectSkillActivation(activation, path) {
  if (activation === undefined) return null;
  if (!activation || typeof activation !== 'object' || Array.isArray(activation)
      || activation.mode !== 'all-sections-filled'
      || !Array.isArray(activation.sections) || !activation.sections.length
      || activation.sections.some((section) =>
        typeof section !== 'string' || !section.trim())
      || new Set(activation.sections).size !== activation.sections.length) {
    throw new Error(`Project extension activation policy is invalid at ${path}`);
  }
  return activation.sections;
}

function unfilledSections(body, requiredSections, path) {
  const sections = sectionBodies(body, path);
  return requiredSections.filter((name) =>
    !sections.has(name) || !meaningfulSectionBody(sections.get(name)));
}

export function projectSkillExtensionPath(skill) {
  if (typeof skill !== 'string' || !SKILL_NAME.test(skill)) {
    throw new Error(`invalid Project extension skill identity: ${skill}`);
  }
  return `docs/agents/skills/${skill}.md`;
}

export async function inspectProjectSkillExtension({ root, skill, activation }) {
  const path = projectSkillExtensionPath(skill);
  const requiredSections = validateProjectSkillActivation(activation, path);
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
  if (requiredSections) {
    const missingSections = unfilledSections(body, requiredSections, path);
    if (missingSections.length) {
      return {
        state: 'inactive',
        reason: 'sections-unfilled',
        schemaVersion: 1,
        path,
        missingSections,
      };
    }
  }
  const content = lines.filter(
    (line) => line && line !== markerLine && !line.startsWith('<!-- setup-workflow:'),
  );
  if (!content.length) {
    throw new Error(`Project extension has no instructions after its v1 marker: ${path}`);
  }
  return { state: 'active', schemaVersion: 1, path };
}
