#!/usr/bin/env python3
"""Claim-bound creation and teardown of one orchestration run's exact worktrees."""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from typing import Any

from cleanup import pr_state
from core import (
    LifecycleError,
    capture_artifact_baseline,
    classify_cleanup,
    collect_cleanup_facts,
    contained_untracked_identity,
    load_profile,
    load_artifact_baseline,
    main_worktree,
    registered_worktrees,
    remove_contained_regular,
    remove_contained_untracked,
    run,
    verified_landing_scratch_files,
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


def ownership_proof_ref(claim_oid: str, branch: str) -> str:
    branch_digest = sha256(branch.encode("utf-8")).hexdigest()
    return (
        "refs/agent-workflow-kit/session-owned/"
        f"{claim_oid}/{branch_digest}"
    )


def validated_proof_ref(receipt: dict[str, Any], entry: dict[str, Any]) -> str:
    expected = ownership_proof_ref(receipt["claimOid"], entry["branch"])
    if entry.get("proofRef") != expected:
        raise LifecycleError("session ownership proof identity is incoherent")
    return expected


def acquire_owned_branch(
    main: Path,
    branch: str,
    proof_ref: str,
    target_oid: str,
    claim_ref: str,
    claim_oid: str,
) -> bool:
    transaction = (
        "start\n"
        f"verify {claim_ref} {claim_oid}\n"
        f"create refs/heads/{branch} {target_oid}\n"
        f"create {proof_ref} {target_oid}\n"
        "prepare\n"
        "commit\n"
    )
    result = subprocess.run(
        ["git", "update-ref", "--stdin"],
        cwd=main,
        input=transaction,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0


def delete_owned_refs_prepared(
    main: Path,
    branch: str,
    proof_ref: str,
    expected_oid: str,
    proof_oid: str,
    claim_ref: str,
    claim_oid: str,
    *,
    remove_worktree: Path | None = None,
    main_ref: str | None = None,
    main_oid: str | None = None,
    root_identity: tuple[int, int] | None = None,
) -> bool:
    process = subprocess.Popen(
        ["git", "update-ref", "--stdin"],
        cwd=main,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    commands = [
        "start",
        f"verify {claim_ref} {claim_oid}",
    ]
    if main_ref is not None and main_oid is not None:
        commands.append(f"verify {main_ref} {main_oid}")
    commands.extend([
        f"delete refs/heads/{branch} {expected_oid}",
        f"delete {proof_ref} {proof_oid}",
        "prepare",
    ])
    try:
        process.stdin.write("\n".join(commands) + "\n")
        process.stdin.flush()
        responses = [process.stdout.readline().strip(), process.stdout.readline().strip()]
        if responses != ["start: ok", "prepare: ok"]:
            process.stdin.close()
            process.wait()
            return False
        linked = worktree_branches(main)
        if (
            (remove_worktree is None and branch in linked)
            or (
                remove_worktree is not None
                and linked.get(branch) != remove_worktree.resolve()
            )
        ):
            process.stdin.write("abort\n")
            process.stdin.flush()
            process.stdin.close()
            process.wait()
            return False
        if remove_worktree is not None:
            try:
                metadata = remove_worktree.lstat()
            except OSError:
                metadata = None
            if (
                metadata is None
                or not stat.S_ISDIR(metadata.st_mode)
                or root_identity is None
                or (metadata.st_dev, metadata.st_ino) != root_identity
            ):
                process.stdin.write("abort\n")
                process.stdin.flush()
                process.stdin.close()
                process.wait()
                return False
            removed = run(
                ["git", "worktree", "remove", str(remove_worktree)],
                cwd=main,
                check=False,
            )
            if removed.returncode != 0:
                process.stdin.write("abort\n")
                process.stdin.flush()
                process.stdin.close()
                process.wait()
                return False
        process.stdin.write("commit\n")
        process.stdin.flush()
        process.stdin.close()
        return process.wait() == 0
    except (BrokenPipeError, OSError):
        if process.poll() is None:
            process.kill()
        process.wait()
        return False


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
        if run(
            ["git", "check-ref-format", "--branch", branch],
            cwd=main,
            check=False,
        ).returncode != 0:
            raise LifecycleError("generated session branch is not a valid branch name")
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
        proof_ref = ownership_proof_ref(receipt["claimOid"], branch)
        if resolve_ref(main, proof_ref) is not None:
            raise LifecycleError("session ownership proof pre-existed this run")

        entry = {
            "state": "provisional",
            "acquisitionState": "pending",
            "branch": branch,
            "worktree": str(target),
            "profile": str(configured_path),
            "proofRef": proof_ref,
            "createdOid": target_base,
            "expectedOid": target_base,
            "rootDevice": None,
            "rootInode": None,
            "artifactBaselineDigest": None,
            "removed": False,
        }
        # Pre-journal the deterministic proof identity, then acquire the branch
        # and proof ref in one Git ref transaction. The proof, rather than this
        # provisional row alone, is the durable ownership authority.
        receipt["targets"].append(entry)
        write_receipt(path, receipt)
        failure_class = "ref-acquisition"
        try:
            if not acquire_owned_branch(
                main,
                branch,
                proof_ref,
                target_base,
                f"refs/tags/wave-active/{args.anchor}",
                receipt["claimOid"],
            ):
                entry["acquisitionState"] = "failed"
                write_receipt(path, receipt)
                raise LifecycleError("session branch ownership acquisition failed")
            entry["acquisitionState"] = "acquired"
            write_receipt(path, receipt)
            failure_class = "worktree-add"
            run(
                ["git", "worktree", "add", str(target), branch],
                cwd=main,
            )
            failure_class = "root-journal"
            created_oid = resolve_ref(main, f"refs/heads/{branch}")
            if created_oid != target_base:
                raise LifecycleError("new session branch did not retain the recorded base OID")
            linked = worktree_branches(main)
            if linked.get(branch) != target.resolve():
                raise LifecycleError("new session worktree registration is incoherent")
            metadata = target.stat()
            entry.update({
                "state": "baseline-pending",
                "rootDevice": metadata.st_dev,
                "rootInode": metadata.st_ino,
            })
            write_receipt(path, receipt)

            # This baseline must precede every project setup step: only its
            # exact untracked delta can later be attributed to failed setup.
            failure_class = "baseline-capture"
            artifact_baseline = capture_artifact_baseline(target)
            if artifact_baseline.setup_head != created_oid:
                raise LifecycleError(
                    "artifact provenance baseline does not match the created OID"
                )
            entry.update({
                "state": "setting-up",
                "artifactBaselineDigest": artifact_baseline.digest,
            })
            write_receipt(path, receipt)
            failure_class = "setup-step"
            for step in profile.setup_steps:
                execute_step(
                    step,
                    main=main,
                    worktree=target,
                    issue=args.issue,
                    branch=branch,
                )
            failure_class = "promotion"
            created_oid = resolve_ref(main, f"refs/heads/{branch}")
            if created_oid != target_base:
                raise LifecycleError("new session branch did not retain the recorded base OID")
            metadata = target.stat()
            if (metadata.st_dev, metadata.st_ino) != (
                entry["rootDevice"], entry["rootInode"]
            ):
                raise LifecycleError("session worktree root changed during setup")
            entry.update({
                "state": "active",
                "rootDevice": metadata.st_dev,
                "rootInode": metadata.st_ino,
                "expectedOid": None,
            })
            write_receipt(path, receipt)
        except Exception as error:
            entry["state"] = "recovery-pending"
            entry.pop("failure", None)
            entry["failureClass"] = failure_class
            write_receipt(path, receipt)
            try:
                _capture_setup_created_evidence(main, target, entry)
            except Exception:
                entry["evidenceState"] = "pending"
                entry["evidenceFailureClass"] = "identity-capture"
            write_receipt(path, receipt)
            try:
                _recover_creation_entry(
                    main,
                    args,
                    path,
                    receipt,
                    entry,
                    archive_reason="automatic rollback after failed setup",
                )
            except Exception:
                # Ownership and the bounded failure class are already durable.
                # Never surface a setup command's exception/stdout/stderr.
                pass
            raise LifecycleError(
                f"session creation failed ({failure_class}); recovery receipt retained"
            ) from error
    return {"branch": branch, "worktree": str(target), "createdOid": created_oid}


def _capture_setup_created_evidence(
    main: Path,
    target: Path,
    entry: dict[str, Any],
) -> None:
    entry.pop("evidenceFailureClass", None)
    if not target.exists() or not entry.get("artifactBaselineDigest"):
        entry["setupCreatedFiles"] = []
        entry["setupTrackedEvidence"] = _tracked_evidence(target) if target.exists() else None
        entry["evidenceState"] = "complete"
        return
    baseline = load_artifact_baseline(target)
    if baseline.digest != entry["artifactBaselineDigest"]:
        raise LifecycleError("creation baseline changed before recovery journaling")
    facts = collect_cleanup_facts(main, target, pr_state="none")
    created = tuple(sorted(
        set(facts.untracked_files).difference(baseline.initial_untracked_files)
    ))
    tracked = _tracked_evidence(target)
    entry["setupTrackedEvidence"] = tracked
    entry["setupCreatedPaths"] = list(created)
    entry["setupInventoryDigest"] = _inventory_digest(tracked, created)
    entry["evidenceState"] = "pending"
    with verified_worktree_root(
        target,
        entry["rootDevice"],
        entry["rootInode"],
    ) as descriptor:
        entry["setupCreatedFiles"] = [
            contained_untracked_identity(descriptor, relative)
            for relative in created
        ]
    entry["evidenceState"] = "complete"


def _tracked_evidence(target: Path) -> dict[str, Any]:
    paths: set[str] = set()
    digests: dict[str, str] = {}
    for name, cached in (("worktree", False), ("index", True)):
        diff_command = [
            "git", "diff", "--binary", "--full-index", "--no-renames",
        ]
        names_command = ["git", "diff", "--name-only", "-z", "--no-renames"]
        if cached:
            diff_command.insert(2, "--cached")
            names_command.insert(2, "--cached")
        diff = run(diff_command, cwd=target).stdout
        names = run(names_command, cwd=target).stdout
        values = [value for value in names.split("\0") if value]
        if any(
            Path(value).is_absolute() or ".." in Path(value).parts
            for value in values
        ):
            raise LifecycleError("tracked recovery path is unsafe")
        paths.update(values)
        digests[f"{name}DiffSha256"] = sha256(
            diff.encode("utf-8", errors="surrogateescape")
        ).hexdigest()
    return {"paths": sorted(paths), **digests}


def _inventory_digest(
    tracked: dict[str, Any],
    untracked_paths: tuple[str, ...] | list[str],
) -> str:
    payload = json.dumps(
        {"tracked": tracked, "untrackedPaths": list(untracked_paths)},
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256(payload).hexdigest()


def _tracked_evidence_at_created_oid() -> dict[str, Any]:
    empty = sha256(b"").hexdigest()
    return {
        "paths": [],
        "worktreeDiffSha256": empty,
        "indexDiffSha256": empty,
    }


def _worktree_backlink_matches(main: Path, target: Path, branch: str) -> bool:
    top = run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=target,
        check=False,
    )
    common = run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=target,
        check=False,
    )
    current = run(
        ["git", "branch", "--show-current"],
        cwd=target,
        check=False,
    )
    return (
        top.returncode == 0
        and Path(top.stdout.strip()).resolve() == target.resolve()
        and common.returncode == 0
        and Path(common.stdout.strip()).resolve() == common_git_dir(main)
        and current.returncode == 0
        and current.stdout.strip() == branch
    )


def _archive_recovered_target(
    path: Path,
    receipt: dict[str, Any],
    entry: dict[str, Any],
    reason: str,
) -> None:
    entry.pop("failure", None)
    archived = {key: value for key, value in entry.items() if key != "failure"}
    receipt.setdefault("recoveredTargets", []).append({
        **archived,
        "state": "recovered",
        "recoveryReason": reason,
    })
    receipt["targets"].remove(entry)
    write_receipt(path, receipt)


def _revalidate_creation_safety(
    main: Path,
    args: argparse.Namespace,
    path: Path,
    receipt: dict[str, Any],
    entry: dict[str, Any],
) -> None:
    branch = entry["branch"]
    expected_oid = entry["createdOid"]
    proof_ref = validated_proof_ref(receipt, entry)
    # The PR query is deliberately before the final receipt/claim read: a
    # command that races either ownership input is detected before mutation.
    if pr_state(args.gh_command, main, branch) == "open":
        raise LifecycleError(f"open PR during creation recovery: {branch}")
    current_path, current_receipt = read_receipt(main, args.anchor, args.owner)
    if current_path != path or current_receipt != receipt:
        raise LifecycleError("active claim or recovery receipt changed")
    profile = load_profile(Path(entry["profile"]))
    if branch in profile.protected_branches:
        raise LifecycleError(f"protected branch during creation recovery: {branch}")
    if resolve_ref(main, f"refs/heads/{branch}") != expected_oid:
        raise LifecycleError(f"unexpected OID during creation recovery: {branch}")
    if resolve_ref(main, proof_ref) != expected_oid:
        raise LifecycleError(f"session ownership proof changed: {branch}")


def _recover_creation_entry(
    main: Path,
    args: argparse.Namespace,
    path: Path,
    receipt: dict[str, Any],
    entry: dict[str, Any],
    *,
    archive_reason: str,
) -> None:
    current_path, current_receipt = read_receipt(main, args.anchor, args.owner)
    if current_path != path or current_receipt != receipt:
        raise LifecycleError("active claim or recovery receipt changed")
    if entry.get("state") != "recovery-pending":
        raise LifecycleError("target is not pending creation recovery")

    branch = entry["branch"]
    target = Path(entry["worktree"])
    proof_ref = validated_proof_ref(receipt, entry)

    current_oid = resolve_ref(main, f"refs/heads/{branch}")
    expected_oid = entry["createdOid"]
    proof_oid = resolve_ref(main, proof_ref)
    linked = worktree_branches(main)
    linked_path = linked.get(branch)
    target_present = os.path.lexists(target)
    if entry.get("acquisitionState") == "failed":
        if (
            current_oid is not None
            or proof_oid is not None
            or target_present
            or linked_path is not None
        ):
            raise LifecycleError(
                f"failed acquisition collided with foreign target: {branch}"
            )
        _archive_recovered_target(path, receipt, entry, archive_reason)
        return
    if proof_oid is None:
        if target_present or linked_path is not None:
            raise LifecycleError(
                f"session ownership proof is missing while a worktree remains: {branch}"
            )
        # A failed transaction may leave a foreign branch at the intended
        # name. It is never adopted or deleted without the proof ref.
        _archive_recovered_target(path, receipt, entry, archive_reason)
        return
    if proof_oid != expected_oid:
        raise LifecycleError(f"session ownership proof changed: {branch}")
    if current_oid is not None and current_oid != expected_oid:
        raise LifecycleError(
            f"unexpected OID during creation recovery: {branch}: "
            f"expected {expected_oid}, found {current_oid}"
        )
    if current_oid is None and (target_present or linked_path is not None):
        raise LifecycleError(
            f"session ref disappeared while its worktree remains: {branch}"
        )
    if current_oid is None and not target_present and linked_path is None:
        raise LifecycleError(
            f"session ref disappeared while its ownership proof remains: {branch}"
        )
    if current_oid == expected_oid and not target_present and linked_path is None:
        _revalidate_creation_safety(main, args, path, receipt, entry)
        if not delete_owned_refs_prepared(
            main,
            branch,
            proof_ref,
            expected_oid,
            entry["createdOid"],
            f"refs/tags/wave-active/{args.anchor}",
            receipt["claimOid"],
        ):
            raise LifecycleError(
                f"compare-delete failed during branch-only creation recovery: {branch}"
            )
        _archive_recovered_target(path, receipt, entry, archive_reason)
        return
    if linked_path != target.resolve():
        raise LifecycleError(
            f"worktree registration changed during creation recovery: {branch}"
        )
    if not target_present:
        raise LifecycleError(
            f"worktree directory is missing while Git registration remains: {branch}"
        )
    if target.is_symlink() or not target.is_dir():
        raise LifecycleError(
            f"worktree root type changed during creation recovery: {branch}"
        )
    metadata = target.stat()
    recorded_identity = (entry.get("rootDevice"), entry.get("rootInode"))
    if None not in recorded_identity and recorded_identity != (
        metadata.st_dev, metadata.st_ino
    ):
        raise LifecycleError(
            f"worktree root identity changed during creation recovery: {branch}"
        )
    if None in recorded_identity:
        if (
            not _worktree_backlink_matches(main, target, branch)
            or collect_cleanup_facts(main, target, pr_state="none").tracked_files
            or collect_cleanup_facts(main, target, pr_state="none").untracked_files
        ):
            raise LifecycleError(
                f"worktree creation identity was not journaled before recovery: {branch}"
            )
        entry["rootDevice"] = metadata.st_dev
        entry["rootInode"] = metadata.st_ino
        recorded_identity = (metadata.st_dev, metadata.st_ino)
        write_receipt(path, receipt)

    facts = collect_cleanup_facts(main, target, pr_state="none")
    baseline_digest = entry.get("artifactBaselineDigest")
    if not baseline_digest:
        if facts.tracked_files or facts.untracked_files:
            raise LifecycleError(
                "creation baseline is missing while worktree changes remain"
            )
        setup_created: tuple[str, ...] = ()
        tracked_evidence = _tracked_evidence(target)
    else:
        baseline = load_artifact_baseline(target)
        if (
            baseline.digest != baseline_digest
            or baseline.setup_head != expected_oid
            or (baseline.root_device, baseline.root_inode) != recorded_identity
        ):
            raise LifecycleError("creation baseline changed or is incoherent")
        initial = set(baseline.initial_untracked_files)
        current = set(facts.untracked_files)
        if not initial.issubset(current):
            raise LifecycleError(
                "creation baseline inventory changed before recovery"
            )
        evidence = entry.get("setupCreatedFiles")
        tracked_evidence = entry.get("setupTrackedEvidence")
        evidence_state = entry.get("evidenceState")
        if evidence_state == "pending":
            current_tracked = _tracked_evidence(target)
            current_created = tuple(sorted(current.difference(initial)))
            current_digest = _inventory_digest(current_tracked, current_created)
            if not facts.tracked_files and not current_created:
                entry["setupTrackedEvidence"] = current_tracked
                entry["setupCreatedFiles"] = []
                entry["setupCreatedPaths"] = []
                entry["setupInventoryDigest"] = current_digest
                entry["evidenceState"] = "complete"
                entry.pop("evidenceFailureClass", None)
                write_receipt(path, receipt)
                evidence = []
                tracked_evidence = current_tracked
            elif current_digest == entry.get("setupInventoryDigest"):
                _capture_setup_created_evidence(main, target, entry)
                write_receipt(path, receipt)
                evidence = entry.get("setupCreatedFiles")
                tracked_evidence = entry.get("setupTrackedEvidence")
            else:
                raise LifecycleError(
                    "creation recovery evidence is pending and inventory changed"
                )
        if not isinstance(evidence, list) or not all(
            isinstance(item, dict)
            and isinstance(item.get("path"), str)
            and item.get("kind") in {"regular", "symlink"}
            for item in evidence
        ):
            raise LifecycleError("setup-created file evidence is missing or incoherent")
        if (
            not isinstance(tracked_evidence, dict)
            or not isinstance(tracked_evidence.get("paths"), list)
        ):
            raise LifecycleError("setup-created tracked evidence is missing or incoherent")
        current_tracked = _tracked_evidence(target)
        clean_tracked = _tracked_evidence_at_created_oid()
        if current_tracked != clean_tracked and current_tracked != tracked_evidence:
            raise LifecycleError("tracked setup changes changed after failed setup")
        evidenced_paths = {item["path"] for item in evidence}
        unexpected = current.difference(initial).difference(evidenced_paths)
        if unexpected:
            raise LifecycleError(
                "foreign untracked files appeared after failed setup: "
                + ", ".join(sorted(unexpected))
            )
        setup_created = tuple(sorted(current.intersection(evidenced_paths)))
        if initial:
            raise LifecycleError(
                "pre-setup untracked files remain protected: "
                + ", ".join(sorted(initial))
            )

    if tracked_evidence != _tracked_evidence_at_created_oid():
        _revalidate_creation_safety(main, args, path, receipt, entry)
        current_tracked = _tracked_evidence(target)
        if current_tracked == tracked_evidence:
            paths = tracked_evidence["paths"]
            if paths:
                _revalidate_creation_safety(main, args, path, receipt, entry)
                restored = run(
                    [
                        "git", "restore", f"--source={expected_oid}",
                        "--staged", "--worktree", "--", *paths,
                    ],
                    cwd=target,
                    check=False,
                )
                if restored.returncode != 0:
                    raise LifecycleError(
                        "bounded tracked restoration failed during creation recovery"
                    )
        elif current_tracked != _tracked_evidence_at_created_oid():
            raise LifecycleError("tracked setup changes changed after failed setup")
    _revalidate_creation_safety(main, args, path, receipt, entry)
    with verified_worktree_root(
        target,
        entry["rootDevice"],
        entry["rootInode"],
    ) as descriptor:
        for relative in setup_created:
            _revalidate_creation_safety(main, args, path, receipt, entry)
            expected = next(
                item for item in entry["setupCreatedFiles"]
                if item["path"] == relative
            )
            remove_contained_untracked(descriptor, expected)
    latest = collect_cleanup_facts(main, target, pr_state="none")
    if latest.tracked_files or latest.untracked_files:
        raise LifecycleError("creation recovery inventory changed before removal")
    _revalidate_creation_safety(main, args, path, receipt, entry)
    if not delete_owned_refs_prepared(
        main,
        branch,
        proof_ref,
        expected_oid,
        entry["createdOid"],
        f"refs/tags/wave-active/{args.anchor}",
        receipt["claimOid"],
        remove_worktree=target,
        root_identity=(entry["rootDevice"], entry["rootInode"]),
    ):
        raise LifecycleError(
            f"locked worktree/ref removal failed during creation recovery: {branch}"
        )
    if os.path.lexists(target) or branch in worktree_branches(main):
        raise LifecycleError("worktree still exists after creation recovery")
    _archive_recovered_target(path, receipt, entry, archive_reason)


def recover_creation(main: Path, args: argparse.Namespace) -> dict[str, Any]:
    with receipt_lock(main, args.anchor):
        path, receipt = read_receipt(main, args.anchor, args.owner)
        entry = next(
            (
                candidate for candidate in receipt["targets"]
                if candidate.get("branch") == args.branch
            ),
            None,
        )
        if entry is None:
            raise LifecycleError(f"no receipt target for recovery: {args.branch}")
        if entry.get("state") not in {
            "provisional",
            "baseline-pending",
            "setting-up",
            "recovery-pending",
        }:
            raise LifecycleError(
                f"target is not a recoverable creation attempt: {args.branch}: "
                f"{entry.get('state', '<missing>')}"
            )
        entry["state"] = "recovery-pending"
        entry.pop("failure", None)
        write_receipt(path, receipt)
        _recover_creation_entry(
            main,
            args,
            path,
            receipt,
            entry,
            archive_reason="explicit creation recovery",
        )
    return {
        "recovered": True,
        "branch": args.branch,
        "receipt": str(path),
    }


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
            if entry.get("state") != "active":
                raise LifecycleError(
                    f"session target is not ready to seal: {branch}: "
                    f"{entry.get('state', '<missing>')}"
                )
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
            proof_ref = validated_proof_ref(receipt, entry)
            if resolve_ref(main, proof_ref) != entry["createdOid"]:
                raise LifecycleError(f"session ownership proof changed before seal: {branch}")
            entry["expectedOid"] = expected
            entry["state"] = "sealed"
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
        proof_ref = validated_proof_ref(receipt, entry)
        proof_oid = resolve_ref(main, proof_ref)
        target_exists = os.path.lexists(target)
        linked_path = linked.get(branch)
        fully_absent = (
            current_oid is None
            and proof_oid is None
            and not target_exists
            and linked_path is None
        )
        if entry.get("removed"):
            if fully_absent:
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
            else:
                rows.append({
                    "branch": branch,
                    "worktree": str(target),
                    "expectedOid": entry.get("expectedOid"),
                    "currentOid": current_oid,
                    "integration": "ambiguous",
                    "commits": [],
                    "reasons": ["removed target was recreated"],
                    "removable": False,
                    "scratchFiles": [],
                })
            continue
        if (
            fully_absent
            and entry.get("teardownPhase") == "ref-deletion-pending"
        ):
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
        if fully_absent:
            rows.append({
                "branch": branch,
                "worktree": str(target),
                "expectedOid": entry.get("expectedOid"),
                "currentOid": current_oid,
                "integration": "ambiguous",
                "commits": [],
                "reasons": ["owned target disappeared outside session teardown"],
                "removable": False,
                "scratchFiles": [],
            })
            continue
        expected_oid = entry.get("expectedOid")
        if not expected_oid or current_oid != expected_oid:
            reasons.append(
                f"unexpected OID: expected {expected_oid or '<unsealed>'}, "
                f"found {current_oid or '<missing>'}"
            )
        if proof_oid != entry.get("createdOid"):
            reasons.append("session ownership proof is missing or changed")
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
            if not target_exists and linked_path is not None:
                reasons.append(
                    "worktree directory is missing while Git registration remains"
                )
            elif target_exists and (target.is_symlink() or not target.is_dir()):
                reasons.append("worktree root type changed")
            elif linked_path != target.resolve():
                reasons.append("worktree registration no longer matches receipt")
            elif target_exists:
                metadata = target.stat()
                if (metadata.st_dev, metadata.st_ino) != (
                    entry["rootDevice"], entry["rootInode"]
                ):
                    reasons.append("worktree root identity changed")
                verified_scratch: tuple[str, ...] = ()
                try:
                    baseline = load_artifact_baseline(target)
                    if (
                        baseline.digest != entry.get("artifactBaselineDigest")
                        or baseline.setup_head != entry["createdOid"]
                    ):
                        raise LifecycleError(
                            "artifact provenance baseline changed or is incoherent"
                        )
                    verified_scratch = verified_landing_scratch_files(
                        profile,
                        target,
                        expected_baseline_digest=entry["artifactBaselineDigest"],
                    )
                except (LifecycleError, KeyError) as error:
                    reasons.append(f"artifact provenance baseline stop: {error}")
                facts = collect_cleanup_facts(
                    main,
                    target,
                    merge_target=args.main,
                    pr_state=state,
                )
                cleanup = classify_cleanup(
                    profile,
                    facts,
                    verified_scratch_files=verified_scratch,
                )
                reasons.extend(
                    reason for reason in cleanup.reasons
                    if not reason.startswith("unmerged branch:")
                )
                scratch = list(cleanup.scratch_files)
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


def revalidate_target(
    main: Path,
    args: argparse.Namespace,
    receipt_path_value: Path,
    receipt: dict[str, Any],
    entry: dict[str, Any],
    main_oid: str,
) -> dict[str, Any]:
    if resolve_commit(main, args.main) != main_oid:
        raise LifecycleError("canonical main moved before target mutation")
    current_path, current_receipt, report = assess(main, args)
    if current_path != receipt_path_value or current_receipt != receipt:
        raise LifecycleError("active claim or teardown receipt changed before mutation")
    row = next(
        (candidate for candidate in report["targets"]
         if candidate["branch"] == entry["branch"]),
        None,
    )
    if row is None:
        raise LifecycleError("exact receipt target disappeared before mutation")
    if not row["removable"] or row["integration"] == "already-removed":
        detail = ", ".join(row["reasons"]) or row["integration"]
        raise LifecycleError(
            f"target changed before mutation: {entry['branch']}: {detail}"
        )
    # assess queries PR state after reading the receipt. Close that race with a
    # final claim/receipt, profile, PR and ref/proof pass.
    revalidate_owned_safety(
        main, args, receipt_path_value, receipt, entry,
        expected_oid=entry["expectedOid"],
        error_suffix="target mutation",
    )
    return row


def revalidate_owned_safety(
    main: Path,
    args: argparse.Namespace,
    receipt_path_value: Path,
    receipt: dict[str, Any],
    entry: dict[str, Any],
    *,
    expected_oid: str,
    error_suffix: str,
) -> None:
    branch = entry["branch"]
    if pr_state(args.gh_command, main, branch) == "open":
        raise LifecycleError(f"open PR before {error_suffix}: {branch}")
    current_path, current_receipt = read_receipt(main, args.anchor, args.owner)
    if current_path != receipt_path_value or current_receipt != receipt:
        raise LifecycleError(
            f"active claim or teardown receipt changed before {error_suffix}"
        )
    profile = load_profile(Path(entry["profile"]))
    if branch in profile.protected_branches:
        raise LifecycleError(f"protected branch before {error_suffix}: {branch}")
    if resolve_ref(main, f"refs/heads/{branch}") != expected_oid:
        raise LifecycleError(f"unexpected OID before {error_suffix}: {branch}")
    proof_ref = validated_proof_ref(receipt, entry)
    if resolve_ref(main, proof_ref) != entry["createdOid"]:
        raise LifecycleError(f"session ownership proof changed before {error_suffix}: {branch}")


def revalidate_ref_cleanup(
    main: Path,
    args: argparse.Namespace,
    receipt_path_value: Path,
    receipt: dict[str, Any],
    entry: dict[str, Any],
    main_oid: str,
) -> None:
    if resolve_commit(main, args.main) != main_oid:
        raise LifecycleError("canonical main moved before branch cleanup")
    branch = entry["branch"]
    revalidate_owned_safety(
        main, args, receipt_path_value, receipt, entry,
        expected_oid=entry["expectedOid"],
        error_suffix="branch cleanup",
    )
    target = Path(entry["worktree"])
    linked = worktree_branches(main)
    target_present = os.path.lexists(target)
    if target_present:
        metadata = target.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or
            linked.get(branch) != target.resolve()
            or (metadata.st_dev, metadata.st_ino)
            != (entry["rootDevice"], entry["rootInode"])
        ):
            raise LifecycleError(
                f"worktree identity changed before branch cleanup: {branch}"
            )
    elif branch in linked:
        raise LifecycleError(
            f"worktree registration changed before branch cleanup: {branch}"
        )
    elif entry.get("teardownPhase") != "ref-deletion-pending":
        raise LifecycleError(f"owned worktree disappeared before branch cleanup: {branch}")


def canonical_ref(repo: Path, rev: str) -> str | None:
    result = run(
        ["git", "rev-parse", "--symbolic-full-name", rev],
        cwd=repo,
        check=False,
    )
    value = result.stdout.strip()
    return value if result.returncode == 0 and value.startswith("refs/") else None


def immutable_oid(value: str) -> bool:
    return len(value) == 40 and all(character in "0123456789abcdef" for character in value)


def teardown(main: Path, args: argparse.Namespace) -> dict[str, Any]:
    with receipt_lock(main, args.anchor):
        path, receipt, preview = assess(main, args)
        main_ref = canonical_ref(main, args.main)
        if main_ref is None and not immutable_oid(args.main):
            raise LifecycleError(
                "canonical main must be a ref or immutable full commit OID"
            )
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
            row = revalidate_target(
                main,
                args,
                path,
                receipt,
                entry,
                preview["mainOid"],
            )
            if row["scratchFiles"] != by_branch[entry["branch"]]["scratchFiles"]:
                raise LifecycleError(
                    f"scratch inventory changed before target mutation: "
                    f"{entry['branch']}"
                )
            target = Path(entry["worktree"])
            if os.path.lexists(target):
                with verified_worktree_root(
                    target,
                    entry["rootDevice"],
                    entry["rootInode"],
                ) as descriptor:
                    for scratch in row["scratchFiles"]:
                        remove_contained_regular(descriptor, scratch)
                after_scratch = revalidate_target(
                    main,
                    args,
                    path,
                    receipt,
                    entry,
                    preview["mainOid"],
                )
                if after_scratch["scratchFiles"]:
                    raise LifecycleError(
                        f"scratch inventory changed before worktree removal: "
                        f"{entry['branch']}"
                    )
            revalidate_ref_cleanup(
                main,
                args,
                path,
                receipt,
                entry,
                preview["mainOid"],
            )
            entry["teardownPhase"] = "ref-deletion-pending"
            write_receipt(path, receipt)
            revalidate_ref_cleanup(
                main,
                args,
                path,
                receipt,
                entry,
                preview["mainOid"],
            )
            if not delete_owned_refs_prepared(
                main,
                entry["branch"],
                entry["proofRef"],
                entry["expectedOid"],
                entry["createdOid"],
                f"refs/tags/wave-active/{args.anchor}",
                receipt["claimOid"],
                remove_worktree=target if os.path.lexists(target) else None,
                main_ref=main_ref,
                main_oid=preview["mainOid"],
                root_identity=(
                    (entry["rootDevice"], entry["rootInode"])
                    if os.path.lexists(target) else None
                ),
            ):
                raise LifecycleError(
                    f"locked worktree/ref cleanup stopped: {entry['branch']}"
                )
            entry["removed"] = True
            entry["teardownPhase"] = "removed"
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
    create_parser.add_argument("--gh-command", default="gh")
    create_parser.add_argument("issue")
    create_parser.add_argument("slug")
    create_parser.add_argument("branch_type", nargs="?", default="feat")

    recover_parser = common("recover")
    recover_parser.add_argument("--branch", required=True)
    recover_parser.add_argument("--gh-command", default="gh")

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
            "recover": recover_creation,
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
