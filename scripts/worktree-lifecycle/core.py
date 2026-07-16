"""Consumer-neutral Worktree Lifecycle facts and decisions."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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

    @property
    def removable(self) -> bool:
        return not self.reasons


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
) -> CleanupAssessment:
    worktree = target.resolve()
    reasons = []
    branch = run(
        ["git", "-C", str(worktree), "branch", "--show-current"],
        cwd=main,
        check=False,
    ).stdout.strip()
    if worktree not in registered_worktrees(main):
        reasons.append("not a registered worktree")
    if not branch:
        reasons.append("detached or unreadable branch")
    if branch in profile.protected_branches or worktree == main.resolve():
        reasons.append(f"protected worktree branch: {branch or '<unknown>'}")
    status = run(
        ["git", "-C", str(worktree), "status", "--porcelain"],
        cwd=main,
        check=False,
    ).stdout
    if status.strip():
        reasons.append("dirty worktree")
    if branch and branch not in profile.protected_branches:
        main_branch = merge_target or run(
            ["git", "-C", str(main), "branch", "--show-current"],
            cwd=main,
            check=False,
        ).stdout.strip()
        merged = run(
            ["git", "merge-base", "--is-ancestor", branch, main_branch],
            cwd=main,
            check=False,
        )
        if merged.returncode != 0:
            reasons.append(f"unmerged branch: {branch}")
    assumptions_path = worktree / "ANNAHMEN.md"
    assumptions = assumptions_path.read_text(encoding="utf-8") if assumptions_path.is_file() else ""
    return CleanupAssessment(worktree, branch, assumptions, tuple(reasons))


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
