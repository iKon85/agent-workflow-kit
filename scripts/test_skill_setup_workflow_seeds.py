#!/usr/bin/env python3
"""setup-workflow seed + idempotency-rule spec (Welle 26 / Slice 5 / #989).

`/setup-workflow` is a prompt-driven skill, so its interactive run is verified
live (mock fresh-fill + in-repo idempotent re-run). This file pins the two parts
that ARE machine-checkable:

1. The seed templates it ships are structurally valid for their consumers, so a
   fresh fill cannot produce a project layer that makes a downstream skill warn.
2. The sentinel-based idempotency rule, as a reference implementation + the
   canonical example table the skill's prose must satisfy (Codex R1 #12 strict
   `state=` header; R2 #2 terminal `not-applicable`; R3 legacy no-sentinel skip).

It does NOT test Claude's execution of the prose — that is the live-verify.

Run: python3 scripts/test_skill_setup_workflow_seeds.py
"""
import json
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILL = REPO / ".claude/skills/setup-workflow"

SENTINEL_RE = re.compile(
    r"^<!--\s*setup-workflow:\s*state=(stub|filled|not-applicable)"
    r"(?:;\s*mode=(github-projects-v2|none))?\s*-->\s*$"
)


# ---- Reference implementation of the documented idempotency rule -------------
def classify(first_line, is_empty):
    """Return the action the skill must take for one target file.

    first_line: the file's first line, or None if the file does not exist.
    is_empty:   True if the file is empty/whitespace-only.
    """
    if first_line is None:
        return "create"
    m = SENTINEL_RE.match(first_line.strip())
    if m:
        return "fill" if m.group(1) == "stub" else "skip"
    # No sentinel: non-empty legacy file is left alone; empty is fillable.
    return "create" if is_empty else "skip"


def update_workflow_action(
    provider, choice, destination_exists, prerequisites=True,
    pull_requests_allowed=True,
):
    """Reference decision table for the prompt-driven setup contract."""
    if provider != "github" or destination_exists or choice != "enable":
        return "skip"
    return "create" if prerequisites and pull_requests_allowed else "skip"


class IdempotencyRule(unittest.TestCase):
    CASES = [
        # (first_line, is_empty, expected)
        (None, False, "create"),                                      # missing
        ("<!-- setup-workflow: state=stub -->", False, "fill"),       # stub
        ("<!-- setup-workflow: state=filled -->", False, "skip"),     # filled
        ("<!-- setup-workflow: state=stub; mode=github-projects-v2 -->", False, "fill"),
        ("<!-- setup-workflow: state=filled; mode=github-projects-v2 -->", False, "skip"),
        ("<!-- setup-workflow: state=not-applicable; mode=none -->", False, "skip"),
        ("# Board sync — GitHub Projects field-IDs", False, "skip"),  # legacy non-empty
        ("", True, "create"),                                         # empty no-sentinel
    ]

    def test_canonical_examples(self):
        for first, empty, expected in self.CASES:
            self.assertEqual(
                classify(first, empty), expected, f"{first!r} empty={empty}"
            )

    def test_filled_file_mentioning_marker_in_body_is_not_refilled(self):
        # Only the FIRST line decides; a body mention must not flip it (Codex R1 #12).
        first = "<!-- setup-workflow: state=filled -->"
        self.assertEqual(classify(first, False), "skip")


class SeedTemplatesValid(unittest.TestCase):
    def test_update_workflow_provider_and_choice_fixtures(self):
        fixtures = [
            ("github", "enable", False, True, True, "create"),
            ("github", "opt-out", False, True, True, "skip"),
            ("github", "later", False, True, True, "skip"),
            ("github", "enable", True, True, True, "skip"),
            ("github", "enable", False, False, True, "skip"),
            ("github", "enable", False, True, False, "skip"),
            ("gitlab", "enable", False, True, True, "skip"),
            ("local", "enable", False, True, True, "skip"),
        ]
        for provider, choice, exists, prerequisites, allowed, expected in fixtures:
            self.assertEqual(
                update_workflow_action(
                    provider, choice, exists, prerequisites, allowed,
                ), expected,
            )

    def test_github_update_opt_in_is_provider_aware_and_idempotent(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        for token in (
            "Automatic Kit update pull requests",
            ".github/workflows/agent-workflow-kit-update.yml",
            "Opt out",
            "Ask later",
            "GitHub tracker",
            "skipped (already present)",
            "package-lock.json",
            "npm test",
            "can_approve_pull_request_reviews",
            "Allow GitHub Actions to create and approve pull requests",
            "explicit confirmation",
        ):
            self.assertIn(token, skill)
        self.assertIn("do not create a GitHub workflow", skill)

    def test_github_update_workflow_has_safe_triggers_and_scoped_runner(self):
        workflow = (SKILL / "assets/agent-workflow-kit-update.yml").read_text(encoding="utf-8")
        for token in (
            "schedule:", "workflow_dispatch:", "contents: write",
            "pull-requests: write", "agent-workflow-kit-update-pr",
            "@ikon85/agent-workflow-kit@latest", "fetch-depth: 0",
            "node-version: 22.14", "npm ci --ignore-scripts",
        ):
            self.assertIn(token, workflow)
        for forbidden in ("npm_token", "NPM_TOKEN", "auto-merge", "gh pr merge"):
            self.assertNotIn(forbidden, workflow)

        mirror = (REPO / ".agents/skills/setup-workflow/assets/agent-workflow-kit-update.yml")
        self.assertEqual(workflow, mirror.read_text(encoding="utf-8"))

    def test_update_pr_runner_is_an_installed_package_binary(self):
        package = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["bin"]["agent-workflow-kit-update-pr"], "scripts/kit-update-pr.mjs")

    def test_spec_completeness_seed_has_valid_self_critique_block(self):
        """A convention without a valid Trigger/Check/Korrektur block makes
        spec-self-critique point 8 warn — the seed must carry one (Codex R1 #14)."""
        t = (SKILL / "spec-completeness-seed.md").read_text(encoding="utf-8")
        self.assertIn("## Self-Critique-Check", t)
        for kw in ("Trigger", "Check", "Korrektur"):
            self.assertRegex(t, rf"\*\*{kw}", f"missing {kw} in Self-Critique-Check")

    def test_spec_self_critique_seed_has_12_point_anchors(self):
        """Stable retro-append anchors for points 1..12 (Codex R1 #15)."""
        t = (SKILL / "spec-self-critique-seed.md").read_text(encoding="utf-8")
        anchors = sorted(int(n) for n in re.findall(r"^## Point (\d+)\b", t, re.M))
        self.assertEqual(anchors, list(range(1, 13)))

    def test_orchestrate_wave_seed_has_section_contract(self):
        """The orchestrate-wave project-layer seed carries the exact §-section
        headings the skill's Phase-0 probe matches (#1958). If a heading is
        renamed here without updating the skeleton (or vice versa) the probe
        stops finding the section — this pins the contract on both sides."""
        seed = (SKILL / "orchestrate-wave-seed.md").read_text(encoding="utf-8")
        skeleton = (REPO / ".claude/skills/orchestrate-wave/SKILL.md").read_text(encoding="utf-8")
        sections = [
            "§Setup", "§Builder Commands", "§Builder Hard Rules",
            "§Integration Suites", "§Verify Recipe", "§Headless Login", "§Landing",
        ]
        for sec in sections:
            self.assertRegex(seed, rf"(?m)^#+ {re.escape(sec)}\b", f"seed missing heading {sec!r}")
            self.assertIn(sec, skeleton, f"skeleton no longer refers to {sec!r}")

    def test_board_sync_seed_documents_states_and_profile(self):
        t = (SKILL / "board-sync.md").read_text(encoding="utf-8")
        for token in ("state=filled", "state=stub", "state=not-applicable", "Status"):
            self.assertIn(token, t)

    def test_workflow_overview_seed_is_generic_and_linked_from_skill(self):
        """Fresh repos should get an entry-point map without Testreporter-local lore.

        The expected skill set is derived from the manifest's `entryPoint` flag
        (publish:true skills only) rather than a hand-maintained token list —
        it used to hardcode 5 names while the manifest already carried 13
        publish:true entry-point-worthy skills, so the seed silently drifted
        behind (#1890: `ask-matt`, the router, was missing entirely)."""
        manifest = json.loads((REPO / ".claude/skills/skill-manifest.json").read_text(encoding="utf-8"))
        expected = sorted(
            name for name, meta in manifest["skills"].items()
            if meta.get("publish") and meta.get("entryPoint")
        )
        self.assertGreaterEqual(len(expected), 10, "manifest entryPoint set looks too small")

        seed = (SKILL / "workflow-overview.md").read_text(encoding="utf-8")
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("# Workflow", seed)
        for name in expected:
            self.assertIn(name, seed, f"entry-point skill {name!r} (manifest entryPoint:true) missing from seed")
        self.assertIn("ask-matt", seed, "router entry must be named explicitly")
        self.assertNotIn("Testreporter", seed)
        self.assertIn("workflow-overview.md", skill)
        self.assertIn("## Workflow", skill)

    def test_triage_labels_seed_matches_two_label_reality(self):
        """The seed presented at setup-workflow fill-time must not contradict
        the triage skill's actual label vocabulary: it used to list five
        canonical roles as if all were active labels, but the triage skill
        only ever applies two — the rest live in board status. A fresh fill
        from the old seed taught agents to assign three dead labels (#1879)."""
        seed = (SKILL / "triage-labels.md").read_text(encoding="utf-8")
        triage_skill = (REPO / ".claude/skills/triage/SKILL.md").read_text(encoding="utf-8")

        for label in ("needs-info", "ready-for-agent"):
            self.assertIn(f"`{label}`", seed)
            self.assertIn(f"`{label}`", triage_skill)

        # The retired roles must not appear in the table portion (before the
        # board-status explainer) as if they were still active labels.
        table, sep, explainer = seed.partition("Board status is authoritative")
        self.assertTrue(sep, "seed must explain that board status is authoritative")
        for retired in ("needs-triage", "ready-for-human", "wontfix"):
            self.assertNotIn(f"`{retired}`", table)

        self.assertIn("Board status is authoritative", seed)
        self.assertIn("Board status is authoritative", triage_skill)


class SentinelProtectsFilledProfile(unittest.TestCase):
    """A consumer's filled board profile must never be rewritten on rerun."""

    def test_filled_public_profile_is_left_unchanged_on_rerun(self):
        real_profile = REPO / "docs/agents/board-sync.md"
        text = real_profile.read_text(encoding="utf-8")
        first_line = text.splitlines()[0]
        self.assertEqual(
            classify(first_line, False), "skip",
            "a filled project profile must classify as skip, never re-fillable",
        )
        # Prove this is genuinely filled (not an accidental stub), otherwise
        # the "skip" assertion above would be vacuous.
        self.assertIn('"repo": "iKon85/agent-workflow-kit"', text)
        self.assertIn('"vorBau": "Clarify Before Build"', text)

    def test_unfilled_stub_gets_english_defaults(self):
        stub_first_line = "<!-- setup-workflow: state=stub; mode=github-projects-v2 -->"
        self.assertEqual(classify(stub_first_line, False), "fill")

        seed = (SKILL / "board-sync.md").read_text(encoding="utf-8")
        self.assertIn('"retroValues": ["ran", "skipped"]', seed)
        self.assertIn('"vorBau": "Clarify Before Build"', seed)
        self.assertNotIn("gefahren", seed)
        self.assertNotIn("Vor Bau zu klären", seed)


class FreshFillProducesValidSentinels(unittest.TestCase):
    """Simulate the write step: prepend the documented sentinel to a template
    body and assert the result is a well-formed project-layer file."""

    def test_prepended_sentinel_parses(self):
        body = (SKILL / "spec-self-critique-seed.md").read_text(encoding="utf-8")
        for state, mode in (("stub", None), ("filled", "github-projects-v2"),
                            ("not-applicable", "none")):
            sentinel = f"<!-- setup-workflow: state={state}" + (
                f"; mode={mode}" if mode else "") + " -->"
            written = sentinel + "\n" + body
            self.assertRegex(written.splitlines()[0], SENTINEL_RE)


if __name__ == "__main__":
    unittest.main(verbosity=2)
