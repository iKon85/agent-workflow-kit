#!/usr/bin/env python3
"""wrapup lands and tears down any born, attached worktree (ADR-0009).

The landing contract — preflight → commit → land — survives here. What is gone
is its provenance half: there is no attempt journal, no artifact baseline, no
canonical-policy reload and no recovery flag, so every test below reads present
state exactly the way the code under test does.
"""

import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
WRAPUP = REPO / "scripts/wrapup-land.py"
LIFECYCLE = REPO / "scripts/worktree-lifecycle"

# The kit never names an integration branch inline, so the fixture deliberately
# calls its own something other than the platform default: every command under
# test has to resolve the name through the consumer profile to work at all.
INTEGRATION_BRANCH = "trunk"


def load_wrapup():
    spec = importlib.util.spec_from_file_location("wrapup_land_worktree_contract", WRAPUP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def command(args, cwd):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise AssertionError(
            f"{' '.join(str(arg) for arg in args)} failed ({result.returncode}): "
            f"{(result.stderr or result.stdout).strip()}"
        )
    return result


def make_repo(root: Path) -> tuple[Path, Path]:
    """A repository whose integration branch is not called the platform default."""
    remote = root / "remote.git"
    main = root / "main"
    command(["git", "init", "--bare", "--initial-branch", INTEGRATION_BRANCH, str(remote)], root)
    command(["git", "init", "-b", INTEGRATION_BRANCH, str(main)], root)
    command(["git", "config", "user.name", "Test"], main)
    command(["git", "config", "user.email", "test@example.invalid"], main)
    (main / ".gitignore").write_text(
        ".worktrees/\nbuild/\nPLAN.md\nANNAHMEN.md\n.env*\n", encoding="utf-8"
    )
    profile = main / "docs/agents/workflow-capabilities.json"
    profile.parent.mkdir(parents=True)
    profile.write_text(json.dumps({
        "worktreeLifecycle": {
            "enabled": True,
            "worktreeRoot": ".worktrees",
            "mainBranches": [INTEGRATION_BRANCH],
            "protectedBranches": [INTEGRATION_BRANCH],
            "setupSteps": [],
        },
    }), encoding="utf-8")
    command(["git", "add", "."], main)
    command(["git", "commit", "-m", "seed"], main)
    command(["git", "remote", "add", "origin", str(remote)], main)
    command(["git", "push", "-u", "origin", INTEGRATION_BRANCH], main)
    return main, remote


def add_worktree(main: Path, path: Path, branch: str) -> Path:
    command(
        ["git", "worktree", "add", "-b", branch, str(path), INTEGRATION_BRANCH], main
    )
    return path


def integrate(main: Path, worktree: Path, branch: str) -> None:
    """Commit one change and fast-forward the integration branch onto it."""
    (worktree / "change.txt").write_text("landed\n", encoding="utf-8")
    command(["git", "add", "change.txt"], worktree)
    command(["git", "commit", "-m", "change"], worktree)
    command(["git", "merge", "--ff-only", branch], main)
    command(["git", "push", "origin", INTEGRATION_BRANCH], main)


def _ok(args, stdout=""):
    return subprocess.CompletedProcess(args, 0, stdout, "")


class FakeHub:
    """The platform PR record, stateful across land runs.

    Idempotency by re-check means the PR record *is* the resume authority, so a
    re-run has to see the state the previous run left behind.
    """

    def __init__(self, real_run, *, exists=True, state="OPEN", number=42,
                 body="**Retro:** n/a"):
        self.real_run = real_run
        self.exists = exists
        self.state = state
        self.number = number
        self.body = body
        self.calls: list[list[str]] = []

    def count(self, *prefix) -> int:
        return len([call for call in self.calls if call[:len(prefix)] == list(prefix)])

    def __call__(self, args, cwd=None, check=False, env=None):
        args = list(args)
        self.calls.append(args)
        if args[:3] == ["gh", "pr", "view"]:
            if not self.exists:
                return subprocess.CompletedProcess(args, 1, "", "no pull requests found")
            fields = args[-1]
            payload = {}
            if "number" in fields:
                payload["number"] = self.number
            if "state" in fields:
                payload["state"] = self.state
            if "body" in fields:
                payload["body"] = self.body
            return _ok(args, json.dumps(payload))
        if args[:3] == ["gh", "pr", "create"]:
            self.exists = True
            return _ok(args)
        if args[:3] == ["gh", "pr", "merge"]:
            self.state = "MERGED"
            return _ok(args)
        if args[:3] == ["gh", "pr", "edit"]:
            return _ok(args)
        if args[:3] == ["gh", "pr", "list"]:
            return _ok(args)
        if args[:3] == ["gh", "issue", "view"]:
            return _ok(args, json.dumps({"state": "CLOSED"}))
        if args and args[0] == sys.executable:
            return _ok(args)
        return self.real_run(args, cwd=cwd, check=check, env=env)


def land_args(branch, **overrides):
    values = {
        "branch": branch,
        "body_file": None,
        "title": None,
        "anchor": None,
        "pr": None,
        "skip_malformed_drift": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def run_land(wrapup, main: Path, args, *, hub, gate=False, kill=None):
    """Run `land` from the main tree with the platform calls stubbed."""
    previous = Path.cwd()
    try:
        os.chdir(main)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(wrapup, "run", side_effect=hub))
            if callable(gate):
                stack.enter_context(
                    patch.object(wrapup, "wait_for_merge_gate", side_effect=gate)
                )
            else:
                stack.enter_context(
                    patch.object(wrapup, "wait_for_merge_gate", return_value=gate)
                )
            if kill is None:
                stack.enter_context(
                    patch.object(wrapup, "kill_worktree_processes", return_value=[])
                )
            else:
                stack.enter_context(
                    patch.object(wrapup, "kill_worktree_processes", side_effect=kill)
                )
            return wrapup.cmd_land(args)
    finally:
        os.chdir(previous)


@contextlib.contextmanager
def sleeping_process(cwd: Path):
    child = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(60)"],
        cwd=cwd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        yield child
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)


class PrBodyAuthority(unittest.TestCase):
    def test_declared_close_targets_is_pr_body_authority(self):
        mod = load_wrapup()
        self.assertEqual(mod.declared_close_targets("Part of #320"), [])
        self.assertEqual(mod.declared_close_targets("closes #341\ncloses #12"),
                         ["12", "341"])
        self.assertEqual(mod.declared_close_targets("`closes #341`"), [])


class IssueAnchorIsOptional(unittest.TestCase):
    def test_branch_prefixes_come_from_the_board_profile(self):
        wrapup = load_wrapup()
        with patch.object(
            wrapup, "load_profile", return_value={"branchPrefixes": ["feat", "fix"]}
        ):
            self.assertEqual(wrapup.issue_from_branch("feat/12-slice"), "12")
            self.assertIsNone(wrapup.issue_from_branch("spike/external-tool"))

    def test_no_board_profile_means_no_anchor_rather_than_a_refusal(self):
        wrapup = load_wrapup()
        with patch.object(wrapup, "load_profile", return_value={}):
            self.assertIsNone(wrapup.issue_from_branch("feat/12-slice"))


class HeadStateContract(unittest.TestCase):
    """Detached and unborn are named refusals, never silent skips."""

    def test_preflight_stops_on_a_detached_head(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, _ = make_repo(root)
            detached = root / "detached"
            command(["git", "worktree", "add", "--detach", str(detached),
                     INTEGRATION_BRANCH], main)
            previous = Path.cwd()
            try:
                os.chdir(detached)
                with self.assertRaises(wrapup.Stop) as stopped:
                    wrapup.cmd_preflight(SimpleNamespace())
            finally:
                os.chdir(previous)
        self.assertEqual(stopped.exception.step, "preflight")
        self.assertIn("detached HEAD", stopped.exception.reason)
        self.assertIn("git switch", stopped.exception.detail)

    def test_preflight_stops_on_an_unborn_branch(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            fresh = Path(tmp) / "fresh"
            fresh.mkdir()
            command(["git", "init", "-b", "work", str(fresh)], Path(tmp))
            previous = Path.cwd()
            try:
                os.chdir(fresh)
                with self.assertRaises(wrapup.Stop) as stopped:
                    wrapup.cmd_preflight(SimpleNamespace())
            finally:
                os.chdir(previous)
        self.assertEqual(stopped.exception.step, "preflight")
        self.assertIn("unborn branch work", stopped.exception.reason)
        self.assertIn("first commit", stopped.exception.detail)

    def test_preflight_reads_the_protected_branch_from_the_profile(self):
        """A branch is protected because the profile says so, never by its name."""
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, _ = make_repo(root)
            profile = main / "docs/agents/workflow-capabilities.json"
            document = json.loads(profile.read_text(encoding="utf-8"))
            document["worktreeLifecycle"]["protectedBranches"] = [
                INTEGRATION_BRANCH, "guarded",
            ]
            profile.write_text(json.dumps(document), encoding="utf-8")
            command(["git", "add", "-A"], main)
            command(["git", "commit", "-m", "guard a second branch"], main)
            guarded = add_worktree(main, root / "guarded-tree", "guarded")
            previous = Path.cwd()
            try:
                os.chdir(guarded)
                with self.assertRaises(wrapup.Stop) as stopped:
                    wrapup.cmd_preflight(SimpleNamespace())
            finally:
                os.chdir(previous)
        self.assertIn("guarded is a protected branch", stopped.exception.reason)

    def test_commit_refuses_a_detached_head(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, _ = make_repo(root)
            detached = root / "detached"
            command(["git", "worktree", "add", "--detach", str(detached),
                     INTEGRATION_BRANCH], main)
            previous = Path.cwd()
            try:
                os.chdir(detached)
                with self.assertRaises(wrapup.Stop) as stopped:
                    wrapup.cmd_commit(SimpleNamespace(message="x", allow_matches=False))
            finally:
                os.chdir(previous)
        self.assertIn("detached HEAD", stopped.exception.reason)


class ExternalWorktreeContract(unittest.TestCase):
    """A worktree an external tool created is first-class (ADR-0009 §5)."""

    def test_foreign_path_and_issueless_branch_land_and_tear_down(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, _ = make_repo(root)
            (main / ".env").write_text("SHARED=1\n", encoding="utf-8")
            branch = "spike/external-tool"
            external = add_worktree(main, root / "somewhere-else", branch)
            integrate(main, external, branch)
            (external / "PLAN.md").write_text("scratch\n", encoding="utf-8")
            (external / "build").mkdir()
            (external / "build/out.txt").write_text("derived\n", encoding="utf-8")
            (external / ".env").write_text("SHARED=1\n", encoding="utf-8")

            hub = FakeHub(wrapup.run)
            result = run_land(wrapup, main, land_args(branch), hub=hub)

            self.assertTrue(result["merged"])
            self.assertEqual(result["worktree_removed"], str(external))
            self.assertFalse(external.exists())
            self.assertIn("PLAN.md", result["scratch_removed"])
            self.assertIn("build", result["scratch_removed"])
            # The derived .env copy is byte-identical to the main checkout's,
            # so it is Scratch; the main checkout's own copy is untouched.
            self.assertIn(".env", result["scratch_removed"])
            self.assertEqual((main / ".env").read_text(encoding="utf-8"), "SHARED=1\n")
            self.assertIsNone(result["anchor_sync"]["anchor"])
            self.assertIn("no issue anchor", result["anchor_sync"]["skipped"])

    def test_a_divergent_env_file_blocks_teardown_and_survives(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, _ = make_repo(root)
            branch = "spike/env"
            external = add_worktree(main, root / "env-tree", branch)
            integrate(main, external, branch)
            (external / ".env").write_text("LOCAL=only-here\n", encoding="utf-8")

            hub = FakeHub(wrapup.run)
            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(branch), hub=hub)

            self.assertEqual(stopped.exception.step, "4 teardown")
            self.assertIn("env-file", stopped.exception.detail)
            self.assertIn(".env", stopped.exception.detail)
            self.assertEqual(
                (external / ".env").read_text(encoding="utf-8"), "LOCAL=only-here\n"
            )
            self.assertTrue(external.is_dir())

    def test_untracked_work_appearing_before_teardown_blocks_with_a_bounded_report(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            main, _ = make_repo(root)
            branch = "spike/late-work"
            external = add_worktree(main, root / "late-tree", branch)
            integrate(main, external, branch)
            (external / "PLAN.md").write_text("scratch\n", encoding="utf-8")

            def late_write(_wt):
                notes = external / "notes"
                notes.mkdir()
                (notes / "review.md").write_text("unsaved thinking\n", encoding="utf-8")
                return []

            hub = FakeHub(wrapup.run)
            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(branch), hub=hub, kill=late_write)

            detail = stopped.exception.detail
            self.assertEqual(stopped.exception.step, "4 teardown")
            self.assertIn("untracked-files", detail)
            self.assertIn("notes/", detail)
            self.assertNotIn("review.md", detail)  # bounded: directories, not a dump
            self.assertEqual(
                (external / "notes/review.md").read_text(encoding="utf-8"),
                "unsaved thinking\n",
            )
            self.assertTrue((external / "PLAN.md").is_file())

    def test_land_refuses_the_protected_branch(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, _ = make_repo(Path(tmp))
            hub = FakeHub(wrapup.run)
            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(INTEGRATION_BRANCH), hub=hub)
        self.assertIn("protected branch", stopped.exception.reason)


class ProcessKillContract(unittest.TestCase):
    """`.dev-ports`-scoped, never signal on doubt."""

    def _fixture(self, tmp: Path):
        main, _ = make_repo(tmp)
        worktree = add_worktree(main, tmp / "ports-tree", "spike/ports")
        (worktree / ".dev-ports").write_text("VITE_DEV_PORT=51999\n", encoding="utf-8")
        return main, worktree

    def _with_listener(self, wrapup, worktree: Path, pid: int):
        real_run = wrapup.run

        def runner(args, cwd=None, check=False, env=None):
            if list(args)[:2] == ["lsof", "-ti"]:
                return _ok(args, f"{pid}\n")
            return real_run(args, cwd=cwd, check=check, env=env)

        return patch.object(wrapup, "run", side_effect=runner)

    def test_a_listener_owned_by_this_worktree_is_signalled(self):
        """Positive control: the same harness does kill when attribution holds."""
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            _, worktree = self._fixture(Path(tmp))
            with sleeping_process(worktree) as child:
                with self._with_listener(wrapup, worktree, child.pid):
                    killed = wrapup.kill_worktree_processes(str(worktree))
                self.assertEqual(len(killed), 1)
                self.assertIn(str(child.pid), killed[0])
                self.assertIsNotNone(child.wait(timeout=10))

    def test_a_foreign_listener_on_a_declared_port_stops_instead_of_being_killed(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, worktree = self._fixture(root)
            foreign = root / "someone-elses-project"
            foreign.mkdir()
            with sleeping_process(foreign) as child:
                with self._with_listener(wrapup, worktree, child.pid):
                    with self.assertRaises(wrapup.Stop) as stopped:
                        wrapup.kill_worktree_processes(str(worktree))
                self.assertIn("never signal on doubt", stopped.exception.reason)
                self.assertIn(str(child.pid), stopped.exception.detail)
                self.assertIsNone(child.poll())

    def test_own_ancestry_is_never_signalled(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            _, worktree = self._fixture(Path(tmp))
            with self._with_listener(wrapup, worktree, os.getpid()):
                self.assertEqual(wrapup.kill_worktree_processes(str(worktree)), [])

    def test_without_declared_ports_no_process_is_hunted(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            _, worktree = self._fixture(Path(tmp))
            (worktree / ".dev-ports").unlink()
            with patch.object(wrapup, "run", side_effect=AssertionError("no lookup")):
                self.assertEqual(wrapup.kill_worktree_processes(str(worktree)), [])


class ResumeByRecheckContract(unittest.TestCase):
    """ADR-0009 §4: every step verifies present state and skips or proceeds."""

    def _merged_fixture(self, tmp: Path, branch="spike/resume"):
        main, _ = make_repo(tmp)
        worktree = add_worktree(main, tmp / "resume-tree", branch)
        integrate(main, worktree, branch)
        return main, worktree

    def test_rerun_after_commit_is_a_no_op(self):
        wrapup = load_wrapup()
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self._merged_fixture(Path(tmp))
            (worktree / "extra.txt").write_text("more\n", encoding="utf-8")
            previous = Path.cwd()
            try:
                os.chdir(worktree)
                args = SimpleNamespace(message="feat: extra", allow_matches=False)
                first = wrapup.cmd_commit(args)
                second = wrapup.cmd_commit(args)
            finally:
                os.chdir(previous)
        self.assertTrue(first["committed"])
        self.assertFalse(second["committed"])
        self.assertIn("nothing to commit", second["reason"])

    def test_rerun_after_push_skips_the_push(self):
        wrapup = load_wrapup()
        branch = "spike/resume"
        with tempfile.TemporaryDirectory() as tmp:
            main, _ = self._merged_fixture(Path(tmp), branch)
            hub = FakeHub(wrapup.run, exists=False)
            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(branch), hub=hub)
            self.assertEqual(stopped.exception.step, "0c pr")
            self.assertEqual(hub.count("git", "push", "-u"), 1)

            hub.exists = True
            second = run_land(wrapup, main, land_args(branch), hub=hub)

            # The second run re-reads the remote tip instead of pushing again.
            self.assertEqual(hub.count("git", "push", "-u"), 1)
            self.assertTrue(any("push:" in entry for entry in second["skipped"]))
            self.assertTrue(second["merged"])

    def test_rerun_after_pr_create_reuses_the_pr(self):
        wrapup = load_wrapup()
        branch = "spike/resume"
        with tempfile.TemporaryDirectory() as tmp:
            main, _ = self._merged_fixture(Path(tmp), branch)
            body = Path(tmp) / "body.md"
            body.write_text("Part of #1\n\n**Retro:** n/a\n", encoding="utf-8")
            gate_calls = []

            def gate(pr):
                gate_calls.append(pr)
                if len(gate_calls) == 1:
                    raise wrapup.Stop("0c merge-gate", "red checks on the PR")
                return False

            hub = FakeHub(wrapup.run, exists=False)
            args = land_args(branch, body_file=str(body), title="Slice")
            with self.assertRaises(wrapup.Stop):
                run_land(wrapup, main, args, hub=hub, gate=gate)
            self.assertEqual(hub.count("gh", "pr", "create"), 1)

            second = run_land(wrapup, main, args, hub=hub, gate=gate)

        self.assertEqual(hub.count("gh", "pr", "create"), 1)
        self.assertTrue(second["pr_reused"])
        self.assertTrue(second["merged"])

    def test_rerun_after_merge_skips_the_merge(self):
        wrapup = load_wrapup()
        branch = "spike/resume"
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self._merged_fixture(Path(tmp), branch)
            hub = FakeHub(wrapup.run)

            def refuse_once(_wt):
                raise wrapup.Stop("2 process-kill", "a foreign process holds the port")

            with self.assertRaises(wrapup.Stop) as stopped:
                run_land(wrapup, main, land_args(branch), hub=hub, kill=refuse_once)
            self.assertEqual(stopped.exception.step, "2 process-kill")
            self.assertEqual(hub.count("gh", "pr", "merge"), 1)
            self.assertTrue(worktree.is_dir())

            second = run_land(wrapup, main, land_args(branch), hub=hub)

        self.assertEqual(hub.count("gh", "pr", "merge"), 1)
        self.assertIn("merge: the PR is already MERGED", second["skipped"])
        self.assertEqual(second["worktree_removed"], str(worktree))

    def test_rerun_after_teardown_skips_the_worktree_and_the_branch(self):
        wrapup = load_wrapup()
        branch = "spike/resume"
        with tempfile.TemporaryDirectory() as tmp:
            main, worktree = self._merged_fixture(Path(tmp), branch)
            hub = FakeHub(wrapup.run)
            first = run_land(wrapup, main, land_args(branch), hub=hub)
            second = run_land(wrapup, main, land_args(branch), hub=hub)

        self.assertEqual(first["worktree_removed"], str(worktree))
        self.assertIn("teardown: the worktree is already removed", second["skipped"])
        self.assertEqual(second["branch_retired"], "already absent")
        self.assertTrue(second["merged"])


class ModuleContract(unittest.TestCase):
    """The provenance half is gone from the executable surface, counted."""

    VOCABULARY = (
        "receipt", "proof-ref", "proofRef", "patch-index", "patchIndex",
        "landing-attempt", "landingAttempt", "landing_attempt",
        "artifact-baseline", "artifactBaseline", "artifact_baseline",
        "provenance", "scratchPatterns", "scratch_patterns",
        "landingGeneratedArtifactPatterns", "landing_generated_artifact",
        "abandon-unfinished-attempt", "recover-canonical-cleanup",
    )

    # The profile loader owns the one documented default branch name; every
    # other executable file has to resolve it through the profile.
    BRANCH_NAME_OWNER = LIFECYCLE / "profile.py"

    def sources(self):
        return [WRAPUP, *sorted(LIFECYCLE.glob("*.py"))]

    def test_no_removed_machinery_vocabulary_survives(self):
        for source in self.sources():
            body = source.read_text(encoding="utf-8")
            for term in self.VOCABULARY:
                self.assertNotIn(term, body, f"{source.name} still names {term}")

    def test_only_the_profile_loader_names_a_branch(self):
        for source in self.sources():
            body = source.read_text(encoding="utf-8")
            names_it = '"main"' in body or "'main'" in body
            self.assertEqual(
                names_it,
                source == self.BRANCH_NAME_OWNER,
                f"{source.name}: the integration branch name belongs in "
                f"{self.BRANCH_NAME_OWNER.name} alone",
            )

    def test_land_exposes_no_recovery_flag(self):
        wrapup = load_wrapup()
        for flag in ("--abandon-unfinished-attempt", "--recover-canonical-cleanup"):
            argv = ["wrapup-land.py", "land", "--branch", "spike/x", flag]
            with patch.object(sys, "argv", argv):
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as exited:
                        wrapup.main()
            self.assertEqual(exited.exception.code, 2, flag)


if __name__ == "__main__":
    unittest.main()
