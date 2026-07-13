import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const FIELDS = ['name', 'version', 'tarballIntegrity', 'manifestSha256'];

const digest = (algorithm, content, encoding = 'hex') =>
  createHash(algorithm).update(content).digest(encoding);

async function readTarEntry(tarball, entry) {
  const { stdout } = await exec('tar', ['-xOf', tarball, entry], { encoding: 'buffer' });
  return stdout;
}

export async function releaseIdentityFromTarball(tarball) {
  const bytes = await readFile(tarball);
  const packageJson = JSON.parse(await readTarEntry(tarball, 'package/package.json'));
  const manifest = await readTarEntry(tarball, 'package/agent-workflow-kit.package.json');
  if (packageJson.version !== JSON.parse(manifest).kitVersion) {
    throw new Error('tarball package and manifest versions mismatch');
  }
  return {
    name: packageJson.name,
    version: packageJson.version,
    tarballIntegrity: `sha512-${digest('sha512', bytes, 'base64')}`,
    manifestSha256: digest('sha256', manifest),
  };
}

function validate(label, identity) {
  if (!identity || typeof identity !== 'object') throw new Error(`${label} release identity missing`);
  for (const field of FIELDS) {
    if (typeof identity[field] !== 'string' || !identity[field]) {
      throw new Error(`${label} ${field} missing`);
    }
  }
}

export function assertReleaseParity(identities) {
  validate('local', identities.local);
  for (const label of ['npm', 'github']) {
    validate(label, identities[label]);
    for (const field of FIELDS) {
      if (identities[label][field] !== identities.local[field]) {
        throw new Error(`${label} ${field} mismatch`);
      }
    }
  }
  return identities.local;
}
