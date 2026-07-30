#!/usr/bin/env python3
"""Truth table for stateless teardown classification (ADR-0009, #330).

Every case runs against a real `git init` repository in a temp directory —
the porcelain v2 records under test are produced by git itself, never mocked,
because a mis-parsed record (the rename record's second path above all) is the
failure this table exists to catch.

Run: python3 scripts/test_classify.py
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
MODULE = REPO / "scripts/worktree-lifecycle/classify.py"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


classify = load("worktree_lifecycle_classify", MODULE)


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def rules(assessment):
    return [block.rule for block in assessment.blocks]


def block_of(assessment, rule):
    for block in assessment.blocks:
        if block.rule == rule:
            return block
    raise AssertionError(f"no {rule} block in {rules(assessment)}")


class Fixture(unittest.TestCase):
    """A worktree repository plus a main checkout to compare `.env*` against."""

    def setUp(self):
        # The kit's own git config must not leak a global excludes file into
        # the fixtures — the ignore semantics under test are the repository's.
        patcher = mock.patch.dict(
            os.environ,
            {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull},
        )
        patcher.start()
        self.addCleanup(patcher.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.worktree = self.root / "worktree"
        self.main = self.root / "checkout"
        self.worktree.mkdir()
        self.main.mkdir()

    def seed(self, ignore=""):
        (self.worktree / ".gitignore").write_text(ignore, encoding="utf-8")
        (self.worktree / "tracked.txt").write_text("one\n", encoding="utf-8")
        git(self.worktree, "init", "-q", ".")
        git(self.worktree, "config", "user.email", "kit@example.test")
        git(self.worktree, "config", "user.name", "kit")
        git(self.worktree, "add", "-A")
        git(self.worktree, "commit", "-qm", "seed")

    def write(self, relative, body="body\n", where=None):
        path = (where or self.worktree) / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        return path

    def assess(self, *declared):
        """Assess the worktree, optionally with the consumer's declared seed paths."""
        return classify.assess(self.worktree, self.main, declared)


class PorcelainTruthTable(Fixture):
    """One row per porcelain v2 record type: 1, 2, u, ?, !."""

    def test_unmodified_tree_is_removable(self):
        self.seed()
        assessment = self.assess()
        self.assertTrue(assessment.removable)
        self.assertEqual(assessment.blocks, ())
        self.assertEqual(assessment.scratch, ())

    def test_tracked_modification_blocks(self):
        self.seed()
        self.write("tracked.txt", "two\n")
        assessment = self.assess()
        self.assertEqual(rules(assessment), [classify.RULE_TRACKED])
        block = block_of(assessment, classify.RULE_TRACKED)
        self.assertEqual(block.items, ("tracked.txt",))
        self.assertIn("commit", block.fix)

    def test_staged_addition_blocks(self):
        self.seed()
        self.write("added.txt")
        git(self.worktree, "add", "added.txt")
        assessment = self.assess()
        self.assertEqual(block_of(assessment, classify.RULE_TRACKED).items, ("added.txt",))

    def test_rename_record_reports_both_paths(self):
        self.seed(ignore="*.log\n")
        self.write("keep me.txt")
        git(self.worktree, "add", "keep me.txt")
        git(self.worktree, "commit", "-qm", "add")
        git(self.worktree, "mv", "keep me.txt", "moved me.txt")
        self.write("build.log")
        assessment = self.assess()
        block = block_of(assessment, classify.RULE_TRACKED)
        self.assertEqual(sorted(block.items), ["keep me.txt", "moved me.txt"])
        self.assertEqual(block.item_count, 2)
        # The record after the rename must still be classified — a mis-split
        # would swallow the ignored entry into the rename's path pair.
        self.assertEqual([entry.path for entry in assessment.scratch], ["build.log"])

    def test_unmerged_path_blocks(self):
        self.seed()
        git(self.worktree, "checkout", "-q", "-b", "side")
        self.write("tracked.txt", "side\n")
        git(self.worktree, "commit", "-qam", "side")
        git(self.worktree, "checkout", "-q", "-")
        self.write("tracked.txt", "home\n")
        git(self.worktree, "commit", "-qam", "home")
        subprocess.run(["git", "merge", "side"], cwd=self.worktree, capture_output=True)
        assessment = self.assess()
        self.assertEqual(rules(assessment), [classify.RULE_UNMERGED])
        self.assertEqual(block_of(assessment, classify.RULE_UNMERGED).items, ("tracked.txt",))

    def test_untracked_file_blocks_and_ignored_file_is_scratch(self):
        self.seed(ignore="*.log\n")
        self.write("notes/todo.md")
        self.write("build.log")
        assessment = self.assess()
        self.assertEqual(rules(assessment), [classify.RULE_UNTRACKED])
        self.assertEqual([entry.path for entry in assessment.scratch], ["build.log"])
        self.assertIn("1 untracked file", block_of(assessment, classify.RULE_UNTRACKED).summary)

    def test_hostile_path_characters_survive_parsing(self):
        self.seed(ignore="*.log\n")
        names = ["ünïcode .txt", 'quo"te.txt', "line\nbreak.txt"]
        for name in names:
            self.write(name)
        self.write('we ird".log')
        assessment = self.assess()
        block = block_of(assessment, classify.RULE_UNTRACKED)
        self.assertIn("3 untracked files", block.summary)
        self.assertEqual([entry.path for entry in assessment.scratch], ['we ird".log'])

    def test_non_utf8_paths_stay_printable_and_deletable(self):
        self.seed(ignore="*.log\n")
        for raw in (b"bad\xff.log", b"bad\xff.txt"):
            with open(os.path.join(os.fsencode(self.worktree), raw), "wb") as handle:
                handle.write(b"x\n")
        blocked = self.assess()
        report = classify.render_report(blocked)
        report.encode("utf-8")  # a refusal that cannot be printed names nothing
        self.assertIn("1 untracked file", report)
        os.unlink(os.path.join(os.fsencode(self.worktree), b"bad\xff.txt"))
        clear = self.assess()
        self.assertTrue(clear.removable)
        classify.render_report(clear).encode("utf-8")
        self.assertEqual(len(classify.remove_scratch(clear)), 1)
        self.assertFalse(os.path.lexists(os.path.join(os.fsencode(self.worktree), b"bad\xff.log")))

    def test_ignored_directory_is_one_bounded_scratch_entry(self):
        self.seed(ignore="node_modules/\n")
        for index in range(20):
            self.write(f"node_modules/pkg{index}/index.js")
        assessment = self.assess()
        self.assertTrue(assessment.removable)
        self.assertEqual(
            [(entry.path, entry.kind) for entry in assessment.scratch],
            [("node_modules", "directory")],
        )
        self.assertEqual(classify.remove_scratch(assessment), ("node_modules",))
        self.assertFalse((self.worktree / "node_modules").exists())


class EnvMatrix(Fixture):
    """`.env*` is the one carve-out inside "ignored" — here its undeclared arm."""

    def seed_env(self, worktree_body, main_body=None, ignore=".env*\n"):
        self.seed(ignore=ignore)
        self.write(".env", worktree_body)
        if main_body is not None:
            self.write(".env", main_body, where=self.main)

    def test_identical_copy_is_deletable(self):
        self.seed_env("SECRET=1\n", "SECRET=1\n")
        assessment = self.assess()
        self.assertTrue(assessment.removable)
        self.assertEqual([entry.path for entry in assessment.scratch], [".env"])
        classify.remove_scratch(assessment)
        self.assertFalse((self.worktree / ".env").exists())
        self.assertTrue((self.main / ".env").exists())

    def test_divergent_copy_blocks_and_names_the_file(self):
        self.seed_env("SECRET=1\n", "SECRET=2\n")
        block = block_of(self.assess(), classify.RULE_ENV)
        self.assertEqual(len(block.items), 1)
        self.assertTrue(block.items[0].startswith(".env"))
        self.assertIn(".env", block.fix)

    def test_same_size_different_bytes_blocks(self):
        self.seed_env("SECRET=1\n", "SECRET=9\n")
        self.assertIn(classify.RULE_ENV, rules(self.assess()))

    def test_absent_in_main_checkout_blocks(self):
        self.seed_env("SECRET=1\n")
        self.assertIn(classify.RULE_ENV, rules(self.assess()))

    def test_symlink_on_either_side_blocks(self):
        self.seed_env("SECRET=1\n", "SECRET=1\n")
        (self.worktree / ".env").unlink()
        (self.worktree / ".env").symlink_to(self.worktree / "tracked.txt")
        self.assertIn(classify.RULE_ENV, rules(self.assess()))
        (self.worktree / ".env").unlink()
        self.write(".env", "SECRET=1\n")
        (self.main / ".env").unlink()
        (self.main / ".env").symlink_to(self.main)
        self.assertIn(classify.RULE_ENV, rules(self.assess()))

    def test_directory_named_env_blocks(self):
        self.seed(ignore=".env*\n")
        (self.worktree / ".env").mkdir()
        self.assertIn(classify.RULE_ENV, rules(self.assess()))

    def test_basename_glob_matches_env_local_and_spares_other_names(self):
        self.seed(ignore=".env*\nnotes.env\n")
        self.write(".env.local", "A=1\n")
        self.write(".env.local", "A=2\n", where=self.main)
        self.write("notes.env", "not a dotenv\n")
        assessment = self.assess()
        block = block_of(assessment, classify.RULE_ENV)
        self.assertEqual(len(block.items), 1)
        self.assertTrue(block.items[0].startswith(".env.local"))
        self.assertEqual([entry.path for entry in assessment.scratch], ["notes.env"])

    def test_nested_env_below_an_ignored_directory_is_compared(self):
        self.seed(ignore="cache/\n")
        self.write("cache/.env", "SECRET=1\n")
        self.write("cache/x.bin")
        blocked = self.assess()
        self.assertIn(classify.RULE_ENV, rules(blocked))
        self.assertIn("cache/.env", block_of(blocked, classify.RULE_ENV).items[0])
        self.write("cache/.env", "SECRET=1\n", where=self.main)
        cleared = self.assess()
        self.assertTrue(cleared.removable)
        self.assertEqual([entry.path for entry in cleared.scratch], ["cache"])


class DeclaredEnv(Fixture):
    """The second `.env*` arm: the consumer's own declaration grants deletion.

    A seed-declared path is what the consumer says a fresh worktree carries, so
    the declaration is the same kind of authority `.gitignore` already carries.
    It waives the main-checkout comparison for exactly the declared file — never
    a sibling, a prefix, a glob, or anything that is not a regular file — and
    every waived deletion is named in the report.
    """

    def seed_env(self, worktree_body, main_body=None, ignore=".env*\n"):
        self.seed(ignore=ignore)
        self.write(".env", worktree_body)
        if main_body is not None:
            self.write(".env", main_body, where=self.main)

    def test_declared_divergent_env_is_deletable_and_named_in_the_report(self):
        self.seed_env("PORT=3101\n", "PORT=3000\n")
        assessment = self.assess(".env")
        self.assertTrue(assessment.removable)
        self.assertEqual([entry.path for entry in assessment.scratch], [".env"])
        self.assertEqual(assessment.declared_deletions, (".env",))
        report = classify.render_report(assessment)
        self.assertIn("declaration", report)
        self.assertIn(".env", report)
        self.assertEqual(classify.remove_scratch(assessment), (".env",))
        self.assertFalse((self.worktree / ".env").exists())
        self.assertEqual((self.main / ".env").read_text(encoding="utf-8"), "PORT=3000\n")

    def test_declared_env_absent_from_the_main_checkout_is_deletable(self):
        self.seed_env("PORT=3101\n")
        assessment = self.assess(".env")
        self.assertTrue(assessment.removable)
        self.assertEqual(assessment.declared_deletions, (".env",))

    def test_an_undeclared_divergent_env_still_blocks_and_names_it(self):
        self.seed_env("PORT=3101\n", "PORT=3000\n")
        assessment = self.assess("config/local.json")
        block = block_of(assessment, classify.RULE_ENV)
        self.assertEqual(len(block.items), 1)
        self.assertTrue(block.items[0].startswith(".env"))
        self.assertEqual(assessment.declared_deletions, ())

    def test_a_declaration_is_neither_a_prefix_nor_a_glob(self):
        self.seed(ignore=".env*\n")
        self.write(".env.local", "PORT=3101\n")
        for declaration in (".env", ".env*", ".env.local.bak", "."):
            assessment = self.assess(declaration)
            self.assertIn(
                classify.RULE_ENV, rules(assessment), f"{declaration} widened consent"
            )
            self.assertEqual(assessment.declared_deletions, ())
        self.assertTrue(self.assess(".env.local").removable)

    def test_a_declared_path_that_is_not_a_regular_file_still_blocks(self):
        self.seed(ignore=".env*\n")
        (self.worktree / ".env").mkdir()
        self.assertIn(classify.RULE_ENV, rules(self.assess(".env")))
        (self.worktree / ".env").rmdir()
        (self.worktree / ".env").symlink_to(self.worktree / "tracked.txt")
        self.assertIn(classify.RULE_ENV, rules(self.assess(".env")))
        self.assertTrue((self.worktree / ".env").is_symlink())

    def test_a_declaration_cannot_make_unignored_work_deletable(self):
        self.seed(ignore="")
        self.write(".env", "PORT=3101\n")
        assessment = self.assess(".env")
        self.assertEqual(rules(assessment), [classify.RULE_UNTRACKED])
        self.assertEqual(assessment.declared_deletions, ())
        self.assertEqual(assessment.scratch, ())

    def test_a_declared_env_below_an_ignored_directory_is_waived_and_named(self):
        self.seed(ignore="cache/\n")
        self.write("cache/.env", "PORT=3101\n")
        self.write("cache/x.bin")
        self.assertIn(classify.RULE_ENV, rules(self.assess()))
        assessment = self.assess("cache/.env")
        self.assertTrue(assessment.removable)
        self.assertEqual([entry.path for entry in assessment.scratch], ["cache"])
        self.assertEqual(assessment.declared_deletions, ("cache/.env",))
        self.assertIn("cache/.env", classify.render_report(assessment))
        classify.remove_scratch(assessment)
        self.assertFalse((self.worktree / "cache").exists())

    def test_the_declared_list_in_the_report_stays_bounded(self):
        self.seed(ignore=".env*\n")
        declared = [f".env.slot{index}" for index in range(9)]
        for name in declared:
            self.write(name, "PORT=3101\n")
        assessment = self.assess(*declared)
        self.assertTrue(assessment.removable)
        self.assertEqual(len(assessment.declared_deletions), 9)
        report = classify.render_report(assessment)
        self.assertIn("4 more", report)
        self.assertLess(len(report), 1000)


class SymlinkContainment(Fixture):
    """An ignored symlink is deletable only when its target stays inside."""

    def seed_link(self, target, ignore="link\n"):
        self.seed(ignore=ignore)
        os.symlink(target, self.worktree / "link")

    def test_contained_target_is_deletable_and_the_target_survives(self):
        self.seed_link("tracked.txt")
        assessment = self.assess()
        self.assertTrue(assessment.removable)
        self.assertEqual(assessment.scratch[0].kind, "symlink")
        self.assertEqual(assessment.scratch[0].link_target, "tracked.txt")
        classify.remove_scratch(assessment)
        self.assertFalse((self.worktree / "link").is_symlink())
        self.assertTrue((self.worktree / "tracked.txt").exists())

    def test_absolute_target_blocks(self):
        self.seed_link(str(self.main))
        self.assertIn(classify.RULE_SYMLINK, rules(self.assess()))

    def test_escaping_target_blocks(self):
        self.seed_link("../checkout")
        block = block_of(self.assess(), classify.RULE_SYMLINK)
        self.assertTrue(block.items[0].startswith("link"))

    def test_dangling_target_blocks(self):
        self.seed_link("gone.txt")
        self.assertIn(classify.RULE_SYMLINK, rules(self.assess()))

    def test_target_changed_between_assessment_and_action_stops(self):
        self.seed_link("tracked.txt")
        assessment = self.assess()
        (self.worktree / "link").unlink()
        os.symlink(".gitignore", self.worktree / "link")
        with self.assertRaises(classify.ClassificationError):
            classify.remove_scratch(assessment)
        self.assertTrue((self.worktree / "link").is_symlink())

    def test_symlink_farm_below_an_ignored_directory_needs_no_configuration(self):
        self.seed(ignore="node_modules/\n")
        self.write("node_modules/.pnpm/pkg/index.js")
        farm = self.worktree / "node_modules" / ".bin"
        farm.mkdir(parents=True)
        os.symlink("../.pnpm/pkg/index.js", farm / "tool")
        os.symlink("../.pnpm/missing/index.js", farm / "dangling")
        os.symlink(str(self.main), farm / "outside")
        assessment = self.assess()
        self.assertTrue(assessment.removable)
        classify.remove_scratch(assessment)
        self.assertFalse((self.worktree / "node_modules").exists())
        self.assertTrue(self.main.is_dir())


class BoundedReport(Fixture):
    """#319 replaced: the report is capped, the count stays exact."""

    def test_thousands_of_untracked_files_render_bounded(self):
        self.seed()
        for directory in range(8):
            for index in range(375):
                self.write(f"generated/d{directory}/file{index}.txt", "x\n")
        assessment = self.assess()
        block = block_of(assessment, classify.RULE_UNTRACKED)
        self.assertIn("3000 untracked files", block.summary)
        self.assertEqual(len(block.items), classify.TOP_DIRECTORY_LIMIT)
        self.assertEqual(block.item_count, 8)
        report = classify.render_report(assessment)
        self.assertLess(len(report), 2000)
        self.assertIn("3000 untracked files", report)
        self.assertIn("3 more", report)

    def test_named_items_are_capped_without_changing_the_verdict(self):
        self.seed()
        for index in range(40):
            self.write(f"tracked{index}.txt")
        git(self.worktree, "add", "-A")
        assessment = self.assess()
        block = block_of(assessment, classify.RULE_TRACKED)
        self.assertEqual(len(block.items), classify.EXAMPLE_LIMIT)
        self.assertEqual(block.item_count, 40)
        self.assertFalse(assessment.removable)
        self.assertLess(len(classify.render_report(assessment)), 2000)


class PreviewEqualsAction(Fixture):
    """One assessment object: preview prints it, the action consumes it."""

    def test_preview_and_action_read_the_same_object(self):
        self.seed(ignore="*.log\n")
        self.write("build.log")
        preview = self.assess()
        action = self.assess()
        self.assertEqual(preview, action)
        self.assertEqual(classify.render_report(preview), classify.render_report(action))
        self.assertEqual(classify.remove_scratch(action), ("build.log",))

    def test_a_blocked_assessment_cannot_be_acted_on(self):
        self.seed(ignore="*.log\n")
        self.write("build.log")
        self.write("tracked.txt", "changed\n")
        assessment = self.assess()
        with self.assertRaises(classify.ClassificationError):
            classify.remove_scratch(assessment)
        self.assertTrue((self.worktree / "build.log").exists())

    def test_a_clear_report_stays_bounded_too(self):
        self.seed(ignore="*.log\n")
        for index in range(40):
            self.write(f"cache{index}.log")
        assessment = self.assess()
        report = classify.render_report(assessment)
        self.assertIn("40", report)
        self.assertLess(len(report), 1000)


class ModuleContract(unittest.TestCase):
    """ADR-0009's own constraints on the module."""

    source = MODULE.read_text(encoding="utf-8")

    def test_residual_risks_are_documented(self):
        docstring = classify.__doc__ or ""
        self.assertIn("between assessment and deletion", docstring.lower())
        self.assertIn("gitignored outside `.env*`", docstring)
        # The declared arm deletes without comparing: an accepted risk is only
        # accepted while it is written down next to the others.
        self.assertIn("A declared `.env*` file is deleted", docstring)

    def test_no_profile_pattern_dependency(self):
        for forbidden in (
            "scratchPatterns",
            "landingGeneratedArtifactPatterns",
            "scratch_patterns",
            "from profile import",
            "import profile",
        ):
            self.assertNotIn(forbidden, self.source)

    def test_no_hardcoded_protected_branch_name(self):
        self.assertNotIn('"main"', self.source)
        self.assertNotIn("'main'", self.source)


if __name__ == "__main__":
    unittest.main()
