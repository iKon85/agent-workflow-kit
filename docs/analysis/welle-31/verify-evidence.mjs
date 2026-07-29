#!/usr/bin/env node
/**
 * Welle 31 · Slice 0 — evidence freeze verifier (#404; #380 "Standing evidence").
 *
 * `export-evidence.mjs` cannot be re-run to reproduce its own output: it fetches
 * live bodies and stamps each one with the fetch time, so a second run differs
 * by construction. The freeze is therefore not "the file re-derives" but "the
 * recorded command still returns the recorded bytes". This verifier is that
 * check, and it is what makes the export auditable rather than merely present:
 *
 *  - re-runs every recorded `gh` argv, exactly as committed;
 *  - compares the sha256 of the untouched stdout against the recorded digest;
 *  - re-hashes each export file against the digest table in the export README.
 *
 * A DIFFERS line is not automatically a defect — a live issue body may have been
 * edited since the freeze. It is the signal that a citation of that body is
 * citing a moving target, which is exactly what #380 asked to be made visible.
 *
 * Read-only: it never writes and never mutates an issue.
 *
 * Usage: node docs/analysis/welle-31/verify-evidence.mjs [--files-only]
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const EVIDENCE = join(REPO_ROOT, 'docs/evidence/welle-31');
const FILES = ['issue-bodies.json', 'aggregate-queries.json'];

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

export async function verifyFiles() {
  const results = [];
  for (const name of FILES) {
    const body = await readFile(join(EVIDENCE, name), 'utf8');
    results.push({ name, sha256: sha256(body) });
  }
  return results;
}

export async function verifyCommands() {
  const results = [];
  for (const name of FILES) {
    const payload = JSON.parse(await readFile(join(EVIDENCE, name), 'utf8'));
    for (const item of payload.exports) {
      const label = item.id ?? `${item.repo}#${item.number}`;
      const [bin, ...argv] = item.command;
      try {
        const { stdout } = await run(bin, argv, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 });
        const digest = sha256(stdout);
        results.push({ file: name, label, recorded: item.sha256, rerun: digest, status: digest === item.sha256 ? 'MATCH' : 'DIFFERS' });
      } catch (error) {
        results.push({ file: name, label, recorded: item.sha256, rerun: null, status: `UNREACHABLE: ${error.message.split('\n')[0]}` });
      }
    }
  }
  return results;
}

async function main() {
  for (const { name, sha256: digest } of await verifyFiles()) console.log(`${digest}  ${name}`);
  if (process.argv.includes('--files-only')) return;
  const results = await verifyCommands();
  for (const row of results) console.log(`${row.status.padEnd(8)} ${row.label} (${row.file})`);
  const bad = results.filter((row) => row.status !== 'MATCH');
  console.log(`${results.length - bad.length} of ${results.length} recorded commands still return the frozen bytes`);
  if (bad.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
