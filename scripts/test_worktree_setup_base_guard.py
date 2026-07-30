#!/usr/bin/env python3
"""Worktree reuse must refuse a stale base on BOTH reuse paths.

`setup.py create()` can reach an existing worktree two ways: the target is
already a registered worktree, or only its branch exists locally and
`git worktree add <target> <branch>` silently ignores `--base`. Reuse is safe
only when the reused HEAD is AT the base or cleanly behind it (fast-forwardable);
anything ahead or diverged builds the slice on a stale base and must STOP.
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from argparse import Namespace
from contextlib import contextmanager
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LIFECYCLE = REPO / "scripts/worktree-lifecycle"

PROFILE = """{
  "worktreeLifecycle": {
    "enabled": true,
    "worktreeRoot": ".worktrees",
    "branchTemplate": "{type}/{issue}-{slug}",
    "pathTemplate": "{issue}-{slug}"
  }
}
"""


def load_setup():
    sys.path.insert(0, str(LIFECYCLE))
    try:
        spec = importlib.util.spec_from_file_location(
            "worktree_setup_base_guard", LIFECYCLE / "setup.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(LIFECYCLE))


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


@contextmanager
def fixture():
    """A repo whose `main` carries two commits: base_first, then head."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp).resolve() / "repo"
        repo.mkdir()
        git(repo, "init", "--initial-branch=main")
        git(repo, "config", "user.email", "test@example.invalid")
        git(repo, "config", "user.name", "Test User")
        profile = repo / "docs/agents/workflow-capabilities.json"
        profile.parent.mkdir(parents=True)
        profile.write_text(PROFILE, encoding="utf-8")
        (repo / "README.md").write_text("# fixture\n", encoding="utf-8")
        git(repo, "add", "-A")
        git(repo, "commit", "-m", "first")
        first = git(repo, "rev-parse", "HEAD")
        (repo / "README.md").write_text("# fixture 2\n", encoding="utf-8")
        git(repo, "commit", "-am", "second")
        second = git(repo, "rev-parse", "HEAD")
        yield repo, first, second


@contextmanager
def chdir(path: Path):
    previous = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(previous)


def args_for(base: str) -> Namespace:
    return Namespace(
        profile="docs/agents/workflow-capabilities.json",
        base=base,
        issue="173",
        slug="wave-safety",
        branch_type="feat",
    )


class WorktreeReuseBaseGuard(unittest.TestCase):
    def test_registered_worktree_reuse_stops_when_head_is_not_at_base(self):
        setup = load_setup()
        with fixture() as (repo, first, second):
            target = repo / ".worktrees/173-wave-safety"
            git(repo, "worktree", "add", "-b", "feat/173-wave-safety", str(target), second)
            # base is the OLDER commit -> the registered worktree is ahead of it.
            with chdir(repo):
                with self.assertRaises(setup.LifecycleError) as stopped:
                    setup.create(args_for(first))
        self.assertIn("stale", str(stopped.exception).lower())

    def test_existing_branch_reuse_stops_when_branch_is_not_at_base(self):
        setup = load_setup()
        with fixture() as (repo, first, second):
            git(repo, "branch", "feat/173-wave-safety", second)
            target = repo / ".worktrees/173-wave-safety"
            with chdir(repo):
                with self.assertRaises(setup.LifecycleError) as stopped:
                    setup.create(args_for(first))
        self.assertIn("stale", str(stopped.exception).lower())
        self.assertFalse(target.exists(), "no worktree may be created on a stale base")

    def test_registered_worktree_reuse_allows_head_at_base(self):
        setup = load_setup()
        with fixture() as (repo, _first, second):
            target = repo / ".worktrees/173-wave-safety"
            git(repo, "worktree", "add", "-b", "feat/173-wave-safety", str(target), second)
            with chdir(repo):
                self.assertEqual(setup.create(args_for(second)).resolve(), target.resolve())

    def test_existing_branch_reuse_allows_a_branch_cleanly_behind_base(self):
        setup = load_setup()
        with fixture() as (repo, first, second):
            git(repo, "branch", "feat/173-wave-safety", first)
            target = repo / ".worktrees/173-wave-safety"
            with chdir(repo):
                self.assertEqual(setup.create(args_for(second)).resolve(), target.resolve())
            self.assertTrue(target.is_dir())


if __name__ == "__main__":
    unittest.main()
