#!/usr/bin/env python3
"""Create a configured, rollback-safe consumer worktree."""

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


def port_slot(step: dict, issue: str, branch: str) -> int:
    modulo = int(step.get("slotModulo", 900))
    offset = int(step.get("slotOffset", 1))
    seed = int(issue) if issue.isdigit() else zlib.crc32(branch.encode("utf-8"))
    return seed % modulo + offset


def write_ports(step: dict, *, worktree: Path, issue: str, branch: str) -> None:
    slot = port_slot(step, issue, branch)
    stride = int(step.get("stride", 10))
    outputs = step.get("outputs") or {}
    if not outputs:
        raise LifecycleError("ports step requires outputs")
    unsafe = {int(port) for port in step.get("unsafePorts", ())}
    modulo = int(step.get("slotModulo", 900))
    for _ in range(modulo):
        ports = [int(base) + slot * stride for base in outputs.values()]
        if not unsafe.intersection(ports):
            break
        slot = slot % modulo + 1
    else:
        raise LifecycleError("port profile has no safe allocation")
    lines = [f"{name}={int(base) + slot * stride}" for name, base in outputs.items()]
    (worktree / ".dev-ports").write_text("\n".join(lines) + "\n", encoding="utf-8")


def execute_step(
    step: dict,
    *,
    main: Path,
    worktree: Path,
    issue: str,
    branch: str,
) -> None:
    kind = step.get("kind")
    if kind == "copy":
        source = main / step["source"]
        target = worktree / step.get("target", step["source"])
        if not source.exists() and step.get("optional"):
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        return
    if kind == "command":
        command = step.get("command")
        if not isinstance(command, list) or not all(isinstance(part, str) for part in command):
            raise LifecycleError("setup command must be a JSON string array")
        run(command, cwd=worktree)
        return
    if kind == "ports":
        write_ports(step, worktree=worktree, issue=issue, branch=branch)
        return
    raise LifecycleError(f"unsupported setup step kind: {kind!r}")


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
        for step in profile.setup_steps:
            execute_step(
                step,
                main=main,
                worktree=target,
                issue=args.issue,
                branch=branch,
            )
    except Exception:
        remove_failed_worktree(main, target, branch, not branch_existed)
        raise
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
