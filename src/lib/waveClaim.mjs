import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const CONTRACT_VERSION = 1;

async function git(repoRoot, args, options = {}) {
  return exec('git', args, { cwd: repoRoot, encoding: 'utf8', ...options });
}

// execFile has no `input` option — the child's stdin would stay open and a
// stdin-reading plumbing command (`git mktag`) would block forever. Spawn and
// close stdin explicitly instead.
function gitWithInput(repoRoot, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
    child.stdin.end(input);
  });
}

function claimRef(anchor) {
  if (typeof anchor !== 'string' || !/^[1-9][0-9]*$/.test(anchor)) {
    throw new TypeError('anchor must be a positive issue number string');
  }
  return `refs/tags/wave-active/${anchor}`;
}

function validateOwner(owner) {
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new TypeError('owner must be a non-empty string');
  }
}

async function resolveRef(repoRoot, ref) {
  try {
    const { stdout } = await git(repoRoot, ['rev-parse', '--verify', ref]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function readClaimAt(repoRoot, ref, tagOid) {
  const { stdout: type } = await git(repoRoot, ['cat-file', '-t', tagOid]);
  if (type.trim() !== 'tag') throw new Error(`${ref} is not an annotated wave claim`);
  const { stdout } = await git(repoRoot, ['cat-file', '-p', tagOid]);
  const separator = stdout.indexOf('\n\n');
  if (separator < 0) throw new Error(`${ref} has no ownership payload`);
  let claim;
  try {
    claim = JSON.parse(stdout.slice(separator + 2).trim());
  } catch (error) {
    throw new Error(`${ref} has an invalid ownership payload`, { cause: error });
  }
  if (claim?.contractVersion !== CONTRACT_VERSION || typeof claim.owner !== 'string') {
    throw new Error(`${ref} has an unsupported ownership payload`);
  }
  return claim;
}

export async function readWaveClaim({ repoRoot, anchor }) {
  const ref = claimRef(anchor);
  const tagOid = await resolveRef(repoRoot, ref);
  return tagOid ? readClaimAt(repoRoot, ref, tagOid) : null;
}

async function createTagObject(repoRoot, anchor, claim) {
  const ref = claimRef(anchor);
  const [{ stdout: head }, { stdout: objectFormat }] = await Promise.all([
    git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(repoRoot, ['rev-parse', '--show-object-format']),
  ]);
  const epoch = Math.floor(Date.parse(claim.createdAt) / 1000);
  const content = [
    `object ${head.trim()}`,
    'type commit',
    `tag ${ref.slice('refs/tags/'.length)}`,
    `tagger agent-workflow-kit waveClaim <wave-claim@localhost> ${epoch} +0000`,
    '',
    JSON.stringify(claim),
    '',
  ].join('\n');
  const { stdout: tagOid } = await gitWithInput(repoRoot, ['mktag'], content);
  const zeroOid = '0'.repeat(objectFormat.trim() === 'sha256' ? 64 : 40);
  return { ref, tagOid: tagOid.trim(), zeroOid };
}

/** Atomically acquire a local annotated-tag claim and read back its owner. */
export async function claimWave({ repoRoot, anchor, owner, sliceBranches = [], now = new Date() }) {
  validateOwner(owner);
  if (!Array.isArray(sliceBranches) || !sliceBranches.every((branch) => typeof branch === 'string')) {
    throw new TypeError('sliceBranches must be an array of strings');
  }
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const proposed = { contractVersion: CONTRACT_VERSION, anchor, owner, createdAt, sliceBranches };
  const { ref, tagOid, zeroOid } = await createTagObject(repoRoot, anchor, proposed);
  let acquired = true;
  try {
    await git(repoRoot, ['update-ref', ref, tagOid, zeroOid]);
  } catch {
    acquired = false;
  }
  const currentOid = await resolveRef(repoRoot, ref);
  if (!currentOid) throw new Error(`wave claim ${ref} was not readable after creation`);
  const claim = await readClaimAt(repoRoot, ref, currentOid);
  return { acquired: acquired && currentOid === tagOid && claim.owner === owner, claim };
}

/** Remove a claim only while the annotated payload and ref still belong to owner. */
export async function releaseWaveClaim({ repoRoot, anchor, owner }) {
  validateOwner(owner);
  const ref = claimRef(anchor);
  const tagOid = await resolveRef(repoRoot, ref);
  if (!tagOid) return false;
  const claim = await readClaimAt(repoRoot, ref, tagOid);
  if (claim.owner !== owner) return false;
  try {
    await git(repoRoot, ['update-ref', '-d', ref, tagOid]);
  } catch {
    return false;
  }
  return await resolveRef(repoRoot, ref) === null;
}
