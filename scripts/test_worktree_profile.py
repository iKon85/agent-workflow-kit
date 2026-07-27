#!/usr/bin/env python3
"""The lifecycle profile carries structural facts only (ADR-0009 §6, #335).

Two contracts are pinned here. A consumer profile that still carries the
removed pattern keys loads clean and silent — the green slate removes them
without migration, so an old key is ignored, never rewritten and never warned
about. And the issue-less Content branch template renders from the profile like
every other branch template, because a planning session landing durable content
has no issue number to interpolate.

Run: python3 scripts/test_worktree_profile.py
"""

import importlib.util
import io
import json
import sys
import unittest
import warnings
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MODULE = REPO / "scripts/worktree-lifecycle/profile.py"

REMOVED_KEYS = ("scratchPatterns", "landingGeneratedArtifactPatterns")

LEGACY_PROFILE = """{
  "worktreeLifecycle": {
    "enabled": true,
    "worktreeRoot": ".worktrees",
    "branchTemplate": "{type}/{issue}-{slug}",
    "pathTemplate": "{issue}-{slug}",
    "scratchPatterns": ["PLAN.md", ".claude/logs/**"],
    "unknownFutureKey": "keep"
  },
  "wrapup": {"landingGeneratedArtifactPatterns": ["dist-kit/**"]}
}
"""

MINIMAL_PROFILE = '{"worktreeLifecycle": {"enabled": true}}'


def load():
    spec = importlib.util.spec_from_file_location("worktree_profile_under_test", MODULE)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


profile = load()


def with_content_template(template):
    return json.dumps(
        {"worktreeLifecycle": {"enabled": True, "contentBranchTemplate": template}},
    )


class RemovedPatternKeysAreIgnoredSilently(unittest.TestCase):
    """Old keys are inert data, not a migration and not warning noise."""

    def test_a_profile_still_carrying_the_removed_keys_loads(self):
        loaded = profile.load_profile_text(LEGACY_PROFILE)
        self.assertEqual(loaded.root, ".worktrees")
        self.assertEqual(
            loaded.branch_name("335", "green-slate", "feat"),
            "feat/335-green-slate",
        )

    def test_loading_emits_no_warning_and_no_output(self):
        out, err = io.StringIO(), io.StringIO()
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            with redirect_stdout(out), redirect_stderr(err):
                profile.load_profile_text(LEGACY_PROFILE)
        self.assertEqual([str(entry.message) for entry in caught], [])
        self.assertEqual(out.getvalue(), "")
        self.assertEqual(err.getvalue(), "")

    def test_the_loaded_profile_exposes_no_pattern_field(self):
        loaded = profile.load_profile_text(LEGACY_PROFILE)
        for field in ("scratch_patterns", "landing_generated_artifact_patterns"):
            self.assertFalse(hasattr(loaded, field), field)

    def test_the_loader_never_names_a_removed_key(self):
        body = MODULE.read_text(encoding="utf-8")
        for key in REMOVED_KEYS:
            self.assertNotIn(key, body)


class ContentBranchTemplate(unittest.TestCase):
    """The Content route cuts an issue-less branch from a profiled template."""

    def test_the_default_is_the_issue_less_type_slug_branch(self):
        loaded = profile.load_profile_text(MINIMAL_PROFILE)
        self.assertEqual(
            loaded.content_branch_template,
            profile.DEFAULT_CONTENT_BRANCH_TEMPLATE,
        )
        self.assertEqual(profile.DEFAULT_CONTENT_BRANCH_TEMPLATE, "{type}/{slug}")
        self.assertEqual(
            loaded.content_branch_name("adr-0009-glossary", "docs"),
            "docs/adr-0009-glossary",
        )

    def test_a_consumer_template_is_honoured(self):
        loaded = profile.load_profile_text(with_content_template("content/{slug}"))
        self.assertEqual(loaded.content_branch_name("glossary", "docs"), "content/glossary")

    def test_an_issue_placeholder_is_refused_because_content_has_no_issue(self):
        loaded = profile.load_profile_text(with_content_template("{type}/{issue}-{slug}"))
        with self.assertRaises(profile.LifecycleError):
            loaded.content_branch_name("glossary", "docs")

    def test_an_unknown_placeholder_is_refused(self):
        loaded = profile.load_profile_text(with_content_template("{nope}/{slug}"))
        with self.assertRaises(profile.LifecycleError):
            loaded.content_branch_name("glossary", "docs")

    def test_the_issue_branch_template_still_renders_all_three_placeholders(self):
        loaded = profile.load_profile_text(MINIMAL_PROFILE)
        self.assertEqual(loaded.branch_name("42", "slug", "fix"), "fix/42-slug")
        self.assertEqual(str(loaded.relative_path("42", "slug", "fix")), ".worktrees/fix-42-slug")


if __name__ == "__main__":
    unittest.main()
