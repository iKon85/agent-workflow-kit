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
first, filename fallback); delegates ALL coherence to scripts/execute-ready-check.py
(--mode handoff). Deny = exit 2 + stderr (house pattern: enforce-worktree.py,
block-secrets.py). Override: a deliberate `<!-- guard-ack: #<n> r<N> reason:… by-user -->`
in the content. fail-closed once a target is parsed (the checker enforces that);
fail-OPEN when no handoff target is identifiable (not the stale handoff we guard).

Audit log: .claude/logs/drift-guard.log
"""
import importlib.util
import json
import re
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
    except Exception as e:
        # checker itself unavailable → fail-closed (a target was identified)
        log(HOOK_NAME, f"checker load/exec failed: {e} → fail-closed")
        return {"deny_recommended": True, "graph_coherent": False,
                "target_buildable": False, "grandfathered": None,
                "violations": [f"#{issue}: checker unavailable ({e}) — fail-closed"]}


def _infer_intent(content: str) -> str:
    try:
        return _load_checker().infer_intent(content)
    except Exception:
        return "build"


def should_block(payload: dict):
    """Returns (block: bool, message: str)."""
    if not is_handoff_write(payload):
        return False, ""
    content = extract_content(payload)
    if GUARD_ACK_RE.search(content):
        log(HOOK_NAME, "guard-ack override present → allow")
        return False, ""
    issue = extract_issue(payload, content)
    if issue is None:
        log(HOOK_NAME, "no identifiable issue target → fail-open allow")
        return False, ""
    intent = _infer_intent(content)
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
