#!/usr/bin/env python3
"""One repository-relative glob dialect backs every consumer-profile glob."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DIALECT_MODULE = REPO / "scripts/profile_globs.py"
ADVISORIES_CORE = REPO / "scripts/workflow-advisories/core.py"
LIFECYCLE_CORE = REPO / "scripts/worktree-lifecycle/core.py"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_lifecycle_core():
    module_dir = str(LIFECYCLE_CORE.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    return load("profile_globs_lifecycle_core", LIFECYCLE_CORE)


dialect = load("profile_globs_under_test", DIALECT_MODULE)


class MatcherContract(unittest.TestCase):
    """The documented dialect, exercised on the axes the contract names."""

    def test_star_stays_inside_one_segment(self):
        self.assertTrue(dialect.path_glob_matches("build.log", "*.log"))
        self.assertFalse(dialect.path_glob_matches("logs/build.log", "*.log"))
        self.assertTrue(dialect.path_glob_matches("logs/build.log", "logs/*.log"))
        self.assertFalse(dialect.path_glob_matches("logs/a/build.log", "logs/*.log"))

    def test_question_mark_matches_one_character_inside_one_segment(self):
        self.assertTrue(dialect.path_glob_matches("a1.tmp", "a?.tmp"))
        self.assertFalse(dialect.path_glob_matches("a/1.tmp", "a?1.tmp"))

    def test_character_classes_stay_per_segment(self):
        self.assertTrue(dialect.path_glob_matches("cache/7.tmp", "cache/[0-9].tmp"))
        self.assertFalse(dialect.path_glob_matches("cache/x.tmp", "cache/[0-9].tmp"))
        self.assertTrue(dialect.path_glob_matches("cache/x.tmp", "cache/[!0-9].tmp"))

    def test_leading_globstar_covers_the_repository_root_and_nested_paths(self):
        self.assertTrue(dialect.path_glob_matches("__pycache__/a.pyc", "**/__pycache__/**"))
        self.assertTrue(dialect.path_glob_matches("src/__pycache__/a.pyc", "**/__pycache__/**"))
        self.assertTrue(dialect.path_glob_matches("notes.md", "**/notes.md"))
        self.assertTrue(dialect.path_glob_matches("a/b/notes.md", "**/notes.md"))

    def test_directory_roots_match_every_depth_below_them(self):
        self.assertTrue(dialect.path_glob_matches("dist-kit/a", "dist-kit/**"))
        self.assertTrue(dialect.path_glob_matches("dist-kit/a/b", "dist-kit/**"))
        self.assertTrue(dialect.path_glob_matches("dist-kit", "dist-kit/**"))
        self.assertFalse(dialect.path_glob_matches("dist-kit/a/b", "dist-kit/*"))
        self.assertFalse(dialect.path_glob_matches("dist-kitten/a", "dist-kit/**"))

    def test_matching_is_case_sensitive_on_every_host(self):
        self.assertTrue(dialect.path_glob_matches("PLAN.md", "PLAN.md"))
        self.assertFalse(dialect.path_glob_matches("plan.md", "PLAN.md"))
        self.assertFalse(dialect.path_glob_matches("Logs/a.log", "logs/*.log"))

    def test_whole_path_must_match(self):
        self.assertFalse(dialect.path_glob_matches("src/index.mjs", "src"))
        self.assertFalse(dialect.path_glob_matches("src", "src/index.mjs"))


class SharedMatcherContract(unittest.TestCase):
    """The one shipped matcher lives in the dialect module, never in a copy."""

    def test_the_shared_matcher_comes_from_the_shipped_dialect_module(self):
        advisories = load("profile_globs_advisories_core", ADVISORIES_CORE)
        shared = advisories.load_profile_globs()
        self.assertEqual(Path(shared.__file__).resolve(), DIALECT_MODULE.resolve())
        self.assertIs(advisories.path_glob_matches, shared.path_glob_matches)

    def test_neither_core_keeps_a_second_matcher(self):
        for core in (ADVISORIES_CORE, LIFECYCLE_CORE):
            body = core.read_text(encoding="utf-8")
            self.assertNotIn("fnmatch.fnmatch(", body)
            self.assertNotIn("def path_glob_matches", body)

    def test_the_lifecycle_core_matches_no_glob_at_all(self):
        """Deletion policy has one surface, the ignore mechanism — so the
        Worktree Lifecycle core reads no consumer glob to decide anything."""
        lifecycle = load_lifecycle_core()
        self.assertFalse(hasattr(lifecycle, "path_glob_matches"))
        self.assertNotIn("glob", LIFECYCLE_CORE.read_text(encoding="utf-8"))


class AdvisorySurfaceContract(unittest.TestCase):
    """Advisory globs select the same paths the lifecycle globs would."""

    def decision_for(self, globs, changed):
        core = load("profile_globs_advisories_surface", ADVISORIES_CORE)
        profile = {
            "stopChecks": {
                "surfaces": [{"globs": globs, "command": ["python3", "-c", "pass"]}],
                "timeoutSeconds": 3,
                "outputBudget": 300,
            },
        }
        with tempfile.TemporaryDirectory() as root:
            return core.stop_check_decision(
                profile, {"changed_files": changed}, Path(root),
            )

    def test_single_segment_glob_no_longer_crosses_a_directory(self):
        self.assertIsNone(self.decision_for(["*.py"], ["pkg/mod.py"]).context)
        self.assertIsNotNone(self.decision_for(["*.py"], ["mod.py"]).context)

    def test_globstar_covers_root_and_nested_paths(self):
        self.assertIsNotNone(self.decision_for(["**/*.py"], ["pkg/mod.py"]).context)
        self.assertIsNotNone(self.decision_for(["**/*.py"], ["mod.py"]).context)

    def test_directory_root_glob_covers_every_depth(self):
        self.assertIsNotNone(self.decision_for(["src/**"], ["src/a/b.mjs"]).context)
        self.assertIsNone(self.decision_for(["src/*"], ["src/a/b.mjs"]).context)

    def test_advisory_matching_is_case_sensitive(self):
        self.assertIsNone(self.decision_for(["src/**"], ["SRC/a.mjs"]).context)


class MigrationClassifier(unittest.TestCase):
    """Legacy patterns whose match set changes are named, never rewritten."""

    def test_literal_pattern_is_stable(self):
        self.assertEqual(dialect.classify_pattern("PLAN.md").effects, ())

    def test_single_segment_wildcard_narrows(self):
        migration = dialect.classify_pattern("*.log")
        self.assertIn(dialect.NARROWS, migration.effects)
        self.assertIn("/", migration.witnesses[dialect.NARROWS])

    def test_nested_wildcard_without_globstar_narrows(self):
        self.assertIn(
            dialect.NARROWS, dialect.classify_pattern("dist-kit/*").effects,
        )

    def test_leading_globstar_widens_at_the_repository_root(self):
        migration = dialect.classify_pattern("**/__pycache__/**")
        self.assertIn(dialect.WIDENS, migration.effects)
        self.assertEqual(migration.witnesses[dialect.WIDENS], "__pycache__")

    def test_directory_root_globstar_widens_onto_the_directory_itself(self):
        migration = dialect.classify_pattern("dist-kit/**")
        self.assertIn(dialect.WIDENS, migration.effects)
        self.assertEqual(migration.witnesses[dialect.WIDENS], "dist-kit")

    def test_bare_globstar_is_stable(self):
        self.assertEqual(dialect.classify_pattern("**").effects, ())

    def test_character_class_pattern_is_stable(self):
        self.assertEqual(dialect.classify_pattern("cache/[0-9].tmp").effects, ())

    def test_case_effect_only_applies_to_the_case_normalizing_legacy(self):
        insensitive = dialect.classify_pattern("PLAN.md", case_insensitive_legacy=True)
        self.assertIn(dialect.CASE_NARROWS, insensitive.effects)
        self.assertEqual(dialect.classify_pattern("PLAN.md").effects, ())


class ProfileScan(unittest.TestCase):
    """Every shipped consumer-profile glob key is reachable from one scan."""

    document = {
        "worktreeLifecycle": {"scratchPatterns": ["PLAN.md", "*.log"]},
        "wrapup": {"landingGeneratedArtifactPatterns": ["dist-kit/**"]},
        "workflowAdvisories": {
            "baseline": {"sourceGlobs": ["src/**"]},
            "preRefactor": {"surfaces": [{"globs": ["frontend/*"]}]},
            "stopChecks": {"surfaces": [{"globs": ["backend/**"]}]},
        },
    }

    def locations(self):
        return [finding.location for finding in dialect.scan_profile(self.document)]

    def test_scan_reaches_every_shipped_glob_key(self):
        self.assertEqual(self.locations(), [
            "workflowAdvisories.baseline.sourceGlobs[0]",
            "workflowAdvisories.preRefactor.surfaces[0].globs[0]",
            "workflowAdvisories.stopChecks.surfaces[0].globs[0]",
        ])

    def test_removed_lifecycle_pattern_keys_are_not_scanned(self):
        """Deletion policy has one surface, the ignore mechanism (ADR-0009 §6),
        so a profile still carrying the removed keys is inert here too."""
        body = DIALECT_MODULE.read_text(encoding="utf-8")
        for key in ("scratchPatterns", "landingGeneratedArtifactPatterns"):
            self.assertNotIn(key, body)
        self.assertEqual(dialect.scan_profile({
            "worktreeLifecycle": {"scratchPatterns": ["*.log"]},
            "wrapup": {"landingGeneratedArtifactPatterns": ["dist-kit/**"]},
        }), ())

    def test_no_remaining_glob_claims_deletion_authority(self):
        for finding in dialect.scan_profile(self.document):
            self.assertFalse(hasattr(finding, "deletion_authority"))

    def test_advisory_globs_carry_the_case_normalizing_legacy(self):
        legacy = {
            finding.location: finding.migration.effects
            for finding in dialect.scan_profile(self.document)
        }
        self.assertIn(
            dialect.CASE_NARROWS,
            legacy["workflowAdvisories.baseline.sourceGlobs[0]"],
        )

    def test_malformed_sections_are_skipped_without_raising(self):
        self.assertEqual(dialect.scan_profile({"workflowAdvisories": []}), ())
        self.assertEqual(dialect.scan_profile("not a profile"), ())


class MigrationReport(unittest.TestCase):
    """The review command reports; it never edits the consumer profile."""

    def run_check(self, document, *args):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "workflow-capabilities.json"
            body = json.dumps(document, indent=2) + "\n"
            path.write_text(body, encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(DIALECT_MODULE), str(path), *args],
                capture_output=True, text=True,
            )
            self.assertEqual(path.read_text(encoding="utf-8"), body)
            return result

    def test_stable_profile_exits_zero(self):
        # Every remaining key carries the case-normalizing advisory legacy, so
        # a stable literal is one no host can fold: caseless and wildcard-free.
        result = self.run_check({
            "workflowAdvisories": {"baseline": {"sourceGlobs": ["123/456"]}},
        })
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_changed_pattern_exits_one_and_names_its_witness(self):
        result = self.run_check({
            "workflowAdvisories": {"baseline": {"sourceGlobs": ["**/__pycache__/**"]}},
        })
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("workflowAdvisories.baseline.sourceGlobs[0]", result.stdout)
        self.assertIn(dialect.WIDENS, result.stdout)
        self.assertIn("__pycache__", result.stdout)

    def test_json_output_is_machine_readable(self):
        result = self.run_check(
            {"workflowAdvisories": {"baseline": {"sourceGlobs": ["dist-kit/*"]}}},
            "--json",
        )
        report = json.loads(result.stdout)
        self.assertEqual(report["reviewed"], 1)
        self.assertEqual(report["changed"], 1)
        self.assertIn(dialect.NARROWS, report["findings"][0]["effects"])
        self.assertNotIn("deletionAuthority", report["findings"][0])

    def test_unreadable_profile_exits_two(self):
        result = subprocess.run(
            [sys.executable, str(DIALECT_MODULE), "does/not/exist.json"],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotEqual(result.stderr.strip(), "")


if __name__ == "__main__":
    unittest.main()
