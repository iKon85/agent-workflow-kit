#!/usr/bin/env python3
"""
pr-body-check.py — mechanical guard for the PR-body conventions that were until
now prose-only.

Called by `wrapup` Step 0c AFTER the PR has been created/reused, BEFORE the
merge gate. Turns four instruction-only rules into a check that actually fires:

  1. Anker-Slice (Issue HAS a parent) → body MUST contain `Part of #<parent>`
     and MUST NOT contain a close-keyword on the **parent anchor** number
     (close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved, case-insens.)
     — the incident: `closes #<anker>` on a slice-PR closed the wave anchor.
     A `closes #<foreign-leaf>` (any number ≠ parent) stays ALLOWED.
  2. Atomar Leaf (Issue has NO parent / FREI) → body MUST contain an ACTIVE
     `closes #<issue>` — not inside a code span / backticks (else GitHub's
     auto-close never fires, wrapup Step 5b lesson).
  3. `**Retro:**`-Pflichtzeile present in one of the Slice-7 forms
     (`gefahren …` | `übersprungen …`), with a space after the marker.
  4. Exactly one valid `E2E-NA: <reason>` trailer in the immutable pull-request
     range requires active `E2E: n/a — <reason>` PR-body evidence.

Scope: this script checks ONLY the closes/Part-of anchor rule, the
`**Retro:**` line, and E2E exemption evidence. It does NOT parse or validate
`annahme-drift` markers
(those are prose-/judgment-driven in wrapup Step 0c + 5e, deliberately not
mechanised — R2-F6). The annahme-drift block therefore runs BEFORE this
check in wrapup Step 0c so the body the script sees is final.

Exit codes:
  0 — green (no violations)
  1 — violation(s) found → wrapup STOPs, fix body via `gh pr edit --body-file`
  2 — not checkable (no issue-number derivable from the branch, or PR body
      unavailable) → warn, do NOT block (fail-open, like drift-guard).

The pure functions below carry the logic + the unit tests; gh/git access is a
thin shell. NOT a hook — `wrapup` invokes it (Design).

Usage:
  pr-body-check.py [--branch <name>] [--issue <n>] [--parent <n>|FREI]
                   [--body-file <path>] [--base-sha <sha>] [--head-sha <sha>]
All flags optional; unset → derived from the current branch + live PR via gh.

Audit log: .claude/logs/pr-body-check.log
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_config import ConfigError, load_board_config  # noqa: E402
from pr_body_e2e import (  # noqa: E402
    check_e2e_na_line,
    fetch_has_e2e_na_trailer,
    fetch_pr_range,
)

try:
    _CFG = load_board_config()
except ConfigError as exc:
    print(f"[FAIL] pr-body-check: Board-Profil nicht verfügbar — {exc}", file=sys.stderr)
    sys.exit(1)


def _spaced(marker: str) -> str:
    """Escape a marker, letting any run of whitespace inside it match `\\s+`."""
    return r"\s+".join(re.escape(tok) for tok in marker.split())


LOG_DIR = Path(".claude/logs")
LOG_NAME = "pr-body-check"

# Branch prefixes + the `Part of` / `**Retro:**` markers are PROJECT conventions
# → read from the board profile. GitHub's auto-close keywords are a PLATFORM
# constant (GitHub only auto-closes on exactly this set), so they stay hardcoded
# here — configuring them would be a footgun, not a portability win.
BRANCH_ISSUE_RE = re.compile(
    r"^(?:" + "|".join(re.escape(p) for p in _CFG["branchPrefixes"]) + r")/(\d+)-")
CLOSE_KEYWORDS = r"close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved"
RETRO_RE = re.compile(
    re.escape(_CFG["prMarkers"]["retroMarker"]) + r"\s+("
    + "|".join(re.escape(v) for v in _CFG["prMarkers"]["retroValues"]) + r")\b",
    re.IGNORECASE)
PART_OF_RE_SRC = _spaced(_CFG["prMarkers"]["partOf"])
INLINE_CODE_RE = re.compile(r"`[^`]*`")
FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)


def log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        from datetime import datetime
        with (LOG_DIR / f"{LOG_NAME}.log").open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except Exception:
        pass


# --- pure parsers / checks --------------------------------------------------
def parse_issue_from_branch(branch: str):
    """Issue number from `feat/<n>-slug` (also fix/chore/docs), or None."""
    m = BRANCH_ISSUE_RE.match(branch or "")
    return int(m.group(1)) if m else None


def strip_code(text: str) -> str:
    """Remove fenced + inline code spans so a keyword that only lives inside
    backticks does not count as active (GitHub ignores it for auto-close)."""
    return INLINE_CODE_RE.sub(" ", FENCED_CODE_RE.sub(" ", text or ""))


def _close_on(body: str, n: int) -> bool:
    """True if an ACTIVE close-keyword targets #n (outside code spans).

    Matches `closes #n`, the colon form `closes: #n` (GitHub auto-closes on both
    — the colon form was the R2-F3 bypass on the anchor guard), AND the
    full-URL form `closes https://github.com/<owner>/<repo>/issues/<n>` (GitHub
    auto-closes on this too — exactly the class bypass this script exists
    to catch).
    """
    target = rf"(?:#0*{n}(?!\d)|https?://\S+/issues/0*{n}(?!\d))"
    pat = re.compile(
        rf"\b(?:{CLOSE_KEYWORDS})(?::\s*|\s+){target}", re.IGNORECASE)
    return bool(pat.search(strip_code(body)))


def _part_of(body: str, n: int) -> bool:
    return bool(re.search(
        rf"\b{PART_OF_RE_SRC}(?::\s*|\s+)#0*{n}(?!\d)", body or "", re.IGNORECASE))


def check_pr_body(body: str, issue: int, parent, is_anchor: bool = False,
                  has_e2e_na_trailer: bool = False):
    """Return a list of violation strings ([] = green).

    parent is the anchor issue number, or None for an atomar Leaf.
    is_anchor: the branch issue IS itself a Wellen-Anker (type:cluster) —
    Wave-PR-Fall: ein PR auf `feat/<anker#>-…` closed die Leaf-Issues,
    nie den Anker selbst.
    """
    violations = []
    body = body or ""

    if parent is not None:
        # Anker-Slice
        if not _part_of(body, parent):
            violations.append(
                f"Anker-Slice: Body braucht `Part of #{parent}` (fehlt).")
        if _close_on(body, parent):
            violations.append(
                f"Anker-Slice: Body enthält ein close-Keyword auf den Anker "
                f"#{parent} — das schließt den Wellen-Anker beim Merge verfrüht "
                f". `Part of #{parent}` nutzen, kein closes.")
    elif is_anchor:
        # Wave-PR auf dem Anker-Branch selbst (Branch trägt die Anker-Nummer)
        if not _part_of(body, issue):
            violations.append(
                f"Wave-PR auf Anker-Branch: Body braucht `Part of #{issue}` (fehlt).")
        if _close_on(body, issue):
            violations.append(
                f"Wave-PR: Body enthält ein close-Keyword auf den Anker #{issue} "
                f"— das schließt den Anker beim Merge. Entfernen; die "
                f"Leaf-Issues per `closes #<leaf>` schließen.")
    else:
        # Atomar Leaf
        if not _close_on(body, issue):
            violations.append(
                f"Leaf-PR: aktives `closes #{issue}` fehlt (oder steht in "
                f"Backticks → GitHub-Auto-Close greift dann nicht).")

    if not RETRO_RE.search(body):
        violations.append(
            "Pflichtzeile `**Retro:** gefahren — …` oder "
            "`**Retro:** übersprungen — <Grund>` fehlt.")

    violations.extend(check_e2e_na_line(body, has_e2e_na_trailer))
    return violations


# --- thin git/gh shell ------------------------------------------------------
def _run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip()
    except Exception:
        return -1, ""


def current_branch():
    rc, out = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    return out if rc == 0 and out else None


def fetch_parent(number: int):
    """Parent issue number via board-sync.py, or None (FREI = atomar)."""
    rc, out = _run(["python3", "scripts/board-sync.py", "parent-of", str(number)])
    if rc != 0 or not out or out.strip() == "FREI":
        return None
    try:
        return int(out.strip())
    except ValueError:
        return None


def fetch_pr_body(branch: str):
    rc, out = _run(["gh", "pr", "view", branch, "--json", "body", "-q", ".body"])
    return out if rc == 0 else None


def fetch_is_anchor(number: int) -> bool:
    """True wenn das Issue selbst ein Wellen-Anker ist (Label type:cluster)."""
    rc, out = _run(["gh", "issue", "view", str(number),
                    "--json", "labels", "-q", ".labels[].name"])
    if rc != 0:
        return False  # fail-open in den Leaf-Pfad (bisheriges Verhalten)
    return "type:cluster" in out.splitlines()


def resolve_has_e2e_na(args, branch: str) -> bool:
    """Explicit test overrides win; otherwise use immutable GitHub PR SHAs."""
    if args.base_sha or args.head_sha:
        base_sha, head_sha = args.base_sha, args.head_sha
    else:
        base_sha, head_sha = fetch_pr_range(branch)
    return fetch_has_e2e_na_trailer(base_sha, head_sha)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--branch", help="default: current git branch")
    ap.add_argument("--issue", type=int, help="override branch-derived issue #")
    ap.add_argument("--parent", help="override parent (number or FREI)")
    ap.add_argument("--body-file", help="read PR body from file instead of gh")
    ap.add_argument("--base-sha", help="override immutable PR base SHA")
    ap.add_argument("--head-sha", help="override immutable PR head SHA")
    args = ap.parse_args()

    branch = args.branch or current_branch()
    issue = args.issue if args.issue is not None else (
        parse_issue_from_branch(branch) if branch else None)
    if issue is None:
        print(f"[WARN] pr-body-check: keine Issue-Nummer aus Branch '{branch}' "
              f"ableitbar — übersprungen (kein Block).")
        log(f"branch={branch} no-issue → exit 2")
        return 2

    if args.body_file:
        try:
            body = Path(args.body_file).read_text(encoding="utf-8")
        except Exception as e:
            print(f"[WARN] pr-body-check: --body-file unlesbar ({e}) — übersprungen.")
            return 2
    else:
        body = fetch_pr_body(branch)
        if body is None:
            print(f"[WARN] pr-body-check: PR-Body für '{branch}' nicht abrufbar "
                  f"(kein PR? gh/Netz?) — übersprungen (kein Block).")
            log(f"branch={branch} issue={issue} no-pr-body → exit 2")
            return 2

    if args.parent is not None:
        parent = None if args.parent.strip().upper() == "FREI" else int(args.parent)
    else:
        parent = fetch_parent(issue)

    is_anchor = fetch_is_anchor(issue) if parent is None else False
    has_e2e_na = resolve_has_e2e_na(args, branch)
    violations = check_pr_body(
        body,
        issue,
        parent,
        is_anchor=is_anchor,
        has_e2e_na_trailer=has_e2e_na,
    )
    kind = ("Anker-Slice" if parent is not None
            else "Wave-PR" if is_anchor else "Leaf")
    log(f"branch={branch} issue={issue} parent={parent} kind={kind} "
        f"violations={len(violations)}")

    if violations:
        print(f"[FAIL] pr-body-check #{issue} ({kind}, parent={parent}):")
        for v in violations:
            print(f"  - {v}")
        return 1
    print(f"[OK] pr-body-check #{issue} ({kind}) — Body-Konventionen erfüllt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
