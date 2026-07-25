import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONSUMER_INSTALL_ROLE, CONSUMER_ORIGIN, filesForInstallRole } from './manifest.mjs';
import { validateCandidateManifestPath } from './updateCandidate.mjs';

const READINESS_MANIFEST_PATH = '.claude/skills/skill-manifest.json';
const SURFACE_ROOT = {
  claude: '.claude/skills/',
  codex: '.agents/skills/',
};

export async function verifyCandidateProtocol(candidateRoot, pkg, installed) {
  if (!filesForInstallRole(pkg).some(({ path }) => path === READINESS_MANIFEST_PATH)) return;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(candidateRoot, READINESS_MANIFEST_PATH), 'utf8'));
  } catch {
    throw new Error('candidate invariant schema: readiness manifest is invalid JSON');
  }
  validateReadinessManifest(manifest);
  validateSkillArtifactReferences(manifest, pkg);
  for (const [name, declaration] of Object.entries(manifest.skills)) {
    if (!declaration.publish
        || (declaration.installRole ?? CONSUMER_INSTALL_ROLE) !== CONSUMER_INSTALL_ROLE
        || !declaration.surfaces.includes('claude')
        || !declaration.surfaces.includes('codex')) continue;
    await verifyMirrorGroup(candidateRoot, pkg, installed, name, declaration.class);
  }
}

function validateReadinessManifest(manifest) {
  if (!manifest || manifest.schema_version !== 1
      || !isRecord(manifest.skills)
      || !isRecord(manifest.readiness)
      || !Number.isInteger(manifest.readiness.contractVersion)
      || !isRecord(manifest.readiness.capabilities)) {
    throw new Error('candidate invariant schema: readiness manifest identity is invalid');
  }
  const capabilities = manifest.readiness.capabilities;
  for (const [name, capability] of Object.entries(capabilities)) {
    const evidence = capability?.evidence;
    if (!isRecord(evidence) || typeof evidence.type !== 'string'
        || !Array.isArray(evidence.paths) || !evidence.paths.length) {
      throw new Error(`candidate invariant schema: invalid capability evidence ${name}`);
    }
    for (const path of evidence.paths) {
      try {
        validateCandidateManifestPath(path);
      } catch {
        throw new Error(`candidate invariant schema: unsafe capability path ${name}`);
      }
    }
  }
  for (const [name, skill] of Object.entries(manifest.skills)) {
    const readiness = skill?.readiness ?? {};
    if (!isRecord(skill) || typeof skill.publish !== 'boolean'
        || !['generic', 'vendored', 'adapter'].includes(skill.class)
        || ![CONSUMER_INSTALL_ROLE, 'maintainer'].includes(
          skill.installRole ?? CONSUMER_INSTALL_ROLE,
        )
        || !Array.isArray(skill.surfaces)
        || (skill.publish && !skill.surfaces.length)
        || skill.surfaces.some((surface) => !SURFACE_ROOT[surface])
        || new Set(skill.surfaces).size !== skill.surfaces.length
        || !isRecord(readiness)
        || !Array.isArray(readiness.required ?? [])
        || !isRecord(readiness.optionalBlocks ?? {})
        || [...(readiness.required ?? []), ...Object.values(readiness.optionalBlocks ?? {})]
          .some((capability) => typeof capability !== 'string' || !capability)) {
      throw new Error(`candidate invariant schema: invalid skill declaration ${name}`);
    }
    for (const capability of [
      ...(readiness.required ?? []),
      ...Object.values(readiness.optionalBlocks ?? {}),
    ]) {
      if (!capabilities[capability]) {
        throw new Error(`candidate invariant schema: unknown readiness reference ${name}.${capability}`);
      }
    }
  }
}

function validateSkillArtifactReferences(manifest, pkg) {
  const installable = filesForInstallRole(pkg);
  for (const entry of installable.filter(({ kind }) => kind === 'skill')) {
    const name = entry.ownerSkill ?? skillNameFromPath(entry.path);
    const surface = entry.surface ?? skillSurfaceFromPath(entry.path);
    const declaration = manifest.skills[name];
    if (!declaration?.publish || !declaration.surfaces.includes(surface)) {
      throw new Error(`candidate invariant schema: undeclared skill artifact ${entry.path}`);
    }
  }
  for (const [name, declaration] of Object.entries(manifest.skills)) {
    if (!declaration.publish
        || (declaration.installRole ?? CONSUMER_INSTALL_ROLE) !== CONSUMER_INSTALL_ROLE) continue;
    for (const surface of declaration.surfaces) {
      const path = `${SURFACE_ROOT[surface]}${name}/SKILL.md`;
      if (!installable.some((entry) => entry.path === path)) {
        throw new Error(`candidate invariant schema: missing skill entrypoint ${path}`);
      }
    }
  }
}

async function verifyMirrorGroup(candidateRoot, pkg, installed, name, skillClass) {
  const relativeBySurface = {};
  for (const [surface, root] of Object.entries(SURFACE_ROOT)) {
    const prefix = `${root}${name}/`;
    relativeBySurface[surface] = new Map(filesForInstallRole(pkg)
      .filter(({ path }) => path.startsWith(prefix))
      .map((entry) => [entry.path.slice(prefix.length), entry.path]));
  }
  const claude = relativeBySurface.claude;
  const codex = relativeBySurface.codex;
  const union = new Set([...claude.keys(), ...codex.keys()]);
  for (const relative of union) {
    const sourcePath = claude.get(relative);
    const mirrorPath = codex.get(relative);
    if (!sourcePath || !mirrorPath) {
      throw new Error(`candidate invariant protocol: mirror file-set mismatch ${name}/${relative}`);
    }
    if (installed.get(sourcePath)?.origin === CONSUMER_ORIGIN
        || installed.get(mirrorPath)?.origin === CONSUMER_ORIGIN) continue;
    const source = await readFile(join(candidateRoot, sourcePath));
    const mirror = await readFile(join(candidateRoot, mirrorPath));
    if (relative.endsWith('.md') && ['generic', 'vendored'].includes(skillClass)) {
      const left = normalizedMirrorMarkdown(source.toString('utf8'));
      const right = normalizedMirrorMarkdown(mirror.toString('utf8'));
      if (left.sequence.join('\0') !== right.sequence.join('\0')
          || left.body !== right.body) {
        throw new Error(`candidate invariant protocol: mirror content mismatch ${name}/${relative}`);
      }
    } else if (!source.equals(mirror)) {
      throw new Error(`candidate invariant protocol: mirror content mismatch ${name}/${relative}`);
    }
  }
}

function normalizedMirrorMarkdown(text) {
  const lines = text.split(/\r?\n/);
  let body = lines;
  let frontmatter = [];
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) throw new Error('candidate invariant schema: unterminated skill frontmatter');
    frontmatter = normalizedFrontmatter(lines.slice(1, end));
    body = lines.slice(end + 1);
  }
  const kept = [];
  const sequence = [];
  let inTransform = false;
  for (const line of body) {
    const start = /^\s*<!--\s*mirror-xform:start(?:\s+([^>]*?))?\s*-->\s*$/.exec(line);
    if (start) {
      if (inTransform) throw new Error('candidate invariant protocol: nested mirror transform');
      inTransform = true;
      sequence.push((start[1] ?? '').trim());
      continue;
    }
    if (/^\s*<!--\s*mirror-xform:end\s*-->\s*$/.test(line)) {
      if (!inTransform) throw new Error('candidate invariant protocol: unmatched mirror transform');
      inTransform = false;
      continue;
    }
    if (!inTransform) kept.push(line.trimEnd());
  }
  if (inTransform) throw new Error('candidate invariant protocol: unterminated mirror transform');
  return { body: [...frontmatter, ...kept].join('\n').trim(), sequence };
}

function normalizedFrontmatter(lines) {
  const fields = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+)):\s*(.*)$/.exec(
      lines[index].trimEnd(),
    );
    if (!match) throw new Error('candidate invariant schema: invalid skill frontmatter');
    const key = match[1] ?? match[2] ?? match[3];
    if (fields.has(key)) throw new Error(`candidate invariant schema: duplicate frontmatter key ${key}`);
    let value = match[4];
    if (/^[>|]-?$/.test(value)) {
      const folded = value.startsWith('>');
      const continuation = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
        continuation.push(lines[index].trim());
      }
      value = continuation.join(folded ? ' ' : '\n');
    } else if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch {
        throw new Error(`candidate invariant schema: invalid frontmatter value ${key}`);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("''", "'");
    } else if (/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(value)) {
      value = JSON.parse(value);
    }
    fields.set(key, value);
  }
  return [
    '---',
    ...[...fields].filter(([key]) => key !== 'description')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    '---',
  ];
}

function skillNameFromPath(path) {
  return path.split('/')[2];
}

function skillSurfaceFromPath(path) {
  if (path.startsWith(SURFACE_ROOT.claude)) return 'claude';
  if (path.startsWith(SURFACE_ROOT.codex)) return 'codex';
  return null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
