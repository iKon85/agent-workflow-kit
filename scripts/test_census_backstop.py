import importlib.util
import json
import os
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

    def enable(self, root, overrides=None, local_scanners=None):
        census = root / ".census"
        census.mkdir(exist_ok=True)
        (census / "profile.json").write_text(json.dumps({
            "schemaVersion": 1,
            "enabled": True,
            "decisions": [],
            "localScanners": local_scanners or [],
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

    def test_override_requires_a_non_empty_text_reason(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.enable(root)
        self.activate_current(root)
        (root / "test").mkdir()
        (root / "test" / "proof.test.mjs").write_text("// evidence\n", encoding="utf-8")
        subprocess.run(["git", "add", "test"], cwd=root, check=True)
        baseline = DRIFT_GUARD.evaluate_census(root)
        self.assertTrue(baseline["mechanical_false_positive"])

        profile = root / ".census" / "profile.json"
        body = json.loads(profile.read_text(encoding="utf-8"))
        for invalid_reason in (True, "", "   "):
            with self.subTest(reason=invalid_reason):
                body["overrides"] = [{
                    "scope": "this change",
                    "reason": invalid_reason,
                    "topologyFingerprint": baseline["change_binding"],
                }]
                profile.write_text(json.dumps(body) + "\n", encoding="utf-8")
                result = DRIFT_GUARD.evaluate_census(root)
                self.assertFalse(result["override_applied"])
                self.assertTrue(result["block_handoff"])

    def test_profile_and_active_census_files_cannot_follow_foreign_symlinks(self):
        temporary, root = self.make_repo()
        foreign_tmp, foreign = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(foreign_tmp.cleanup)
        census = root / ".census"
        census.mkdir()
        foreign_marker = "FOREIGN-CENSUS-CONTENT-MUST-NOT-LEAK"
        foreign_profile = foreign / "profile.json"
        foreign_profile.write_text(json.dumps({
            "enabled": True,
            "overrides": [{"reason": foreign_marker, "scope": "this change"}],
        }), encoding="utf-8")
        (census / "profile.json").symlink_to(foreign_profile)
        (census / "active.json").write_text("{}\n", encoding="utf-8")

        profile_result = DRIFT_GUARD.evaluate_census(root)

        self.assertEqual((profile_result["state"], profile_result["block_handoff"]),
                         ("failed", False))
        self.assertEqual(profile_result["overrides"], [])
        self.assertNotIn(foreign_marker, json.dumps(profile_result))
        completed = subprocess.run(
            [sys.executable, str(HOOKS / "drift-guard.py"), "--census-status"],
            cwd=root,
            capture_output=True,
            check=True,
            text=True,
        )
        self.assertNotIn(foreign_marker, completed.stdout + completed.stderr)

        (census / "profile.json").unlink()
        self.enable(root)
        (census / "active.json").unlink()
        foreign_active = foreign / "active.json"
        foreign_active.write_text(f'{{"secret":"{foreign_marker}"}}\n', encoding="utf-8")
        (census / "active.json").symlink_to(foreign_active)

        active_result = DRIFT_GUARD.evaluate_census(root)

        self.assertEqual((active_result["state"], active_result["block_handoff"]),
                         ("failed", True))
        self.assertNotIn(foreign_marker, json.dumps(active_result))
        (census / "profile.json").unlink()
        missing_profile = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((missing_profile["state"], missing_profile["block_handoff"]),
                         ("failed", False))
        self.assertNotIn(foreign_marker, json.dumps(missing_profile))
        self.enable(root)
        (root / ".handoff").mkdir()
        payload = {
            "tool_name": "Write",
            "tool_input": {
                "file_path": str(root / ".handoff" / "52.md"),
                "content": "Build [#52](https://github.com/iKon85/agent-workflow-kit/issues/52)",
            },
        }
        with patch.object(DRIFT_GUARD, "run_check", return_value={"deny_recommended": False}):
            blocked, message = DRIFT_GUARD.should_block(payload)
        self.assertTrue(blocked)
        self.assertIn("failed", message)
        self.assertNotIn(foreign_marker, message)

    def test_disabled_census_control_failures_stay_visible_but_fail_open(self):
        temporary, root = self.make_repo()
        foreign_tmp, foreign = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(foreign_tmp.cleanup)
        self.enable(root)
        profile_path = root / ".census" / "profile.json"
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        profile["enabled"] = False
        profile_path.write_text(json.dumps(profile) + "\n", encoding="utf-8")
        active_path = root / ".census" / "active.json"

        active_path.write_text("{not-json\n", encoding="utf-8")
        corrupt = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((corrupt["state"], corrupt["block_handoff"]),
                         ("failed", False))
        self.assertEqual(corrupt["detail"], "census scan or active snapshot is invalid")

        active_path.unlink()
        foreign_active = foreign / "active.json"
        foreign_active.write_text('{"secret":"must-not-leak"}\n', encoding="utf-8")
        active_path.symlink_to(foreign_active)
        unreadable = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((unreadable["state"], unreadable["block_handoff"]),
                         ("failed", False))
        self.assertNotIn("must-not-leak", json.dumps(unreadable))

    def test_local_scanner_proof_is_required_for_current(self):
        temporary, root = self.make_repo()
        foreign_tmp, foreign = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.addCleanup(foreign_tmp.cleanup)
        module = root / "scanner.mjs"
        test = root / "scanner.test.mjs"
        module.write_text("export function scanLocal() { return ['src']; }\n", encoding="utf-8")
        test.write_text("import { test } from 'node:test'; test('proof', () => {});\n",
                        encoding="utf-8")
        subprocess.run(["git", "add", "scanner.mjs", "scanner.test.mjs"], cwd=root, check=True)
        scanner = {
            "surface": "src", "module": "scanner.mjs",
            "export": "scanLocal", "test": "scanner.test.mjs",
        }
        self.enable(root, local_scanners=[scanner])
        self.activate_current(root)
        self.assertEqual(DRIFT_GUARD.evaluate_census(root)["state"], "current")

        profile_path = root / ".census" / "profile.json"
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        foreign_module = foreign / "foreign.mjs"
        foreign_module.write_text("export function scanLocal() { return ['src']; }\n",
                                  encoding="utf-8")
        foreign_test = foreign / "foreign.test.mjs"
        foreign_test.write_text(
            "import { test } from 'node:test'; test('foreign', () => {});\n",
            encoding="utf-8",
        )
        invalid_records = [
            {**scanner, "module": "missing.mjs"},
            {**scanner, "module": "../escape.mjs"},
            {**scanner, "export": "missingExport"},
            {**scanner, "test": "missing.test.mjs"},
            {**scanner, "test": "../escape.test.mjs"},
        ]
        (root / "scanner-link.mjs").symlink_to(foreign_module)
        invalid_records.append({**scanner, "module": "scanner-link.mjs"})
        (root / "foreign-dir-link").symlink_to(foreign, target_is_directory=True)
        invalid_records.append({**scanner, "module": "foreign-dir-link/foreign.mjs"})
        (root / "scanner-link.test.mjs").symlink_to(foreign_test)
        invalid_records.append({**scanner, "test": "scanner-link.test.mjs"})
        module.write_text("export function scanLocal() { return ['another-surface']; }\n",
                          encoding="utf-8")
        invalid_records.append(scanner)

        for index, record in enumerate(invalid_records):
            with self.subTest(case=index, record=record):
                if index == len(invalid_records) - 1:
                    module.write_text(
                        "export function scanLocal() { return ['another-surface']; }\n",
                        encoding="utf-8",
                    )
                else:
                    module.write_text(
                        "export function scanLocal() { return ['src']; }\n", encoding="utf-8"
                    )
                profile["localScanners"] = [record]
                profile_path.write_text(json.dumps(profile) + "\n", encoding="utf-8")
                result = DRIFT_GUARD.evaluate_census(root)
                self.assertEqual((result["state"], result["block_handoff"]),
                                 ("refresh_required", True))
                self.assertIn("proof:src", result["reasons"])

        module.chmod(0)
        try:
            profile["localScanners"] = [scanner]
            profile_path.write_text(json.dumps(profile) + "\n", encoding="utf-8")
            unreadable = DRIFT_GUARD.evaluate_census(root)
            self.assertEqual((unreadable["state"], unreadable["block_handoff"]),
                             ("refresh_required", True))
            self.assertIn("proof:src", unreadable["reasons"])
        finally:
            module.chmod(0o644)

        module.write_text("export function scanLocal() { return ['src']; }\n", encoding="utf-8")
        test.write_text("import { test } from 'node:test'; test('proof', () => { throw new Error('no'); });\n",
                        encoding="utf-8")
        profile["localScanners"] = [scanner]
        profile_path.write_text(json.dumps(profile) + "\n", encoding="utf-8")
        failed_test = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((failed_test["state"], failed_test["block_handoff"]),
                         ("refresh_required", True))
        self.assertIn("proof:src", failed_test["reasons"])

    def test_activated_census_blocks_when_local_proof_times_out(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        module = root / "scanner.mjs"
        test = root / "scanner.test.mjs"
        module.write_text("export function scanLocal() { return ['src']; }\n", encoding="utf-8")
        test.write_text(
            "import { test } from 'node:test'; "
            "test('hang', async () => new Promise(resolve => setTimeout(resolve, 250)));\n",
            encoding="utf-8",
        )
        subprocess.run(["git", "add", "scanner.mjs", "scanner.test.mjs"], cwd=root, check=True)
        scanner = {
            "surface": "src", "module": "scanner.mjs",
            "export": "scanLocal", "test": "scanner.test.mjs",
        }
        self.enable(root, local_scanners=[scanner])
        self.activate_current(root)

        result = DRIFT_GUARD.evaluate_census(root, proof_timeout_ms=25)

        self.assertEqual((result["state"], result["block_handoff"]),
                         ("refresh_required", True))
        self.assertIn("proof:src", result["reasons"])

        test.write_text("import { test } from 'node:test'; test('proof', () => {});\n",
                        encoding="utf-8")
        module.write_text(
            "export async function scanLocal() { return new Promise(() => {}); }\n",
            encoding="utf-8",
        )
        scanner_timeout = DRIFT_GUARD.evaluate_census(root, proof_timeout_ms=25)
        self.assertEqual((scanner_timeout["state"], scanner_timeout["block_handoff"]),
                         ("refresh_required", True))
        self.assertIn("proof:src", scanner_timeout["reasons"])

    def test_activated_census_fails_closed_when_bridge_is_unavailable(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.enable(root)
        self.activate_current(root)

        with patch.object(DRIFT_GUARD, "scan_census_status",
                          side_effect=subprocess.TimeoutExpired("node", 1)):
            activated = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((activated["state"], activated["block_handoff"]),
                         ("offline", True))

        (root / ".census" / "active.json").unlink()
        with patch.object(DRIFT_GUARD, "scan_census_status",
                          side_effect=subprocess.TimeoutExpired("node", 1)):
            bootstrap = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((bootstrap["state"], bootstrap["block_handoff"]),
                         ("offline", False))

        self.activate_current(root)
        profile_path = root / ".census" / "profile.json"
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        profile["enabled"] = False
        profile_path.write_text(json.dumps(profile) + "\n", encoding="utf-8")
        with patch.object(DRIFT_GUARD, "scan_census_status",
                          side_effect=subprocess.TimeoutExpired("node", 1)):
            disabled = DRIFT_GUARD.evaluate_census(root)
        self.assertEqual((disabled["state"], disabled["block_handoff"]),
                         ("offline", False))

    def test_active_local_scanner_history_is_authoritative(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        module = root / "scanner.mjs"
        test = root / "scanner.test.mjs"
        module.write_text("export function scanLocal() { return ['src']; }\n", encoding="utf-8")
        test.write_text("import { test } from 'node:test'; test('proof', () => {});\n",
                        encoding="utf-8")
        subprocess.run(["git", "add", "scanner.mjs", "scanner.test.mjs"], cwd=root, check=True)
        scanner = {
            "surface": "src", "module": "scanner.mjs",
            "export": "scanLocal", "test": "scanner.test.mjs",
        }
        self.enable(root, local_scanners=[scanner])
        self.activate_current(root)
        profile_path = root / ".census" / "profile.json"
        active_path = root / ".census" / "active.json"

        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        for replacement in (None, "corrupt", [], [{**scanner, "export": "other"}]):
            with self.subTest(current=replacement):
                changed = dict(profile)
                if replacement is None:
                    changed.pop("localScanners")
                else:
                    changed["localScanners"] = replacement
                profile_path.write_text(json.dumps(changed) + "\n", encoding="utf-8")
                result = DRIFT_GUARD.evaluate_census(root)
                self.assertEqual((result["state"], result["block_handoff"]),
                                 ("refresh_required", True))
                self.assertTrue(any(reason.startswith("proof:") for reason in result["reasons"]))

        profile_path.write_text(json.dumps(profile) + "\n", encoding="utf-8")
        for replacement in (None, "corrupt", [], [{**scanner, "test": "other.test.mjs"}]):
            with self.subTest(active=replacement):
                active = json.loads(active_path.read_text(encoding="utf-8"))
                report = active.setdefault("profileReport", {})
                if replacement is None:
                    report.pop("localScanners", None)
                else:
                    report["localScanners"] = replacement
                active_path.write_text(json.dumps(active) + "\n", encoding="utf-8")
                result = DRIFT_GUARD.evaluate_census(root)
                self.assertEqual((result["state"], result["block_handoff"]),
                                 ("refresh_required", True))
                self.assertTrue(any(reason.startswith("proof:") for reason in result["reasons"]))
                self.activate_current(root)

    def test_local_scanner_export_requires_an_array_of_exact_surface_strings(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        module = root / "scanner.mjs"
        test = root / "scanner.test.mjs"
        test.write_text("import { test } from 'node:test'; test('proof', () => {});\n",
                        encoding="utf-8")
        scanner = {
            "surface": "src", "module": "scanner.mjs",
            "export": "scanLocal", "test": "scanner.test.mjs",
        }
        self.enable(root, local_scanners=[scanner])
        invalid_results = (
            "'src'",
            "({ includes: () => true })",
            "['src', 42]",
            "['SRC']",
        )
        for expression in invalid_results:
            with self.subTest(expression=expression):
                module.write_text(
                    f"export function scanLocal() {{ return {expression}; }}\n", encoding="utf-8"
                )
                subprocess.run(["git", "add", "scanner.mjs", "scanner.test.mjs"],
                               cwd=root, check=True)
                self.activate_current(root)
                result = DRIFT_GUARD.evaluate_census(root)
                self.assertEqual((result["state"], result["block_handoff"]),
                                 ("refresh_required", True))
                self.assertIn("proof:src", result["reasons"])

        module.write_text("export function scanLocal() { return ['src']; }\n", encoding="utf-8")
        subprocess.run(["git", "add", "scanner.mjs"], cwd=root, check=True)
        self.activate_current(root)
        self.assertEqual(DRIFT_GUARD.evaluate_census(root)["state"], "current")

    def test_justified_change_local_override_bypasses_only_evidence_topology_noise(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.enable(root)
        self.activate_current(root)
        (root / "test").mkdir()
        (root / "test" / "new-proof.test.mjs").write_text(
            "// evidence only\n", encoding="utf-8"
        )
        subprocess.run(["git", "add", "test"], cwd=root, check=True)

        unbound = DRIFT_GUARD.evaluate_census(root)
        self.assertTrue(unbound["mechanical_false_positive"])
        self.assertFalse(unbound["override_applied"])
        profile = root / ".census" / "profile.json"
        body = json.loads(profile.read_text(encoding="utf-8"))
        body["overrides"] = [{
            "scope": "this change",
            "reason": "test-only evidence file",
            "topologyFingerprint": unbound["change_binding"],
        }]
        profile.write_text(json.dumps(body) + "\n", encoding="utf-8")

        result = DRIFT_GUARD.evaluate_census(root)

        self.assertEqual(result["state"], "refresh_required")
        self.assertEqual(result["reasons"], ["topology"])
        self.assertTrue(result["override_applied"])
        self.assertFalse(result["block_handoff"])

        (root / "test" / "later-proof.test.mjs").write_text(
            "// later evidence\n", encoding="utf-8"
        )
        subprocess.run(["git", "add", "test"], cwd=root, check=True)
        stale = DRIFT_GUARD.evaluate_census(root)
        self.assertNotEqual(stale["change_binding"], result["change_binding"])
        self.assertFalse(stale["override_applied"])
        self.assertTrue(stale["block_handoff"])

    def test_handoff_payload_uses_target_repo_when_cwd_is_elsewhere(self):
        target_tmp, target = self.make_repo()
        cwd_tmp, cwd_repo = self.make_repo()
        self.addCleanup(target_tmp.cleanup)
        self.addCleanup(cwd_tmp.cleanup)
        self.enable(target)
        self.activate_current(target)
        (target / "test").mkdir()
        (target / "test" / "proof.test.mjs").write_text("// evidence\n", encoding="utf-8")
        subprocess.run(["git", "add", "test"], cwd=target, check=True)
        (target / ".handoff").mkdir()
        payload = {
            "tool_name": "Write",
            "tool_input": {
                "file_path": str(target / ".handoff" / "52.md"),
                "content": "Build [#52](https://github.com/iKon85/agent-workflow-kit/issues/52)",
            },
        }

        previous = Path.cwd()
        try:
            os.chdir(cwd_repo / "src")
            with patch.object(DRIFT_GUARD, "run_check", return_value={"deny_recommended": False}):
                blocked, message = DRIFT_GUARD.should_block(payload)
        finally:
            os.chdir(previous)

        self.assertTrue(blocked)
        self.assertIn("CENSUS", message)

    def test_handoff_payload_rejects_symlink_escape_from_claimed_repo(self):
        target_tmp, target = self.make_repo()
        foreign_tmp, foreign = self.make_repo()
        self.addCleanup(target_tmp.cleanup)
        self.addCleanup(foreign_tmp.cleanup)
        self.enable(foreign)
        (foreign / "handoffs").mkdir()
        (target / ".handoff").symlink_to(foreign / "handoffs", target_is_directory=True)
        payload = {
            "tool_name": "Write",
            "tool_input": {
                "file_path": str(target / ".handoff" / "52.md"),
                "content": "Build [#52](https://github.com/iKon85/agent-workflow-kit/issues/52)",
            },
        }

        with patch.object(DRIFT_GUARD, "run_check", return_value={"deny_recommended": False}):
            blocked, message = DRIFT_GUARD.should_block(payload)

        self.assertTrue(blocked)
        self.assertIn("target repository", message)

    def test_cli_root_resolution_finds_git_root_from_subdirectory(self):
        temporary, root = self.make_repo()
        self.addCleanup(temporary.cleanup)
        self.enable(root)

        completed = subprocess.run(
            [sys.executable, str(HOOKS / "drift-guard.py"), "--census-status"],
            cwd=root / "src",
            capture_output=True,
            check=True,
            text=True,
        )
        status = json.loads(completed.stdout)

        self.assertEqual(status["state"], "bootstrap")

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
            self.assertIn("topologyFingerprint", prose)
        for prose in (source_update, mirror_update):
            self.assertIn("--census-status", prose)
            self.assertRegex(prose, r"newer census builder[\s\S]*census-update")
            self.assertRegex(prose, r"never overwrite[\s\S]*consumer-owned census")


if __name__ == "__main__":
    unittest.main()
