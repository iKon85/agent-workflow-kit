"""Consumer-neutral Worktree Lifecycle facts and decisions."""

from __future__ import annotations

import re
from fnmatch import fnmatchcase
from dataclasses import dataclass
from pathlib import Path
from time import time
from typing import Any, Callable

from profile import (
    LifecycleError,
    WorktreeProfile,
    load_profile,
    local_branch_exists,
    main_worktree,
    registered_worktrees,
    run,
)

_BRANCH_CHANGE_RE = re.compile(r"\b(?:git\s+(?:checkout|switch)|gh\s+pr\s+(?:merge|checkout))\b")
_BRANCH_CREATE_RE = re.compile(r"\bgit\s+(?:checkout|switch)\s+-[bc]\s+(\S+)")

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
    scratch_files: tuple[str, ...] = ()

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
) -> CleanupAssessment:
    return classify_cleanup(
        profile,
        collect_cleanup_facts(
            main,
            target,
            merge_target=merge_target,
            pr_state=pr_state,
        ),
    )


def collect_cleanup_facts(
    main: Path,
    target: Path,
    *,
    merge_target: str | None = None,
    pr_state: str = "none",
) -> CleanupFacts:
    worktree = target.resolve()
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
    )


def classify_cleanup(
    profile: WorktreeProfile,
    facts: CleanupFacts,
) -> CleanupAssessment:
    reasons = []
    if not facts.registered:
        reasons.append("not a registered worktree")
    if not facts.branch:
        reasons.append("detached or unreadable branch")
    if facts.branch in profile.protected_branches or facts.is_main:
        reasons.append(f"protected worktree branch: {facts.branch or '<unknown>'}")
    scratch = sorted(
        path for path in facts.untracked_files
        if any(fnmatchcase(path, pattern) for pattern in profile.scratch_patterns)
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
        tuple(scratch),
    )


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
        rows.append(SweepFactRow(
            path=path,
            branch="",
            pr_state="none",
            merged_into_main=False,
            last_commit_age_seconds=0,
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
