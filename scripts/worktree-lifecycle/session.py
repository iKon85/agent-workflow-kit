#!/usr/bin/env python3
"""Claim-bound creation and teardown of one orchestration run's exact worktrees."""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

from cleanup import pr_state
from core import (
    LifecycleError,
    classify_cleanup,
    collect_cleanup_facts,
    load_profile,
    main_worktree,
    registered_worktrees,
    remove_contained_regular,
    run,
    verified_worktree_root,
)
from setup import execute_step

SCHEMA_VERSION = 1


def resolve_commit(repo: Path, rev: str) -> str | None:
    result = run(
        ["git", "rev-parse", "--verify", f"{rev}^{{commit}}"],
        cwd=repo,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def resolve_ref(repo: Path, ref: str) -> str | None:
    result = run(["git", "rev-parse", "--verify", ref], cwd=repo, check=False)
    return result.stdout.strip() if result.returncode == 0 else None


def active_claim(main: Path, anchor: str, owner: str) -> tuple[str, dict[str, Any]]:
    if not anchor.isdigit() or int(anchor) <= 0:
        raise LifecycleError("anchor must be a positive issue number")
    if not owner.strip():
        raise LifecycleError("owner must be non-empty")
    ref = f"refs/tags/wave-active/{anchor}"
    tag_oid = resolve_ref(main, ref)
    if tag_oid is None:
        raise LifecycleError(f"active wave claim is missing: {ref}")
    kind = run(["git", "cat-file", "-t", tag_oid], cwd=main).stdout.strip()
    if kind != "tag":
        raise LifecycleError(f"active wave claim is not annotated: {ref}")
    raw = run(["git", "cat-file", "-p", tag_oid], cwd=main).stdout
    separator = raw.find("\n\n")
    try:
        claim = json.loads(raw[separator + 2:].strip()) if separator >= 0 else None
    except json.JSONDecodeError as error:
        raise LifecycleError("active wave claim has invalid ownership evidence") from error
    if (
        not isinstance(claim, dict)
        or claim.get("contractVersion") != 1
        or str(claim.get("anchor")) != anchor
        or claim.get("owner") != owner
    ):
        raise LifecycleError("active wave claim belongs to another or incoherent run")
    return tag_oid, claim


def common_git_dir(main: Path) -> Path:
    value = run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=main,
    ).stdout.strip()
    return Path(value).resolve()


def receipt_path(main: Path, anchor: str, claim_oid: str) -> Path:
    return common_git_dir(main) / "agent-workflow-kit" / "session-teardown" / (
        f"{anchor}-{claim_oid}.json"
    )


@contextmanager
def receipt_lock(main: Path, anchor: str):
    directory = common_git_dir(main) / "agent-workflow-kit" / "session-teardown"
    directory.mkdir(parents=True, exist_ok=True)
    lock_path = directory / f"{anchor}.lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def write_receipt(path: Path, receipt: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(receipt, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_receipt(
    main: Path,
    anchor: str,
    owner: str,
) -> tuple[Path, dict[str, Any]]:
    claim_oid, _ = active_claim(main, anchor, owner)
    path = receipt_path(main, anchor, claim_oid)
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LifecycleError(f"cannot read this run's teardown receipt: {error}") from error
    if (
        not isinstance(receipt, dict)
        or receipt.get("schemaVersion") != SCHEMA_VERSION
        or receipt.get("anchor") != anchor
        or receipt.get("owner") != owner
        or receipt.get("claimOid") != claim_oid
        or Path(str(receipt.get("repoRoot", ""))).resolve() != main.resolve()
        or not isinstance(receipt.get("targets"), list)
    ):
        raise LifecycleError("teardown receipt belongs to another or incoherent run")
    return path, receipt


def begin(main: Path, args: argparse.Namespace) -> dict[str, Any]:
    claim_oid, _ = active_claim(main, args.anchor, args.owner)
    base_oid = resolve_commit(main, args.base)
    if base_oid is None:
        raise LifecycleError(f"base is not resolvable: {args.base}")
    path = receipt_path(main, args.anchor, claim_oid)
    with receipt_lock(main, args.anchor):
        if path.exists():
            _, receipt = read_receipt(main, args.anchor, args.owner)
            if receipt.get("baseOid") != base_oid:
                raise LifecycleError("existing receipt has a different base OID")
            return receipt_report(path, receipt)
        receipt = {
            "schemaVersion": SCHEMA_VERSION,
            "anchor": args.anchor,
            "owner": args.owner,
            "claimOid": claim_oid,
            "repoRoot": str(main.resolve()),
            "baseRef": args.base,
            "baseOid": base_oid,
            "state": "open",
            "targets": [],
        }
        write_receipt(path, receipt)
    return receipt_report(path, receipt)


def profile_path(main: Path, value: str) -> Path:
    path = Path(value)
    return path.resolve() if path.is_absolute() else (main / path).resolve()


def contained_target(main: Path, relative: Path) -> Path:
    target = (main / relative).resolve()
    try:
        target.relative_to(main.resolve())
    except ValueError as error:
        raise LifecycleError(f"worktree path escapes repository root: {relative}") from error
    return target


def create_target(main: Path, args: argparse.Namespace) -> dict[str, Any]:
    with receipt_lock(main, args.anchor):
        path, receipt = read_receipt(main, args.anchor, args.owner)
        if receipt.get("state") != "open":
            raise LifecycleError("teardown receipt is already sealed")
        configured_path = profile_path(main, args.profile)
        profile = load_profile(configured_path)
        branch = profile.branch_name(args.issue, args.slug, args.branch_type)
        target = contained_target(
            main,
            profile.relative_path(args.issue, args.slug, args.branch_type),
        )
        if branch in profile.protected_branches:
            raise LifecycleError(f"refusing protected session branch: {branch}")
        if any(entry.get("branch") == branch or entry.get("worktree") == str(target)
               for entry in receipt["targets"]):
            raise LifecycleError("target is already present in this receipt")
        if resolve_ref(main, f"refs/heads/{branch}") is not None:
            raise LifecycleError(f"branch pre-existed this run: {branch}")
        if target.exists() or target in registered_worktrees(main):
            raise LifecycleError(f"worktree path pre-existed this run: {target}")
        target_base = (
            resolve_commit(main, args.base) if args.base else receipt["baseOid"]
        )
        if target_base is None or not is_ancestor(main, receipt["baseOid"], target_base):
            raise LifecycleError("target base is unresolved or incoherent with the receipt base")

        run(
            ["git", "worktree", "add", str(target), "-b", branch, target_base],
            cwd=main,
        )
        try:
            for step in profile.setup_steps:
                execute_step(
                    step,
                    main=main,
                    worktree=target,
                    issue=args.issue,
                    branch=branch,
                )
            created_oid = resolve_ref(main, f"refs/heads/{branch}")
            if created_oid != target_base:
                raise LifecycleError("new session branch did not retain the recorded base OID")
            metadata = target.stat()
            entry = {
                "branch": branch,
                "worktree": str(target),
                "profile": str(configured_path),
                "createdOid": created_oid,
                "expectedOid": None,
                "rootDevice": metadata.st_dev,
                "rootInode": metadata.st_ino,
                "removed": False,
            }
            receipt["targets"].append(entry)
            write_receipt(path, receipt)
        except Exception:
            run(["git", "worktree", "remove", "--force", str(target)], cwd=main, check=False)
            run(
                ["git", "update-ref", "-d", f"refs/heads/{branch}", target_base],
                cwd=main,
                check=False,
            )
            raise
    return {"branch": branch, "worktree": str(target), "createdOid": created_oid}


def worktree_branches(main: Path) -> dict[str, Path]:
    output = run(["git", "worktree", "list", "--porcelain"], cwd=main).stdout
    result: dict[str, Path] = {}
    current: Path | None = None
    for line in output.splitlines():
        if line.startswith("worktree "):
            current = Path(line.split(" ", 1)[1]).resolve()
        elif line.startswith("branch refs/heads/") and current is not None:
            result[line.removeprefix("branch refs/heads/")] = current
    return result


def seal(main: Path, args: argparse.Namespace) -> dict[str, Any]:
    with receipt_lock(main, args.anchor):
        path, receipt = read_receipt(main, args.anchor, args.owner)
        if receipt.get("state") == "sealed":
            return receipt_report(path, receipt)
        if receipt.get("state") != "open" or not receipt["targets"]:
            raise LifecycleError("only a non-empty open receipt can be sealed")
        linked = worktree_branches(main)
        for entry in receipt["targets"]:
            branch = entry["branch"]
            target = Path(entry["worktree"])
            if linked.get(branch) != target.resolve():
                raise LifecycleError(f"session worktree identity changed before seal: {branch}")
            metadata = target.stat()
            if (metadata.st_dev, metadata.st_ino) != (
                entry["rootDevice"], entry["rootInode"]
            ):
                raise LifecycleError(f"session worktree root changed before seal: {branch}")
            if run(["git", "status", "--porcelain"], cwd=target).stdout.strip():
                raise LifecycleError(f"session worktree is dirty before seal: {branch}")
            expected = resolve_ref(main, f"refs/heads/{branch}")
            if expected is None or run(
                ["git", "merge-base", "--is-ancestor", entry["createdOid"], expected],
                cwd=main,
                check=False,
            ).returncode != 0:
                raise LifecycleError(f"session branch moved outside its created history: {branch}")
            entry["expectedOid"] = expected
        receipt["state"] = "sealed"
        write_receipt(path, receipt)
    return receipt_report(path, receipt)


def commit_parents(repo: Path, commit: str) -> list[str]:
    line = run(["git", "rev-list", "--parents", "-n", "1", commit], cwd=repo).stdout
    return line.strip().split()[1:]


def content_empty(repo: Path, commit: str, first_parent: str) -> bool:
    return run(
        ["git", "diff-tree", "--quiet", first_parent, commit],
        cwd=repo,
        check=False,
    ).returncode == 0


def patch_id(repo: Path, commit: str, first_parent: str) -> str | None:
    diff = run(
        [
            "git", "diff", "--binary", "--full-index", "--no-renames",
            first_parent, commit,
        ],
        cwd=repo,
    ).stdout
    if not diff:
        return None
    result = subprocess.run(
        ["git", "patch-id", "--stable"],
        cwd=repo,
        input=diff,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return result.stdout.split()[0]


def is_ancestor(repo: Path, commit: str, target: str) -> bool:
    return run(
        ["git", "merge-base", "--is-ancestor", commit, target],
        cwd=repo,
        check=False,
    ).returncode == 0


def main_patch_index(repo: Path, base: str, main_oid: str) -> Counter[str]:
    commits = run(
        ["git", "rev-list", "--reverse", "--topo-order", f"{base}..{main_oid}"],
        cwd=repo,
    ).stdout.splitlines()
    patches: Counter[str] = Counter()
    for commit in commits:
        parents = commit_parents(repo, commit)
        if len(parents) != 1 or content_empty(repo, commit, parents[0]):
            continue
        value = patch_id(repo, commit, parents[0])
        if value:
            patches[value] += 1
    return patches


def integration_report(
    repo: Path,
    created_oid: str,
    expected_oid: str,
    main_oid: str,
) -> dict[str, Any]:
    if not is_ancestor(repo, created_oid, main_oid):
        return {
            "integration": "ambiguous",
            "commits": [],
            "reason": "recorded base is no longer an ancestor of canonical main",
        }
    commits = run(
        [
            "git", "rev-list", "--reverse", "--topo-order",
            f"{created_oid}..{expected_oid}",
        ],
        cwd=repo,
    ).stdout.splitlines()
    index = main_patch_index(repo, created_oid, main_oid)
    provisional: list[dict[str, Any]] = []
    owned_patch_counts: Counter[str] = Counter()
    for commit in commits:
        parents = commit_parents(repo, commit)
        if not parents:
            provisional.append({"oid": commit, "status": "ambiguous", "reason": "root commit"})
            continue
        if content_empty(repo, commit, parents[0]):
            provisional.append({
                "oid": commit,
                "status": "ambiguous",
                "reason": "empty commit has no patch identity",
            })
            continue
        if len(parents) != 1:
            provisional.append({
                "oid": commit,
                "status": "ambiguous",
                "reason": "merge commit has no unambiguous patch identity",
            })
            continue
        if is_ancestor(repo, commit, main_oid):
            provisional.append({"oid": commit, "status": "ancestry-merged"})
            continue
        value = patch_id(repo, commit, parents[0])
        if value is None:
            provisional.append({"oid": commit, "status": "ambiguous", "reason": "missing patch-id"})
            continue
        owned_patch_counts[value] += 1
        provisional.append({"oid": commit, "status": "pending", "patchId": value})

    for row in provisional:
        value = row.get("patchId")
        if row["status"] != "pending" or value is None:
            continue
        if owned_patch_counts[value] != 1 or index[value] > 1:
            row["status"] = "ambiguous"
            row["reason"] = "patch-id is not one-to-one"
        elif index[value] == 1:
            row["status"] = "patch-equivalent"
        else:
            row["status"] = "unique-patch"

    statuses = {row["status"] for row in provisional}
    if "ambiguous" in statuses:
        integration = "ambiguous"
    elif "unique-patch" in statuses:
        integration = "unique-patch"
    elif statuses and statuses <= {"ancestry-merged"}:
        integration = "ancestry-merged"
    else:
        integration = "patch-equivalent"
    return {"integration": integration, "commits": provisional}


def assess(main: Path, args: argparse.Namespace) -> tuple[Path, dict[str, Any], dict[str, Any]]:
    path, receipt = read_receipt(main, args.anchor, args.owner)
    if receipt.get("state") not in {"sealed", "tearing-down", "complete"}:
        raise LifecycleError("teardown receipt must be sealed first")
    main_oid = resolve_commit(main, args.main)
    if main_oid is None:
        raise LifecycleError(f"canonical main is not resolvable: {args.main}")
    linked = worktree_branches(main)
    rows = []
    for entry in receipt["targets"]:
        branch = entry["branch"]
        target = Path(entry["worktree"])
        reasons: list[str] = []
        current_oid = resolve_ref(main, f"refs/heads/{branch}")
        target_exists = target.exists()
        linked_path = linked.get(branch)
        if entry.get("removed") or (current_oid is None and not target_exists and linked_path is None):
            rows.append({
                "branch": branch,
                "worktree": str(target),
                "expectedOid": entry.get("expectedOid"),
                "currentOid": current_oid,
                "integration": "already-removed",
                "commits": [],
                "reasons": [],
                "removable": True,
                "scratchFiles": [],
            })
            continue
        expected_oid = entry.get("expectedOid")
        if not expected_oid or current_oid != expected_oid:
            reasons.append(
                f"unexpected OID: expected {expected_oid or '<unsealed>'}, "
                f"found {current_oid or '<missing>'}"
            )
        profile = load_profile(Path(entry["profile"]))
        if branch in profile.protected_branches:
            reasons.append(f"protected branch: {branch}")
        state = pr_state(args.gh_command, main, branch)
        if state == "open":
            reasons.append("open PR")
        integration = (
            integration_report(main, entry["createdOid"], expected_oid, main_oid)
            if expected_oid and current_oid == expected_oid
            else {"integration": "ambiguous", "commits": []}
        )
        if integration["integration"] == "unique-patch":
            reasons.append("unique patch content is not represented on canonical main")
        elif integration["integration"] == "ambiguous":
            reasons.append("ambiguous patch identity")

        scratch: list[str] = []
        if target_exists or linked_path is not None:
            if linked_path != target.resolve():
                reasons.append("worktree registration no longer matches receipt")
            elif target_exists:
                facts = collect_cleanup_facts(
                    main,
                    target,
                    merge_target=args.main,
                    pr_state=state,
                )
                cleanup = classify_cleanup(profile, facts)
                reasons.extend(
                    reason for reason in cleanup.reasons
                    if not reason.startswith("unmerged branch:")
                )
                scratch = list(cleanup.scratch_files)
                if (facts.root_device, facts.root_inode) != (
                    entry["rootDevice"], entry["rootInode"]
                ):
                    reasons.append("worktree root identity changed")
        rows.append({
            "branch": branch,
            "worktree": str(target),
            "expectedOid": expected_oid,
            "currentOid": current_oid,
            "integration": integration["integration"],
            "commits": integration["commits"],
            "reasons": list(dict.fromkeys(reasons)),
            "removable": not reasons,
            "scratchFiles": scratch,
        })
    report = {
        "receipt": str(path),
        "anchor": args.anchor,
        "owner": args.owner,
        "main": args.main,
        "mainOid": main_oid,
        "targets": rows,
        "removable": all(row["removable"] for row in rows),
    }
    return path, receipt, report


def inspect(main: Path, args: argparse.Namespace) -> dict[str, Any]:
    return assess(main, args)[2]


def teardown(main: Path, args: argparse.Namespace) -> dict[str, Any]:
    with receipt_lock(main, args.anchor):
        path, receipt, preview = assess(main, args)
        if not preview["removable"]:
            blockers = [
                f"{row['branch']}: {', '.join(row['reasons'])}"
                for row in preview["targets"] if row["reasons"]
            ]
            raise LifecycleError("; ".join(blockers))
        _, latest_receipt, latest = assess(main, args)
        if latest != preview or latest_receipt != receipt:
            raise LifecycleError("teardown inventory changed before removal")
        if resolve_commit(main, args.main) != preview["mainOid"]:
            raise LifecycleError("canonical main moved before teardown")

        by_branch = {row["branch"]: row for row in latest["targets"]}
        # Persist every recovery OID before the first mutation. The receipt is
        # an audit/recovery archive even if the process stops between targets.
        for entry in receipt["targets"]:
            if not entry.get("removed"):
                entry["recoveryOid"] = entry["expectedOid"]
        receipt["state"] = "tearing-down"
        write_receipt(path, receipt)

        for entry in receipt["targets"]:
            row = by_branch[entry["branch"]]
            if row["integration"] == "already-removed":
                entry["removed"] = True
                continue
            target = Path(entry["worktree"])
            if target.exists():
                facts = collect_cleanup_facts(
                    main,
                    target,
                    merge_target=args.main,
                    pr_state="none",
                )
                with verified_worktree_root(
                    target,
                    facts.root_device,
                    facts.root_inode,
                ) as descriptor:
                    for scratch in row["scratchFiles"]:
                        remove_contained_regular(descriptor, scratch)
                run(["git", "worktree", "remove", str(target)], cwd=main)
            result = run(
                [
                    "git", "update-ref", "-d", f"refs/heads/{entry['branch']}",
                    entry["expectedOid"],
                ],
                cwd=main,
                check=False,
            )
            if result.returncode != 0:
                raise LifecycleError(
                    f"concurrent branch move stopped cleanup: {entry['branch']}"
                )
            entry["removed"] = True
            write_receipt(path, receipt)
        receipt["state"] = "complete"
        write_receipt(path, receipt)
    result = receipt_report(path, receipt)
    result["removed"] = True
    return result


def receipt_report(path: Path, receipt: dict[str, Any]) -> dict[str, Any]:
    return {
        "receipt": str(path),
        "anchor": receipt["anchor"],
        "owner": receipt["owner"],
        "baseOid": receipt["baseOid"],
        "state": receipt["state"],
        "targets": receipt["targets"],
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="action", required=True)

    def common(name: str) -> argparse.ArgumentParser:
        command = commands.add_parser(name)
        command.add_argument("--anchor", required=True)
        command.add_argument("--owner", required=True)
        return command

    begin_parser = common("begin")
    begin_parser.add_argument("--base", default="origin/main")

    create_parser = common("create")
    create_parser.add_argument(
        "--profile", default="docs/agents/workflow-capabilities.json"
    )
    create_parser.add_argument("--base")
    create_parser.add_argument("issue")
    create_parser.add_argument("slug")
    create_parser.add_argument("branch_type", nargs="?", default="feat")

    common("seal")
    for name in ("inspect", "teardown"):
        command = common(name)
        command.add_argument("--main", default="origin/main")
        command.add_argument("--gh-command", default="gh")
    return root


def main() -> int:
    try:
        args = parser().parse_args()
        repo = main_worktree(Path.cwd())
        actions = {
            "begin": begin,
            "create": create_target,
            "seal": seal,
            "inspect": inspect,
            "teardown": teardown,
        }
        result = actions[args.action](repo, args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except LifecycleError as error:
        print(f"STOP: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
