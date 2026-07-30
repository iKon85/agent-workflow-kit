"""Consumer-neutral Worktree Lifecycle facts and decisions.

Teardown authority is not stored here. `classify.py` derives it from the
repository's current state at the moment of action, and this module consumes
exactly that assessment: it adds only the facts git status cannot answer — is
the path a registered worktree, is its branch protected, is there an open PR,
is the branch merged — and renders the one classification report instead of
formatting a second one.

Authorization follows the same rule: a decision is made from an **observable
target**, never from an inferred intent. A structured Edit/Write payload names
the file it writes, so that write can be judged; a shell command string only
describes what someone means to do, so no command is authorized or refused from
it. The floor for a shell mistake is git state, the protected branch, and the
PR flow — not a pattern that guesses at a command.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from time import time
from typing import Any, Callable

from classify import ClassificationError, assess, render_report
from profile import (
    LifecycleError,
    WorktreeProfile,
    load_profile,
    local_branch_exists,
    main_worktree,
    registered_worktrees,
    run,
)

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
class CleanupFacts:
    worktree: Path
    branch: str
    registered: bool
    is_main: bool
    classification: Any
    merged: bool
    pr_state: str
    assumptions: str


@dataclass(frozen=True)
class CleanupAssessment:
    worktree: Path
    branch: str
    assumptions: str
    reasons: tuple[str, ...]
    classification: Any

    @property
    def removable(self) -> bool:
        return not self.reasons

    @property
    def scratch_files(self) -> tuple[str, ...]:
        if self.classification is None:
            return ()
        return tuple(entry.path for entry in self.classification.scratch)

    @property
    def declared_deletions(self) -> tuple[str, ...]:
        """The deletions the consumer's seed declaration authorized by consent."""
        if self.classification is None:
            return ()
        return tuple(self.classification.declared_deletions)


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




def collect_cleanup_facts(
    main: Path,
    target: Path,
    *,
    merge_target: str | None = None,
    pr_state: str = "none",
    declared_paths: tuple[str, ...] = (),
) -> CleanupFacts:
    """Read every fact a removal verdict needs, deciding nothing.

    The file taxonomy comes from `classify.assess`, which is also the object the
    removal step consumes — preview and action can never disagree.

    `declared_paths` is the consumer's seed declaration, resolved here because
    the classifier reads no profile: the paths a consumer declares as what a
    fresh worktree carries are the paths its own declaration clears for
    deletion.
    """
    worktree = target.resolve()
    branch = run(
        ["git", "-C", str(worktree), "branch", "--show-current"],
        cwd=main,
        check=False,
    ).stdout.strip()
    try:
        classification = assess(worktree, main, declared_paths)
    except ClassificationError as error:
        raise LifecycleError(str(error)) from error
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
    # ANNAHMEN.md is governed separately: its bytes are returned before removal.
    assumptions_path = worktree / "ANNAHMEN.md"
    assumptions = assumptions_path.read_text(encoding="utf-8") if assumptions_path.is_file() else ""
    return CleanupFacts(
        worktree=worktree,
        branch=branch,
        registered=worktree in registered_worktrees(main),
        is_main=worktree == main.resolve(),
        classification=classification,
        merged=merged,
        pr_state=pr_state,
        assumptions=assumptions,
    )


def classify_cleanup(profile: WorktreeProfile, facts: CleanupFacts) -> CleanupAssessment:
    reasons = []
    if not facts.registered:
        reasons.append("not a registered worktree")
    if not facts.branch:
        reasons.append("detached or unreadable branch")
    if facts.branch in profile.protected_branches or facts.is_main:
        reasons.append(f"protected worktree branch: {facts.branch or '<unknown>'}")
    if facts.classification is not None and facts.classification.blocks:
        reasons.append(render_report(facts.classification))
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
        facts.classification,
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
    cleanup_error: str = ""


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


def _cleanup_facts_or_error(
    main: Path,
    path: Path,
    *,
    merge_target: str,
    pr_state: str,
    declared_paths: tuple[str, ...] = (),
) -> tuple[CleanupFacts | None, str]:
    """A single unreadable worktree must not abort the read-only inventory."""
    try:
        facts = collect_cleanup_facts(
            main,
            path,
            merge_target=merge_target,
            pr_state=pr_state,
            declared_paths=declared_paths,
        )
    except LifecycleError as error:
        return None, str(error)
    return facts, ""


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
        cleanup, cleanup_error = (
            _cleanup_facts_or_error(
                main,
                path,
                merge_target=main_branch,
                pr_state=pr_state,
                declared_paths=profile.seed.paths,
            )
            if path is not None
            else (None, "")
        )
        rows.append(SweepFactRow(
            path=path,
            branch=branch,
            pr_state=pr_state,
            merged_into_main=merged,
            last_commit_age_seconds=max(0, timestamp - int(commit_time)),
            cleanup=cleanup,
            cleanup_error=cleanup_error,
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
            reasons = (fact.cleanup_error or "detached or unreadable branch",)
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


def write_target_decision(
    profile: WorktreeProfile,
    facts: RepoFacts,
    payload: dict[str, Any],
) -> Decision:
    """Judge where a write lands, never what a shell command says it will do.

    A `Bash` payload carries no observable target — its command string is prose
    about intent, and reading it authorized anything that merely *mentioned* a
    worktree path, never classified the `git -C <path>` form at all, and refused
    writes that never touched the repository. Only a structured Edit/Write
    payload states its target, so only that is judged: resolved to an absolute
    path and refused when it lands in the protected main checkout while linked
    worktrees are active. The floor for a shell mistake is git state, the
    protected branch, and the PR flow.
    """
    if payload.get("tool_name") not in {"Edit", "Write", "MultiEdit"}:
        return Decision("skip")
    target = str((payload.get("tool_input") or {}).get("file_path") or "")
    if not target:
        return Decision("skip")
    if len(facts.worktrees) < 2 or facts.main_branch not in profile.protected_branches:
        return Decision("allow")
    absolute = str(Path(target) if Path(target).is_absolute() else facts.root / target)
    relative = repo_relative(absolute, facts.main_root)
    if relative is None:
        return Decision("allow")
    # A linked worktree under the repository root is lexically inside the main
    # checkout without belonging to it: its own files are exactly where the
    # guard wants writes to land.
    linked = [path for path in facts.worktrees if path != facts.main_root]
    if any(repo_relative(absolute, worktree) is not None for worktree in linked):
        return Decision("allow")
    if is_ignored(facts.main_root, relative):
        return Decision("allow")
    active = ", ".join(path.name for path in linked)
    return Decision(
        "block",
        f"Worktree Lifecycle blocked a write to {relative} in the protected main "
        f"checkout while linked worktrees are active: {active}. "
        f"Write it in the target worktree.",
    )


def evaluate(
    profile: WorktreeProfile,
    facts: RepoFacts,
    event: str,
    payload: dict[str, Any],
) -> Decision:
    if event == "write-target":
        return write_target_decision(profile, facts, payload)
    return Decision("skip")
