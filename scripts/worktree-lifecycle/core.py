"""Consumer-neutral Worktree Lifecycle facts and decisions."""

from __future__ import annotations

import json
import os
import re
import stat
from contextlib import contextmanager
from dataclasses import dataclass, replace
from fnmatch import fnmatchcase
from hashlib import sha256
from pathlib import Path, PurePosixPath
from time import time
from typing import Any, Callable

from profile import (
    LifecycleError,
    WorktreeProfile,
    load_profile,
    load_profile_text,
    local_branch_exists,
    main_worktree,
    registered_worktrees,
    run,
)

_BRANCH_CHANGE_RE = re.compile(r"\b(?:git\s+(?:checkout|switch)|gh\s+pr\s+(?:merge|checkout))\b")
_BRANCH_CREATE_RE = re.compile(r"\bgit\s+(?:checkout|switch)\s+-[bc]\s+(\S+)")
ARTIFACT_BASELINE_FILE = "awkit-artifact-baseline-v1.json"
LANDING_ATTEMPT_FILE = "awkit-landing-attempt-v1.json"


class BaselineBackfillDeferred(LifecycleError):
    """A safe legacy baseline cannot be captured until consumer state changes."""


def durable_atomic_json(
    path: Path,
    document: dict[str, Any],
    *,
    label: str,
    mode: int = 0o666,
    sort_keys: bool = False,
) -> None:
    """Atomically replace one JSON journal and durably publish its directory entry."""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                document,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=sort_keys,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory_descriptor = os.open(
            path.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise LifecycleError(f"cannot {label}: {error}") from error


def durable_replace(source: Path, destination: Path, *, label: str) -> None:
    """Rename one journal durably without inspecting or claiming its payload files."""
    try:
        os.replace(source, destination)
        directory_descriptor = os.open(
            destination.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError as error:
        raise LifecycleError(f"cannot {label}: {error}") from error


def path_glob_matches(path: str, pattern: str) -> bool:
    """Match POSIX path segments while retaining fnmatch bracket compatibility."""
    path_parts = PurePosixPath(path).parts
    pattern_parts = PurePosixPath(pattern).parts
    memo: dict[tuple[int, int], bool] = {}

    def matches(path_index: int, pattern_index: int) -> bool:
        key = (path_index, pattern_index)
        if key in memo:
            return memo[key]
        if pattern_index == len(pattern_parts):
            result = path_index == len(path_parts)
        elif pattern_parts[pattern_index] == "**":
            result = matches(path_index, pattern_index + 1) or (
                path_index < len(path_parts)
                and matches(path_index + 1, pattern_index)
            )
        else:
            result = (
                path_index < len(path_parts)
                and fnmatchcase(path_parts[path_index], pattern_parts[pattern_index])
                and matches(path_index + 1, pattern_index + 1)
            )
        memo[key] = result
        return result

    return matches(0, 0)

@dataclass(frozen=True)
class RepoFacts:
    root: Path
    main_root: Path
    branch: str
    main_branch: str
    is_main_worktree: bool
    worktrees: tuple[Path, ...]
    changed_count: int


@dataclass(frozen=True)
class Decision:
    action: str
    message: str = ""
    event_name: str = ""


@dataclass(frozen=True)
class CleanupAssessment:
    worktree: Path
    branch: str
    assumptions: str
    reasons: tuple[str, ...]
    root_device: int
    root_inode: int
    scratch_files: tuple[str, ...] = ()
    scratch_evidence: tuple[dict[str, Any], ...] = ()

    @property
    def removable(self) -> bool:
        return not self.reasons


@dataclass(frozen=True)
class CleanupFacts:
    worktree: Path
    branch: str
    registered: bool
    is_main: bool
    tracked_files: tuple[str, ...]
    untracked_files: tuple[str, ...]
    merged: bool
    pr_state: str
    assumptions: str
    root_device: int
    root_inode: int


@dataclass(frozen=True)
class ArtifactBaseline:
    worktree: Path
    branch: str
    root_device: int
    root_inode: int
    setup_head: str
    initial_ignored_files: tuple[str, ...]
    initial_untracked_files: tuple[str, ...]
    digest: str


def ignored_file_inventory(worktree: Path) -> tuple[str, ...]:
    result = run(
        [
            "git", "ls-files", "--others", "--ignored",
            "--exclude-standard", "-z",
        ],
        cwd=worktree,
    )
    return tuple(sorted(path for path in result.stdout.split("\0") if path))


def untracked_file_inventory(worktree: Path) -> tuple[str, ...]:
    ordinary = run(
        ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        cwd=worktree,
    ).stdout.split("\0")
    return tuple(sorted(
        set(path for path in ordinary if path).union(ignored_file_inventory(worktree))
    ))


def artifact_baseline_path(worktree: Path) -> Path:
    result = run(
        ["git", "rev-parse", "--absolute-git-dir"],
        cwd=worktree,
    )
    git_dir = Path(result.stdout.strip())
    if not git_dir.is_absolute():
        raise LifecycleError("artifact provenance baseline git dir is not absolute")
    return git_dir / ARTIFACT_BASELINE_FILE


def _baseline_payload(
    *,
    worktree: Path,
    branch: str,
    root_device: int,
    root_inode: int,
    setup_head: str,
    initial_ignored_files: tuple[str, ...],
    initial_untracked_files: tuple[str, ...],
) -> dict[str, Any]:
    return {
        "contractVersion": 2,
        "worktree": str(worktree),
        "branch": branch,
        "rootDevice": root_device,
        "rootInode": root_inode,
        "setupHead": setup_head,
        "initialIgnoredFiles": list(initial_ignored_files),
        "initialUntrackedFiles": list(initial_untracked_files),
    }


def _baseline_digest(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256(encoded).hexdigest()


def landing_cleanup_policy_digest(profile: WorktreeProfile) -> str:
    """Bind one attempt to the exact ordered policy that nominated its files."""
    return _baseline_digest({
        "scratchPatterns": list(profile.scratch_patterns),
        "landingGeneratedArtifactPatterns": list(
            profile.landing_generated_artifact_patterns
        ),
    })


def capture_artifact_baseline(
    worktree: Path,
    *,
    reject_ignored_patterns: tuple[str, ...] = (),
) -> ArtifactBaseline:
    worktree = worktree.resolve()
    metadata = worktree.stat()
    branch = run(["git", "branch", "--show-current"], cwd=worktree).stdout.strip()
    setup_head = run(["git", "rev-parse", "HEAD"], cwd=worktree).stdout.strip()
    ignored = ignored_file_inventory(worktree)
    untracked = untracked_file_inventory(worktree)
    blocked = tuple(sorted(
        path
        for path in ignored
        if any(path_glob_matches(path, pattern) for pattern in reject_ignored_patterns)
    ))
    if blocked:
        raise BaselineBackfillDeferred(
            "landing-start generated paths are consumer-owned and protected: "
            + ", ".join(blocked)
        )
    payload = _baseline_payload(
        worktree=worktree,
        branch=branch,
        root_device=metadata.st_dev,
        root_inode=metadata.st_ino,
        setup_head=setup_head,
        initial_ignored_files=ignored,
        initial_untracked_files=untracked,
    )
    digest = _baseline_digest(payload)
    path = artifact_baseline_path(worktree)
    durable_atomic_json(
        path,
        {**payload, "sha256": digest},
        label="write artifact provenance baseline",
    )
    return ArtifactBaseline(
        worktree,
        branch,
        metadata.st_dev,
        metadata.st_ino,
        setup_head,
        ignored,
        untracked,
        digest,
    )


def load_artifact_baseline(worktree: Path) -> ArtifactBaseline:
    worktree = worktree.resolve()
    path = artifact_baseline_path(worktree)
    try:
        if path.is_symlink() or not path.is_file():
            raise LifecycleError("artifact provenance baseline is missing or not a regular file")
        document = json.loads(path.read_text(encoding="utf-8"))
        payload = {
            key: document[key]
            for key in (
                "contractVersion",
                "worktree",
                "branch",
                "rootDevice",
                "rootInode",
                "setupHead",
                "initialIgnoredFiles",
                "initialUntrackedFiles",
            )
        }
        digest = document["sha256"]
    except LifecycleError:
        raise
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise LifecycleError(f"artifact provenance baseline is incoherent: {error}") from error
    ignored = payload["initialIgnoredFiles"]
    untracked = payload["initialUntrackedFiles"]
    if (
        payload["contractVersion"] != 2
        or not isinstance(payload["worktree"], str)
        or not isinstance(payload["branch"], str)
        or not payload["branch"]
        or type(payload["rootDevice"]) is not int
        or type(payload["rootInode"]) is not int
        or not isinstance(payload["setupHead"], str)
        or re.fullmatch(r"[0-9a-f]{40,64}", payload["setupHead"]) is None
        or not isinstance(ignored, list)
        or not all(
            isinstance(path_value, str)
            and path_value
            and not PurePosixPath(path_value).is_absolute()
            and ".." not in PurePosixPath(path_value).parts
            for path_value in ignored
        )
        or ignored != sorted(set(ignored))
        or not isinstance(untracked, list)
        or not all(
            isinstance(path_value, str)
            and path_value
            and not PurePosixPath(path_value).is_absolute()
            and ".." not in PurePosixPath(path_value).parts
            for path_value in untracked
        )
        or untracked != sorted(set(untracked))
        or not set(ignored).issubset(untracked)
        or not isinstance(digest, str)
        or re.fullmatch(r"[0-9a-f]{64}", digest) is None
        or digest != _baseline_digest(payload)
    ):
        raise LifecycleError("artifact provenance baseline is incoherent")
    try:
        metadata = worktree.stat()
        branch = run(["git", "branch", "--show-current"], cwd=worktree).stdout.strip()
    except (OSError, LifecycleError) as error:
        raise LifecycleError(
            f"artifact provenance baseline binding cannot be verified: {error}"
        ) from error
    if (
        payload["worktree"] != str(worktree)
        or payload["branch"] != branch
        or (payload["rootDevice"], payload["rootInode"])
        != (metadata.st_dev, metadata.st_ino)
    ):
        raise LifecycleError("artifact provenance baseline binding does not match worktree")
    return ArtifactBaseline(
        worktree,
        branch,
        metadata.st_dev,
        metadata.st_ino,
        payload["setupHead"],
        tuple(ignored),
        tuple(untracked),
        digest,
    )


def ensure_artifact_baseline(
    worktree: Path,
    *,
    reject_ignored_patterns: tuple[str, ...] = (),
) -> ArtifactBaseline:
    """Load provenance or conservatively backfill one exact clean legacy worktree."""
    path = artifact_baseline_path(worktree)
    if os.path.lexists(path):
        return load_artifact_baseline(worktree)
    attempt_path = path.with_name(LANDING_ATTEMPT_FILE)
    if os.path.lexists(attempt_path):
        raise LifecycleError(
            "artifact provenance baseline is missing while a landing attempt exists"
        )
    absolute = worktree.absolute()
    try:
        metadata = os.lstat(absolute)
    except OSError as error:
        raise LifecycleError(
            f"legacy artifact baseline root cannot be inspected: {error}"
        ) from error
    if not stat.S_ISDIR(metadata.st_mode) or absolute != worktree.resolve():
        raise LifecycleError("legacy artifact baseline root is not an exact nofollow directory")
    main = main_worktree(worktree)
    if worktree.resolve() not in registered_worktrees(main):
        raise LifecycleError("legacy artifact baseline requires an exact registered worktree")
    branch = run(["git", "branch", "--show-current"], cwd=worktree).stdout.strip()
    if not branch:
        raise LifecycleError("legacy artifact baseline requires an attached branch")
    for command in (
        ["git", "diff", "--quiet"],
        ["git", "diff", "--cached", "--quiet"],
    ):
        if run(command, cwd=worktree, check=False).returncode != 0:
            raise BaselineBackfillDeferred(
                "legacy artifact baseline requires a clean tracked worktree and index"
            )
    return capture_artifact_baseline(
        worktree,
        reject_ignored_patterns=reject_ignored_patterns,
    )


def verified_landing_scratch_files(
    profile: WorktreeProfile,
    worktree: Path,
    *,
    expected_baseline_digest: str | None = None,
    landing_start_files: tuple[str, ...] = (),
) -> tuple[str, ...]:
    return tuple(
        item["path"]
        for item in verified_landing_scratch_evidence(
            profile,
            worktree,
            expected_baseline_digest=expected_baseline_digest,
            landing_start_files=landing_start_files,
        )
    )


def landing_start_artifact_inventory(
    profile: WorktreeProfile,
    worktree: Path,
) -> dict[str, Any]:
    """Persist/reuse the generated-path inventory preceding the landing build."""
    baseline = ensure_artifact_baseline(
        worktree,
        reject_ignored_patterns=profile.landing_generated_artifact_patterns,
    )
    path = artifact_baseline_path(worktree).with_name(LANDING_ATTEMPT_FILE)
    if path.exists():
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
            payload = {
                key: document[key]
                for key in (
                    "contractVersion", "worktree", "branch", "rootDevice",
                    "rootInode", "baselineDigest", "generatedFiles",
                    "generatedEvidence", "state", "authorizedEvidence",
                    "pushSucceeded", "policyDigest",
                )
            }
            digest = document["sha256"]
        except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
            raise LifecycleError(
                f"landing-attempt provenance is incoherent: {error}"
            ) from error
        if payload["policyDigest"] != landing_cleanup_policy_digest(profile):
            raise LifecycleError(
                "landing cleanup policy changed after attempt start; "
                "abandon the unfinished attempt before retrying"
            )
        if (
            payload["contractVersion"] != 2
            or payload["worktree"] != str(worktree.resolve())
            or payload["branch"] != baseline.branch
            or (payload["rootDevice"], payload["rootInode"])
            != (baseline.root_device, baseline.root_inode)
            or payload["baselineDigest"] != baseline.digest
            or not isinstance(payload["generatedFiles"], list)
            or payload["generatedFiles"] != sorted(set(payload["generatedFiles"]))
            or not isinstance(payload["generatedEvidence"], list)
            or payload["state"] not in {"started", "frozen"}
            or not isinstance(payload["authorizedEvidence"], list)
            or type(payload["pushSucceeded"]) is not bool
            or digest != _baseline_digest(payload)
        ):
            raise LifecycleError("landing-attempt provenance is incoherent")
        return {
            "baselineDigest": payload["baselineDigest"],
            "generatedFiles": payload["generatedFiles"],
            "generatedEvidence": payload["generatedEvidence"],
            "state": payload["state"],
            "authorizedEvidence": payload["authorizedEvidence"],
            "pushSucceeded": payload["pushSucceeded"],
            "policyDigest": payload["policyDigest"],
            "newAttempt": False,
        }
    current = set(ignored_file_inventory(worktree))
    generated = tuple(sorted(
        path for path in current
        if any(
            path_glob_matches(path, pattern)
            for pattern in profile.landing_generated_artifact_patterns
        )
    ))
    if generated:
        raise LifecycleError(
            "landing-start generated paths are consumer-owned and protected: "
            + ", ".join(generated)
        )
    result = {
        "baselineDigest": baseline.digest,
        "generatedFiles": list(generated),
        "generatedEvidence": [],
        "state": "started",
        "authorizedEvidence": [],
        "pushSucceeded": False,
        "policyDigest": landing_cleanup_policy_digest(profile),
    }
    payload = {
        "contractVersion": 2,
        "worktree": str(worktree.resolve()),
        "branch": baseline.branch,
        "rootDevice": baseline.root_device,
        "rootInode": baseline.root_inode,
        **result,
    }
    digest = _baseline_digest(payload)
    durable_atomic_json(
        path,
        {**payload, "sha256": digest},
        label="persist landing-attempt provenance",
    )
    return {**result, "newAttempt": True}


def verified_landing_scratch_evidence(
    profile: WorktreeProfile,
    worktree: Path,
    *,
    expected_baseline_digest: str | None = None,
    landing_start_files: tuple[str, ...] = (),
) -> tuple[dict[str, Any], ...]:
    """Return frozen regular-file identities for the authorized generator delta."""
    baseline = load_artifact_baseline(worktree)
    if (
        expected_baseline_digest is not None
        and baseline.digest != expected_baseline_digest
    ):
        raise LifecycleError("artifact provenance baseline changed during landing")
    current = set(ignored_file_inventory(worktree))
    initial = current.intersection(baseline.initial_ignored_files)
    initial_generated = sorted(
        path for path in initial
        if any(
            path_glob_matches(path, pattern)
            for pattern in profile.landing_generated_artifact_patterns
        )
    )
    if initial_generated:
        raise LifecycleError(
            "artifact provenance baseline protects initial generated paths: "
            + ", ".join(initial_generated)
        )
    if landing_start_files:
        raise LifecycleError(
            "landing-start generated paths are consumer-owned and protected: "
            + ", ".join(sorted(landing_start_files))
        )
    candidates = tuple(sorted(
        path
        for path in current.difference(baseline.initial_ignored_files)
        if path not in landing_start_files
        if any(
            path_glob_matches(path, pattern)
            for pattern in profile.landing_generated_artifact_patterns
        )
    ))
    if not candidates:
        return ()
    with verified_worktree_root(
        worktree,
        baseline.root_device,
        baseline.root_inode,
    ) as descriptor:
        return tuple(
            contained_regular_identity(descriptor, relative)
            for relative in candidates
        )


def freeze_landing_artifact_evidence(
    profile: WorktreeProfile,
    worktree: Path,
    *,
    push_succeeded: bool,
) -> tuple[dict[str, Any], ...]:
    """Freeze or revalidate the exact output of one generator-capable push."""
    attempt = landing_start_artifact_inventory(profile, worktree)
    current = verified_landing_scratch_evidence(
        profile,
        worktree,
        expected_baseline_digest=attempt["baselineDigest"],
        landing_start_files=tuple(attempt["generatedFiles"]),
    )
    frozen = tuple(attempt["authorizedEvidence"])
    if attempt["state"] == "frozen" and frozen != current:
        raise LifecycleError(
            "landing-generated evidence changed after it was frozen"
        )
    if attempt["state"] == "frozen":
        return frozen
    path = artifact_baseline_path(worktree).with_name(LANDING_ATTEMPT_FILE)
    document = json.loads(path.read_text(encoding="utf-8"))
    payload = {
        key: document[key]
        for key in (
            "contractVersion", "worktree", "branch", "rootDevice",
            "rootInode", "baselineDigest", "generatedFiles",
            "generatedEvidence", "policyDigest",
        )
    }
    payload.update({
        "state": "frozen",
        "authorizedEvidence": list(current),
        "pushSucceeded": push_succeeded,
    })
    digest = _baseline_digest(payload)
    durable_atomic_json(
        path,
        {**payload, "sha256": digest},
        label="freeze landing-generated evidence",
    )
    return current


def reopen_frozen_landing_attempt(
    profile: WorktreeProfile,
    worktree: Path,
) -> tuple[dict[str, Any], ...]:
    """Validate a failed push boundary before permitting its generator to retry."""
    frozen = freeze_landing_artifact_evidence(
        profile, worktree, push_succeeded=False
    )
    path = artifact_baseline_path(worktree).with_name(LANDING_ATTEMPT_FILE)
    document = json.loads(path.read_text(encoding="utf-8"))
    payload = {
        key: document[key]
        for key in (
            "contractVersion", "worktree", "branch", "rootDevice",
            "rootInode", "baselineDigest", "generatedFiles",
            "generatedEvidence", "policyDigest",
        )
    }
    payload.update({
        "state": "started",
        "authorizedEvidence": [],
        "pushSucceeded": False,
    })
    digest = _baseline_digest(payload)
    durable_atomic_json(
        path,
        {**payload, "sha256": digest},
        label="reopen validated landing attempt",
    )
    return frozen


def abandon_unfinished_landing_attempt(
    worktree: Path,
) -> Path:
    """Archive an ambiguous started attempt without claiming or deleting files."""
    path = artifact_baseline_path(worktree).with_name(LANDING_ATTEMPT_FILE)
    if not os.path.lexists(path):
        raise LifecycleError("no pre-existing unfinished landing attempt to abandon")
    try:
        if path.is_symlink() or not path.is_file():
            raise LifecycleError("landing-attempt provenance is not a regular file")
        document = json.loads(path.read_text(encoding="utf-8"))
        contract_version = document["contractVersion"]
        keys = [
            "contractVersion", "worktree", "branch", "rootDevice",
            "rootInode", "baselineDigest", "generatedFiles",
            "generatedEvidence", "state", "authorizedEvidence",
            "pushSucceeded",
        ]
        if contract_version == 2:
            keys.append("policyDigest")
        payload = {
            key: document[key]
            for key in keys
        }
        digest = document["sha256"]
        metadata = os.lstat(worktree)
        branch = run(["git", "branch", "--show-current"], cwd=worktree).stdout.strip()
    except LifecycleError:
        raise
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise LifecycleError(f"landing-attempt provenance is incoherent: {error}") from error
    if (
        payload["contractVersion"] not in {1, 2}
        or payload["worktree"] != str(worktree.resolve())
        or payload["branch"] != branch
        or not stat.S_ISDIR(metadata.st_mode)
        or (payload["rootDevice"], payload["rootInode"])
        != (metadata.st_dev, metadata.st_ino)
        or payload["state"] not in {"started", "frozen"}
        or digest != _baseline_digest(payload)
    ):
        raise LifecycleError("landing-attempt provenance is incoherent")
    archive = path.with_name(
        f"{path.stem}.abandoned-{int(time() * 1_000_000)}.json"
    )
    durable_replace(path, archive, label="archive landing attempt")
    return archive


def collect_facts(cwd: Path) -> RepoFacts:
    root = Path(run(["git", "rev-parse", "--show-toplevel"], cwd=cwd).stdout.strip()).resolve()
    main = main_worktree(root)
    branch = run(["git", "branch", "--show-current"], cwd=root).stdout.strip()
    main_branch = run(
        ["git", "-C", str(main), "branch", "--show-current"],
        cwd=root,
    ).stdout.strip()
    worktrees = tuple(sorted(registered_worktrees(root)))
    status = run(["git", "status", "--porcelain"], cwd=root).stdout
    return RepoFacts(
        root=root,
        main_root=main,
        branch=branch,
        main_branch=main_branch,
        is_main_worktree=root == main,
        worktrees=worktrees,
        changed_count=len([line for line in status.splitlines() if line]),
    )


def branch_context(profile: WorktreeProfile, facts: RepoFacts) -> Decision:
    lines = [f"Branch: {facts.branch}", f"Status: {facts.changed_count} uncommitted change(s)"]
    issue = profile.issue_from_branch(facts.branch)
    if issue:
        lines.insert(1, f"Issue: #{issue}")
    elif facts.branch in profile.protected_branches:
        lines.insert(1, "Warning: direct work on a protected branch")
    else:
        lines.insert(1, "Warning: branch has no issue according to the consumer profile")
    if len(facts.worktrees) > 1:
        lines.append(f"Worktrees: {len(facts.worktrees)} active")
        lines.append(f"Setup entry: {profile.setup_entry}")
    return Decision("emit", "\n".join(lines), "SessionStart")


def repo_relative(target: str, root: Path) -> str | None:
    if not target:
        return None
    path = Path(target)
    if not path.is_absolute():
        return target
    try:
        return str(path.resolve().relative_to(root))
    except ValueError:
        return None


def is_ignored(root: Path, relative: str) -> bool:
    result = run(
        ["git", "check-ignore", "-q", "--", relative],
        cwd=root,
        check=False,
    )
    return result.returncode == 0


def is_tracked(root: Path, relative: str) -> bool:
    result = run(
        ["git", "ls-files", "--error-unmatch", "--", relative],
        cwd=root,
        check=False,
    )
    return result.returncode == 0


def cleanup_assessment(
    profile: WorktreeProfile,
    main: Path,
    target: Path,
    merge_target: str | None = None,
    pr_state: str = "none",
    verified_scratch_files: tuple[str, ...] = (),
    verified_scratch_evidence: tuple[dict[str, Any], ...] = (),
) -> CleanupAssessment:
    assessment = classify_cleanup(
        profile,
        collect_cleanup_facts(
            main,
            target,
            merge_target=merge_target,
            pr_state=pr_state,
        ),
        verified_scratch_files=verified_scratch_files,
    )
    try:
        return bind_cleanup_scratch_evidence(
            profile,
            assessment,
            verified_scratch_evidence,
            require_generator_evidence=True,
        )
    except LifecycleError as error:
        return replace(
            assessment,
            reasons=assessment.reasons + (f"scratch evidence stop: {error}",),
        )


def collect_cleanup_facts(
    main: Path,
    target: Path,
    *,
    merge_target: str | None = None,
    pr_state: str = "none",
) -> CleanupFacts:
    worktree = target.resolve()
    root_metadata = worktree.stat()
    branch = run(
        ["git", "-C", str(worktree), "branch", "--show-current"],
        cwd=main,
        check=False,
    ).stdout.strip()
    tracked = set(run(
        ["git", "-C", str(worktree), "diff", "--name-only"],
        cwd=main,
        check=False,
    ).stdout.splitlines())
    tracked.update(run(
        ["git", "-C", str(worktree), "diff", "--cached", "--name-only"],
        cwd=main,
        check=False,
    ).stdout.splitlines())
    untracked = set(run(
        ["git", "-C", str(worktree), "ls-files", "--others", "--exclude-standard"],
        cwd=main,
        check=False,
    ).stdout.splitlines())
    untracked.update(run(
        [
            "git", "-C", str(worktree), "ls-files", "--others", "--ignored",
            "--exclude-standard",
        ],
        cwd=main,
        check=False,
    ).stdout.splitlines())
    # ANNAHMEN.md is governed separately: its bytes are returned before removal.
    untracked.discard("ANNAHMEN.md")
    merged = False
    if branch:
        main_branch = merge_target or run(
            ["git", "-C", str(main), "branch", "--show-current"],
            cwd=main,
            check=False,
        ).stdout.strip()
        merged = run(
            ["git", "merge-base", "--is-ancestor", branch, main_branch],
            cwd=main,
            check=False,
        ).returncode == 0
    assumptions_path = worktree / "ANNAHMEN.md"
    assumptions = assumptions_path.read_text(encoding="utf-8") if assumptions_path.is_file() else ""
    return CleanupFacts(
        worktree=worktree,
        branch=branch,
        registered=worktree in registered_worktrees(main),
        is_main=worktree == main.resolve(),
        tracked_files=tuple(sorted(tracked)),
        untracked_files=tuple(sorted(untracked)),
        merged=merged,
        pr_state=pr_state,
        assumptions=assumptions,
        root_device=root_metadata.st_dev,
        root_inode=root_metadata.st_ino,
    )


def classify_cleanup(
    profile: WorktreeProfile,
    facts: CleanupFacts,
    *,
    verified_scratch_files: tuple[str, ...] = (),
) -> CleanupAssessment:
    reasons = []
    if not facts.registered:
        reasons.append("not a registered worktree")
    if not facts.branch:
        reasons.append("detached or unreadable branch")
    if facts.branch in profile.protected_branches or facts.is_main:
        reasons.append(f"protected worktree branch: {facts.branch or '<unknown>'}")
    verified = set(verified_scratch_files)
    missing_verified = sorted(verified.difference(facts.untracked_files))
    if missing_verified:
        reasons.append(
            "verified scratch evidence no longer matches inventory: "
            + ", ".join(missing_verified)
        )
    scratch = sorted(
        path for path in facts.untracked_files
        if (
            path in verified
            or any(path_glob_matches(path, pattern) for pattern in profile.scratch_patterns)
        )
    )
    non_scratch = sorted(set(facts.untracked_files).difference(scratch))
    if facts.tracked_files:
        reasons.append(
            f"dirty worktree: tracked modifications: {', '.join(facts.tracked_files)}"
        )
    if non_scratch:
        reasons.append(f"dirty worktree: untracked non-scratch: {', '.join(non_scratch)}")
    if facts.pr_state == "open":
        reasons.append("open PR")
    if (
        facts.branch
        and facts.branch not in profile.protected_branches
        and not facts.merged
    ):
        reasons.append(f"unmerged branch: {facts.branch}")
    return CleanupAssessment(
        facts.worktree,
        facts.branch,
        facts.assumptions,
        tuple(reasons),
        facts.root_device,
        facts.root_inode,
        tuple(scratch),
    )


@contextmanager
def verified_worktree_root(root: Path, expected_device: int, expected_inode: int):
    """Open the assessed worktree root without following a replacement symlink."""
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    descriptor = None
    try:
        descriptor = os.open(root, directory_flags | no_follow)
        metadata = os.fstat(descriptor)
        if (metadata.st_dev, metadata.st_ino) != (expected_device, expected_inode):
            raise LifecycleError("worktree root changed before removal")
        yield descriptor
    except OSError as error:
        raise LifecycleError("worktree root changed before removal") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)


def remove_contained_regular(
    root_descriptor: int,
    relative: str,
    expected_identity: dict[str, Any] | None = None,
) -> None:
    """Delete one exact assessed regular file without following path symlinks."""
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or any(
        part in {"", ".", ".."} for part in path.parts
    ):
        raise LifecycleError(f"unsafe scratch path: {relative}")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    descriptors = []
    try:
        current = root_descriptor
        for component in path.parts[:-1]:
            current = os.open(
                component,
                directory_flags | no_follow,
                dir_fd=current,
            )
            descriptors.append(current)
        initial_metadata = os.stat(
            path.name,
            dir_fd=current,
            follow_symlinks=False,
        )
        if not stat.S_ISREG(initial_metadata.st_mode):
            raise LifecycleError(f"scratch path is not a regular file: {relative}")
        file_descriptor = os.open(
            path.name,
            os.O_RDONLY | no_follow,
            dir_fd=current,
        )
        try:
            metadata = os.fstat(file_descriptor)
            digest = sha256()
            while chunk := os.read(file_descriptor, 128 * 1024):
                digest.update(chunk)
        finally:
            os.close(file_descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or (metadata.st_dev, metadata.st_ino)
            != (initial_metadata.st_dev, initial_metadata.st_ino)
        ):
            raise LifecycleError(f"scratch path changed before removal: {relative}")
        identity = {
            "path": relative,
            "device": metadata.st_dev,
            "inode": metadata.st_ino,
            "size": metadata.st_size,
            "sha256": digest.hexdigest(),
        }
        if expected_identity is not None and identity != expected_identity:
            raise LifecycleError(f"scratch path identity changed: {relative}")
        latest = os.stat(path.name, dir_fd=current, follow_symlinks=False)
        if (latest.st_dev, latest.st_ino) != (metadata.st_dev, metadata.st_ino):
            raise LifecycleError(f"scratch path changed before removal: {relative}")
        os.unlink(path.name, dir_fd=current)
    except OSError as error:
        raise LifecycleError(f"scratch path changed before removal: {relative}") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def remove_authorized_scratch(
    profile: WorktreeProfile,
    root_descriptor: int,
    scratch_files: tuple[str, ...] | list[str],
    verified_evidence: tuple[dict[str, Any], ...] | list[dict[str, Any]] = (),
) -> None:
    """Remove profile scratch or exact generator evidence without weakening overlaps."""
    evidence_by_path: dict[str, dict[str, Any]] = {}
    for item in verified_evidence:
        relative = item.get("path")
        if not isinstance(relative, str) or relative in evidence_by_path:
            raise LifecycleError("scratch evidence is incoherent")
        evidence_by_path[relative] = item
    unexpected = sorted(set(evidence_by_path).difference(scratch_files))
    if unexpected:
        raise LifecycleError(
            "scratch evidence is outside the assessed inventory: "
            + ", ".join(unexpected)
        )
    for relative in scratch_files:
        generated = any(
            path_glob_matches(relative, pattern)
            for pattern in profile.landing_generated_artifact_patterns
        )
        profile_authorized = any(
            path_glob_matches(relative, pattern)
            for pattern in profile.scratch_patterns
        )
        expected = evidence_by_path.get(relative)
        if not generated and not profile_authorized:
            raise LifecycleError(
                f"canonical cleanup policy does not authorize scratch: {relative}"
            )
        if generated and expected is None:
            raise LifecycleError(
                f"landing-generated scratch evidence is missing: {relative}"
            )
        if profile_authorized and expected is None:
            raise LifecycleError(f"profile scratch evidence is missing: {relative}")
        if not profile_authorized and expected is None:
            raise LifecycleError(f"verified scratch evidence is missing: {relative}")
    for relative in scratch_files:
        expected = evidence_by_path[relative]
        remove_contained_regular(
            root_descriptor,
            relative,
            expected_identity=expected,
        )


def bind_cleanup_scratch_evidence(
    profile: WorktreeProfile,
    assessment: CleanupAssessment,
    verified_generator_evidence: tuple[dict[str, Any], ...] | list[dict[str, Any]] = (),
    *,
    require_generator_evidence: bool = False,
) -> CleanupAssessment:
    """Freeze identity for every assessed scratch path at its authority boundary."""
    evidence_by_path = {
        item.get("path"): item
        for item in verified_generator_evidence
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    }
    if len(evidence_by_path) != len(verified_generator_evidence):
        raise LifecycleError("scratch evidence is incoherent")
    unauthorized_evidence = sorted(
        relative
        for relative in evidence_by_path
        if not any(
            path_glob_matches(relative, pattern)
            for pattern in profile.landing_generated_artifact_patterns
        )
    )
    if unauthorized_evidence:
        raise LifecycleError(
            "generator evidence is outside canonical landing policy: "
            + ", ".join(unauthorized_evidence)
        )
    scratch = set(assessment.scratch_files)
    if not set(evidence_by_path).issubset(scratch):
        raise LifecycleError("scratch evidence is outside the assessed inventory")
    profile_only = [
        relative
        for relative in assessment.scratch_files
        if not any(
            path_glob_matches(relative, pattern)
            for pattern in profile.landing_generated_artifact_patterns
        )
    ]
    missing_generator = [
        relative
        for relative in assessment.scratch_files
        if any(
            path_glob_matches(relative, pattern)
            for pattern in profile.landing_generated_artifact_patterns
        )
        and relative not in evidence_by_path
    ]
    if missing_generator and require_generator_evidence:
        raise LifecycleError(
            "landing-generated scratch evidence is missing: "
            + ", ".join(missing_generator)
        )
    with verified_worktree_root(
        assessment.worktree,
        assessment.root_device,
        assessment.root_inode,
    ) as descriptor:
        for relative in profile_only:
            evidence_by_path[relative] = contained_regular_identity(
                descriptor, relative
            )
    return replace(
        assessment,
        scratch_evidence=tuple(
            evidence_by_path[relative]
            for relative in assessment.scratch_files
            if relative in evidence_by_path
        ),
    )


def contained_regular_identity(root_descriptor: int, relative: str) -> dict[str, Any]:
    """Read one exact regular file identity without following path symlinks."""
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or any(
        part in {"", ".", ".."} for part in path.parts
    ):
        raise LifecycleError(f"unsafe scratch path: {relative}")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    descriptors = []
    try:
        current = root_descriptor
        for component in path.parts[:-1]:
            current = os.open(
                component,
                directory_flags | no_follow,
                dir_fd=current,
            )
            descriptors.append(current)
        initial = os.stat(path.name, dir_fd=current, follow_symlinks=False)
        if not stat.S_ISREG(initial.st_mode):
            raise LifecycleError(
                f"scratch path is not a regular file: {relative}"
            )
        file_descriptor = os.open(
            path.name,
            os.O_RDONLY | no_follow,
            dir_fd=current,
        )
        try:
            metadata = os.fstat(file_descriptor)
            if (
                not stat.S_ISREG(metadata.st_mode)
                or (metadata.st_dev, metadata.st_ino)
                != (initial.st_dev, initial.st_ino)
            ):
                raise LifecycleError(
                    f"scratch path changed before inspection: {relative}"
                )
            digest = sha256()
            while chunk := os.read(file_descriptor, 128 * 1024):
                digest.update(chunk)
        finally:
            os.close(file_descriptor)
        return {
            "path": relative,
            "device": metadata.st_dev,
            "inode": metadata.st_ino,
            "size": metadata.st_size,
            "sha256": digest.hexdigest(),
        }
    except OSError as error:
        raise LifecycleError(f"scratch path changed before inspection: {relative}") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def contained_untracked_identity(
    root_descriptor: int,
    relative: str,
) -> dict[str, Any]:
    """Read exact regular/symlink identity without following any symlink."""
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or any(
        part in {"", ".", ".."} for part in path.parts
    ):
        raise LifecycleError(f"unsafe recovery path: {relative}")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    descriptors = []
    try:
        current = root_descriptor
        for component in path.parts[:-1]:
            current = os.open(
                component,
                directory_flags | no_follow,
                dir_fd=current,
            )
            descriptors.append(current)
        metadata = os.stat(path.name, dir_fd=current, follow_symlinks=False)
        common = {
            "path": relative,
            "device": metadata.st_dev,
            "inode": metadata.st_ino,
            "size": metadata.st_size,
        }
        if stat.S_ISLNK(metadata.st_mode):
            target = os.readlink(path.name, dir_fd=current).encode(
                "utf-8", errors="surrogateescape"
            )
            return {**common, "kind": "symlink", "sha256": sha256(target).hexdigest()}
        if not stat.S_ISREG(metadata.st_mode):
            raise LifecycleError(f"unsupported recovery path type: {relative}")
        file_descriptor = os.open(
            path.name,
            os.O_RDONLY | no_follow,
            dir_fd=current,
        )
        try:
            opened = os.fstat(file_descriptor)
            if (opened.st_dev, opened.st_ino) != (
                metadata.st_dev, metadata.st_ino
            ):
                raise LifecycleError(
                    f"recovery path changed before inspection: {relative}"
                )
            digest = sha256()
            while chunk := os.read(file_descriptor, 128 * 1024):
                digest.update(chunk)
        finally:
            os.close(file_descriptor)
        return {**common, "kind": "regular", "sha256": digest.hexdigest()}
    except OSError as error:
        raise LifecycleError(
            f"recovery path changed before inspection: {relative}"
        ) from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def remove_contained_untracked(
    root_descriptor: int,
    expected_identity: dict[str, Any],
) -> None:
    """Unlink one frozen regular file or symlink if its identity still matches."""
    relative = expected_identity.get("path")
    if not isinstance(relative, str):
        raise LifecycleError("recovery path evidence is incoherent")
    current = contained_untracked_identity(root_descriptor, relative)
    if current != expected_identity:
        raise LifecycleError(f"recovery path identity changed: {relative}")
    path = PurePosixPath(relative)
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    descriptors = []
    try:
        parent = root_descriptor
        for component in path.parts[:-1]:
            parent = os.open(
                component,
                directory_flags | no_follow,
                dir_fd=parent,
            )
            descriptors.append(parent)
        latest = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        if (latest.st_dev, latest.st_ino) != (
            expected_identity["device"], expected_identity["inode"]
        ):
            raise LifecycleError(f"recovery path changed before removal: {relative}")
        os.unlink(path.name, dir_fd=parent)
    except OSError as error:
        raise LifecycleError(f"recovery path changed before removal: {relative}") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


@dataclass(frozen=True)
class SweepRow:
    kind: str
    path: str | None
    branch: str
    issue: str | None
    pr_state: str
    merged_into_main: bool
    last_commit_age_seconds: int
    removable: bool
    reasons: tuple[str, ...]
    verdict_reason: str
    scratch_files: tuple[str, ...] = ()
    assumptions: str = ""


@dataclass(frozen=True)
class SweepReport:
    main_branch: str
    worktree_count: int
    local_branch_count: int
    merged_remote_branch_count: int
    rows: tuple[SweepRow, ...]


@dataclass(frozen=True)
class SweepFactRow:
    path: Path | None
    branch: str
    pr_state: str
    merged_into_main: bool
    last_commit_age_seconds: int
    cleanup: CleanupFacts | None = None


@dataclass(frozen=True)
class SweepFacts:
    main: Path
    main_branch: str
    worktree_count: int
    local_branch_count: int
    merged_remote_branch_count: int
    rows: tuple[SweepFactRow, ...]


def _worktree_branches(main: Path) -> tuple[dict[str, Path], tuple[Path, ...]]:
    output = run(["git", "worktree", "list", "--porcelain"], cwd=main).stdout
    linked: dict[str, Path] = {}
    detached = []
    path: Path | None = None
    branch = ""
    for line in [*output.splitlines(), ""]:
        if line.startswith("worktree "):
            path = Path(line.split(" ", 1)[1]).resolve()
            branch = ""
        elif line.startswith("branch refs/heads/"):
            branch = line.removeprefix("branch refs/heads/")
        elif not line and path is not None:
            if branch:
                linked[branch] = path
            else:
                detached.append(path)
            path = None
    return linked, tuple(detached)


def collect_sweep_facts(
    profile: WorktreeProfile,
    main: Path,
    pr_lookup: Callable[[str], str],
    *,
    now: int | None = None,
) -> SweepFacts:
    """Gather the complete read-only inventory without making removal decisions."""
    main = main.resolve()
    main_branch = run(
        ["git", "-C", str(main), "branch", "--show-current"], cwd=main
    ).stdout.strip()
    linked, detached = _worktree_branches(main)
    refs = run(
        [
            "git", "for-each-ref",
            "--format=%(refname:short)\t%(committerdate:unix)",
            "refs/heads/",
        ],
        cwd=main,
    ).stdout.splitlines()
    timestamp = int(time()) if now is None else now
    rows: list[SweepFactRow] = []
    for line in refs:
        branch, commit_time = line.rsplit("\t", 1)
        path = linked.get(branch)
        pr_state = pr_lookup(branch)
        merged = run(
            ["git", "merge-base", "--is-ancestor", branch, main_branch],
            cwd=main,
            check=False,
        ).returncode == 0
        rows.append(SweepFactRow(
            path=path,
            branch=branch,
            pr_state=pr_state,
            merged_into_main=merged,
            last_commit_age_seconds=max(0, timestamp - int(commit_time)),
            cleanup=collect_cleanup_facts(
                main,
                path,
                merge_target=main_branch,
                pr_state=pr_state,
            ) if path is not None else None,
        ))
    for path in detached:
        commit_time = run(
            ["git", "-C", str(path), "show", "-s", "--format=%ct", "HEAD"],
            cwd=main,
        ).stdout.strip()
        rows.append(SweepFactRow(
            path=path,
            branch="",
            pr_state="none",
            merged_into_main=False,
            last_commit_age_seconds=max(0, timestamp - int(commit_time)),
        ))
    remote_merged = run(
        [
            "git", "for-each-ref",
            f"--merged={main_branch}",
            "--format=%(refname:short)",
            "refs/remotes/",
        ],
        cwd=main,
        check=False,
    ).stdout.splitlines()
    return SweepFacts(
        main=main,
        main_branch=main_branch,
        worktree_count=len(linked) + len(detached),
        local_branch_count=len(refs),
        merged_remote_branch_count=len([
            branch for branch in remote_merged if branch and not branch.endswith("/HEAD")
        ]),
        rows=tuple(rows),
    )


def classify_sweep(profile: WorktreeProfile, facts: SweepFacts) -> SweepReport:
    """Apply profile policy to already-collected inventory facts."""
    rows = []
    for fact in facts.rows:
        if fact.cleanup is not None:
            assessment = classify_cleanup(profile, fact.cleanup)
            reasons = assessment.reasons
            scratch = assessment.scratch_files
            assumptions = assessment.assumptions
        elif fact.path is not None:
            reasons = ("detached or unreadable branch",)
            scratch = ()
            assumptions = ""
        else:
            reasons_list = []
            if fact.branch in profile.protected_branches:
                reasons_list.append(f"protected branch: {fact.branch}")
            if fact.pr_state == "open":
                reasons_list.append("open PR")
            if not fact.merged_into_main:
                reasons_list.append(f"unmerged branch: {fact.branch}")
            reasons = tuple(reasons_list)
            scratch = ()
            assumptions = ""
        rows.append(SweepRow(
            kind="worktree" if fact.path is not None else "branch",
            path=str(fact.path) if fact.path is not None else None,
            branch=fact.branch,
            issue=profile.issue_from_branch(fact.branch),
            pr_state=fact.pr_state,
            merged_into_main=fact.merged_into_main,
            last_commit_age_seconds=fact.last_commit_age_seconds,
            removable=not reasons,
            reasons=reasons,
            verdict_reason=(
                "; ".join(reasons)
                if reasons
                else (
                    f"merged into {facts.main_branch}; scratch-only: {', '.join(scratch)}"
                    if scratch
                    else f"merged into {facts.main_branch}; no blocking work"
                )
            ),
            scratch_files=scratch,
            assumptions=assumptions,
        ))
    return SweepReport(
        main_branch=facts.main_branch,
        worktree_count=facts.worktree_count,
        local_branch_count=facts.local_branch_count,
        merged_remote_branch_count=facts.merged_remote_branch_count,
        rows=tuple(rows),
    )


def collect_sweep(
    profile: WorktreeProfile,
    main: Path,
    pr_lookup: Callable[[str], str],
    *,
    now: int | None = None,
) -> SweepReport:
    return classify_sweep(profile, collect_sweep_facts(profile, main, pr_lookup, now=now))


def edit_decision(
    profile: WorktreeProfile,
    facts: RepoFacts,
    payload: dict[str, Any],
) -> Decision:
    if payload.get("tool_name") not in {"Edit", "Write", "MultiEdit"}:
        return Decision("skip")
    target = str((payload.get("tool_input") or {}).get("file_path") or "")
    if facts.is_main_worktree and facts.branch in profile.protected_branches:
        relative = repo_relative(target, facts.root)
        if relative is not None and not is_ignored(facts.root, relative):
            return Decision(
                "block",
                f"Worktree Lifecycle blocked an edit to {relative} on protected branch "
                f"{facts.branch}. Use `{profile.setup_entry}` first.",
            )
    if not facts.is_main_worktree and Path(target).is_absolute():
        relative = repo_relative(target, facts.main_root)
        if (
            relative is not None
            and facts.main_branch in profile.protected_branches
            and is_tracked(facts.main_root, relative)
            and not is_ignored(facts.main_root, relative)
        ):
            return Decision(
                "block",
                f"Worktree Lifecycle blocked a cross-worktree edit to {relative} in "
                f"the protected main checkout. Edit the linked worktree copy instead.",
            )
    return Decision("allow")


def targets_linked_worktree(command: str, facts: RepoFacts) -> bool:
    for worktree in facts.worktrees:
        if worktree == facts.main_root:
            continue
        if str(worktree) in command or str(worktree.relative_to(facts.main_root)) in command:
            return True
    return False


def command_decision(
    profile: WorktreeProfile,
    facts: RepoFacts,
    payload: dict[str, Any],
) -> Decision:
    if payload.get("tool_name") != "Bash":
        return Decision("skip")
    command = str((payload.get("tool_input") or {}).get("command") or "")
    if not command:
        return Decision("skip")
    risky = any(re.search(pattern, command) for pattern in profile.risky_command_patterns)
    if not risky:
        return Decision("allow")
    if re.search(r"\bgit\s+push\s+\S+\s+--delete\s+\S+", command):
        return Decision("allow")
    if targets_linked_worktree(command, facts):
        return Decision("allow")
    if (
        facts.is_main_worktree
        and facts.branch in profile.protected_branches
        and len(facts.worktrees) > 1
    ):
        active = ", ".join(path.name for path in facts.worktrees if path != facts.main_root)
        return Decision(
            "block",
            f"Worktree Lifecycle blocked `{command}` in the protected main checkout "
            f"while linked worktrees are active: {active}. Run it in the target worktree.",
        )
    return Decision("allow")


def branch_create_decision(
    profile: WorktreeProfile,
    facts: RepoFacts,
    payload: dict[str, Any],
) -> Decision:
    if payload.get("tool_name") != "Bash":
        return Decision("skip")
    command = str((payload.get("tool_input") or {}).get("command") or "")
    match = _BRANCH_CREATE_RE.search(command)
    if match is None or profile.issue_from_branch(match.group(1)) is None:
        return Decision("allow")
    if facts.is_main_worktree and len(facts.worktrees) > 1:
        return Decision(
            "block",
            f"Worktree Lifecycle blocked branch creation `{match.group(1)}` in the main "
            f"checkout while linked worktrees are active. Use `{profile.setup_entry}`.",
        )
    return Decision("allow")


def handoff_decision(
    profile: WorktreeProfile,
    facts: RepoFacts,
    payload: dict[str, Any],
) -> Decision:
    prompt = str(payload.get("prompt") or "")
    pattern = re.compile(
        rf"{re.escape(profile.setup_entry)}\s+(\d+)\s+(\S+)"
    )
    match = pattern.search(prompt)
    if match is None or not facts.is_main_worktree:
        return Decision("skip")
    issue, slug = match.groups()
    command = f"{profile.setup_entry} {issue} {slug}"
    return Decision(
        "emit",
        f"Defined slice detected: create its isolated worktree first with `{command}`, "
        "then perform repository reads from that worktree.",
        "UserPromptSubmit",
    )


def evaluate(
    profile: WorktreeProfile,
    facts: RepoFacts,
    event: str,
    payload: dict[str, Any],
) -> Decision:
    if event == "session-start":
        return branch_context(profile, facts)
    if event == "branch-watch":
        command = str((payload.get("tool_input") or {}).get("command") or "")
        if payload.get("tool_name") != "Bash" or not _BRANCH_CHANGE_RE.search(command):
            return Decision("skip")
        context = branch_context(profile, facts)
        return Decision("emit", context.message, "PostToolUse")
    if event == "edit":
        return edit_decision(profile, facts, payload)
    if event == "command-cwd":
        return command_decision(profile, facts, payload)
    if event == "branch-create":
        return branch_create_decision(profile, facts, payload)
    if event == "handoff":
        return handoff_decision(profile, facts, payload)
    return Decision("skip")
