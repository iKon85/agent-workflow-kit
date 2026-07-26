#!/usr/bin/env python3
"""Preview or safely remove a profile-governed linked worktree."""

from __future__ import annotations

import argparse
from dataclasses import asdict, replace
import json
import sys
from pathlib import Path

from core import (
    LifecycleError,
    bind_cleanup_scratch_evidence,
    classify_cleanup,
    collect_cleanup_facts,
    collect_sweep,
    load_profile,
    main_worktree,
    remove_authorized_scratch,
    run,
    verified_worktree_root,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="docs/agents/workflow-capabilities.json")
    parser.add_argument("--remove", action="store_true")
    parser.add_argument("--gh-command", default="gh")
    parser.add_argument("worktree", nargs="?")
    return parser.parse_args()


def parse_sweep_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="cleanup.py sweep")
    parser.add_argument("--profile", default="docs/agents/workflow-capabilities.json")
    parser.add_argument("--gh-command", default="gh")
    return parser.parse_args(argv)


def pr_state(gh_command: str, main: Path, branch: str) -> str:
    remote = run(
        ["git", "remote", "get-url", "origin"],
        cwd=main,
        check=False,
    )
    if remote.returncode != 0:
        return "none"
    result = run(
        [
            gh_command, "pr", "list", "--state", "all", "--head", branch,
            "--json", "number,state,mergedAt",
        ],
        cwd=main,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise LifecycleError(f"cannot determine PR state for {branch}: {detail}")
    try:
        prs = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise LifecycleError(f"cannot determine PR state for {branch}: invalid gh output") from error
    if any(str(pr.get("state", "")).upper() == "OPEN" for pr in prs):
        return "open"
    if any(pr.get("mergedAt") or str(pr.get("state", "")).upper() == "MERGED" for pr in prs):
        return "merged"
    return "none"


def collect_assessment(profile, main: Path, worktree: Path, gh_command: str):
    facts = collect_cleanup_facts(
        main,
        worktree,
    )
    state = pr_state(gh_command, main, facts.branch)
    assessment = classify_cleanup(profile, replace(facts, pr_state=state))
    try:
        return bind_cleanup_scratch_evidence(
            profile,
            assessment,
            require_generator_evidence=True,
        )
    except LifecycleError as error:
        return replace(
            assessment,
            reasons=assessment.reasons + (f"scratch evidence stop: {error}",),
        )


def execute(args: argparse.Namespace) -> dict:
    main = main_worktree(Path.cwd())
    profile_path = Path(args.profile)
    if not profile_path.is_absolute():
        profile_path = main / profile_path
    profile = load_profile(profile_path)
    if not args.worktree:
        raise LifecycleError("worktree is required")
    worktree = Path(args.worktree)
    assessment = collect_assessment(profile, main, worktree, args.gh_command)
    report = {
        "worktree": str(assessment.worktree),
        "branch": assessment.branch,
        "removable": assessment.removable,
        "reasons": list(assessment.reasons),
        "assumptions": assessment.assumptions,
        "scratchFiles": list(assessment.scratch_files),
        "removed": False,
    }
    if not args.remove:
        return report
    if not assessment.removable:
        raise LifecycleError("; ".join(assessment.reasons))
    latest = collect_assessment(profile, main, worktree, args.gh_command)
    if not latest.removable:
        raise LifecycleError(f"cleanup changed before removal: {'; '.join(latest.reasons)}")
    if (
        latest.branch != assessment.branch
        or latest.scratch_files != assessment.scratch_files
        or latest.assumptions != assessment.assumptions
        or latest.root_device != assessment.root_device
        or latest.root_inode != assessment.root_inode
        or latest.scratch_evidence != assessment.scratch_evidence
    ):
        raise LifecycleError("cleanup changed before removal: inventory no longer matches preview")
    with verified_worktree_root(
        latest.worktree,
        latest.root_device,
        latest.root_inode,
    ) as root_descriptor:
        remove_authorized_scratch(
            profile,
            root_descriptor,
            latest.scratch_files,
            assessment.scratch_evidence,
        )
    run(["git", "worktree", "remove", str(latest.worktree)], cwd=main)
    run(["git", "branch", "-d", assessment.branch], cwd=main)
    report["removed"] = True
    return report


def sweep(args: argparse.Namespace) -> dict:
    main = main_worktree(Path.cwd())
    profile_path = Path(args.profile)
    if not profile_path.is_absolute():
        profile_path = main / profile_path
    profile = load_profile(profile_path)
    report = collect_sweep(
        profile,
        main,
        lambda branch: pr_state(args.gh_command, main, branch),
    )
    payload = asdict(report)
    return {
        "mainBranch": payload["main_branch"],
        "worktreeCount": payload["worktree_count"],
        "localBranchCount": payload["local_branch_count"],
        "mergedRemoteBranchCount": payload["merged_remote_branch_count"],
        "rows": [
            {
                "kind": row["kind"],
                "path": row["path"],
                "branch": row["branch"],
                "issue": row["issue"],
                "prState": row["pr_state"],
                "mergedIntoMain": row["merged_into_main"],
                "lastCommitAgeSeconds": row["last_commit_age_seconds"],
                "removable": row["removable"],
                "reasons": list(row["reasons"]),
                "verdictReason": row["verdict_reason"],
                "scratchFiles": list(row["scratch_files"]),
                "assumptions": row["assumptions"],
            }
            for row in payload["rows"]
        ],
    }


def main() -> int:
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "sweep":
            result = sweep(parse_sweep_args(sys.argv[2:]))
        else:
            result = execute(parse_args())
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except LifecycleError as error:
        print(f"STOP: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
