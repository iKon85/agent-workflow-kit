#!/usr/bin/env python3
"""Offer the planning-artifact ignore rules for a consumer `.gitignore`.

The shipped skills write `PLAN.md`, `PLAN-REVIEW-LOG.md`, and `ANNAHMEN.md`
into a session worktree, but `.gitignore` is a consumer file the kit does not
own: `init` and `update` never touch it. This helper is the one place that
closes that gap, and it closes it only when a user explicitly approves the
offer inside `/setup-workflow`.

Contract:

- `preview` reads and reports; it never writes.
- `apply` appends one marker block and nothing else. It never rewrites,
  reorders, or removes an existing line, so a second run is a byte-identical
  no-op once the rules are in place.
- Rules a consumer already has — by any pattern, including a wildcard — are
  reported as covered and never duplicated.
- A marker block that the consumer has since edited is theirs: the helper
  blocks instead of repairing it.
- Nothing here runs during `init`/`update` reconciliation.

Usage:
  python3 scripts/worktree-lifecycle/ignore_seed.py preview [--repo PATH] [--json]
  python3 scripts/worktree-lifecycle/ignore_seed.py apply   [--repo PATH] [--json]

Exit codes: 0 previewed/appended/nothing-to-do · 2 blocked · 1 error.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent / "plan-artifacts.json"

BLOCK_START = "# >>> agent-workflow-kit: planning-artifacts/v1 >>>"
BLOCK_END = "# <<< agent-workflow-kit: planning-artifacts/v1 <<<"
BLOCK_NOTE = (
    "# Planning artifacts the agent workflow skills write into a session\n"
    "# worktree. They are session scratch, never part of the change. Added by\n"
    "# setup-workflow on request; this block is yours to edit or delete.\n"
)


class IgnoreSeedError(RuntimeError):
    """A safe, user-visible refusal."""


@dataclass(frozen=True)
class IgnorePlan:
    """What an approval would append — and nothing more."""

    repo: Path
    gitignore_exists: bool
    already_ignored: tuple[str, ...]
    pending: tuple[str, ...]
    tracked: tuple[str, ...]
    block: str | None
    status: str
    detail: str

    def as_dict(self) -> dict:
        return {
            "status": self.status,
            "detail": self.detail,
            "gitignoreExists": self.gitignore_exists,
            "alreadyIgnored": list(self.already_ignored),
            "pending": list(self.pending),
            "tracked": list(self.tracked),
            "block": self.block,
        }


def load_artifacts(manifest: Path = MANIFEST) -> tuple[str, ...]:
    """Return the kit-declared planning artifacts, in declaration order."""
    try:
        document = json.loads(manifest.read_text(encoding="utf-8"))
        return tuple(entry["path"] for entry in document["artifacts"])
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise IgnoreSeedError(f"cannot read planning-artifact manifest: {error}") from error


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            ["git", *args], cwd=repo, capture_output=True, text=True,
        )
    except OSError as error:  # pragma: no cover - git absent
        raise IgnoreSeedError(f"cannot run git: {error}") from error


def is_ignored(repo: Path, path: str) -> bool:
    """True when any ignore rule already matches `path`.

    `--no-index` asks the pattern question, not the index question, so an
    artifact that a consumer once committed still reports its real rule state.
    """
    return _git(repo, "check-ignore", "-q", "--no-index", "--", path).returncode == 0


def is_tracked(repo: Path, path: str) -> bool:
    """True when the artifact is committed — an ignore rule cannot untrack it."""
    result = _git(repo, "ls-files", "--error-unmatch", "--", path)
    return result.returncode == 0


def render_block(paths: tuple[str, ...]) -> str:
    """The exact text an approval appends."""
    listed = "".join(f"{path}\n" for path in paths)
    return f"{BLOCK_START}\n{BLOCK_NOTE}{listed}{BLOCK_END}\n"


def _read_gitignore(repo: Path) -> tuple[bool, str]:
    target = repo / ".gitignore"
    try:
        return True, target.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False, ""
    except OSError as error:
        raise IgnoreSeedError(f"cannot read {target}: {error}") from error


def plan(repo: Path, manifest: Path = MANIFEST) -> IgnorePlan:
    """Report what an approval would change. Reads only."""
    repo = Path(repo)
    if not (repo / ".git").exists():
        raise IgnoreSeedError(f"not a git repository: {repo}")
    artifacts = load_artifacts(manifest)
    exists, text = _read_gitignore(repo)
    covered = tuple(path for path in artifacts if is_ignored(repo, path))
    pending = tuple(path for path in artifacts if path not in covered)
    tracked = tuple(path for path in artifacts if is_tracked(repo, path))
    has_block = BLOCK_START in text

    if not pending:
        return IgnorePlan(
            repo=repo, gitignore_exists=exists, already_ignored=covered,
            pending=(), tracked=tracked, block=None, status="nothing-to-do",
            detail="every planning artifact is already ignored",
        )
    if has_block:
        return IgnorePlan(
            repo=repo, gitignore_exists=exists, already_ignored=covered,
            pending=pending, tracked=tracked, block=None, status="blocked",
            detail=(
                "the marker block exists but no longer covers "
                f"{', '.join(pending)} — that block is consumer-owned; "
                "edit .gitignore yourself"
            ),
        )
    return IgnorePlan(
        repo=repo, gitignore_exists=exists, already_ignored=covered,
        pending=pending, tracked=tracked, block=render_block(pending),
        status="append",
        detail=f"would append {len(pending)} rule(s) in one marker block",
    )


def apply(repo: Path, manifest: Path = MANIFEST) -> IgnorePlan:
    """Append the previewed block. Never rewrites an existing line."""
    decision = plan(repo, manifest)
    if decision.status != "append":
        return decision
    target = Path(repo) / ".gitignore"
    _, text = _read_gitignore(Path(repo))
    prefix = text
    if prefix and not prefix.endswith("\n"):
        prefix += "\n"
    if prefix and not prefix.endswith("\n\n"):
        prefix += "\n"
    try:
        target.write_text(prefix + decision.block, encoding="utf-8")
    except OSError as error:
        raise IgnoreSeedError(f"cannot write {target}: {error}") from error
    return IgnorePlan(
        repo=decision.repo, gitignore_exists=True,
        already_ignored=decision.already_ignored, pending=decision.pending,
        tracked=decision.tracked, block=decision.block, status="appended",
        detail=f"appended {len(decision.pending)} rule(s) to .gitignore",
    )


def _report(decision: IgnorePlan, *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(decision.as_dict(), indent=2))
        return
    print(f"{decision.status} — {decision.detail}")
    if decision.already_ignored:
        print(f"  already ignored: {', '.join(decision.already_ignored)}")
    if decision.tracked:
        print(
            "  tracked in git (an ignore rule cannot untrack these): "
            f"{', '.join(decision.tracked)}"
        )
    if decision.block:
        label = "appended" if decision.status == "appended" else "would append"
        print(f"  {label}:")
        for line in decision.block.rstrip("\n").split("\n"):
            print(f"    {line}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="ignore_seed.py")
    parser.add_argument("command", choices=("preview", "apply"))
    parser.add_argument("--repo", default=".")
    parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        decision = plan(args.repo) if args.command == "preview" else apply(args.repo)
    except IgnoreSeedError as error:
        print(str(error), file=sys.stderr)
        return 1
    _report(decision, as_json=args.json)
    return 2 if decision.status == "blocked" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
