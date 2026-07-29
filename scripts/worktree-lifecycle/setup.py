#!/usr/bin/env python3
"""Create a configured, rollback-safe consumer worktree — optional, never a mandate.

One call cuts the profile's branch, adds the worktree at the profile's path, and
seeds it from the profile's flat declaration: `seed.paths` are copied verbatim
out of the main checkout, `seed.variables` are rendered into `.dev-ports` with
this worktree's own slot. The kit owns the mechanism only — it never reads,
parses, or patches a declared file's contents, so a hand-written secret crosses
into the worktree as bytes and nothing else.

A worktree that already exists is **adopted**, not re-seeded: its values are the
consumer's, including in a worktree some other tool created. Only a worktree
this call creates is seeded, and a seeding failure removes it again together
with the branch it cut, so a half-built checkout never survives the command.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import zlib
from pathlib import Path

from core import (
    LifecycleError,
    load_profile,
    local_branch_exists,
    main_worktree,
    registered_worktrees,
    run,
)

VARIABLES_FILE = ".dev-ports"
SLOT_MODULO = 900
SLOT_OFFSET = 1
SLOT_STRIDE = 10
# The ports browsers refuse to connect to above 1023 (Chrome's blocked list).
# This is protocol knowledge, not consumer policy: a dev server that lands here
# is unreachable in every project, so the allocator steps past it everywhere.
UNSAFE_PORTS = frozenset({
    1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000,
    6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="docs/agents/workflow-capabilities.json")
    # Resolved from the consumer profile when omitted — the integration
    # branch is never named inline.
    parser.add_argument("--base")
    parser.add_argument("issue")
    parser.add_argument("slug")
    parser.add_argument("branch_type", nargs="?", default="feat")
    return parser.parse_args()


def variable_slot(bases: tuple[int, ...], issue: str, branch: str) -> int:
    """This worktree's own slot: deterministic, and never on a blocked port.

    The issue number (or the branch's checksum when there is none) picks the
    slot, so the same slice always gets the same ports and two slices collide
    only by sharing a number they cannot share.
    """
    start = int(issue) if issue.isdigit() else zlib.crc32(branch.encode("utf-8"))
    slot = start % SLOT_MODULO + SLOT_OFFSET
    for _ in range(SLOT_MODULO):
        if not UNSAFE_PORTS.intersection(base + slot * SLOT_STRIDE for base in bases):
            return slot
        slot = slot % SLOT_MODULO + 1
    raise LifecycleError("no browser-safe allocation exists for the declared variables")


def copy_declared_paths(paths: tuple[str, ...], *, main: Path, worktree: Path) -> list[str]:
    """Copy each declared path verbatim; report the ones the checkout lacks.

    A declared path that the main checkout does not have is skipped and named:
    a fresh clone has no local config yet, and refusing to create the worktree
    over that would make the helper unusable exactly when it is needed most.
    """
    missing: list[str] = []
    for declared in paths:
        source = main / declared
        if source.is_symlink() or (source.exists() and not source.is_file()):
            raise LifecycleError(
                f"declared seed path is not a plain file: {declared} — "
                "the helper copies bytes and follows nothing",
            )
        if not source.exists():
            missing.append(declared)
            continue
        target = worktree / declared
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    return missing


def render_declared_variables(
    variables: tuple[tuple[str, int], ...],
    *,
    worktree: Path,
    issue: str,
    branch: str,
) -> None:
    """Write the declared bases, offset by this worktree's slot."""
    if not variables:
        return
    slot = variable_slot(tuple(base for _, base in variables), issue, branch)
    lines = [f"{name}={base + slot * SLOT_STRIDE}" for name, base in variables]
    (worktree / VARIABLES_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")


def commit_oid(repo: Path, rev: str) -> str | None:
    result = run(["git", "rev-parse", "--verify", f"{rev}^{{commit}}"], cwd=repo, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def ensure_reusable_base(main: Path, *, repo: Path, rev: str, base: str, label: str) -> None:
    """Reuse is safe only AT the base or cleanly behind it; anything else is stale.

    Both reuse paths skip `git worktree add`'s base argument, so without this
    guard a slice silently builds on whatever the old branch/worktree pointed at.
    """
    base_oid = commit_oid(main, base)
    if base_oid is None:
        raise LifecycleError(f"base {base!r} is not resolvable")
    current = commit_oid(repo, rev)
    if current is None:
        raise LifecycleError(f"{label}: HEAD is not resolvable")
    if current == base_oid:
        return
    behind = run(
        ["git", "merge-base", "--is-ancestor", current, base_oid],
        cwd=main,
        check=False,
    )
    if behind.returncode == 0:
        return
    raise LifecycleError(
        f"{label}: HEAD {current[:7]} is stale against base {base} ({base_oid[:7]}) — "
        "it is ahead of or diverged from the base. Land or rebase that work, or remove "
        "the worktree/branch, before reusing it."
    )


def remove_failed_worktree(main: Path, target: Path, branch: str, created_branch: bool) -> None:
    run(["git", "worktree", "remove", "--force", str(target)], cwd=main, check=False)
    if created_branch:
        run(["git", "branch", "-d", branch], cwd=main, check=False)


def create(args: argparse.Namespace) -> Path:
    cwd = Path.cwd()
    main = main_worktree(cwd)
    profile_path = Path(args.profile)
    if not profile_path.is_absolute():
        profile_path = main / profile_path
    profile = load_profile(profile_path)
    base = args.base or f"origin/{profile.main_branches[0]}"
    branch = profile.branch_name(args.issue, args.slug, args.branch_type)
    target = (main / profile.relative_path(args.issue, args.slug, args.branch_type)).resolve()

    if target in registered_worktrees(main):
        ensure_reusable_base(
            main, repo=target, rev="HEAD", base=base, label=f"worktree {target}"
        )
        print(f"Worktree already exists: {target} ({branch})")
        return target

    branch_existed = local_branch_exists(main, branch)
    if branch_existed:
        ensure_reusable_base(
            main, repo=main, rev=branch, base=base, label=f"branch {branch}"
        )
    command = ["git", "worktree", "add", str(target)]
    command += [branch] if branch_existed else ["-b", branch, base]
    run(command, cwd=main)
    try:
        missing = copy_declared_paths(profile.seed.paths, main=main, worktree=target)
        render_declared_variables(
            profile.seed.variables, worktree=target, issue=args.issue, branch=branch,
        )
    except Exception:
        remove_failed_worktree(main, target, branch, not branch_existed)
        raise
    if missing:
        print(f"Declared, absent in the main checkout, not seeded: {', '.join(missing)}")
    print(f"Worktree ready: {target} ({branch})")
    return target


def main() -> int:
    try:
        create(parse_args())
        return 0
    except LifecycleError as error:
        print(f"STOP: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
