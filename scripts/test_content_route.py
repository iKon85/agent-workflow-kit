#!/usr/bin/env python3
"""wrapup's Content route: a planning session lands durable content (#334).

A planning session has no worktree and no slice. Its output — an ADR, a
CONTEXT.md update, a research note — sits dirty in the main checkout on the
protected branch. The Content route is the door: inference proposes, an
explicit confirmed claim decides, every claimed path is verified by its own
hash, and everything else in that dirty tree is a bystander that must come out
untouched.

The fixture is a real repository with a real bare remote, so branch collision,
the index, and the return switch are observed rather than mocked. The one place
a test reaches into the process is the command census: `wrapup.run` is wrapped
by a recorder that still runs every command for real.
"""

import inspect
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from test_worktree_wrapup_contract import (
    INTEGRATION_BRANCH,
    command,
    load_wrapup,
    make_repo,
)

CONTENT_BRANCH = "docs/glossary"
WRAPUP = Path(__file__).resolve().parent / "wrapup-land.py"


def claim_args(claim_file, **overrides):
    values = {
        "claim_file": str(claim_file),
        "message": "docs(context): land the session's durable content",
        "slug": "glossary",
        "type": "docs",
        "anchor": None,
        "body_file": None,
        "allow_matches": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class Recorder:
    """Run every command for real and keep the argv census of the run."""

    def __init__(self, real_run):
        self.real_run = real_run
        self.calls: list[list[str]] = []

    def __call__(self, cmd, cwd=None, check=False, env=None):
        self.calls.append([str(part) for part in cmd])
        return self.real_run(cmd, cwd=cwd, check=check, env=env)

    def generic_commit_calls(self) -> list[list[str]]:
        """Every argv that commits, stages wholesale, or forces the tree.

        This is the apparatus behind "the generic dirty-tree commit never runs
        here", so it is exercised on a positive control too — the ordinary
        `commit` subcommand, which does exactly what this looks for.
        """
        offenders = []
        for call in self.calls:
            if call[:1] != ["git"] or len(call) < 2:
                continue
            verb, rest = call[1], call[2:]
            if verb == "commit":
                offenders.append(call)
            elif verb == "add" and (not rest or {"-A", "--all", "."} & set(rest)):
                offenders.append(call)
            elif verb in {"stash", "checkout", "switch"} and (
                {"--force", "-f"} & set(rest)
            ):
                offenders.append(call)
        return offenders

    def staged_pathspecs(self) -> set[str]:
        """Every path a staging, object-writing, or index command named."""
        named = set()
        for call in self.calls:
            if call[:2] == ["git", "update-index"]:
                named.add(call[-1].split(",", 2)[-1])
            elif call[:2] == ["git", "hash-object"] and "-w" in call:
                named.update(call[call.index("--") + 1:])
            elif call[:2] == ["git", "reset"] and "--" in call:
                named.update(call[call.index("--") + 1:])
        return named


def in_main(cwd: Path, call, *args, recorder=None, wrapup=None):
    """Run one Content-route command with the given checkout as cwd."""
    previous = Path.cwd()
    try:
        os.chdir(cwd)
        if recorder is None:
            return call(*args)
        with patch.object(wrapup, "run", side_effect=recorder):
            return call(*args)
    finally:
        os.chdir(previous)


def write_claim(path: Path, records) -> Path:
    path.write_text(json.dumps({"claimed": list(records)}), encoding="utf-8")
    return path


def status(main: Path) -> list[str]:
    return sorted(command(["git", "status", "--porcelain"], main).stdout.splitlines())


def commit_paths(main: Path, sha: str) -> list[str]:
    out = command(
        ["git", "diff-tree", "-r", "--name-only", "--no-commit-id", f"{sha}^", sha],
        main,
    ).stdout
    return sorted(out.split())


def head_branch(main: Path) -> str:
    return command(["git", "rev-parse", "--abbrev-ref", "HEAD"], main).stdout.strip()


def oid(main: Path, relative: str) -> str:
    return command(["git", "hash-object", "--", relative], main).stdout.strip()


class ContentRouteFixture(unittest.TestCase):
    """A dirty main checkout on the protected branch, exactly as a planning
    session leaves it: durable content next to bystanders it must not touch."""

    def setUp(self):
        self.wrapup = load_wrapup()
        self.addCleanup(os.chdir, Path.cwd())
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.tmp = Path(holder.name)
        self.main, self.remote = make_repo(self.tmp)

    def seed(self, files: dict) -> None:
        """Write the dirty files a planning session left in the main checkout."""
        for relative, content in files.items():
            path = self.main / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    def infer(self, cwd=None):
        return in_main(cwd or self.main, self.wrapup.cmd_content_claim,
                       SimpleNamespace())

    def claim(self, *paths):
        """Run the read-only inference, then confirm exactly `paths` from it."""
        report = self.infer()
        by_path = {entry["path"]: entry for entry in report["candidates"]}
        missing = [path for path in paths if path not in by_path]
        self.assertEqual(missing, [], f"not inferred: {missing} · {report}")
        return report, write_claim(
            self.tmp / "claim.json", [by_path[path] for path in paths]
        )

    def land(self, claim_file, *, recorder=None, **overrides):
        return in_main(
            self.main,
            self.wrapup.cmd_content_commit,
            claim_args(claim_file, **overrides),
            recorder=recorder,
            wrapup=self.wrapup,
        )


class ClaimSubsetContract(ContentRouteFixture):
    """Inference proposes; the claim decides. Only claimed paths land."""

    def test_only_the_claimed_subset_lands_and_the_rest_stays_dirty(self):
        self.seed({
            "docs/adr/0011-content.md": "# Content route\n",
            "note.md": "a second note\n",
            "research/spike.md": "a third note\n",
        })

        report, claim = self.claim("docs/adr/0011-content.md")
        result = self.land(claim)

        self.assertEqual(result["claimed"], ["docs/adr/0011-content.md"])
        self.assertEqual(
            commit_paths(self.main, result["commit"]), ["docs/adr/0011-content.md"]
        )
        self.assertEqual(
            sorted(entry["path"] for entry in report["candidates"]),
            ["docs/adr/0011-content.md", "note.md", "research/spike.md"],
        )
        # The two unclaimed candidates are bystanders: still there, still dirty.
        self.assertEqual(
            (self.main / "research/spike.md").read_text(encoding="utf-8"),
            "a third note\n",
        )
        self.assertEqual(status(self.main), ["?? note.md", "?? research/"])

    def test_claiming_something_inference_never_offered_stops(self):
        self.seed({"docs/note.md": "durable\n", "PLAN.md": "scratch\n"})
        _, claim = self.claim("docs/note.md")
        write_claim(claim, [
            {"path": "docs/note.md", "oid": oid(self.main, "docs/note.md")},
            {"path": "PLAN.md", "oid": oid(self.main, "PLAN.md")},
        ])

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.land(claim)

        self.assertIn("ignored", stopped.exception.reason)
        self.assertIn("PLAN.md", stopped.exception.detail)
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)
        self.assertTrue((self.main / "docs/note.md").is_file())


class BystanderContract(ContentRouteFixture):
    """Everything not in the claim comes out of the route untouched."""

    def test_working_tree_and_index_bystanders_survive_byte_identical(self):
        self.seed({
            "docs/note.md": "durable\n",
            "notes/scratchpad.md": "thinking out loud\n",
            "staged.txt": "the user staged this\n",
        })
        ignore = self.main / ".gitignore"
        ignore.write_text(ignore.read_text(encoding="utf-8") + "# a tracked edit\n",
                          encoding="utf-8")
        command(["git", "add", "staged.txt"], self.main)
        before = status(self.main)

        _, claim = self.claim("docs/note.md")
        result = self.land(claim)

        self.assertEqual(commit_paths(self.main, result["commit"]), ["docs/note.md"])
        self.assertEqual(
            (self.main / "notes/scratchpad.md").read_text(encoding="utf-8"),
            "thinking out loud\n",
        )
        self.assertEqual(
            (self.main / "staged.txt").read_text(encoding="utf-8"),
            "the user staged this\n",
        )
        self.assertIn("# a tracked edit", ignore.read_text(encoding="utf-8"))
        # The dirty tree is exactly what it was, minus the landed claim — and
        # the user's staged bystander is still staged, not committed.
        self.assertIn("A  staged.txt", before)
        self.assertEqual(
            status(self.main), [line for line in before if "docs/note.md" not in line]
        )
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)


class PathDriftContract(ContentRouteFixture):
    """A path that changed between claim and staging is dropped and named."""

    def test_a_drifted_path_is_dropped_named_and_the_rest_still_lands(self):
        self.seed({"docs/note.md": "durable\n", "docs/moving.md": "first draft\n"})
        _, claim = self.claim("docs/note.md", "docs/moving.md")

        (self.main / "docs/moving.md").write_text("second draft\n", encoding="utf-8")
        result = self.land(claim)

        self.assertEqual(result["claimed"], ["docs/note.md"])
        self.assertEqual(len(result["dropped"]), 1)
        self.assertIn("docs/moving.md", result["dropped"][0])
        self.assertIn("changed", result["dropped"][0])
        self.assertEqual(commit_paths(self.main, result["commit"]), ["docs/note.md"])
        self.assertEqual(
            (self.main / "docs/moving.md").read_text(encoding="utf-8"),
            "second draft\n",
        )
        self.assertIn("?? docs/moving.md", status(self.main))

    def test_a_claim_whose_every_path_drifted_stops_instead_of_committing(self):
        self.seed({"docs/note.md": "durable\n"})
        _, claim = self.claim("docs/note.md")
        (self.main / "docs/note.md").unlink()

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.land(claim)

        self.assertIn("nothing left to land", stopped.exception.reason)
        self.assertIn("docs/note.md", stopped.exception.detail)
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)


class BranchCollisionContract(ContentRouteFixture):
    """A collision resolves by stopping, never by reusing someone's branch."""

    def test_an_existing_local_branch_stops_before_anything_is_cut(self):
        self.seed({"docs/note.md": "durable\n"})
        command(["git", "branch", CONTENT_BRANCH], self.main)
        tip = command(["git", "rev-parse", CONTENT_BRANCH], self.main).stdout.strip()
        _, claim = self.claim("docs/note.md")

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.land(claim)

        self.assertIn(CONTENT_BRANCH, stopped.exception.reason)
        self.assertIn("exists", stopped.exception.reason)
        self.assertEqual(
            command(["git", "rev-parse", CONTENT_BRANCH], self.main).stdout.strip(),
            tip,
        )
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)
        self.assertIn("?? docs/note.md", status(self.main))

    def test_a_branch_that_exists_only_on_the_remote_is_a_collision_too(self):
        self.seed({"docs/note.md": "durable\n"})
        command(
            ["git", "push", "origin", f"HEAD:refs/heads/{CONTENT_BRANCH}"], self.main
        )
        _, claim = self.claim("docs/note.md")

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.land(claim)

        self.assertIn(CONTENT_BRANCH, stopped.exception.reason)
        self.assertIn("remote", stopped.exception.reason)
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)


class ReturnSwitchContract(ContentRouteFixture):
    """The return switch is attempted, never forced; a block is named."""

    def test_a_blocked_return_stops_and_names_what_is_in_the_way(self):
        self.seed({"docs/note.md": "durable\n"})
        # Another worktree takes the protected branch, so returning to it is
        # the conflicting checkout git itself refuses.
        command(
            ["git", "worktree", "add", "--force", str(self.tmp / "second"),
             INTEGRATION_BRANCH],
            self.main,
        )
        _, claim = self.claim("docs/note.md")

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.land(claim)

        detail = stopped.exception.detail
        self.assertIn(INTEGRATION_BRANCH, stopped.exception.reason)
        self.assertIn(str(self.tmp / "second"), detail)
        self.assertIn(CONTENT_BRANCH, detail)
        # Nothing was forced and nothing was stashed: the content is safe on the
        # branch, and the main checkout honestly says it is still on it.
        self.assertEqual(head_branch(self.main), CONTENT_BRANCH)
        self.assertEqual(
            command(["git", "stash", "list"], self.main).stdout.strip(), ""
        )
        sha = command(["git", "rev-parse", CONTENT_BRANCH], self.main).stdout.strip()
        self.assertEqual(commit_paths(self.main, sha), ["docs/note.md"])

    def test_a_clear_return_leaves_the_main_checkout_on_the_protected_branch(self):
        """Positive control for the blocked case above."""
        self.seed({"docs/note.md": "durable\n"})
        _, claim = self.claim("docs/note.md")

        result = self.land(claim)

        self.assertEqual(result["returned_to"], INTEGRATION_BRANCH)
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)
        self.assertFalse((self.main / "docs/note.md").exists())
        self.assertEqual(status(self.main), [])


class GenericCommitUnreachable(ContentRouteFixture):
    """The generic dirty-tree commit cannot be entered from this route."""

    def test_the_route_never_stages_or_commits_beyond_the_claim(self):
        self.seed({"docs/note.md": "durable\n", "notes/scratchpad.md": "bystander\n"})
        _, claim = self.claim("docs/note.md")
        recorder = Recorder(self.wrapup.run)

        with patch.object(
            self.wrapup, "cmd_commit",
            side_effect=AssertionError("the generic commit ran"),
        ):
            result = self.land(claim, recorder=recorder)

        self.assertEqual(recorder.generic_commit_calls(), [])
        self.assertEqual(recorder.staged_pathspecs(), {"docs/note.md"})
        self.assertTrue(
            any(call[:2] == ["git", "commit-tree"] for call in recorder.calls),
            "the route builds its commit from a verified tree",
        )
        self.assertEqual(commit_paths(self.main, result["commit"]), ["docs/note.md"])

    def test_the_census_catches_the_generic_commit_when_it_does_run(self):
        """Positive control: the same apparatus on the route that does commit."""
        self.seed({"docs/note.md": "durable\n"})
        command(["git", "switch", "-c", "docs/ordinary"], self.main)
        recorder = Recorder(self.wrapup.run)

        in_main(
            self.main,
            self.wrapup.cmd_commit,
            SimpleNamespace(message="docs: ordinary", allow_matches=False),
            recorder=recorder,
            wrapup=self.wrapup,
        )

        offenders = recorder.generic_commit_calls()
        self.assertTrue(
            any(call[:3] == ["git", "add", "-A"] for call in offenders), offenders
        )
        self.assertTrue(any(call[:2] == ["git", "commit"] for call in offenders))

    def test_no_other_route_can_fall_back_into_the_content_route(self):
        """Authorization is unchanged: this route is invoked, never chained."""
        for entry in (self.wrapup.cmd_preflight, self.wrapup.cmd_commit,
                      self.wrapup.cmd_land):
            self.assertNotIn("cmd_content", inspect.getsource(entry))
        dispatch = inspect.getsource(self.wrapup.main)
        self.assertIn("content-claim", dispatch)
        self.assertIn("content-commit", dispatch)

    def test_the_route_never_reaches_the_teardown_half(self):
        self.seed({"docs/note.md": "durable\n"})
        _, claim = self.claim("docs/note.md")
        recorder = Recorder(self.wrapup.run)

        with patch.object(
            self.wrapup, "assess_teardown",
            side_effect=AssertionError("teardown ran on the Content route"),
        ):
            self.land(claim, recorder=recorder)

        self.assertEqual(
            [call for call in recorder.calls
             if call[:2] == ["git", "worktree"] and "remove" in call],
            [],
        )


class SecretAndEnvContract(ContentRouteFixture):
    """The hard block and the secret scan are the ordinary ones, unweakened."""

    def test_a_claimed_env_path_is_a_hard_block(self):
        self.seed({"docs/note.md": "durable\n"})
        (self.main / ".env.local").write_text("API_KEY=live\n", encoding="utf-8")
        _, claim = self.claim("docs/note.md")
        write_claim(claim, [{"path": ".env.local", "oid": "0" * 40}])

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.land(claim)

        self.assertIn(".env", stopped.exception.reason)
        self.assertTrue((self.main / ".env.local").is_file())
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)

    def test_a_secret_in_the_claimed_content_stops_before_the_branch_is_cut(self):
        self.seed({"docs/note.md": "api_key = sk-live-not-a-drill\n"})
        _, claim = self.claim("docs/note.md")

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.land(claim)

        self.assertIn("secret", stopped.exception.reason)
        self.assertIn("api_key", stopped.exception.detail)
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)
        self.assertEqual(
            command(["git", "branch", "--list", CONTENT_BRANCH],
                    self.main).stdout.strip(),
            "",
        )

    def test_a_reviewed_false_positive_lands_with_allow_matches(self):
        self.seed({"docs/note.md": "api_key = <redacted example>\n"})
        _, claim = self.claim("docs/note.md")

        result = self.land(claim, allow_matches=True)

        self.assertTrue(result["allowed_matches"])
        self.assertEqual(commit_paths(self.main, result["commit"]), ["docs/note.md"])


class AnchorReferenceContract(ContentRouteFixture):
    """`Part of` the anchor — a planning session never closes one."""

    def test_the_anchor_reference_comes_from_the_board_profile(self):
        self.seed({"docs/note.md": "durable\n"})
        _, claim = self.claim("docs/note.md")

        result = self.land(claim, anchor="318")

        marker = self.wrapup.load_profile()["prMarkers"]["partOf"]
        self.assertEqual(result["pr_reference"], f"{marker} #318")

    def test_a_body_that_declares_a_close_keyword_is_refused(self):
        self.seed({"docs/note.md": "durable\n"})
        body = self.tmp / "body.md"
        body.write_text("closes #318\n", encoding="utf-8")
        _, claim = self.claim("docs/note.md")

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.land(claim, body_file=str(body), anchor="318")

        self.assertIn("close", stopped.exception.reason)
        self.assertIn("318", stopped.exception.detail)
        self.assertEqual(head_branch(self.main), INTEGRATION_BRANCH)


class ContextContract(ContentRouteFixture):
    """The route runs in the main checkout, on the protected branch, only."""

    def test_a_worktree_is_sent_to_the_ordinary_route(self):
        worktree = self.tmp / "slice"
        command(
            ["git", "worktree", "add", "-b", "feat/1-slice", str(worktree),
             INTEGRATION_BRANCH],
            self.main,
        )

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.infer(cwd=worktree)

        self.assertIn("main checkout", stopped.exception.reason)

    def test_an_unprotected_branch_is_sent_to_the_ordinary_route(self):
        command(["git", "switch", "-c", "docs/already-cut"], self.main)

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.infer()

        self.assertIn("protected branch", stopped.exception.reason)

    def test_inference_names_what_it_cannot_claim_instead_of_hiding_it(self):
        self.seed({"docs/note.md": "durable\n"})
        (self.main / "docs/link.md").symlink_to(self.main / "docs/note.md")
        command(["git", "rm", "-q", "--cached", ".gitignore"], self.main)
        (self.main / ".gitignore").unlink()

        report = self.infer()

        paths = [entry["path"] for entry in report["candidates"]]
        self.assertIn("docs/note.md", paths)
        self.assertNotIn("docs/link.md", paths)
        self.assertNotIn(".gitignore", paths)
        unclaimable = " ".join(report["unclaimable"])
        self.assertIn("docs/link.md", unclaimable)
        self.assertIn(".gitignore", unclaimable)

    def test_an_unbounded_dirty_tree_is_summarised_not_dumped(self):
        limit = self.wrapup.CONTENT_CANDIDATE_LIMIT
        bulk = self.main / "bulk"
        bulk.mkdir()
        for index in range(limit + 1):
            (bulk / f"file{index}.md").write_text("noise\n", encoding="utf-8")

        with self.assertRaises(self.wrapup.Stop) as stopped:
            self.infer()

        self.assertIn(str(limit + 1), stopped.exception.detail)
        self.assertIn("bulk/", stopped.exception.detail)
        self.assertNotIn("file7.md", stopped.exception.detail)


if __name__ == "__main__":
    unittest.main()
