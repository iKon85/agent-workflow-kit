#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GITLEAKS_PROFILE = JSON.parse(
  await readFile(join(HERE, 'gitleaks-profile.json'), 'utf8'),
);

async function defaultIsAvailable() {
  try {
    await exec('gitleaks', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function defaultFetchArchive(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function defaultInstallArchive({ bytes, destination }) {
  const scratch = await mkdtemp(join(tmpdir(), 'awkit-gitleaks-'));
  const archive = join(scratch, 'gitleaks.tar.gz');
  const extracted = join(scratch, 'gitleaks');
  const staged = `${destination}.tmp-${process.pid}`;
  try {
    await writeFile(archive, bytes);
    await exec('tar', ['-xzf', archive, '-C', scratch, 'gitleaks']);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(extracted, staged);
    await chmod(staged, 0o755);
    await rename(staged, destination);
  } finally {
    await unlink(staged).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function ensureGitleaks({
  profile = DEFAULT_GITLEAKS_PROFILE,
  platform = process.platform,
  arch = process.arch,
  destination = join(homedir(), '.local', 'bin', 'gitleaks'),
  isAvailable = defaultIsAvailable,
  fetchArchive = defaultFetchArchive,
  installArchive = defaultInstallArchive,
} = {}) {
  if (await isAvailable()) return { status: 'already-available' };

  const target = profile.platforms?.[`${platform}-${arch}`];
  if (!target?.asset || !/^[a-f0-9]{64}$/i.test(target.sha256 ?? '')) {
    return { status: 'unsupported-platform', platform, arch };
  }

  const url = `${profile.baseUrl ?? ''}/${target.asset}`;
  let bytes;
  try {
    bytes = await fetchArchive(url);
  } catch (error) {
    return { status: 'offline', message: error.message };
  }

  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== target.sha256.toLowerCase()) {
    return { status: 'checksum-mismatch', expected: target.sha256, actual };
  }

  try {
    await installArchive({ bytes, destination, asset: target.asset });
  } catch (error) {
    return { status: 'unwritable', message: error.message };
  }
  return { status: 'installed', destination, version: profile.version };
}

async function main() {
  const result = await ensureGitleaks({ destination: process.argv[2] });
  if (result.status === 'installed' || result.status === 'already-available') {
    console.log(`Gitleaks provisioning: ${result.status}.`);
  } else {
    console.error(`Gitleaks provisioning skipped safely: ${result.status}.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Gitleaks provisioning failed safely: ${error.message}`);
  });
}
