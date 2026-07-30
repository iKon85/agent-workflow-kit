"""Worktree Lifecycle profile loading and low-level git operations.

The profile carries **structural facts only** — worktree root, naming
templates, the protected branches, the seed a fresh worktree carries. No pattern
list is read here. Deletion policy is configured by declaration: the ignore
mechanism decides what is scratch, and the seed declaration decides only whether
a `.env*` the consumer itself named still needs teardown's comparison against
the main checkout. Authorization is decided from observable write targets, so
there is no command pattern to declare either — nothing judges a shell command
by its command string. Keys this loader does not know are ignored in silence: a
profile written for an older kit keeps working, and an obsolete key produces no
warning noise.

The seed is **flat by contract**: `paths` names repository-relative
files the creation helper copies verbatim out of the main checkout, `variables`
names integer bases the helper renders with the worktree's own slot. There are
no step kinds, no ordering knobs, and no per-entry flags, because a declaration
of what a worktree carries transfers between projects while a procedure that
produces one does not. The kit ships the copying mechanism and never reads,
patches, or transforms a declared file's contents.

Two branch templates exist because two kinds of work land. `branchTemplate`
names the branch of an issue-anchored slice; `contentBranchTemplate` names the
issue-less branch a session cuts for durable content, so it renders `{type}`
and `{slug}` only and refuses `{issue}` outright rather than inventing a number.

`DEFAULT_MAIN_BRANCHES` is the single place in the kit that names an
integration branch at all; every command, test, and message resolves the name
through the profile instead of assuming it.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

DEFAULT_MAIN_BRANCHES = ("main", "master")
DEFAULT_CONTENT_BRANCH_TEMPLATE = "{type}/{slug}"
DEFAULT_WORKTREE_ROOT = ".worktrees"


class LifecycleError(RuntimeError):
    """A safe, user-visible lifecycle refusal."""


@dataclass(frozen=True)
class SeedDeclaration:
    """What a fresh worktree carries — declared, never derived.

    `paths` are repository-relative files copied verbatim from the main
    checkout; `variables` are ordered `(name, base)` pairs the creation helper
    renders per worktree. Both are consumer values; the kit owns only the
    mechanism that moves them.
    """

    paths: tuple[str, ...] = ()
    variables: tuple[tuple[str, int], ...] = ()


@dataclass(frozen=True)
class WorktreeProfile:
    root: str
    branch_template: str
    content_branch_template: str
    path_template: str
    main_branches: tuple[str, ...]
    protected_branches: tuple[str, ...]
    seed: SeedDeclaration
    branch_regex: str
    setup_entry: str

    def branch_name(self, issue: str, slug: str, branch_type: str) -> str:
        return _render(self.branch_template, issue=issue, slug=slug, type=branch_type)

    def content_branch_name(self, slug: str, branch_type: str) -> str:
        """Name the issue-less branch of a Content-route session."""
        return render_content_branch(self.content_branch_template, slug, branch_type)

    def relative_path(self, issue: str, slug: str, branch_type: str) -> Path:
        name = _render(self.path_template, issue=issue, slug=slug, type=branch_type)
        return Path(self.root) / name

    def issue_from_branch(self, branch: str) -> str | None:
        match = re.match(self.branch_regex, branch)
        return match.groupdict().get("issue") if match else None


def _render(template: str, **values: str) -> str:
    """Render a profile template from exactly the placeholders it may use."""
    try:
        return template.format(**values)
    except (KeyError, IndexError, ValueError) as error:
        raise LifecycleError(f"invalid worktree template: {error}") from error


def render_content_branch(template: str, slug: str, branch_type: str) -> str:
    """Render one issue-less content branch name — the placeholder policy's home.

    A caller that reads the template out of a raw profile document (the
    durable-content commit in `make-landable` does, because it must work
    whether or not the worktree lifecycle itself is enabled) renders it here,
    so `{issue}` is refused in exactly one place instead of two.
    """
    return _render(template, slug=slug, type=branch_type)


def worktree_root_of(document: Any) -> str:
    """The declared worktree root of a raw profile document.

    Read separately from `load_profile` because the root is a location fact,
    not a capability: the ignore offer needs it even for a profile that never
    enabled the lifecycle, and this keeps the default in exactly one place.
    """
    try:
        root = document["worktreeLifecycle"]["worktreeRoot"]
    except (KeyError, TypeError):
        return DEFAULT_WORKTREE_ROOT
    if not isinstance(root, str) or not root.strip():
        return DEFAULT_WORKTREE_ROOT
    return root.strip()


def _seed_path(declared: Any) -> str:
    """One declared seed path: repository-relative, or refused by name."""
    if not isinstance(declared, str) or not declared.strip():
        raise LifecycleError(f"seed path must be a non-empty string: {declared!r}")
    path = PurePosixPath(declared.strip())
    if path.is_absolute() or ".." in path.parts:
        raise LifecycleError(
            f"seed path must stay inside the repository: {declared}",
        )
    return declared.strip()


def _seed_variable(name: Any, value: Any) -> tuple[str, int]:
    """One declared variable: a named positive integer base, or refused."""
    if not isinstance(name, str) or not name.strip():
        raise LifecycleError(f"seed variable needs a name: {name!r}")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise LifecycleError(
            f"seed variable {name} must be a positive integer base, not {value!r} — "
            "the helper renders it with this worktree's own slot",
        )
    return name.strip(), value


def seed_of(raw: Any) -> SeedDeclaration:
    """The flat seed declaration of a raw `worktreeLifecycle` section."""
    declared = raw.get("seed") if isinstance(raw, dict) else None
    if declared is None:
        return SeedDeclaration()
    if not isinstance(declared, dict):
        raise LifecycleError("seed must be an object with paths and variables")
    paths = declared.get("paths") or ()
    variables = declared.get("variables") or {}
    if isinstance(paths, (str, bytes)) or not isinstance(paths, (list, tuple)):
        raise LifecycleError("seed paths must be a list of repository-relative paths")
    if not isinstance(variables, dict):
        raise LifecycleError("seed variables must be an object of name/base pairs")
    return SeedDeclaration(
        paths=tuple(_seed_path(entry) for entry in paths),
        variables=tuple(_seed_variable(name, value) for name, value in variables.items()),
    )


def _load_profile_document(document: Any) -> WorktreeProfile:
    try:
        raw = document["worktreeLifecycle"]
    except (KeyError, TypeError) as error:
        raise LifecycleError(f"cannot load worktree lifecycle profile: {error}") from error
    if raw.get("enabled") is not True:
        raise LifecycleError("worktree lifecycle is not enabled")
    main = tuple(raw.get("mainBranches") or DEFAULT_MAIN_BRANCHES)
    return WorktreeProfile(
        root=worktree_root_of({"worktreeLifecycle": raw}),
        branch_template=raw.get("branchTemplate", "{type}/{issue}-{slug}"),
        content_branch_template=raw.get(
            "contentBranchTemplate", DEFAULT_CONTENT_BRANCH_TEMPLATE,
        ),
        path_template=raw.get("pathTemplate", "{type}-{issue}-{slug}"),
        main_branches=main,
        protected_branches=tuple(raw.get("protectedBranches") or main),
        seed=seed_of(raw),
        branch_regex=raw.get(
            "branchRegex",
            r"^(?:feat|fix|chore|docs)/(?P<issue>\d+)-",
        ),
        setup_entry=raw.get(
            "setupEntry",
            "python3 scripts/worktree-lifecycle/setup.py",
        ),
    )


def load_profile(path: Path) -> WorktreeProfile:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError) as error:
        raise LifecycleError(f"cannot load worktree lifecycle profile: {error}") from error
    return _load_profile_document(document)


def load_profile_text(text: str) -> WorktreeProfile:
    try:
        document = json.loads(text)
    except (json.JSONDecodeError, TypeError) as error:
        raise LifecycleError(f"cannot load worktree lifecycle profile: {error}") from error
    return _load_profile_document(document)


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
