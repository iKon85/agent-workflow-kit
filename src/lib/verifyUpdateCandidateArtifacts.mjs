import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  candidateInputPaths, declaredCandidateRunbookPaths, validateCandidateManifestPath,
} from './updateCandidate.mjs';

const run = promisify(execFile);

export async function verifyCandidateMembership(candidateRoot, context) {
  const manifests = [
    context.priorReadinessManifest, context.nextReadinessManifest,
  ];
  const allowed = new Set(candidateInputPaths({ pkg: context.pkg, manifests }));
  for (const path of await declaredCandidateRunbookPaths({ candidateRoot, manifests })) {
    allowed.add(path);
  }
  for (const path of context.preview?.generated ?? []) allowed.add(path);
  for (const { path } of context.preview?.migrations ?? []) allowed.add(path);
  for (const path of await regularCandidateFiles(candidateRoot)) {
    if (!allowed.has(path)) {
      throw new Error(`candidate invariant artifact: extra ${path}`);
    }
  }
}

export async function verifyChangedSyntax(candidateRoot, preview) {
  const changed = new Set([
    ...(preview?.added ?? []),
    ...(preview?.updated ?? []),
    ...(preview?.generated ?? []),
    ...(preview?.migrations ?? []).map(({ path }) => path),
  ]);
  for (const path of [...changed].sort()) {
    const absolute = join(candidateRoot, path);
    let command;
    if (/\.(?:mjs|cjs|js)$/.test(path)) {
      command = [process.execPath, ['--check', absolute], 'Node'];
    } else if (path.endsWith('.py')) {
      command = [
        'python3',
        [
          '-c',
          'import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_bytes())',
          absolute,
        ],
        'Python',
      ];
    } else if (path.endsWith('.sh')) {
      command = ['bash', ['-n', absolute], 'shell'];
    } else {
      continue;
    }
    try {
      await run(command[0], command[1]);
    } catch {
      throw new Error(`candidate invariant syntax: ${command[2]} parse failed ${path}`);
    }
  }
}

async function regularCandidateFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await regularCandidateFiles(root, path));
      continue;
    }
    const state = await lstat(join(root, path));
    if (!state.isFile()) {
      throw new Error(`candidate invariant artifact: not a regular file ${path}`);
    }
    files.push(path);
  }
  return files;
}
