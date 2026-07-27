#!/usr/bin/env python3
"""The branch-deletion authority matrix (ADR 0009 §3).

A branch is force-deleted on the platform's own record and nothing else:
exactly one pull request whose full tuple matches — this repository as base
repo, the head repository equal to it, this head ref, the configured
integration branch as base ref, merged — and whose head SHA is still the branch
tip when the deletion happens. Zero matches, several matches, an open pull
request on the same head, drift between authorization and deletion, or no
platform access at all keep the branch and say why.

The `gh` boundary is faked with the shapes the 23b spike (#329) recorded from
the live API, because two of them decide the implementation: the list endpoint
sends `merged: null` even for a genuinely merged pull request, and a reused
head ref returns several pull requests.
"""

import contextlib
import io
import json
import re
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from test_worktree_wrapup_contract import (
    FakeHub,
    INTEGRATION_BRANCH,
    add_worktree,
    command,
    integrate,
    land_args,
    load_wrapup,
    make_repo,
    run_land,
)

REPOSITORY = "acme/repo"
HEAD_REF = "feat/9-slice"
MERGED_AT = "2026-07-27T12:04:28Z"


def completed(payload, returncode=0, stderr=""):
    return subprocess.CompletedProcess([], returncode, json.dumps(payload), stderr)


def pr_record(number, sha, *, ref=HEAD_REF, base=INTEGRATION_BRANCH, state="closed",
              merged_at=MERGED_AT, head_repository=REPOSITORY,
              base_repository=REPOSITORY, **overrides):
    """One pull request in the recorded list-endpoint shape.

    `merged` is null even for a merged pull request — that is what the live API
    returns (#329 caveat 1), so every fixture carries the null.
    """
    record = {
        "number": number,
        "state": state,
        "merged": None,
        "merged_at": merged_at,
        "head": {
            "ref": ref,
            "sha": sha,
            "repo": {"full_name": head_repository} if head_repository else None,
        },
        "base": {"ref": base, "repo": {"full_name": base_repository}},
    }
    record.update(overrides)
    return record


class FakePlatform:
    """The `gh` boundary; git still runs for real against the fixture."""

    def __init__(self, real_run, records, *, single=None, repository=REPOSITORY,
                 authenticated=True, installed=True):
        self.real_run = real_run
        self.records = records
        self.single = single
        self.repository = repository
        self.authenticated = authenticated
        self.installed = installed
        self.calls: list[list[str]] = []

    def __call__(self, args, cwd=None, check=False, env=None):
        args = list(args)
        self.calls.append(args)
        if args[0] != "gh":
            return self.real_run(args, cwd=cwd, check=check, env=env)
        if not self.installed:
            raise FileNotFoundError(2, "No such file or directory", "gh")
        if not self.authenticated:
            return subprocess.CompletedProcess(args, 1, "", "gh: authentication required")
        if args[:3] == ["gh", "repo", "view"]:
            return completed({"nameWithOwner": self.repository})
        if args[:2] == ["gh", "api"] and re.search(r"/pulls/\d+$", args[2]):
            return completed(self.single)
        if args[:2] == ["gh", "api"]:
            return completed(self.records)
        raise AssertionError(f"unexpected platform call: {args}")

    @property
    def api_paths(self) -> list[str]:
        return [call[2] for call in self.calls if call[:2] == ["gh", "api"]]


def cut_branch(main: Path, root: Path, branch: str, *, merged: bool, pushed: bool) -> str:
    """Create `branch` with one commit and return its tip, holding no worktree."""
    path = root / f"cut-{branch.replace('/', '-')}"
    command(["git", "worktree", "add", "-b", branch, str(path), INTEGRATION_BRANCH], main)
    (path / "work.txt").write_text("work\n", encoding="utf-8")
    command(["git", "add", "work.txt"], path)
    command(["git", "commit", "-m", f"work on {branch}"], path)
    tip = command(["git", "rev-parse", "HEAD"], path).stdout.strip()
    if pushed:
        command(["git", "push", "-u", "origin", branch], path)
    if merged:
        command(["git", "merge", "--ff-only", branch], main)
        command(["git", "push", "origin", INTEGRATION_BRANCH], main)
    command(["git", "worktree", "remove", str(path)], main)
    return tip


def move_tip(main: Path, root: Path, branch: str) -> str:
    """Advance the branch the way a concurrent commit would."""
    path = root / "moved"
    command(["git", "worktree", "add", str(path), branch], main)
    (path / "late.txt").write_text("late\n", encoding="utf-8")
    command(["git", "add", "late.txt"], path)
    command(["git", "commit", "-m", "late work"], path)
    tip = command(["git", "rev-parse", "HEAD"], path).stdout.strip()
    command(["git", "worktree", "remove", str(path)], main)
    return tip


@contextmanager
def repository(*, merged=False, pushed=True, delete_remote=False, branch=HEAD_REF):
    """A repository whose integration branch is not the platform default."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        main, _ = make_repo(root)
        tip = cut_branch(main, root, branch, merged=merged, pushed=pushed)
        if delete_remote:
            command(["git", "push", "origin", "--delete", branch], main)
        yield root, main, branch, tip


class BranchDeletionAuthority(unittest.TestCase):
    def setUp(self):
        self.wrapup = load_wrapup()

    def authorize(self, main: Path, branch: str, platform, **kwargs):
        return self.wrapup.authorize_branch_deletion(
            str(main), branch, integration=INTEGRATION_BRANCH,
            command_runner=platform, **kwargs,
        )

    def branch_exists(self, main: Path, branch: str) -> bool:
        return bool(self.wrapup.branch_tip(str(main), branch))

    # --- row 1: the full tuple ------------------------------------------------

    def test_the_full_tuple_authorizes_force_deletion(self):
        with repository() as (_root, main, branch, tip):
            platform = FakePlatform(self.wrapup.run, [
                pr_record(41, tip, head_repository=None),          # deleted fork head
                pr_record(42, tip, head_repository="fork/repo"),   # fork head
                pr_record(43, tip, base="release/next"),           # foreign base ref
                pr_record(44, tip, ref="feat/9-other"),            # foreign head ref
                pr_record(45, tip),                                # the only match
            ])

            authority = self.authorize(main, branch, platform)

            self.assertEqual(authority.decision, self.wrapup.BRANCH_PR_RECORD)
            self.assertEqual(authority.pr, "45")
            self.assertEqual(authority.tip, tip)
            self.assertFalse(authority.degraded)
            deleted, detail = self.wrapup.delete_authorized_branch(str(main), authority)
            self.assertTrue(deleted, detail)
            self.assertFalse(self.branch_exists(main, branch))

    def test_force_deletion_is_exactly_what_the_record_buys(self):
        """Positive control for the flag: `-d` alone cannot retire this branch."""
        with repository(pushed=False) as (_root, main, branch, tip):
            refusal = self.wrapup.git(["branch", "-d", branch], cwd=str(main))
            self.assertNotEqual(refusal.returncode, 0)

            platform = FakePlatform(self.wrapup.run, [pr_record(45, tip)])
            authority = self.authorize(main, branch, platform)
            deleted, detail = self.wrapup.delete_authorized_branch(str(main), authority)

            self.assertTrue(deleted, detail)
            self.assertFalse(self.branch_exists(main, branch))

    # --- row 2: drift ---------------------------------------------------------

    def test_a_tip_that_moves_before_deletion_retains_the_branch(self):
        with repository() as (root, main, branch, tip):
            platform = FakePlatform(self.wrapup.run, [pr_record(45, tip)])
            authority = self.authorize(main, branch, platform)
            self.assertEqual(authority.decision, self.wrapup.BRANCH_PR_RECORD)

            moved = move_tip(main, root, branch)
            deleted, detail = self.wrapup.delete_authorized_branch(str(main), authority)

            self.assertNotEqual(moved, tip)
            self.assertFalse(deleted)
            self.assertIn("moved", detail)
            self.assertEqual(self.wrapup.branch_tip(str(main), branch), moved)

    # --- row 3: zero matches --------------------------------------------------

    def test_no_matching_pull_request_retains_the_branch(self):
        with repository() as (_root, main, branch, _tip):
            platform = FakePlatform(self.wrapup.run, [])

            authority = self.authorize(main, branch, platform)
            deleted, detail = self.wrapup.delete_authorized_branch(str(main), authority)

            self.assertEqual(authority.decision, self.wrapup.BRANCH_RETAINED)
            self.assertIn("no merged pull request", authority.reason)
            self.assertFalse(deleted)
            self.assertIn("no merged pull request", detail)
            self.assertTrue(self.branch_exists(main, branch))

    # --- row 4: several matches -----------------------------------------------

    def test_several_matching_pull_requests_retain_the_branch(self):
        with repository() as (_root, main, branch, tip):
            platform = FakePlatform(self.wrapup.run, [
                pr_record(68, tip), pr_record(69, tip),
            ])

            authority = self.authorize(main, branch, platform)

            self.assertEqual(authority.decision, self.wrapup.BRANCH_RETAINED)
            self.assertIn("#68", authority.reason)
            self.assertIn("#69", authority.reason)
            self.assertIn("--pr", authority.reason)
            self.assertTrue(self.branch_exists(main, branch))

    # --- row 5: an open pull request on the same head -------------------------

    def test_an_open_pull_request_on_the_same_head_retains_the_branch(self):
        with repository() as (_root, main, branch, tip):
            platform = FakePlatform(self.wrapup.run, [
                pr_record(45, tip),
                pr_record(50, tip, state="open", merged_at=None),
            ])

            authority = self.authorize(main, branch, platform)

            self.assertEqual(authority.decision, self.wrapup.BRANCH_RETAINED)
            self.assertIn("#50", authority.reason)
            self.assertIn("open", authority.reason)
            self.assertTrue(self.branch_exists(main, branch))

    # --- row 6: no platform access --------------------------------------------

    def test_without_platform_access_the_degradation_is_reported(self):
        for label, platform_kwargs in (
            ("gh is not installed", {"installed": False}),
            ("gh cannot authenticate", {"authenticated": False}),
        ):
            with self.subTest(label):
                with repository() as (_root, main, branch, tip):
                    blind = FakePlatform(self.wrapup.run, [], **platform_kwargs)

                    authority = self.authorize(main, branch, blind)

                    self.assertEqual(authority.decision, self.wrapup.BRANCH_RETAINED)
                    self.assertTrue(authority.degraded)
                    self.assertIn("ancestry", authority.reason)
                    self.assertTrue(self.branch_exists(main, branch))

                    # Positive control on the same fixture: the identical
                    # harness authorizes as soon as the platform answers.
                    answering = FakePlatform(self.wrapup.run, [pr_record(45, tip)])
                    self.assertEqual(
                        self.authorize(main, branch, answering).decision,
                        self.wrapup.BRANCH_PR_RECORD,
                    )

    # --- row 7: the deleted-remote recovery (#329) ----------------------------

    def test_a_deleted_remote_branch_is_still_resolved_historically(self):
        with repository(delete_remote=True) as (_root, main, branch, tip):
            platform = FakePlatform(self.wrapup.run, [pr_record(45, tip)])

            authority = self.authorize(main, branch, platform)

            self.assertEqual(authority.decision, self.wrapup.BRANCH_PR_RECORD)
            self.assertEqual(authority.pr, "45")
            self.assertEqual(len(platform.api_paths), 1)
            path = platform.api_paths[0]
            self.assertIn(f"repos/{REPOSITORY}/pulls?", path)
            self.assertIn("state=all", path)
            self.assertIn(f"head=acme:{HEAD_REF.replace('/', '%2F')}", path)
            self.assertNotIn(
                ["gh", "pr", "view"], [call[:3] for call in platform.calls]
            )

    # --- row 8: a stale fetch stops -------------------------------------------

    def test_a_failed_fetch_stops_instead_of_trusting_stale_ancestry(self):
        with repository() as (root, main, branch, _tip):
            command(["git", "remote", "set-url", "origin", str(root / "gone.git")], main)
            platform = FakePlatform(self.wrapup.run, [])

            with self.assertRaises(self.wrapup.Stop) as stopped:
                self.authorize(main, branch, platform)

            self.assertEqual(stopped.exception.step, "5 branch-authority")
            self.assertIn(INTEGRATION_BRANCH, stopped.exception.reason)
            self.assertEqual(platform.calls, [])
            self.assertTrue(self.branch_exists(main, branch))

    # --- ancestry: the branch that never needs the platform -------------------

    def test_an_ancestry_merged_branch_deletes_without_asking_the_platform(self):
        with repository(merged=True) as (_root, main, branch, tip):
            platform = FakePlatform(self.wrapup.run, [])

            authority = self.authorize(main, branch, platform)
            deleted, detail = self.wrapup.delete_authorized_branch(str(main), authority)

            self.assertEqual(authority.decision, self.wrapup.BRANCH_ANCESTRY)
            self.assertEqual(authority.tip, tip)
            self.assertEqual(platform.api_paths, [])
            self.assertTrue(deleted, detail)
            self.assertFalse(self.branch_exists(main, branch))

    # --- caveat 1: `merged` is always null on the list endpoint ---------------

    def test_merged_at_decides_merged_state_not_the_null_merged_field(self):
        with repository() as (_root, main, branch, tip):
            record = pr_record(45, tip)
            self.assertIsNone(record["merged"])  # the recorded live shape

            authority = self.authorize(
                main, branch, FakePlatform(self.wrapup.run, [record])
            )

            self.assertEqual(authority.decision, self.wrapup.BRANCH_PR_RECORD)

    def test_an_unmerged_pull_request_is_not_authorized_by_a_merged_field(self):
        with repository() as (_root, main, branch, tip):
            platform = FakePlatform(self.wrapup.run, [
                pr_record(45, tip, merged_at=None, merged=True),
            ])

            authority = self.authorize(main, branch, platform)

            self.assertEqual(authority.decision, self.wrapup.BRANCH_RETAINED)
            self.assertTrue(self.branch_exists(main, branch))

    # --- caveat 2: a reused head ref is not unique ----------------------------

    def test_a_reused_head_ref_is_disambiguated_by_the_head_sha(self):
        with repository() as (_root, main, branch, tip):
            platform = FakePlatform(self.wrapup.run, [
                pr_record(67, "a" * 40),
                pr_record(68, "b" * 40),
                pr_record(69, tip),
            ])

            authority = self.authorize(main, branch, platform)

            self.assertEqual(authority.decision, self.wrapup.BRANCH_PR_RECORD)
            self.assertEqual(authority.pr, "69")

    # --- the `--pr` escape hatch ---------------------------------------------

    def test_an_explicit_pr_selects_the_record_and_is_still_validated(self):
        with repository() as (_root, main, branch, tip):
            platform = FakePlatform(
                self.wrapup.run,
                [pr_record(67, "a" * 40), pr_record(68, "b" * 40), pr_record(69, tip)],
                single=pr_record(69, tip, merged=True),
            )

            authority = self.authorize(main, branch, platform, pr="69")

            self.assertEqual(authority.decision, self.wrapup.BRANCH_PR_RECORD)
            self.assertEqual(authority.pr, "69")
            self.assertIn(f"repos/{REPOSITORY}/pulls/69", platform.api_paths)

    def test_an_explicit_pr_that_fails_the_tuple_retains_the_branch(self):
        with repository() as (_root, main, branch, tip):
            platform = FakePlatform(
                self.wrapup.run,
                [pr_record(69, tip)],
                single=pr_record(67, "a" * 40, merged=True),
            )

            authority = self.authorize(main, branch, platform, pr="67")

            self.assertEqual(authority.decision, self.wrapup.BRANCH_RETAINED)
            self.assertTrue(self.branch_exists(main, branch))


class LandBranchRetirement(unittest.TestCase):
    """The CLI contract: `land --pr <n>` reaches the authority, nothing else."""

    def setUp(self):
        self.wrapup = load_wrapup()

    def test_land_reports_the_authority_and_forwards_the_pr_flag(self):
        seen = {}
        real = self.wrapup.authorize_branch_deletion

        def spy(main_tree, branch, **kwargs):
            seen.update(kwargs)
            return real(main_tree, branch, **kwargs)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, _ = make_repo(root)
            branch = "spike/land"
            worktree = add_worktree(main, root / "land-tree", branch)
            integrate(main, worktree, branch)
            hub = FakeHub(self.wrapup.run)

            with patch.object(self.wrapup, "authorize_branch_deletion", side_effect=spy):
                result = run_land(
                    self.wrapup, main, land_args(branch, pr="77"), hub=hub
                )

            self.assertEqual(seen.get("pr"), "77")
            self.assertEqual(
                result["branch_authority"]["decision"], self.wrapup.BRANCH_ANCESTRY
            )
            self.assertTrue(result["branch_retired"])

    def test_the_pr_flag_takes_a_pull_request_number(self):
        parser = self.wrapup.build_parser()

        self.assertEqual(
            parser.parse_args(["land", "--branch", "spike/x", "--pr", "77"]).pr, "77"
        )
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as exited:
                parser.parse_args(["land", "--branch", "spike/x", "--pr", "later"])
        self.assertEqual(exited.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
