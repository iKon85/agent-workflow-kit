/** Build the distributable kit from this public repository's current SSOT. */
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBundle } from '../src/lib/bundle.mjs';
import { sha256 } from '../src/lib/hash.mjs';
import { scrub } from './lib/scrub.mjs';
import { auditExecRefs, auditModuleImports, auditSkillNameRefs } from './lib/audit-refs.mjs';

const ROOT_FILES = ['LICENSE', 'README.md', 'PROVENANCE.md'];
const DOC_ASSETS = ['index.html', 'methodology.html', 'methodology.svg', 'workflow.png'];

const isBinary = (buf) => buf.includes(0);

async function walk(dir) {
  const files = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return files; throw error; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function writeOut(path, content, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, mode);
}

async function copySource(repoRoot, distDir, source, destination, mode = 0o644, shouldScrub = true) {
  const raw = await readFile(join(repoRoot, source));
  const content = shouldScrub && !isBinary(raw)
    ? Buffer.from(scrub(raw.toString('utf8')), 'utf8') : raw;
  await writeOut(join(distDir, destination), content, mode);
  return content;
}

async function shipBundle(repoRoot, distDir, bundleFiles) {
  const entries = [];
  for (const file of bundleFiles) {
    const content = await copySource(repoRoot, distDir, file.src, file.dest, file.mode);
    entries.push({
      path: file.dest, kind: file.kind, ownerSkill: file.ownerSkill,
      surface: file.surface, installRole: file.installRole,
      sha256: sha256(content), mode: file.mode, origin: 'kit',
    });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function shipRepositoryFiles(repoRoot, distDir, packageJson) {
  for (const file of ROOT_FILES) await copySource(repoRoot, distDir, file, file, 0o644, false);
  for (const file of DOC_ASSETS) {
    await copySource(repoRoot, distDir, `docs/${file}`, `docs/${file}`);
  }
  for (const absolute of await walk(join(repoRoot, 'src'))) {
    const path = `src/${relative(join(repoRoot, 'src'), absolute)}`;
    await copySource(repoRoot, distDir, path, path);
  }
  const distributable = {
    ...packageJson,
    repository: {
      type: 'git', url: 'git+https://github.com/iKon85/agent-workflow-kit.git',
    },
  };
  await writeOut(join(distDir, 'package.json'), Buffer.from(`${JSON.stringify(distributable, null, 2)}\n`));
}

async function auditBuild(repoRoot, distDir, manifest, entries) {
  const bodies = new Map();
  for (const entry of entries) {
    if (entry.path.endsWith('.md') || entry.path.endsWith('.py')) {
      bodies.set(entry.path, await readFile(join(distDir, entry.path), 'utf8'));
    }
  }
  const localModules = (await Promise.all(
    ['scripts', '.claude/hooks'].map(async (dir) => {
      try { return await readdir(join(repoRoot, dir)); } catch { return []; }
    }),
  )).flat().filter((name) => name.endsWith('.py')).map((name) => name.slice(0, -3));
  const known = Object.keys(manifest.skills);
  const published = known.filter((name) => manifest.skills[name].publish);
  const read = (path) => bodies.get(path) ?? null;
  const failures = [
    ...auditExecRefs(entries, read).map((v) => `${v.file} -> ${v.ref}`),
    ...auditModuleImports(entries, read, localModules).map((v) => `${v.file} -> ${v.module}`),
    ...auditSkillNameRefs(entries, read, { known, published }).map((v) => `${v.file} -> ${v.skill}`),
  ];
  if (failures.length) throw new Error(`build-kit: dangling dependencies:\n${failures.join('\n')}`);
}

export async function buildKit({ repoRoot, distDir } = {}) {
  repoRoot ??= join(dirname(fileURLToPath(import.meta.url)), '..');
  distDir ??= join(repoRoot, 'dist-kit');
  const manifest = JSON.parse(await readFile(join(repoRoot, '.claude/skills/skill-manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  const { files } = await collectBundle(repoRoot, manifest);
  const entries = await shipBundle(repoRoot, distDir, files);
  await shipRepositoryFiles(repoRoot, distDir, packageJson);
  await writeOut(join(distDir, 'agent-workflow-kit.package.json'), Buffer.from(
    `${JSON.stringify({ kitVersion: packageJson.version, files: entries }, null, 2)}\n`,
  ));
  await auditBuild(repoRoot, distDir, manifest, entries);
  return { distDir, kitVersion: packageJson.version, fileCount: entries.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildKit().then(({ distDir, kitVersion, fileCount }) => {
    console.log(`built ${distDir} · kitVersion ${kitVersion} · ${fileCount} files`);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
