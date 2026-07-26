#!/usr/bin/env python3
"""Diagnostics contract for the handoff drift guard.

Three independent gaps, one guard:

  * the issue anchor may only come from the handoff repository's OWN issues —
    a link to a foreign repository's issue must never become the anchor;
  * a census block must name the checkout it evaluated, and say so explicitly
    when the session sits in a different worktree of the same repository;
  * `--census-status` must report WHAT drifted, bounded, not only that the
    topology fingerprint moved.
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
HOOKS = ROOT / ".claude" / "hooks"
sys.path.insert(0, str(HOOKS))
SPEC = importlib.util.spec_from_file_location("drift_guard", HOOKS / "drift-guard.py")
DRIFT_GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIFT_GUARD)

GIT_IDENTITY = [
    "-c", "user.name=drift-guard-test",
    "-c", "user.email=drift-guard@example.invalid",
    "-c", "commit.gpgsign=false",
]


class DriftGuardDiagnosticsTest(unittest.TestCase):
    def make_repo(self, remote=None):
        temporary = tempfile.TemporaryDirectory(prefix="awk-drift-guard-")
        root = Path(temporary.name)
        self.addCleanup(temporary.cleanup)
        (root / "src").mkdir()
        (root / "package.json").write_text('{"name":"consumer"}\n', encoding="utf-8")
        (root / "src" / "index.mjs").write_text("export const ready = true;\n", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        if remote:
            subprocess.run(["git", "remote", "add", "origin", remote], cwd=root, check=True)
        return root

    def enable(self, root):
        census = root / ".census"
        census.mkdir(exist_ok=True)
        (census / "profile.json").write_text(json.dumps({
            "schemaVersion": 1,
            "enabled": True,
            "decisions": [],
            "localScanners": [],
            "overrides": [],
        }) + "\n", encoding="utf-8")

    def activate_current(self, root):
        fresh = DRIFT_GUARD.scan_census_status(root)["fresh"]
        (root / ".census" / "active.json").write_text(
            json.dumps(fresh) + "\n", encoding="utf-8"
        )

    def write_payload(self, root, name, content):
        handoff = root / ".handoff"
        handoff.mkdir(exist_ok=True)
        return {
            "tool_name": "Write",
            "tool_input": {"file_path": str(handoff / name), "content": content},
        }

    def census_status(self, root, *extra):
        completed = subprocess.run(
            [sys.executable, str(HOOKS / "drift-guard.py"), "--census-status", *extra],
            cwd=root, capture_output=True, check=True, text=True,
        )
        return json.loads(completed.stdout)

    # --- anchor extraction ------------------------------------------------

    def test_foreign_repository_issue_link_never_becomes_the_anchor(self):
        root = self.make_repo(remote="git@github.com:acme/consumer.git")
        content = (
            "Refresh landed as chore PR "
            "[#2281](https://github.com/acme/consumer/pull/2281).\n"
            "Reported upstream: "
            "[kit#276](https://github.com/iKon85/agent-workflow-kit/issues/276)\n"
        )

        issue = DRIFT_GUARD.extract_issue(
            self.write_payload(root, "2026-07-26-2279.md", content), content, root
        )

        self.assertEqual(issue, 2279)

    def test_own_repository_content_anchor_still_wins_over_the_filename(self):
        for remote in (
            "git@github.com:acme/consumer.git",
            "https://github.com/acme/consumer.git",
            "ssh://git@github.com/acme/consumer",
        ):
            with self.subTest(remote=remote):
                root = self.make_repo(remote=remote)
                content = (
                    "Anchor [#2280](https://github.com/acme/consumer/issues/2280) — "
                    "upstream [#276](https://github.com/iKon85/agent-workflow-kit/issues/276)\n"
                )

                issue = DRIFT_GUARD.extract_issue(
                    self.write_payload(root, "2026-07-26-2279.md", content), content, root
                )

                self.assertEqual(issue, 2280)

    def test_without_a_parsable_remote_the_filename_anchor_is_preferred(self):
        root = self.make_repo()
        content = "Upstream [#276](https://github.com/iKon85/agent-workflow-kit/issues/276)\n"

        issue = DRIFT_GUARD.extract_issue(
            self.write_payload(root, "2026-07-26-2279.md", content), content, root
        )

        self.assertEqual(issue, 2279)

    def test_without_remote_and_without_filename_anchor_the_content_anchor_remains(self):
        root = self.make_repo()
        content = "Anchor [#276](https://github.com/iKon85/agent-workflow-kit/issues/276)\n"

        issue = DRIFT_GUARD.extract_issue(
            self.write_payload(root, "session-notes.md", content), content, root
        )

        self.assertEqual(issue, 276)

    def test_a_foreign_only_handoff_without_a_filename_anchor_fails_open(self):
        root = self.make_repo(remote="git@github.com:acme/consumer.git")
        content = "Upstream [#276](https://github.com/iKon85/agent-workflow-kit/issues/276)\n"
        payload = self.write_payload(root, "session-notes.md", content)

        self.assertIsNone(DRIFT_GUARD.extract_issue(payload, content, root))
        with patch.object(DRIFT_GUARD, "run_check") as check:
            self.assertEqual(DRIFT_GUARD.should_block(payload), (False, ""))
        check.assert_not_called()

    def test_block_message_names_the_own_anchor_not_the_foreign_issue(self):
        root = self.make_repo(remote="git@github.com:acme/consumer.git")
        content = (
            "Refresh landed as chore PR "
            "[#2281](https://github.com/acme/consumer/pull/2281).\n"
            "Reported upstream: "
            "[kit#276](https://github.com/iKon85/agent-workflow-kit/issues/276)\n"
        )
        payload = self.write_payload(root, "2026-07-26-2279.md", content)
        checked = []

        def check(issue, intent):
            checked.append(issue)
            return {"deny_recommended": True, "violations": [f"#{issue}: plan_revision missing"]}

        with patch.object(DRIFT_GUARD, "run_check", side_effect=check):
            blocked, message = DRIFT_GUARD.should_block(payload)

        self.assertEqual(checked, [2279])
        self.assertTrue(blocked)
        self.assertIn("#2279", message)
        self.assertNotIn("276", message)

    # --- evaluated checkout -----------------------------------------------

    def test_census_block_message_names_the_evaluated_checkout(self):
        root = self.make_repo()
        result = {"state": "refresh_required", "reasons": ["topology"], "overrides": []}

        message = DRIFT_GUARD.build_census_block_message(2279, result, root, root)

        self.assertIn(str(root), message)
        self.assertIn("evaluated checkout", message)
        self.assertIn("worktree", message)
        self.assertIn("$census-update", message)

    def test_a_sibling_worktree_working_directory_is_named_explicitly(self):
        root = self.make_repo()
        subprocess.run(["git", *GIT_IDENTITY, "commit", "--quiet", "-m", "init"],
                       cwd=root, check=True)
        sibling = root / "sibling-worktree"
        subprocess.run(["git", "worktree", "add", "--quiet", str(sibling), "-b", "slice"],
                       cwd=root, check=True)
        result = {"state": "refresh_required", "reasons": ["topology"], "overrides": []}

        from_sibling = DRIFT_GUARD.build_census_block_message(2279, result, root, sibling)
        from_root = DRIFT_GUARD.build_census_block_message(2279, result, root, root)
        from_elsewhere = DRIFT_GUARD.build_census_block_message(
            2279, result, root, self.make_repo()
        )

        self.assertIn(str(sibling), from_sibling)
        self.assertIn("different worktree", from_sibling)
        self.assertNotIn("different worktree", from_root)
        self.assertNotIn("different worktree", from_elsewhere)

    def test_a_blocked_build_handoff_reports_the_checkout_it_evaluated(self):
        root = self.make_repo()
        payload = self.write_payload(
            root, "2279.md", "Build [#2279](https://github.com/acme/consumer/issues/2279)\n"
        )
        refresh = {
            "state": "refresh_required", "block_handoff": True,
            "reasons": ["topology"], "overrides": [],
        }

        with patch.object(DRIFT_GUARD, "run_check", return_value={"deny_recommended": False}), \
             patch.object(DRIFT_GUARD, "evaluate_census", return_value=refresh):
            blocked, message = DRIFT_GUARD.should_block(payload)

        self.assertTrue(blocked)
        self.assertIn("evaluated checkout", message)
        self.assertIn(str(root), message)

    # --- drift delta -------------------------------------------------------

    def test_census_status_reports_what_drifted(self):
        root = self.make_repo()
        self.enable(root)
        self.activate_current(root)
        (root / "src" / "added.mjs").write_text("export const added = true;\n", encoding="utf-8")
        (root / "test").mkdir()
        (root / "test" / "proof.test.mjs").write_text("// evidence\n", encoding="utf-8")
        (root / "src" / "index.mjs").write_text("export const ready = false;\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=root, check=True)

        status = self.census_status(root)

        self.assertEqual(status["state"], "refresh_required")
        self.assertIn("topology", status["reasons"])
        delta = status["delta"]
        self.assertIn("src/added.mjs", delta["denominator"]["added"])
        self.assertIn("src/index.mjs", delta["denominator"]["changed"])
        self.assertEqual(delta["denominator"]["removed"], [])
        self.assertIn("test/proof.test.mjs", delta["evidence"]["added"])
        self.assertEqual(delta["families"]["added"], [])

    def test_a_new_surface_and_a_removed_file_are_named_in_the_delta(self):
        root = self.make_repo()
        self.enable(root)
        self.activate_current(root)
        (root / "packages" / "api" / "src").mkdir(parents=True)
        (root / "packages" / "api" / "src" / "index.mjs").write_text(
            "export const api = true;\n", encoding="utf-8"
        )
        (root / "src" / "index.mjs").unlink()
        subprocess.run(["git", "add", "--all"], cwd=root, check=True)

        status = self.census_status(root)
        delta = status["delta"]

        self.assertIn("packages/api/src/index.mjs", delta["denominator"]["added"])
        self.assertIn("src/index.mjs", delta["denominator"]["removed"])
        self.assertIn("surface:packages/api", delta["families"]["added"])
        self.assertIn("surface:src", delta["families"]["removed"])

    def test_a_large_delta_stays_bounded_and_verbose_reports_everything(self):
        root = self.make_repo()
        self.enable(root)
        self.activate_current(root)
        grown = DRIFT_GUARD.CENSUS_DELTA_LIMIT + 7
        for index in range(grown):
            (root / "src" / f"grown-{index:03d}.mjs").write_text(
                f"export const grown{index} = true;\n", encoding="utf-8"
            )
        subprocess.run(["git", "add", "."], cwd=root, check=True)

        capped = self.census_status(root)["delta"]["denominator"]["added"]
        verbose = self.census_status(root, "--verbose")["delta"]["denominator"]["added"]

        self.assertEqual(len(capped), DRIFT_GUARD.CENSUS_DELTA_LIMIT + 1)
        self.assertEqual(capped[-1], "…and 7 more")
        self.assertEqual(len(verbose), grown)
        self.assertIn("src/grown-000.mjs", verbose)

    def test_a_census_without_an_active_snapshot_reports_no_delta(self):
        root = self.make_repo()
        self.enable(root)

        status = self.census_status(root)

        self.assertEqual(status["state"], "bootstrap")
        self.assertIsNone(status.get("delta"))


if __name__ == "__main__":
    unittest.main()
