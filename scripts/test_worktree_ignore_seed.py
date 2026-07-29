#!/usr/bin/env python3
"""Consumer ignore-gap contract (#255, #370).

Shipped skills write `PLAN.md`, `PLAN-REVIEW-LOG.md`, and `ANNAHMEN.md` into a
session worktree, and the creation helper puts that worktree under the profile's
declared worktree root — but `.gitignore` is a consumer file the kit does not
own, so `init`/`update` never seed the matching rules. ADR 0008 resolves the gap
two ways, and both are pinned here:

1. `/setup-workflow` may **offer** the rules through
   `scripts/worktree-lifecycle/ignore_seed.py`. The helper is append-only
   inside one idempotent marker block: it never rewrites, reorders, or removes
   an existing line, it is a no-op on re-run, and it is unreachable from
   `init`/`update` reconciliation.
2. Shipped skill prose states the assumption instead of asserting the ignore
   state as a fact the kit cannot guarantee.

The offered set is the kit's artifact declaration plus the worktree root the
consumer profile declares, so a stray `git add -A` cannot stage a linked
worktree as an embedded git repository (#370).

Run: python3 scripts/test_worktree_ignore_seed.py
"""

from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LIFECYCLE = REPO / "scripts/worktree-lifecycle"
HELPER = LIFECYCLE / "ignore_seed.py"
ARTIFACT_MANIFEST = LIFECYCLE / "plan-artifacts.json"
SKILL_TREES = (REPO / ".claude/skills", REPO / ".agents/skills")


def load_helper():
    sys.path.insert(0, str(LIFECYCLE))
    try:
        spec = importlib.util.spec_from_file_location("wl_ignore_seed", HELPER)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(LIFECYCLE))


def write_profile(repo: Path, worktree_root: str) -> None:
    """Give the repo a consumer profile declaring its own worktree root."""
    target = repo / "docs/agents/workflow-capabilities.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps({"worktreeLifecycle": {"enabled": True, "worktreeRoot": worktree_root}}),
        encoding="utf-8",
    )


def git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True,
    )


def make_repo(stack, gitignore: str | None = None) -> Path:
    repo = Path(stack.enter_context(tempfile.TemporaryDirectory()))
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "test")
    if gitignore is not None:
        (repo / ".gitignore").write_text(gitignore, encoding="utf-8")
    return repo


class ArtifactManifestTest(unittest.TestCase):
    """The kit declares which planning artifacts its own skills write."""

    def test_manifest_declares_the_three_planning_artifacts(self):
        document = json.loads(ARTIFACT_MANIFEST.read_text(encoding="utf-8"))
        paths = [entry["path"] for entry in document["artifacts"]]
        self.assertEqual(
            paths, ["PLAN.md", "PLAN-REVIEW-LOG.md", "ANNAHMEN.md"],
        )
        for entry in document["artifacts"]:
            self.assertTrue(entry["writtenBy"], entry["path"])


class PlanTest(unittest.TestCase):
    """`plan()` reports the exact append, never a rewrite."""

    def setUp(self):
        self.helper = load_helper()
        self.stack = __import__("contextlib").ExitStack()
        self.addCleanup(self.stack.close)

    def test_fresh_repo_lists_every_rule_as_pending(self):
        repo = make_repo(self.stack, "node_modules/\n")
        plan = self.helper.plan(repo)
        self.assertEqual(
            plan.pending,
            ("PLAN.md", "PLAN-REVIEW-LOG.md", "ANNAHMEN.md", ".worktrees/"),
        )
        self.assertEqual(plan.already_ignored, ())
        self.assertEqual(plan.status, "append")
        for path in plan.pending:
            self.assertIn(f"\n{path}\n", plan.block)
        self.assertTrue(plan.block.startswith(self.helper.BLOCK_START))
        self.assertTrue(plan.block.rstrip("\n").endswith(self.helper.BLOCK_END))

    def test_missing_gitignore_is_reported_as_a_create(self):
        repo = make_repo(self.stack)
        plan = self.helper.plan(repo)
        self.assertEqual(plan.status, "append")
        self.assertFalse(plan.gitignore_exists)

    def test_consumer_rules_already_covering_everything_are_nothing_to_do(self):
        repo = make_repo(
            self.stack, "PLAN.md\nPLAN-REVIEW-LOG.md\nANNAHMEN.md\n.worktrees/\n",
        )
        plan = self.helper.plan(repo)
        self.assertEqual(plan.pending, ())
        self.assertEqual(plan.status, "nothing-to-do")
        self.assertIsNone(plan.block)

    def test_partial_coverage_pends_only_the_missing_rules(self):
        repo = make_repo(self.stack, "PLAN.md\n.worktrees/\n")
        plan = self.helper.plan(repo)
        self.assertEqual(plan.pending, ("PLAN-REVIEW-LOG.md", "ANNAHMEN.md"))
        self.assertEqual(plan.already_ignored, ("PLAN.md", ".worktrees/"))
        self.assertNotIn("\nPLAN.md\n", plan.block)

    def test_a_wildcard_consumer_rule_counts_as_covered(self):
        repo = make_repo(self.stack, "*.md\n.worktrees/\n")
        plan = self.helper.plan(repo)
        self.assertEqual(plan.pending, ())

    def test_a_tracked_artifact_is_named_because_a_rule_cannot_untrack_it(self):
        repo = make_repo(self.stack, "node_modules/\n")
        (repo / "PLAN.md").write_text("plan\n", encoding="utf-8")
        git(repo, "add", "PLAN.md")
        git(repo, "commit", "-qm", "add plan")
        plan = self.helper.plan(repo)
        self.assertEqual(plan.tracked, ("PLAN.md",))
        self.assertIn("PLAN.md", plan.pending)


class ApplyTest(unittest.TestCase):
    """`apply()` is append-only, idempotent, and never rewrites."""

    def setUp(self):
        self.helper = load_helper()
        self.stack = __import__("contextlib").ExitStack()
        self.addCleanup(self.stack.close)

    def test_apply_appends_and_preserves_the_existing_bytes_verbatim(self):
        original = "node_modules/\n\n# my rules\ndist/\n"
        repo = make_repo(self.stack, original)
        result = self.helper.apply(repo)
        self.assertEqual(result.status, "appended")
        text = (repo / ".gitignore").read_text(encoding="utf-8")
        self.assertTrue(text.startswith(original))
        self.assertIn(self.helper.BLOCK_START, text)
        for path in ("PLAN.md", "PLAN-REVIEW-LOG.md", "ANNAHMEN.md", ".worktrees/"):
            self.assertIn(f"\n{path}\n", text)

    def test_rerun_is_a_byte_identical_no_op(self):
        repo = make_repo(self.stack, "node_modules/\n")
        self.helper.apply(repo)
        first = (repo / ".gitignore").read_bytes()
        second_result = self.helper.apply(repo)
        self.assertEqual(second_result.status, "nothing-to-do")
        self.assertEqual((repo / ".gitignore").read_bytes(), first)
        self.assertEqual(first.decode().count(self.helper.BLOCK_START), 1)

    def test_decline_path_writes_nothing(self):
        repo = make_repo(self.stack, "node_modules/\n")
        before = (repo / ".gitignore").read_bytes()
        self.helper.plan(repo)
        self.assertEqual((repo / ".gitignore").read_bytes(), before)

    def test_already_covered_repo_is_left_untouched(self):
        original = "PLAN.md\nPLAN-REVIEW-LOG.md\nANNAHMEN.md\n.worktrees/\n"
        repo = make_repo(self.stack, original)
        result = self.helper.apply(repo)
        self.assertEqual(result.status, "nothing-to-do")
        self.assertEqual(
            (repo / ".gitignore").read_text(encoding="utf-8"), original,
        )

    def test_missing_gitignore_is_created_with_only_the_block(self):
        repo = make_repo(self.stack)
        self.helper.apply(repo)
        text = (repo / ".gitignore").read_text(encoding="utf-8")
        self.assertTrue(text.startswith(self.helper.BLOCK_START))

    def test_an_edited_marker_block_blocks_instead_of_rewriting(self):
        repo = make_repo(self.stack)
        self.helper.apply(repo)
        text = (repo / ".gitignore").read_text(encoding="utf-8")
        edited = text.replace("ANNAHMEN.md\n", "")
        (repo / ".gitignore").write_text(edited, encoding="utf-8")
        result = self.helper.apply(repo)
        self.assertEqual(result.status, "blocked")
        self.assertEqual(
            (repo / ".gitignore").read_text(encoding="utf-8"), edited,
        )
        self.assertEqual(edited.count(self.helper.BLOCK_START), 1)

    def test_cli_preview_writes_nothing_and_reports_json(self):
        repo = make_repo(self.stack, "node_modules/\n")
        before = (repo / ".gitignore").read_bytes()
        result = subprocess.run(
            [sys.executable, str(HELPER), "preview", "--repo", str(repo), "--json"],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "append")
        self.assertEqual((repo / ".gitignore").read_bytes(), before)

    def test_cli_apply_exits_zero_and_is_idempotent(self):
        repo = make_repo(self.stack, "node_modules/\n")
        for _ in range(2):
            result = subprocess.run(
                [sys.executable, str(HELPER), "apply", "--repo", str(repo)],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        text = (repo / ".gitignore").read_text(encoding="utf-8")
        self.assertEqual(text.count(self.helper.BLOCK_START), 1)


class WorktreeRootRuleTest(unittest.TestCase):
    """#370: a stray `git add -A` must not stage a worktree as an embedded repo."""

    def setUp(self):
        self.helper = load_helper()
        self.stack = __import__("contextlib").ExitStack()
        self.addCleanup(self.stack.close)

    def _repo_with_worktree(self, root: str = ".worktrees") -> Path:
        repo = make_repo(self.stack, "node_modules/\n")
        (repo / "README.md").write_text("# fixture\n", encoding="utf-8")
        git(repo, "add", "README.md")
        git(repo, "commit", "-qm", "initial")
        git(
            repo, "worktree", "add", "-q", "-b", "feat/370-repro",
            str(repo / root / "370-repro"),
        )
        return repo

    def _staged_by_add_all(self, repo: Path):
        """What a stray `git add -A` would stage, and what git warns about."""
        result = subprocess.run(
            ["git", "add", "-A", "--dry-run"], cwd=repo,
            capture_output=True, text=True, check=True,
        )
        return result.stdout, result.stderr

    def test_positive_control_an_unseeded_repo_stages_the_worktree(self):
        repo = self._repo_with_worktree()
        stdout, stderr = self._staged_by_add_all(repo)
        self.assertIn(".worktrees/370-repro", stdout)
        self.assertIn("embedded git repository", stderr)

    def test_after_the_seed_nothing_under_the_worktree_root_is_staged(self):
        repo = self._repo_with_worktree()
        self.assertEqual(self.helper.apply(repo).status, "appended")
        stdout, stderr = self._staged_by_add_all(repo)
        self.assertNotIn(".worktrees/", stdout)
        self.assertNotIn("embedded git repository", stderr)

    def test_the_rule_is_the_root_the_consumer_profile_declares(self):
        repo = make_repo(self.stack, "node_modules/\n")
        write_profile(repo, ".sandboxes")
        plan = self.helper.plan(repo)
        self.assertIn(".sandboxes/", plan.pending)
        self.assertNotIn(".worktrees/", plan.pending)

    def test_a_declared_root_is_ignored_for_a_foreign_named_worktree_too(self):
        repo = self._repo_with_worktree(".sandboxes")
        write_profile(repo, ".sandboxes")
        self.assertEqual(self.helper.apply(repo).status, "appended")
        stdout, stderr = self._staged_by_add_all(repo)
        self.assertNotIn(".sandboxes/", stdout)
        self.assertNotIn("embedded git repository", stderr)

    def test_a_repo_without_a_profile_falls_back_to_the_kit_default(self):
        repo = make_repo(self.stack, "node_modules/\n")
        plan = self.helper.plan(repo)
        self.assertIn(".worktrees/", plan.pending)

    def test_a_root_already_ignored_by_the_consumer_is_never_offered_again(self):
        repo = make_repo(self.stack, ".worktrees/\n")
        plan = self.helper.plan(repo)
        self.assertIn(".worktrees/", plan.already_ignored)
        self.assertNotIn(".worktrees/", plan.pending)


class ReconciliationBoundaryTest(unittest.TestCase):
    """Only setup-workflow may reach the seeder; never init/update."""

    def test_no_installer_command_invokes_the_seeder(self):
        # bundle.mjs only DECLARES the file as shipped; every other installer
        # module must not know the seeder exists.
        declaration = REPO / "src/lib/bundle.mjs"
        offenders = []
        for path in sorted((REPO / "src").rglob("*.mjs")):
            if path == declaration:
                continue
            if "ignore_seed" in path.read_text(encoding="utf-8"):
                offenders.append(str(path.relative_to(REPO)))
        self.assertEqual(offenders, [])

    def test_the_seeder_ships_with_the_kit(self):
        bundle = (REPO / "src/lib/bundle.mjs").read_text(encoding="utf-8")
        self.assertIn("scripts/worktree-lifecycle/ignore_seed.py", bundle)
        self.assertIn("scripts/worktree-lifecycle/plan-artifacts.json", bundle)


class SetupWorkflowOfferTest(unittest.TestCase):
    """The offer is an explicit, previewed, declinable setup step."""

    def _skill(self, tree: Path) -> str:
        return (tree / "setup-workflow/SKILL.md").read_text(encoding="utf-8")

    def _seed(self, tree: Path) -> str:
        return (tree / "setup-workflow/worktree-lifecycle.md").read_text(
            encoding="utf-8",
        )

    def test_both_surfaces_document_the_previewed_offer(self):
        for tree in SKILL_TREES:
            body = self._skill(tree)
            self.assertIn(
                "python3 scripts/worktree-lifecycle/ignore_seed.py preview", body,
            )
            self.assertIn(
                "python3 scripts/worktree-lifecycle/ignore_seed.py apply", body,
            )
            flat = re.sub(r"\s+", " ", body)
            self.assertIn("Add the rules", flat)
            self.assertIn("Not now", flat)

    def test_the_seed_contract_carries_the_ignore_offer_matrix(self):
        for tree in SKILL_TREES:
            flat = re.sub(r"\s+", " ", self._seed(tree))
            self.assertIn("ignore_seed.py", flat)
            for row in ("approve", "decline", "already ignored", "re-run"):
                self.assertIn(row, flat)


class ProseClaimCensusTest(unittest.TestCase):
    """No shipped skill asserts an ignore state the kit cannot guarantee."""

    ARTIFACT = re.compile(
        r"PLAN\.md|PLAN-REVIEW-LOG\.md|ANNAHMEN\.md|plan doc|assumptions log",
        re.IGNORECASE,
    )
    # Unconditional assertions of the ignore state. Conditional or hedged
    # wording ("a project may gitignore these files", "when `PLAN.md` is
    # ignored") is deliberately allowed.
    FORBIDDEN = (
        re.compile(r"\(gitignored\b", re.IGNORECASE),
        re.compile(r"\b(?:is|are|stays?|remains?)\s+gitignored\b", re.IGNORECASE),
        re.compile(r"\bgitignored\s+(?:at|in|since)\b", re.IGNORECASE),
        re.compile(r"\ba\s+gitignored\s+plan\s+doc\b", re.IGNORECASE),
        re.compile(r"\bgitignored,\s*on-disk only\b", re.IGNORECASE),
    )
    WINDOW = 160

    def _claim_offenders(self):
        offenders = []
        for tree in SKILL_TREES:
            for path in sorted(tree.rglob("*.md")):
                flat = re.sub(r"\s+", " ", path.read_text(encoding="utf-8"))
                for pattern in self.FORBIDDEN:
                    for match in pattern.finditer(flat):
                        window = flat[
                            max(0, match.start() - self.WINDOW):
                            match.end() + self.WINDOW
                        ]
                        if self.ARTIFACT.search(window):
                            offenders.append(
                                f"{path.relative_to(REPO)}: {match.group(0)}"
                            )
        return sorted(set(offenders))

    def test_no_skill_states_the_ignore_rule_as_an_installed_fact(self):
        self.assertEqual(self._claim_offenders(), [])

    def test_the_replacement_wording_names_who_can_make_it_true(self):
        for name in ("grill-me", "grill-with-docs", "orchestrate-wave"):
            for tree in SKILL_TREES:
                body = (tree / name / "SKILL.md").read_text(encoding="utf-8")
                flat = re.sub(r"\s+", " ", body)
                self.assertIn("setup-workflow", flat, f"{tree}/{name}")


if __name__ == "__main__":
    unittest.main()
