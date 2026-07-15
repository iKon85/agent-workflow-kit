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


class CensusBackstopTest(unittest.TestCase):
    def make_repo(self):
        temporary = tempfile.TemporaryDirectory(prefix="awk-census-backstop-")
        root = Path(temporary.name)
        (root / "src").mkdir()
        (root / "package.json").write_text('{"name":"consumer"}\n', encoding="utf-8")
        (root / "src" / "index.mjs").write_text("export const ready = true;\n", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet"], cwd=root, check=True)
        subprocess.run(["git", "add", "."], cwd=root, check=True)
        return temporary, root

    def enable(self, root, overrides=None):
        census = root / ".census"
        census.mkdir(exist_ok=True)
        (census / "profile.json").write_text(json.dumps({
            "schemaVersion": 1,
            "enabled": True,
            "decisions": [],
            "localScanners": [],
            "overrides": overrides or [],
        }) + "\n", encoding="utf-8")

    def activate_current(self, root):
        fresh = DRIFT_GUARD.scan_census_status(root)["fresh"]
        (root / ".census" / "active.json").write_text(
            json.dumps(fresh) + "\n", encoding="utf-8"
        )

    def test_missing_disabled_bootstrap_and_offline_are_visible_but_fail_open(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)

        missing = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((missing["state"], missing["block_handoff"]), ("no_census", False))

        self.enable(root)
        profile = root / ".census" / "profile.json"
        body = json.loads(profile.read_text(encoding="utf-8"))
        body["enabled"] = False
        profile.write_text(json.dumps(body) + "\n", encoding="utf-8")
        disabled = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((disabled["state"], disabled["block_handoff"]), ("disabled", False))

        body["enabled"] = True
        profile.write_text(json.dumps(body) + "\n", encoding="utf-8")
        bootstrap = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((bootstrap["state"], bootstrap["block_handoff"]), ("bootstrap", False))

        with patch.object(DRIFT_GUARD, "scan_census_status", side_effect=OSError("node offline")):
            offline = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((offline["state"], offline["block_handoff"]), ("offline", False))
        self.assertIn("node offline", offline["detail"])

    def test_known_growth_unknown_topology_and_newer_builder_require_refresh(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.enable(root)
        self.activate_current(root)
        self.assertEqual(DRIFT_GUARD.evaluate_census(root)["state"], "current")

        (root / "packages" / "api" / "src").mkdir(parents=True)
        (root / "packages" / "api" / "src" / "index.mjs").write_text(
            "export const api = true;\n", encoding="utf-8"
        )
        subprocess.run(["git", "add", "packages"], cwd=root, check=True)
        growth = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((growth["state"], growth["block_handoff"]), ("refresh_required", True))
        self.assertIn("topology", growth["reasons"])

        self.activate_current(root)
        (root / "services" / "payments" / "src").mkdir(parents=True)
        (root / "services" / "payments" / "src" / "index.mjs").write_text(
            "export const payments = true;\n", encoding="utf-8"
        )
        unknown = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((unknown["state"], unknown["block_handoff"]), ("refresh_required", True))
        self.assertIn("open", unknown["reasons"])

        (root / "services").rename(root / "evidence-only")
        active_path = root / ".census" / "active.json"
        active = json.loads(active_path.read_text(encoding="utf-8"))
        active["fingerprints"]["builder"] = "older-builder"
        active_path.write_text(json.dumps(active) + "\n", encoding="utf-8")
        newer = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((newer["state"], newer["block_handoff"]), ("refresh_required", True))
        self.assertIn("builder", newer["reasons"])

    def test_change_local_override_never_greens_real_drift(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.enable(root, overrides=[{"scope": "this change", "reason": "generated path alias"}])
        self.activate_current(root)
        (root / "apps" / "web" / "src").mkdir(parents=True)
        (root / "apps" / "web" / "src" / "index.mjs").write_text(
            "export const web = true;\n", encoding="utf-8"
        )
        subprocess.run(["git", "add", "apps"], cwd=root, check=True)

        result = DRIFT_GUARD.evaluate_census(root)

        self.assertEqual((result["state"], result["block_handoff"]), ("refresh_required", True))
        self.assertEqual(result["overrides"], [
            {"scope": "this change", "reason": "generated path alias"}
        ])

    def test_justified_change_local_override_bypasses_only_evidence_topology_noise(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.enable(root, overrides=[{"scope": "this change", "reason": "test-only evidence file"}])
        self.activate_current(root)
        (root / "test").mkdir()
        (root / "test" / "new-proof.test.mjs").write_text(
            "// evidence only\n", encoding="utf-8"
        )
        subprocess.run(["git", "add", "test"], cwd=root, check=True)

        result = DRIFT_GUARD.evaluate_census(root)

        self.assertEqual(result["state"], "refresh_required")
        self.assertEqual(result["reasons"], ["topology"])
        self.assertTrue(result["override_applied"])
        self.assertFalse(result["block_handoff"])

    def test_activated_refresh_blocks_build_handoff_but_not_normal_work(self):
        payload = {
            "tool_name": "Write",
            "tool_input": {
                "file_path": "/tmp/repo/.handoff/52.md",
                "content": "Build [#52](https://github.com/iKon85/agent-workflow-kit/issues/52)",
            },
        }
        refresh = {
            "state": "refresh_required",
            "block_handoff": True,
            "reasons": ["topology"],
            "overrides": [],
        }
        with patch.object(DRIFT_GUARD, "run_check", return_value={"deny_recommended": False}), \
             patch.object(DRIFT_GUARD, "evaluate_census", return_value=refresh):
            blocked, message = DRIFT_GUARD.should_block(payload)
        self.assertTrue(blocked)
        self.assertIn("CENSUS", message)

        normal_payload = {"tool_name": "Write", "tool_input": {"file_path": "/tmp/repo/notes.md"}}
        with patch.object(DRIFT_GUARD, "evaluate_census") as census:
            self.assertEqual(DRIFT_GUARD.should_block(normal_payload), (False, ""))
        census.assert_not_called()

    def test_cross_cutting_prd_and_kit_update_prose_use_the_same_backstop_contract(self):
        source_prd = (ROOT / ".claude/skills/to-prd/SKILL.md").read_text(encoding="utf-8")
        mirror_prd = (ROOT / ".agents/skills/to-prd/SKILL.md").read_text(encoding="utf-8")
        source_update = (ROOT / ".claude/skills/kit-update/SKILL.md").read_text(encoding="utf-8")
        mirror_update = (ROOT / ".agents/skills/kit-update/SKILL.md").read_text(encoding="utf-8")

        for prose in (source_prd, mirror_prd):
            self.assertIn("--census-status", prose)
            self.assertRegex(prose, r"cross-cutting[\s\S]*refresh_required[\s\S]*must not be locked")
            self.assertRegex(prose, r"disabled[\s\S]*no_census[\s\S]*manual walk")
            self.assertRegex(prose, r"change-local\s+override[\s\S]*mechanical\s+false positive")
        for prose in (source_update, mirror_update):
            self.assertIn("--census-status", prose)
            self.assertRegex(prose, r"newer census builder[\s\S]*census-update")
            self.assertRegex(prose, r"never overwrite[\s\S]*consumer-owned census")


if __name__ == "__main__":
    unittest.main()
