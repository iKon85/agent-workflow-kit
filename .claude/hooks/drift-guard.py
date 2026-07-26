#!/usr/bin/env python3
"""
Drift-Guard — PreToolUse block on Write|Edit|MultiEdit of a handoff doc when the
linked GitHub issue's rooted graph is not execute-ready.

Why a hook (not skill prose): the `handoff` skill AND the global
`grill-with-docs-codex` live OUTSIDE the repo. Only a repo-side hook fires
regardless of which global skill triggered the Write — the single repo-side net
covering the -codex path.

Coverage (honestly bounded): fires at the handoff / session-boundary Write.
NOT a board-wide scan, NOT a "grill-exit" event (no clean tool hook for that).
Accepted gap: Bash redirect / tee / cp into `.handoff/` is not covered — the
threat model is "skill/agent forgot", not an adversary; handoff writes via Write.

Mechanism: self-filters to `.handoff/*.md`; extracts the issue (an own-repository
content anchor first, then the filename); delegates graph coherence to
scripts/execute-ready-check.py (`--mode handoff`) and census state/fingerprint
evaluation to `scripts/census/index.mjs`. Deny = exit 2 + stderr (house pattern:
enforce-worktree.py, block-secrets.py). A deliberate
`<!-- guard-ack: #<n> r<N> reason:… by-user -->` overrides only the graph gate,
never activated census drift. fail-closed once a target is parsed (the checker
enforces that); fail-OPEN when no handoff target is identifiable (not the stale
handoff we guard).

Audit log: .claude/logs/drift-guard.log
"""
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

from _hook_utils import log

HOOK_NAME = "drift-guard"
HANDLED_TOOLS = {"Write", "Edit", "MultiEdit"}
HANDOFF_PATH_RE = re.compile(r"/\.handoff/[^/]*\.md$")
ISSUE_ANCHOR_RE = re.compile(r"/issues/(\d+)")          # any repo: [#n](…/issues/n)
FILENAME_ISSUE_RE = re.compile(r"(\d+)\.md$")           # skill-controlled: <date>-<n>.md
# Remote URL → host/owner/repo. Covers scp-style (`git@host:owner/repo.git`),
# https and ssh:// forms; deeper namespaces and local paths deliberately do not
# match — an unparsable remote falls back to the filename anchor.
REMOTE_URL_RE = re.compile(
    r"^(?:[a-z][a-z0-9+.-]*://)?(?:[^@/\s]+@)?(?P<host>[^/:\s]+)[/:]"
    r"(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+?)(?:\.git)?/?$",
    re.IGNORECASE,
)
# Bounded diagnostics: a large drift reports its head plus a remainder counter.
CENSUS_DELTA_LIMIT = 10
# Override must be issue-scoped, rev-scoped, reasoned, by-user (Codex R1 — not the cheap `known`).
GUARD_ACK_RE = re.compile(r"<!--\s*guard-ack:\s*#?\d+\s+r\d+\s+reason:.+\bby-user\s*-->",
                          re.IGNORECASE | re.DOTALL)

# Load the shared checker (hyphenated filename → importlib). Repo root = parents[2].
_CHECKER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "execute-ready-check.py"
_CENSUS_MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "census" / "index.mjs"
# Production repositories can need more than the former five-second proof and
# fifteen-second bridge budgets. Keep the default proof comfortably below the
# outer bridge so a hung repository-local proof still cannot wedge the hook.
CENSUS_BRIDGE_TIMEOUT_SECONDS = 30
CENSUS_PROOF_TIMEOUT_MS = 12_000

_CENSUS_SCAN = r"""
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(readFileSync(0, 'utf8'));
const {
  modulePath,
  repoRoot,
  profileJson,
  activeJson,
  localScanners,
  profileLocalScanners,
  localScannersValid,
  activeLocalScanners,
  activeLocalScannersValid,
  proofTimeoutMs,
} = input;
const writeResult = process.stdout.write.bind(process.stdout);
// Repository-local proof modules are allowed to be noisy. Keep their output
// captured so neither scanner/test output nor accidentally-read content reaches
// the hook protocol or the CLI status response.
process.stdout.write = () => true;
process.stderr.write = () => true;
const {
  CENSUS_BUILDER_VERSION,
  CENSUS_VERDICTS,
  diffCensus,
  fingerprintCensus,
  resolveCensusState,
  scanCensus,
} = await import(pathToFileURL(modulePath).href);
const profile = JSON.parse(profileJson);
const active = activeJson ? JSON.parse(activeJson) : null;
const behaviorFamilies = (profile.decisions || []).map(({ family, status }) => ({
  name: family,
  status,
}));
const fresh = await scanCensus({
  repoRoot,
  enabled: Boolean(profile.enabled),
  hasActive: active !== null,
  behaviorFamilies,
});
const calculated = fingerprintCensus(fresh);
if (calculated.builder !== fresh.fingerprints.builder
    || calculated.topology !== fresh.fingerprints.topology) {
  throw new Error('census fingerprint API returned inconsistent facts');
}
const reasons = [];
const withProofTimeout = async (operation) => {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('local proof timed out')), proofTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const proofReason = (surface) => typeof surface === 'string' && surface.length > 0
  ? `proof:${surface}`
  : 'proof:profile-history';
if (active !== null) {
  if (!localScannersValid || !activeLocalScannersValid) {
    reasons.push('proof:profile-history');
  } else if (JSON.stringify(profileLocalScanners) !== JSON.stringify(activeLocalScanners)) {
    const changedSurfaces = new Set([
      ...profileLocalScanners.map(({ surface }) => surface),
      ...activeLocalScanners.map(({ surface }) => surface),
    ]);
    if (changedSurfaces.size === 0) reasons.push('proof:profile-history');
    for (const surface of changedSurfaces) reasons.push(proofReason(surface));
  }
}
for (const record of localScanners) {
  const reason = `proof:${record.surface}`;
  if (record.validationError) {
    reasons.push(reason);
    continue;
  }
  const test = spawnSync(process.execPath, ['--test', record.testPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: proofTimeoutMs,
  });
  if (test.status !== 0 || test.error) {
    reasons.push(reason);
    continue;
  }
  try {
    const scannerModule = await import(`${pathToFileURL(record.modulePath).href}?proof=${Date.now()}`);
    const scanner = scannerModule[record.exportName];
    const result = typeof scanner === 'function'
      ? await withProofTimeout(() => scanner())
      : null;
    if (!Array.isArray(result)
        || !result.every((surface) => typeof surface === 'string')
        || !result.includes(record.surface)) reasons.push(reason);
  } catch {
    reasons.push(reason);
  }
}
if (active !== null && active.fingerprints?.builder !== fresh.fingerprints.builder) reasons.push('builder');
if (active !== null && active.fingerprints?.topology !== fresh.fingerprints.topology) reasons.push('topology');
const uniqueReasons = [...new Set(reasons)];
const hasOpen = uniqueReasons.some((reason) => reason.startsWith('proof:'))
  || [...fresh.families.surfaces, ...fresh.families.behaviors]
    .some(({ status }) => status === CENSUS_VERDICTS.open);
if (hasOpen) uniqueReasons.push('open');
const delta = active === null ? null : diffCensus(active, fresh);
// The guard already knows WHAT moved; report it instead of forcing a blocked
// consumer to rebuild the diff from the kit internals.
const pathHashes = (entries) => new Map(
  (Array.isArray(entries) ? entries : []).map(({ path, hash }) => [path, hash]),
);
const diffEntries = (before, after) => {
  const previous = pathHashes(before);
  const next = pathHashes(after);
  return {
    added: [...next.keys()].filter((path) => !previous.has(path)).sort(),
    changed: [...next.keys()]
      .filter((path) => previous.has(path) && previous.get(path) !== next.get(path)).sort(),
    removed: [...previous.keys()].filter((path) => !next.has(path)).sort(),
  };
};
const familyIndex = (families) => new Map([
  ...(families?.surfaces ?? []), ...(families?.behaviors ?? []),
].map(({ name, status, type }) => [`${type}:${name}`, status]));
const familyDelta = (before, after) => {
  const previous = familyIndex(before);
  const next = familyIndex(after);
  return {
    added: [...next.keys()].filter((key) => !previous.has(key)).sort(),
    removed: [...previous.keys()].filter((key) => !next.has(key)).sort(),
    statusChanged: [...next.keys()]
      .filter((key) => previous.has(key) && previous.get(key) !== next.get(key)).sort()
      .map((key) => `${key}: ${previous.get(key)} → ${next.get(key)}`),
  };
};
const deltaReport = active === null ? null : {
  denominator: {
    added: delta.added, changed: delta.changed, removed: delta.removed,
  },
  evidence: diffEntries(active.evidence, fresh.evidence),
  families: { ...familyDelta(active.families, fresh.families), open: delta.open },
};
const denominatorUnchanged = delta !== null
  && Object.values(delta).every((paths) => paths.length === 0);
const familiesUnchanged = active !== null
  && JSON.stringify(active.families) === JSON.stringify(fresh.families);
const mechanicalFalsePositive = uniqueReasons.length === 1
  && uniqueReasons[0] === 'topology'
  && denominatorUnchanged
  && familiesUnchanged;
const state = resolveCensusState({
  enabled: Boolean(profile.enabled),
  hasActive: active !== null,
  hasOpen: hasOpen || uniqueReasons.includes('builder') || uniqueReasons.includes('topology'),
});
writeResult(JSON.stringify({
  builderVersion: CENSUS_BUILDER_VERSION,
  changeBinding: fresh.fingerprints.topology,
  delta: deltaReport,
  fresh: {
    ...fresh,
    profileReport: {
      decisions: profile.decisions || [],
      localScanners: profile.localScanners,
      overrides: profile.overrides || [],
    },
    state,
  },
  mechanicalFalsePositive,
  reasons: uniqueReasons,
  state,
}));
"""


_CHECKER = None


class CensusFileError(Exception):
    """A census control file failed the contained-regular-file contract."""


def _load_checker():
    """Load + cache the shared checker (module exec is not free — load once per
    process, not once per call site)."""
    global _CHECKER
    if _CHECKER is None:
        spec = importlib.util.spec_from_file_location("execute_ready_check", _CHECKER_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _CHECKER = mod
    return _CHECKER


def is_handoff_write(payload: dict) -> bool:
    if payload.get("tool_name") not in HANDLED_TOOLS:
        return False
    fp = (payload.get("tool_input") or {}).get("file_path", "")
    return bool(HANDOFF_PATH_RE.search(fp))


def _git_root(start: Path) -> Path:
    """Resolve the owning repository without treating process cwd as ownership."""
    completed = subprocess.run(
        ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
        capture_output=True,
        check=True,
        text=True,
        timeout=5,
    )
    return Path(completed.stdout.strip()).resolve()


def resolve_census_root_from_cwd(cwd: Path) -> Path:
    """CLI entry points may be invoked from any directory inside the repo."""
    return _git_root(cwd.resolve())


def resolve_handoff_repo_root(payload: dict) -> Path:
    """Return the repository that owns the handoff target.

    The raw target identifies the claimed repository, while the resolved target
    proves that `.handoff` did not escape it through a symlink. This permits a
    hook launched from another checkout without trusting an arbitrary payload
    path as the census root.
    """
    raw = (payload.get("tool_input") or {}).get("file_path", "")
    if not raw:
        raise ValueError("missing handoff target repository path")
    target = Path(raw)
    if not target.is_absolute():
        target = Path(os.path.abspath(Path.cwd() / target))
    else:
        target = Path(os.path.abspath(target))
    if target.parent.name != ".handoff":
        raise ValueError("handoff target is not rooted in a target repository .handoff directory")
    claimed_root = _git_root(target.parent.parent)
    expected_handoff = claimed_root / ".handoff"
    if target.parent != expected_handoff:
        raise ValueError("handoff target repository does not own the claimed .handoff path")
    resolved_target = target.resolve(strict=False)
    try:
        relative = resolved_target.relative_to(claimed_root)
    except ValueError as error:
        raise ValueError("handoff target repository containment check failed") from error
    if not relative.parts or relative.parts[0] != ".handoff":
        raise ValueError("handoff target repository containment check failed")
    return claimed_root


def _path_entry_exists(path: Path) -> bool:
    """Unlike exists(), count dangling symlinks as present activation state."""
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def _contained_regular_file(repo_root: Path, local_path) -> Path | None:
    """Resolve a readable repo-local regular file without following a final link."""
    if not isinstance(local_path, str) or not local_path or Path(local_path).is_absolute():
        return None
    lexical_root = Path(os.path.abspath(repo_root))
    candidate = Path(os.path.abspath(lexical_root / local_path))
    try:
        candidate.relative_to(lexical_root)
    except ValueError:
        return None
    try:
        info = candidate.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            return None
        if not info.st_mode & (stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH):
            return None
        canonical_root = lexical_root.resolve(strict=True)
        canonical = candidate.resolve(strict=True)
        canonical.relative_to(canonical_root)
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return None
    return candidate


def _read_census_control(repo_root: Path, local_path: str) -> str:
    target = _contained_regular_file(repo_root, local_path)
    if target is None:
        raise CensusFileError(f"invalid {Path(local_path).name}")
    try:
        return target.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise CensusFileError(f"unreadable {Path(local_path).name}") from error


def _normalize_local_scanners(records) -> tuple[bool, list[dict]]:
    """Return the exact proof-record contract without trusting arbitrary JSON shapes."""
    if not isinstance(records, list):
        return False, []
    normalized = []
    for raw in records:
        if not isinstance(raw, dict):
            return False, normalized
        record = {}
        for key in ("surface", "module", "export", "test"):
            value = raw.get(key)
            if not isinstance(value, str) or not value.strip():
                return False, normalized
            record[key] = value.strip()
        normalized.append(record)
    return True, normalized


def _validated_local_scanners(repo_root: Path, records: list[dict]) -> list[dict]:
    """Convert profile records to proof inputs without exposing unsafe paths."""
    validated = []
    for raw in records:
        surface = raw["surface"]
        module_path = _contained_regular_file(repo_root, raw.get("module"))
        test_path = _contained_regular_file(repo_root, raw.get("test"))
        export_name = raw.get("export")
        valid_export = isinstance(export_name, str) and bool(export_name.strip())
        validated.append({
            "surface": surface,
            "modulePath": str(module_path) if module_path else "",
            "testPath": str(test_path) if test_path else "",
            "exportName": export_name.strip() if valid_export else "",
            "validationError": not (module_path and test_path and valid_export),
        })
    return validated


def extract_content(payload: dict) -> str:
    ti = payload.get("tool_input") or {}
    tool = payload.get("tool_name")
    if tool == "Write":
        return ti.get("content", "") or ""
    if tool == "Edit":
        return ti.get("new_string", "") or ""
    if tool == "MultiEdit":
        return "\n".join((e or {}).get("new_string", "") for e in ti.get("edits", []) or [])
    return ""


def own_repository_slugs(repo_root: Path) -> list[str]:
    """Return the `host/owner/repo` slugs this repository's remotes point at."""
    try:
        completed = subprocess.run(
            ["git", "-C", str(repo_root), "config", "--get-regexp", r"^remote\..*\.url$"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if completed.returncode != 0:
        return []
    slugs = []
    for line in completed.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        match = REMOTE_URL_RE.match(parts[1].strip())
        if match is None:
            continue
        slug = f"{match.group('host')}/{match.group('owner')}/{match.group('repo')}"
        if slug not in slugs:
            slugs.append(slug)
    return slugs


def own_issue_pattern(repo_root):
    """Match only issue links of the repository that owns the handoff.

    A handoff routinely links the upstream issues a session produced. Without
    this restriction the first `/issues/<n>` in the prose wins, so a foreign
    link hijacks the anchor and the guard reports an unrelated issue number.
    """
    if repo_root is None:
        return None
    slugs = own_repository_slugs(repo_root)
    if not slugs:
        return None
    alternatives = "|".join(re.escape(slug) for slug in slugs)
    return re.compile(rf"(?<![A-Za-z0-9.-])(?:{alternatives})/issues/(\d+)", re.IGNORECASE)


def extract_issue(payload: dict, content: str, repo_root=None):
    # Own-repository content anchor first, then the skill-controlled filename.
    # The unrestricted content anchor only remains for a repository whose remote
    # is unparsable — there the filename is the only trustworthy signal, and a
    # handoff without one keeps today's behaviour. Deliberately NO branch
    # fallback: a meta/tooling handoff carries no issue (handoff skill supports
    # this) and must fail-open; a branch-based guess would mis-attribute the
    # branch's issue and false-block. None here → should_block() allows (not the
    # stale handoff we guard).
    own = own_issue_pattern(repo_root)
    if own is not None:
        m = own.search(content or "")
        if m:
            return int(m.group(1))
    fp = (payload.get("tool_input") or {}).get("file_path", "")
    m = FILENAME_ISSUE_RE.search(fp)
    if m:
        return int(m.group(1))
    if own is None:
        m = ISSUE_ANCHOR_RE.search(content or "")
        if m:
            return int(m.group(1))
    return None


def run_check(issue: int, intent: str) -> dict:
    """Delegate to the shared checker. Isolated so tests can patch it."""
    try:
        checker = _load_checker()
        return checker.build_and_evaluate(issue, "handoff", intent)
    except (Exception, SystemExit) as e:
        # checker itself unavailable → fail-closed (a target was identified)
        log(HOOK_NAME, f"checker load/exec failed: {e} → fail-closed")
        return {"deny_recommended": True, "graph_coherent": False,
                "target_buildable": False, "grandfathered": None,
                "violations": [f"#{issue}: checker unavailable ({e}) — fail-closed"]}


def _infer_intent(content: str) -> str:
    try:
        return _load_checker().infer_intent(content)
    except (Exception, SystemExit):
        return "build"


def scan_census_status(repo_root: Path, profile_json=None, active_json=None,
                       proof_timeout_ms=CENSUS_PROOF_TIMEOUT_MS) -> dict:
    """Scan census facts through the shipped JavaScript API, never a hook-local
    copy of its state or fingerprint rules."""
    active_path = repo_root / ".census" / "active.json"
    profile = profile_json if profile_json is not None else _read_census_control(
        repo_root, ".census/profile.json"
    )
    active = active_json
    if active is None:
        active = _read_census_control(repo_root, ".census/active.json") \
            if _path_entry_exists(active_path) else ""
    try:
        profile_body = json.loads(profile)
    except (json.JSONDecodeError, TypeError) as error:
        raise CensusFileError("invalid profile.json") from error
    if not isinstance(profile_body, dict):
        raise CensusFileError("invalid profile.json")
    if not isinstance(proof_timeout_ms, int) or isinstance(proof_timeout_ms, bool):
        raise ValueError("proof timeout must be an integer")
    proof_timeout_ms = max(1, min(
        proof_timeout_ms,
        CENSUS_BRIDGE_TIMEOUT_SECONDS * 1_000 - 1,
    ))
    profile_scanners_valid, profile_scanners = _normalize_local_scanners(
        profile_body.get("localScanners")
    )
    active_scanners_valid = True
    active_scanners = []
    if active:
        try:
            active_body = json.loads(active)
            report = active_body.get("profileReport") if isinstance(active_body, dict) else None
            active_scanners_valid, active_scanners = _normalize_local_scanners(
                report.get("localScanners") if isinstance(report, dict) else None
            )
        except (json.JSONDecodeError, TypeError):
            active_scanners_valid = False
    # Each record has two independently bounded proof phases (test + scanner).
    # Keep their aggregate ceiling below the outer bridge budget as well as
    # making every inner timeout strictly smaller than it.
    proof_timeout_ms = min(
        proof_timeout_ms,
        max(1, (CENSUS_BRIDGE_TIMEOUT_SECONDS * 1_000 - 2_000)
            // max(1, len(profile_scanners) * 2)),
    )
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", _CENSUS_SCAN],
        capture_output=True,
        check=True,
        input=json.dumps({
            "modulePath": str(_CENSUS_MODULE_PATH),
            "repoRoot": str(repo_root),
            "profileJson": profile,
            "activeJson": active,
            "localScanners": _validated_local_scanners(repo_root, profile_scanners),
            "profileLocalScanners": profile_scanners,
            "localScannersValid": profile_scanners_valid,
            "activeLocalScanners": active_scanners,
            "activeLocalScannersValid": active_scanners_valid,
            "proofTimeoutMs": proof_timeout_ms,
        }),
        text=True,
        timeout=CENSUS_BRIDGE_TIMEOUT_SECONDS,
    )
    return json.loads(completed.stdout)


def evaluate_census(repo_root: Path, proof_timeout_ms=CENSUS_PROOF_TIMEOUT_MS) -> dict:
    """Return the activation-aware handoff verdict.

    Missing/disabled/unactivated/unavailable census remains visible but does not
    gate ordinary work. Only an explicitly enabled, activated census may fail
    closed. Consumer overrides are reported and deliberately never fed into
    scanning, fingerprinting, or state resolution.
    """
    profile_path = repo_root / ".census" / "profile.json"
    active_path = repo_root / ".census" / "active.json"
    profile_present = _path_entry_exists(profile_path)
    active_present = _path_entry_exists(active_path)
    if not profile_present:
        if active_present:
            return {"state": "failed", "block_handoff": False,
                    "detail": "active census has no valid profile",
                    "reasons": ["profile"], "overrides": [], "override_applied": False}
        return {"state": "no_census", "block_handoff": False, "detail": "manual walk required",
                "reasons": [], "overrides": [], "override_applied": False}
    try:
        profile_json = _read_census_control(repo_root, ".census/profile.json")
        profile = json.loads(profile_json)
        if not isinstance(profile, dict):
            raise ValueError("profile must be an object")
    except (CensusFileError, json.JSONDecodeError, ValueError, TypeError):
        return {"state": "failed", "block_handoff": False,
                "detail": "census profile is invalid or unreadable",
                "reasons": ["profile"], "overrides": [], "override_applied": False}
    try:
        active_json = _read_census_control(repo_root, ".census/active.json") \
            if active_present else ""
        result = scan_census_status(repo_root, profile_json, active_json, proof_timeout_ms)
    except (OSError, subprocess.TimeoutExpired) as error:
        activated = active_present and bool(profile.get("enabled"))
        return {"state": "offline", "block_handoff": activated, "detail": str(error),
                "reasons": [], "overrides": profile.get("overrides", []), "override_applied": False}
    except Exception:
        activated = active_present and bool(profile.get("enabled"))
        return {"state": "failed", "block_handoff": activated,
                "detail": "census scan or active snapshot is invalid",
                "reasons": ["scan"], "overrides": profile.get("overrides", []),
                "override_applied": False}
    state = result["state"]
    activated = active_present
    overrides = profile.get("overrides", [])
    change_binding = result["changeBinding"]
    justified_change_local = any(
        override.get("scope") == "this change"
        and isinstance(override.get("reason"), str)
        and bool(override.get("reason").strip())
        and override.get("topologyFingerprint") == change_binding
        for override in overrides
        if isinstance(override, dict)
    )
    override_applied = result["mechanicalFalsePositive"] and justified_change_local
    return {
        "state": state,
        "block_handoff": activated and state == "refresh_required" and not override_applied,
        "detail": f"builder {result['builderVersion']}",
        "reasons": result["reasons"],
        "overrides": overrides,
        "override_applied": override_applied,
        "change_binding": result["changeBinding"],
        "mechanical_false_positive": result["mechanicalFalsePositive"],
        "delta": result.get("delta"),
    }


def _cap_entries(entries, limit: int):
    if not isinstance(entries, list) or len(entries) <= limit:
        return entries
    return [*entries[:limit], f"…and {len(entries) - limit} more"]


def cap_delta(delta, limit: int = CENSUS_DELTA_LIMIT):
    """Keep a diagnostic delta readable — head plus an honest remainder count."""
    if not isinstance(delta, dict):
        return delta
    capped = {}
    for group, entries in delta.items():
        if isinstance(entries, dict):
            capped[group] = {key: _cap_entries(value, limit) for key, value in entries.items()}
        else:
            capped[group] = _cap_entries(entries, limit)
    return capped


def worktree_identity(path):
    """Return (checkout root, shared git dir) or None when git cannot answer."""
    try:
        completed = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--show-toplevel", "--git-common-dir"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    lines = completed.stdout.splitlines()
    if len(lines) != 2 or not lines[0] or not lines[1]:
        return None
    # `--git-common-dir` may answer relative to the directory git ran in.
    toplevel = Path(os.path.realpath(lines[0]))
    common = Path(os.path.realpath(Path(path) / lines[1]))
    return toplevel, common


def checkout_diagnostic_lines(census_root, cwd=None) -> list[str]:
    """Name the checkout the census verdict describes.

    The census root comes from the handoff TARGET path, not from the session's
    working directory — handoff documents live in the main checkout so they
    survive worktree cleanup. A census describes the tree it was scanned in, so
    a refresh in another worktree legitimately does not count here; without this
    diagnosis the block reads as simply wrong to a session working elsewhere.
    """
    if census_root is None:
        return []
    lines = [
        f"  · evaluated checkout: {census_root}",
        "    (derived from the handoff target path — a census refresh in another",
        "     worktree does not count for this checkout)",
    ]
    try:
        # A diagnostic must never cost the block: an unusable working directory
        # only drops the extra sentence.
        here = worktree_identity(Path.cwd() if cwd is None else Path(cwd))
        there = worktree_identity(census_root)
    except OSError:
        return lines
    if here and there and here[1] == there[1] and here[0] != there[0]:
        lines += [
            "  · your working directory is a different worktree of the same repository:",
            f"    {here[0]} — refresh the evaluated checkout above, not this one",
        ]
    return lines


def build_census_block_message(issue: int, result: dict, census_root=None, cwd=None) -> str:
    reasons = ", ".join(result.get("reasons", [])) or "activated census is stale"
    lines = [
        f"CENSUS — Build-Handoff für #{issue} BLOCKED ({result.get('state', 'refresh_required')}):",
        "",
        f"  · {reasons}",
        *checkout_diagnostic_lines(census_root, cwd),
        "  · run `$census-update` and activate a verified current census",
    ]
    if result.get("overrides"):
        lines += [
            "  · change-local overrides remain visible but cannot green real drift",
        ]
    return "\n".join(lines)


def should_block(payload: dict):
    """Returns (block: bool, message: str)."""
    if not is_handoff_write(payload):
        return False, ""
    content = extract_content(payload)
    # The owning repository decides which issue links may anchor the handoff,
    # so it is resolved before the anchor is extracted.
    census_root = None
    root_error = None
    try:
        census_root = resolve_handoff_repo_root(payload)
    except Exception as error:
        root_error = error
    issue = extract_issue(payload, content, census_root)
    if issue is None:
        log(HOOK_NAME, "no identifiable issue target → fail-open allow")
        return False, ""
    intent = _infer_intent(content)

    def unavailable(error):
        return {
            "state": "failed",
            "block_handoff": intent == "build",
            "reasons": [f"target repository unavailable ({error})"],
            "overrides": [],
        }

    if census_root is None:
        census = unavailable(root_error)
    else:
        try:
            census = evaluate_census(census_root)
        except Exception as error:
            census = unavailable(error)
    log(HOOK_NAME, f"census state={census['state']} reasons={census.get('reasons', [])}")
    if intent == "build" and census.get("block_handoff"):
        return True, build_census_block_message(issue, census, census_root)
    if GUARD_ACK_RE.search(content):
        log(HOOK_NAME, "guard-ack override present → allow graph gate only")
        return False, ""
    result = run_check(issue, intent)
    if result.get("deny_recommended"):
        return True, build_block_message(issue, intent, result)
    return False, ""


def build_block_message(issue: int, intent: str, result: dict) -> str:
    lines = [f"DRIFT-GUARD — Handoff für #{issue} BLOCKED (nicht execute-ready):", ""]
    for v in result.get("violations", []):
        lines.append(f"  · {v}")
    if intent == "build" and not result.get("target_buildable", True) and result.get("graph_coherent"):
        lines.append(f"  · #{issue} ist HITL (gültig, aber nicht baubar) — erst grillen, kein /tdd")
    if result.get("open_blockers"):
        blocked = ", ".join(f"#{n}" for n in result["open_blockers"])
        lines.append(f"  · #{issue} ist nativ blockiert durch offene {blocked} "
                     f"(Blocking-SSOT = Issue-Dependencies) — erst Blocker landen")
    lines += [
        "",
        "Fix (eines):",
        f"  - re-grill #{issue} → Re-Grill-Reconcile gleicht ab + stempelt plan_revision neu, ODER",
        "  - bewusster Override in den Handoff-Body:",
        f"    <!-- guard-ack: #{issue} r<N> reason:<warum> by-user -->",
        "",
        "(Legacy-Alt-Anker: <!-- guard-legacy --> in den Anker-Issue setzen (einmalig,",
        " NICHT in den Handoff) → ganzer Graph grandfathered, kein Block.)",
    ]
    return "\n".join(lines)


def main() -> int:
    arguments = sys.argv[1:]
    if arguments[:1] == ["--census-status"] and arguments[1:] in ([], ["--verbose"]):
        try:
            root = resolve_census_root_from_cwd(Path.cwd())
            result = evaluate_census(root)
        except Exception as error:
            result = {"state": "failed", "block_handoff": False,
                      "detail": f"target repository unavailable ({error})",
                      "reasons": ["repository"], "overrides": [],
                      "override_applied": False}
        if arguments[1:] != ["--verbose"]:
            result["delta"] = cap_delta(result.get("delta"))
        print(json.dumps(result, sort_keys=True))
        return 0
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        log(HOOK_NAME, f"bad stdin: {e}")
        return 0
    try:
        block, message = should_block(payload)
    except Exception as e:
        log(HOOK_NAME, f"should_block crashed: {e} → allow (do not wedge handoff on hook bug)")
        return 0
    if not block:
        return 0
    print(message, file=sys.stderr)
    log(HOOK_NAME, f"BLOCKED handoff path={(payload.get('tool_input') or {}).get('file_path')!r}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
