#!/usr/bin/env python3
"""LoC-offender drive gate — git/subprocess adapter + CLI (, ADR-0034).

Thin shell over the pure core in loc_offender_core.py. Invoked by .githooks/pre-push
as `loc_offender_gate.py --check --head <local_sha> [--base-ref <ref>]`, once per
non-delete pushed branch ref. Exit 1 = red (push blocked). Pure logic + its tests
live in loc_offender_core.py.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from loc_offender_core import (
    FileChange,
    Verdict,
    evaluate,
    parse_loc_defer_trailers,
)

class GateError(RuntimeError):
    """A condition the gate cannot evaluate → fail-closed (exit 1)."""


def _git(args, cwd=None) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise GateError(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def _ref_exists(ref: str, cwd=None) -> bool:
    return subprocess.run(["git", "rev-parse", "--verify", "--quiet", ref],
                          cwd=cwd, capture_output=True).returncode == 0


def resolve_base_ref(explicit, cwd=None) -> str:
    """origin/HEAD → origin/main → fail-closed. An explicit --base-ref wins if valid."""
    if explicit:
        if _ref_exists(explicit, cwd):
            return explicit
        raise GateError(f"--base-ref {explicit!r} nicht auflösbar.")
    head = subprocess.run(["git", "rev-parse", "--abbrev-ref", "origin/HEAD"],
                          cwd=cwd, capture_output=True, text=True)
    if head.returncode == 0 and head.stdout.strip():
        return head.stdout.strip()
    if _ref_exists("origin/main", cwd):
        return "origin/main"
    raise GateError("keine base-ref auflösbar (origin/HEAD, origin/main fehlen) → fail-closed.")


def load_max_lines(path=None):
    """Read maxLines + offenders set from max-lines-allowlist.json (the single SSOT).

    Missing file / malformed JSON / missing keys → GateError, not a bare
    exception — run_gate's `except GateError` already turns that into a normal
    red gate message (with the SKIP_CI_GUARDS escape hatch) instead of a raw
    traceback escaping the gate.
    """
    p = Path(path) if path else _repo_root() / "max-lines-allowlist.json"
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        return int(raw["maxLines"]), set(raw["offenders"])
    except GateError:
        raise
    except Exception as exc:
        raise GateError(f"max-lines-allowlist.json unlesbar/ungültig ({p}): {exc}") from exc


def _repo_root() -> Path:
    return Path(_git(["rev-parse", "--show-toplevel"]).strip())


def _count_lines_at(rev: str, path: str, cwd=None):
    """wc -l style count of <rev>:<path>; None if the path does not exist there."""
    r = subprocess.run(["git", "show", f"{rev}:{path}"], cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        return None
    body = r.stdout
    if body == "":
        return 0
    return len(body[:-1].split("\n")) if body.endswith("\n") else len(body.split("\n"))


def parse_numstat_z(raw: str):
    """Parse `git diff --numstat -z --find-renames` into (added, deleted, old_path, path).
    -z record: `A\\tD\\tpath\\0` normally; `A\\tD\\t\\0from\\0to\\0` for renames;
    `-` for added/deleted on binary files."""
    toks = raw.split("\0")
    i, out = 0, []
    while i < len(toks):
        field = toks[i]
        if field == "":
            i += 1
            continue
        added, deleted, inline = (field.split("\t") + ["", "", ""])[:3]
        if inline == "":  # rename → next two tokens are from, to
            old_path, path = toks[i + 1], toks[i + 2]
            i += 3
        else:
            old_path, path = None, inline
            i += 1
        out.append((added, deleted, old_path, path))
    return out


def collect_changes(base: str, head: str, offenders, cwd=None):
    """Build FileChange entries for diff files that touch an offender (matched by
    old path on rename). Non-offender files are skipped (no git line-count calls)."""
    raw = _git(["diff", "--numstat", "-z", "--find-renames", base, head], cwd=cwd)
    changes = []
    for added, deleted, old_path, path in parse_numstat_z(raw):
        key = old_path or path
        if key not in offenders:
            continue
        binary = added == "-" or deleted == "-"
        changed = 0 if binary else int(added) + int(deleted)
        base_lines = _count_lines_at(base, key, cwd) or 0
        head_lines = _count_lines_at(head, path, cwd)
        changes.append(FileChange(path=path, old_path=old_path, changed_loc=changed,
                                  head_lines=head_lines, base_lines=base_lines, binary=binary))
    return changes


def collect_defer_values(base: str, head: str, cwd=None):
    """All `Loc-Defer:` trailer values across the slice commits (real trailer block,
    via git's own parser — not a %B body grep)."""
    out = _git(["log", f"{base}..{head}",
                "--format=%(trailers:key=Loc-Defer,valueonly,unfold)"], cwd=cwd)
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


DEFAULT_MAX_LINES = 300  # only the fallback when the allowlist itself is unreadable


def run_gate(head: str, base_ref=None, cwd=None):
    """Resolve base, collect the slice diff + defers, evaluate. GateError → red.
    Returns (Verdict, max_lines) so the caller's repair message needs no re-read."""
    max_lines = DEFAULT_MAX_LINES
    try:
        ref = resolve_base_ref(base_ref, cwd)
        base = _git(["merge-base", ref, head], cwd=cwd).strip()
        max_lines, offenders = load_max_lines()
        changes = collect_changes(base, head, offenders, cwd)
        defers, errors = parse_loc_defer_trailers(collect_defer_values(base, head, cwd))
        return evaluate(changes, offenders, defers, max_lines, defer_errors=errors), max_lines
    except GateError as exc:
        v = Verdict(ok=False)
        v.reds.append(f"{exc} → fail-closed (Notausgang: SKIP_CI_GUARDS=1 git push).")
        return v, max_lines


_REPAIR = (
    "→ schrumpfen (≤{max}) ODER Aufschub:\n"
    '   git commit --amend --trailer "Loc-Defer: file=<pfad>; reason=grossfile-partial; followup=#NNN"\n'
    "→ Notausgang: SKIP_CI_GUARDS=1 git push")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="loc_offender_gate.py", description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="run the gate (exit 1 = red)")
    ap.add_argument("--head", required=True, help="pushed commit SHA (the slice head)")
    ap.add_argument("--base-ref", dest="base_ref", help="integration base ref (default: origin/HEAD→origin/main)")
    args = ap.parse_args(argv)

    v, max_lines = run_gate(args.head, args.base_ref)
    for w in v.warnings:
        print(f"⚠ LoC-Offender: {w}")
    if v.ok:
        return 0
    print("🔴 LoC-Offender-Gate — Push blockiert:")
    for r in v.reds:
        print(f"   {r}")
    print(_REPAIR.format(max=max_lines))
    return 1


if __name__ == "__main__":
    sys.exit(main())
