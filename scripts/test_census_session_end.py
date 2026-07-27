#!/usr/bin/env python3
"""wrapup gives the census freshness verdict a session-end home (#321).

Three contracts, one step:

  * the verdict is read for the checkout the NEXT session starts from — the
    main checkout — so a worktree-green census can never mask a stale main
    (lineage of the closed #278);
  * only `refresh_required` speaks; `current` and `no_census` leave no trace,
    exactly as everywhere else in the kit;
  * the optional tracking issue is identified by its marker, so a second
    session updates the issue the first one opened instead of minting a
    duplicate.

That the finding never gates the landing is proved where the landing lives —
`test_worktree_wrapup_contract.py::CensusFindingNeverGates`.
"""

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
WRAPUP = REPO / "scripts/wrapup-land.py"
HOOK_RELATIVE = Path(".claude/hooks/drift-guard.py")
# The hook's own local imports travel with it — a consumer installs the whole
# hooks directory, and the copied fixture has to be runnable the same way.
HOOK_SUPPORT = ("_hook_utils.py",)
CENSUS_RELATIVE = Path("scripts/census")
# The engine the hook resolves from its own location — copied with it, because a
# consumer installs both halves or neither.
CENSUS_MODULES = (
    "delta.mjs", "fingerprint.mjs", "index.mjs", "scan.mjs",
    "state.mjs", "transaction.mjs",
)
# The kit never names an integration branch inline; the fixture deliberately
# calls its own something other than the platform default.
BASE_BRANCH = "trunk"
GIT_IDENTITY = [
    "-c", "user.name=census-session-end",
    "-c", "user.email=census@example.invalid",
    "-c", "commit.gpgsign=false",
]

sys.path.insert(0, str((REPO / HOOK_RELATIVE).parent))
_DRIFT_SPEC = importlib.util.spec_from_file_location(
    "drift_guard_for_census_session_end", REPO / HOOK_RELATIVE)
DRIFT_GUARD = importlib.util.module_from_spec(_DRIFT_SPEC)
_DRIFT_SPEC.loader.exec_module(DRIFT_GUARD)


def load_wrapup():
    spec = importlib.util.spec_from_file_location("wrapup_land_census_step", WRAPUP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(cwd, *args) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", *GIT_IDENTITY, *args], cwd=cwd, capture_output=True, text=True
    )
    if result.returncode != 0:
        raise AssertionError(
            f"git {' '.join(str(arg) for arg in args)} failed: "
            f"{(result.stderr or result.stdout).strip()}"
        )
    return result


def completed(cmd, stdout="", returncode=0, stderr=""):
    return subprocess.CompletedProcess(list(cmd), returncode, stdout, stderr)


class CensusEvaluatedCheckout(unittest.TestCase):
    """A census describes the tree it was scanned in — name which one (#278)."""

    def setUp(self):
        self.wrapup = load_wrapup()
        self.root = Path(tempfile.mkdtemp(prefix="awk-census-session-end-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def make_checkout(self) -> Path:
        """A consumer checkout with an enabled, not-yet-activated census."""
        checkout = self.root / "main"
        (checkout / "src").mkdir(parents=True)
        (checkout / "package.json").write_text(
            '{"name":"consumer"}\n', encoding="utf-8")
        (checkout / "src" / "index.mjs").write_text(
            "export const ready = true;\n", encoding="utf-8")
        (checkout / HOOK_RELATIVE).parent.mkdir(parents=True)
        shutil.copy2(REPO / HOOK_RELATIVE, checkout / HOOK_RELATIVE)
        for name in HOOK_SUPPORT:
            shutil.copy2((REPO / HOOK_RELATIVE).parent / name,
                         (checkout / HOOK_RELATIVE).parent / name)
        (checkout / CENSUS_RELATIVE).mkdir(parents=True)
        for name in CENSUS_MODULES:
            shutil.copy2(REPO / CENSUS_RELATIVE / name, checkout / CENSUS_RELATIVE / name)
        (checkout / ".census").mkdir()
        (checkout / ".census" / "profile.json").write_text(json.dumps({
            "schemaVersion": 1,
            "enabled": True,
            "decisions": [],
            "localScanners": [],
            "overrides": [],
        }) + "\n", encoding="utf-8")
        git(self.root, "init", "-b", BASE_BRANCH, str(checkout))
        git(checkout, "add", ".")
        git(checkout, "commit", "-m", "seed")
        return checkout

    def activate(self, checkout: Path) -> None:
        """Commit the active snapshot the way an activated census carries it."""
        fresh = DRIFT_GUARD.scan_census_status(checkout)["fresh"]
        (checkout / ".census" / "active.json").write_text(
            json.dumps(fresh) + "\n", encoding="utf-8")
        git(checkout, "add", ".census/active.json")
        git(checkout, "commit", "-m", "activate census")

    def drift(self, checkout: Path) -> None:
        """A new production surface the active snapshot no longer describes."""
        (checkout / "src" / "added.mjs").write_text(
            "export const added = true;\n", encoding="utf-8")
        git(checkout, "add", "src/added.mjs")
        git(checkout, "commit", "-m", "add a surface")

    def refresh(self, checkout: Path) -> None:
        """Land the refresh on THIS working tree's branch — and nowhere else."""
        fresh = DRIFT_GUARD.scan_census_status(checkout)["fresh"]
        (checkout / ".census" / "active.json").write_text(
            json.dumps(fresh) + "\n", encoding="utf-8")
        git(checkout, "add", ".census/active.json")
        git(checkout, "commit", "-m", "refresh census")

    def test_a_green_worktree_census_never_masks_a_stale_main_checkout(self):
        main = self.make_checkout()
        self.activate(main)
        self.drift(main)
        worktree = self.root / "slice"
        git(main, "worktree", "add", str(worktree), "-b", "slice")
        self.refresh(worktree)

        # Positive control on the same apparatus: the worktree that carries the
        # refresh DOES report green. Without it "stale" could merely mean this
        # harness never returns `current` at all.
        self.assertEqual(self.wrapup.census_status(str(worktree))["state"], "current")
        self.assertEqual(self.wrapup.census_status(str(main))["state"], "refresh_required")

        report = {"warnings": []}
        self.wrapup.census_step(str(main), {}, report)

        finding = report["census"]
        self.assertEqual(finding["state"], "refresh_required")
        self.assertEqual(finding["evaluated_checkout"], str(main))
        self.assertFalse(finding["blocking"])
        self.assertIn("topology", finding["reasons"])
        text = finding["finding"]
        self.assertIn("evaluated checkout", text)
        self.assertIn(str(main), text)
        self.assertNotIn(str(worktree), text)
        self.assertIn("$census-update", text)
        self.assertIn("dedicated pull request", text)
        self.assertIn("never mirror", text)

    def test_a_current_census_leaves_no_trace(self):
        main = self.make_checkout()
        self.activate(main)
        self.assertEqual(self.wrapup.census_status(str(main))["state"], "current")

        report = {"warnings": []}
        self.wrapup.census_step(str(main), {}, report)

        self.assertNotIn("census", report)
        self.assertEqual(report["warnings"], [])

    def test_a_checkout_without_a_census_leaves_no_trace(self):
        main = self.make_checkout()
        (main / ".census" / "profile.json").unlink()
        self.assertEqual(self.wrapup.census_status(str(main))["state"], "no_census")

        report = {"warnings": []}
        self.wrapup.census_step(str(main), {}, report)

        self.assertNotIn("census", report)
        self.assertEqual(report["warnings"], [])

    def test_a_checkout_without_the_kit_hook_leaves_no_trace(self):
        main = self.make_checkout()
        (main / HOOK_RELATIVE).unlink()

        report = {"warnings": []}
        self.wrapup.census_step(str(main), {}, report)

        self.assertNotIn("census", report)
        self.assertEqual(report["warnings"], [])

    def test_an_unreadable_verdict_warns_instead_of_speaking_or_raising(self):
        main = self.make_checkout()
        (main / HOOK_RELATIVE).write_text(
            "import sys\nsys.exit(3)\n", encoding="utf-8")

        report = {"warnings": []}
        self.wrapup.census_step(str(main), {}, report)

        self.assertNotIn("census", report)
        self.assertEqual(len(report["warnings"]), 1)
        self.assertIn(str(main), report["warnings"][0])


class CensusTracking(unittest.TestCase):
    """Opt-in, marker-identified, and never duplicated."""

    def setUp(self):
        self.wrapup = load_wrapup()
        self.marker = (
            f"<!-- {self.wrapup.CENSUS_TRACKING_KIND}: "
            f"{self.wrapup.CENSUS_TRACKING_SLUG} -->"
        )

    @staticmethod
    def stale() -> dict:
        return {"state": "refresh_required", "reasons": ["topology"],
                "override_applied": False}

    @staticmethod
    def body_of(cmd) -> str:
        return Path(cmd[cmd.index("--body-file") + 1]).read_text(encoding="utf-8")

    @staticmethod
    def is_board_create(cmd) -> bool:
        return any(str(part).endswith("board-sync.py") for part in cmd)

    def test_tracking_stays_off_until_the_consumer_opts_in(self):
        report = {"warnings": []}
        with patch.object(self.wrapup, "census_status", return_value=self.stale()), \
             patch.object(self.wrapup, "run",
                          side_effect=AssertionError("tracking must make no call")):
            self.wrapup.census_step("/main", {}, report)

        self.assertEqual(report["census"]["state"], "refresh_required")
        self.assertNotIn("tracking", report["census"])

    def test_the_second_session_updates_the_tracking_issue_instead_of_duplicating(self):
        open_issues: list[dict] = []
        calls: list[list] = []

        def runner(cmd, cwd=None, check=False, env=None):
            calls.append(list(cmd))
            if list(cmd[:3]) == ["gh", "issue", "list"]:
                return completed(cmd, json.dumps(open_issues))
            if list(cmd[:3]) == ["gh", "issue", "edit"]:
                number = int(cmd[3])
                for issue in open_issues:
                    if issue["number"] == number:
                        issue["body"] = self.body_of(cmd)
                return completed(cmd)
            if self.is_board_create(cmd):
                open_issues.append({"number": 77, "body": self.body_of(cmd)})
                return completed(cmd, "#77 https://example.invalid/issues/77\n")
            raise AssertionError(f"unexpected command: {cmd}")

        profile = {"wrapup": {"censusTrackingIssue": True}}
        first, second = {"warnings": []}, {"warnings": []}
        with patch.object(self.wrapup, "census_status", return_value=self.stale()), \
             patch.object(self.wrapup, "run", side_effect=runner):
            self.wrapup.census_step("/main", profile, first)
            self.wrapup.census_step("/main", profile, second)

        self.assertEqual(
            first["census"]["tracking"],
            {"action": "created", "issue": 77, "ok": True, "error": None},
        )
        self.assertEqual(
            second["census"]["tracking"],
            {"action": "updated", "issue": 77, "ok": True, "error": None},
        )
        self.assertEqual(len(open_issues), 1)
        self.assertEqual(len([call for call in calls if self.is_board_create(call)]), 1)
        # Closed issues are history: a resolved refresh must not wedge the next.
        lookup = next(call for call in calls if call[:3] == ["gh", "issue", "list"])
        self.assertEqual(lookup[lookup.index("--state") + 1], "open")
        self.assertIn(self.marker, open_issues[0]["body"])

    def test_several_open_tracking_issues_stop_the_write_and_name_them(self):
        open_issues = [{"number": 11, "body": self.marker},
                       {"number": 12, "body": self.marker}]

        def runner(cmd, cwd=None, check=False, env=None):
            if list(cmd[:3]) == ["gh", "issue", "list"]:
                return completed(cmd, json.dumps(open_issues))
            raise AssertionError(f"ambiguous identity must write nothing: {cmd}")

        report = {"warnings": []}
        with patch.object(self.wrapup, "census_status", return_value=self.stale()), \
             patch.object(self.wrapup, "run", side_effect=runner):
            self.wrapup.census_step(
                "/main", {"wrapup": {"censusTrackingIssue": True}}, report)

        tracking = report["census"]["tracking"]
        self.assertEqual(tracking["action"], "none")
        self.assertFalse(tracking["ok"])
        self.assertIn("#11", tracking["error"])
        self.assertIn("#12", tracking["error"])

    def test_an_unreadable_issue_list_reports_the_error_and_writes_nothing(self):
        def runner(cmd, cwd=None, check=False, env=None):
            if list(cmd[:3]) == ["gh", "issue", "list"]:
                return completed(cmd, "", returncode=1, stderr="gh: not authenticated")
            raise AssertionError(f"a failed lookup must write nothing: {cmd}")

        report = {"warnings": []}
        with patch.object(self.wrapup, "census_status", return_value=self.stale()), \
             patch.object(self.wrapup, "run", side_effect=runner):
            self.wrapup.census_step(
                "/main", {"wrapup": {"censusTrackingIssue": True}}, report)

        tracking = report["census"]["tracking"]
        self.assertEqual(tracking["action"], "none")
        self.assertFalse(tracking["ok"])
        self.assertIn("not authenticated", tracking["error"])
        # The finding itself survives an unreachable platform.
        self.assertEqual(report["census"]["state"], "refresh_required")


if __name__ == "__main__":
    unittest.main()
