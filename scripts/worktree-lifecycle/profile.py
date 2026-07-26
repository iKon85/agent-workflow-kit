"""Worktree Lifecycle profile loading and low-level git operations."""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class LifecycleError(RuntimeError):
    """A safe, user-visible lifecycle refusal."""


@dataclass(frozen=True)
class WorktreeProfile:
    root: str
    branch_template: str
    path_template: str
    main_branches: tuple[str, ...]
    protected_branches: tuple[str, ...]
    setup_steps: tuple[dict[str, Any], ...]
    branch_regex: str
    setup_entry: str
    risky_command_patterns: tuple[str, ...]
    scratch_patterns: tuple[str, ...]

    def branch_name(self, issue: str, slug: str, branch_type: str) -> str:
        return _render(self.branch_template, issue, slug, branch_type)

    def relative_path(self, issue: str, slug: str, branch_type: str) -> Path:
        name = _render(self.path_template, issue, slug, branch_type)
        return Path(self.root) / name

    def issue_from_branch(self, branch: str) -> str | None:
        match = re.match(self.branch_regex, branch)
        return match.groupdict().get("issue") if match else None


def _render(template: str, issue: str, slug: str, branch_type: str) -> str:
    values = {"issue": issue, "slug": slug, "type": branch_type}
    try:
        return template.format(**values)
    except (KeyError, ValueError) as error:
        raise LifecycleError(f"invalid worktree template: {error}") from error


def load_profile(path: Path) -> WorktreeProfile:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        raw = document["worktreeLifecycle"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        raise LifecycleError(f"cannot load worktree lifecycle profile: {error}") from error
    if raw.get("enabled") is not True:
        raise LifecycleError("worktree lifecycle is not enabled")
    main = tuple(raw.get("mainBranches") or ("main", "master"))
    return WorktreeProfile(
        root=raw.get("worktreeRoot", ".worktrees"),
        branch_template=raw.get("branchTemplate", "{type}/{issue}-{slug}"),
        path_template=raw.get("pathTemplate", "{type}-{issue}-{slug}"),
        main_branches=main,
        protected_branches=tuple(raw.get("protectedBranches") or main),
        setup_steps=tuple(raw.get("setupSteps") or ()),
        branch_regex=raw.get(
            "branchRegex",
            r"^(?:feat|fix|chore|docs)/(?P<issue>\d+)-",
        ),
        setup_entry=raw.get(
            "setupEntry",
            "python3 scripts/worktree-lifecycle/setup.py",
        ),
        risky_command_patterns=tuple(raw.get("riskyCommandPatterns") or (
            r"\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|build)\b",
            r"\bgit\s+(?:commit|push)\b",
        )),
        scratch_patterns=tuple(raw.get("scratchPatterns") or ()),
    )


def run(
    command: list[str],
    *,
    cwd: Path,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise LifecycleError(f"{' '.join(command)} failed: {detail}")
    return result


def main_worktree(cwd: Path) -> Path:
    output = run(["git", "worktree", "list", "--porcelain"], cwd=cwd).stdout
    first = next((line for line in output.splitlines() if line.startswith("worktree ")), "")
    if not first:
        raise LifecycleError("not inside a git worktree")
    return Path(first.split(" ", 1)[1]).resolve()


def registered_worktrees(cwd: Path) -> set[Path]:
    output = run(["git", "worktree", "list", "--porcelain"], cwd=cwd).stdout
    return {
        Path(line.split(" ", 1)[1]).resolve()
        for line in output.splitlines()
        if line.startswith("worktree ")
    }


def local_branch_exists(cwd: Path, branch: str) -> bool:
    result = run(
        ["git", "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
        cwd=cwd,
        check=False,
    )
    return result.returncode == 0
