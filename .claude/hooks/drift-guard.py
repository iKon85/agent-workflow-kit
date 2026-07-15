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

Mechanism: self-filters to `.handoff/*.md`; extracts the issue (content anchor
first, filename fallback); delegates graph coherence to
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
import subprocess
import sys
from pathlib import Path

from _hook_utils import log

HOOK_NAME = "drift-guard"
HANDLED_TOOLS = {"Write", "Edit", "MultiEdit"}
HANDOFF_PATH_RE = re.compile(r"/\.handoff/[^/]*\.md$")
ISSUE_ANCHOR_RE = re.compile(r"/issues/(\d+)")          # content-first: [#n](…/issues/n)
FILENAME_ISSUE_RE = re.compile(r"(\d+)\.md$")           # fallback: <date>-<n>.md
# Override must be issue-scoped, rev-scoped, reasoned, by-user (Codex R1 — not the cheap `known`).
GUARD_ACK_RE = re.compile(r"<!--\s*guard-ack:\s*#?\d+\s+r\d+\s+reason:.+\bby-user\s*-->",
                          re.IGNORECASE | re.DOTALL)

# Load the shared checker (hyphenated filename → importlib). Repo root = parents[2].
_CHECKER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "execute-ready-check.py"
_CENSUS_MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "census" / "index.mjs"

_CENSUS_SCAN = r"""
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { modulePath, repoRoot, profileJson, activeJson } = JSON.parse(readFileSync(0, 'utf8'));
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
if (active !== null && active.fingerprints?.builder !== fresh.fingerprints.builder) reasons.push('builder');
if (active !== null && active.fingerprints?.topology !== fresh.fingerprints.topology) reasons.push('topology');
const hasOpen = [...fresh.families.surfaces, ...fresh.families.behaviors]
  .some(({ status }) => status === CENSUS_VERDICTS.open);
if (hasOpen) reasons.push('open');
const delta = active === null ? null : diffCensus(active, fresh);
const denominatorUnchanged = delta !== null
  && Object.values(delta).every((paths) => paths.length === 0);
const familiesUnchanged = active !== null
  && JSON.stringify(active.families) === JSON.stringify(fresh.families);
const mechanicalFalsePositive = reasons.length === 1
  && reasons[0] === 'topology'
  && denominatorUnchanged
  && familiesUnchanged;
const state = resolveCensusState({
  enabled: Boolean(profile.enabled),
  hasActive: active !== null,
  hasOpen: hasOpen || reasons.includes('builder') || reasons.includes('topology'),
});
process.stdout.write(JSON.stringify({
  builderVersion: CENSUS_BUILDER_VERSION,
  changeBinding: fresh.fingerprints.topology,
  fresh: { ...fresh, state },
  mechanicalFalsePositive,
  reasons,
  state,
}));
"""


_CHECKER = None


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


def extract_issue(payload: dict, content: str):
    # Content anchor first, filename fallback. Deliberately NO branch fallback:
    # a meta/tooling handoff carries no issue (handoff skill supports this) and
    # must fail-open; a branch-based guess would mis-attribute the branch's issue
    # and false-block. None here → should_block() allows (not the stale handoff we guard).
    m = ISSUE_ANCHOR_RE.search(content or "")
    if m:
        return int(m.group(1))
    fp = (payload.get("tool_input") or {}).get("file_path", "")
    m = FILENAME_ISSUE_RE.search(fp)
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


def scan_census_status(repo_root: Path) -> dict:
    """Scan census facts through the shipped JavaScript API, never a hook-local
    copy of its state or fingerprint rules."""
    profile_path = repo_root / ".census" / "profile.json"
    active_path = repo_root / ".census" / "active.json"
    profile = profile_path.read_text(encoding="utf-8")
    active = active_path.read_text(encoding="utf-8") if active_path.exists() else ""
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", _CENSUS_SCAN],
        capture_output=True,
        check=True,
        input=json.dumps({
            "modulePath": str(_CENSUS_MODULE_PATH),
            "repoRoot": str(repo_root),
            "profileJson": profile,
            "activeJson": active,
        }),
        text=True,
        timeout=15,
    )
    return json.loads(completed.stdout)


def evaluate_census(repo_root: Path) -> dict:
    """Return the activation-aware handoff verdict.

    Missing/disabled/unactivated/unavailable census remains visible but does not
    gate ordinary work. Only an activated refresh requirement blocks a build
    handoff. Consumer overrides are reported and deliberately never fed into
    scanning, fingerprinting, or state resolution.
    """
    profile_path = repo_root / ".census" / "profile.json"
    active_path = repo_root / ".census" / "active.json"
    if not profile_path.exists():
        return {"state": "no_census", "block_handoff": False, "detail": "manual walk required",
                "reasons": [], "overrides": [], "override_applied": False}
    try:
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
    except Exception as error:
        return {"state": "failed", "block_handoff": active_path.exists(), "detail": str(error),
                "reasons": ["profile"], "overrides": [], "override_applied": False}
    try:
        result = scan_census_status(repo_root)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"state": "offline", "block_handoff": False, "detail": str(error),
                "reasons": [], "overrides": profile.get("overrides", []), "override_applied": False}
    except Exception as error:
        return {"state": "failed", "block_handoff": active_path.exists(), "detail": str(error),
                "reasons": ["scan"], "overrides": profile.get("overrides", []),
                "override_applied": False}
    state = result["state"]
    activated = active_path.exists()
    overrides = profile.get("overrides", [])
    change_binding = result["changeBinding"]
    justified_change_local = any(
        override.get("scope") == "this change"
        and bool(override.get("reason"))
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
    }


def build_census_block_message(issue: int, result: dict) -> str:
    reasons = ", ".join(result.get("reasons", [])) or "activated census is stale"
    lines = [
        f"CENSUS — Build-Handoff für #{issue} BLOCKED ({result.get('state', 'refresh_required')}):",
        "",
        f"  · {reasons}",
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
    issue = extract_issue(payload, content)
    if issue is None:
        log(HOOK_NAME, "no identifiable issue target → fail-open allow")
        return False, ""
    intent = _infer_intent(content)
    try:
        census_root = resolve_handoff_repo_root(payload)
        census = evaluate_census(census_root)
    except Exception as error:
        census = {
            "state": "failed",
            "block_handoff": intent == "build",
            "reasons": [f"target repository unavailable ({error})"],
            "overrides": [],
        }
    log(HOOK_NAME, f"census state={census['state']} reasons={census.get('reasons', [])}")
    if intent == "build" and census.get("block_handoff"):
        return True, build_census_block_message(issue, census)
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
    if sys.argv[1:] == ["--census-status"]:
        try:
            root = resolve_census_root_from_cwd(Path.cwd())
            result = evaluate_census(root)
        except Exception as error:
            result = {"state": "failed", "block_handoff": False,
                      "detail": f"target repository unavailable ({error})",
                      "reasons": ["repository"], "overrides": [],
                      "override_applied": False}
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
