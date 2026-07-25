#!/usr/bin/env python3
"""Issue-claim-on-pickup contract (#231).

A skill that ACCEPTS a tracked issue for building must leave a claim on the
issue itself before it builds — the local worktree/branch/PR guard only sees
the same machine, and only until someone pushes. The claim is what a second
session, a second machine, or a cloud agent can actually see.

Enforced here:

- `implement` and `diagnose` carry one byte-identical claim block on both
  surfaces, and it sits before their first build instruction.
- The block covers all three legs: check for a foreign claim (STOP), plant a
  claim naming branch + worktree, release it.
- `orchestrate-wave` claims each slice issue at builder-launch time and
  releases only its own slice claims.
- Every tracker seed and this repo's own tracker layer document the concrete
  claim / check / release operations, so the tracker-neutral skill prose
  resolves to real commands.

Run: python3 scripts/test_issue_claim_contract.py
"""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SURFACES = (".claude/skills", ".agents/skills")
PICKUP_SKILLS = ("implement", "diagnose")
START = "<!-- issue-claim:start -->"
END = "<!-- issue-claim:end -->"
MARKER = "<!-- agent-claim:"
TRACKER_DOC = "docs/agents/issue-tracker.md"
TRACKER_SEEDS = (
    "setup-workflow/issue-tracker-github.md",
    "setup-workflow/issue-tracker-gitlab.md",
    "setup-workflow/issue-tracker-local.md",
)
# The first instruction that already assumes the build has started.
FIRST_BUILD_ANCHOR = {
    "implement": "Use /tdd where possible",
    "diagnose": "## Phase 1 — Build a feedback loop",
}


def skill_body(surface: str, skill: str) -> str:
    return (ROOT / surface / skill / "SKILL.md").read_text(encoding="utf-8")


def claim_block(body: str) -> str:
    return body.split(START, 1)[1].split(END, 1)[0]


def section(body: str, heading: str) -> str:
    """Return one second-level Markdown section, excluding the next one."""
    start = body.index(heading) + len(heading)
    end = body.find("\n## ", start)
    return body[start:] if end == -1 else body[start:end]


class ClaimBlockContract(unittest.TestCase):
    def test_pickup_skills_carry_exactly_one_claim_block_on_both_surfaces(self):
        for skill in PICKUP_SKILLS:
            for surface in SURFACES:
                with self.subTest(skill=skill, surface=surface):
                    body = skill_body(surface, skill)
                    self.assertEqual(body.count(START), 1)
                    self.assertEqual(body.count(END), 1)
                    self.assertLess(body.index(START), body.index(END))

    def test_claim_block_is_byte_identical_across_skills_and_surfaces(self):
        blocks = {
            (skill, surface): claim_block(skill_body(surface, skill))
            for skill in PICKUP_SKILLS
            for surface in SURFACES
        }
        first = blocks[(PICKUP_SKILLS[0], SURFACES[0])]
        for key, block in blocks.items():
            with self.subTest(key=key):
                self.assertEqual(block, first)

    def test_claim_block_covers_check_plant_and_release(self):
        block = claim_block(skill_body(SURFACES[0], PICKUP_SKILLS[0]))
        # Check leg — a foreign claim stops the pickup, and is never removed.
        self.assertIn("foreign claim", block)
        self.assertIn("STOP", block)
        self.assertIn("never delete a foreign claim", block)
        # Plant leg — the marker must carry branch AND worktree, or a colliding
        # session cannot find the work in progress.
        self.assertIn(MARKER, block)
        self.assertIn("branch=", block)
        self.assertIn("worktree=", block)
        # Release leg — the PR supersedes it; an abandoned claim is removed.
        self.assertIn("supersedes", block)
        self.assertIn("abandon", block)

    def test_claim_block_resolves_through_the_tracker_layer_with_a_fallback(self):
        block = claim_block(skill_body(SURFACES[0], PICKUP_SKILLS[0]))
        self.assertIn(TRACKER_DOC, block)
        self.assertIn("fall back", block)

    def test_claim_is_planted_before_the_first_build_instruction(self):
        for skill in PICKUP_SKILLS:
            for surface in SURFACES:
                with self.subTest(skill=skill, surface=surface):
                    body = skill_body(surface, skill)
                    self.assertLess(
                        body.index(END), body.index(FIRST_BUILD_ANCHOR[skill])
                    )


class OrchestrateWaveSliceClaimContract(unittest.TestCase):
    def test_dispatch_claims_each_slice_issue_at_builder_launch(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                dispatch = section(
                    skill_body(surface, "orchestrate-wave"),
                    "## Phase 2 — Dispatch one wave in parallel",
                )
                self.assertIn(MARKER, dispatch)
                self.assertIn("slice issue", dispatch)
                self.assertIn("branch=", dispatch)
                self.assertIn("worktree=", dispatch)

    def test_wave_claim_is_not_treated_as_a_slice_claim(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                dispatch = section(
                    skill_body(surface, "orchestrate-wave"),
                    "## Phase 2 — Dispatch one wave in parallel",
                )
                self.assertIn("wave claim", dispatch)

    def test_cleanup_releases_only_this_runs_slice_claims(self):
        for surface in SURFACES:
            with self.subTest(surface=surface):
                cleanup = section(
                    skill_body(surface, "orchestrate-wave"),
                    "## Phase 6 — Cleanup + close",
                )
                self.assertIn("slice claim", cleanup)
                self.assertIn("this run", cleanup)


class TrackerLayerClaimOperations(unittest.TestCase):
    def documents(self) -> dict[str, str]:
        docs = {TRACKER_DOC: (ROOT / TRACKER_DOC).read_text(encoding="utf-8")}
        for surface in SURFACES:
            for seed in TRACKER_SEEDS:
                path = ROOT / surface / seed
                docs[str(path.relative_to(ROOT))] = path.read_text(encoding="utf-8")
        return docs

    def test_every_tracker_layer_defines_claim_check_and_release(self):
        for name, body in self.documents().items():
            with self.subTest(document=name):
                self.assertIn("## Pickup claim", body)
                claim = section(body, "## Pickup claim")
                self.assertIn(MARKER, claim)
                self.assertIn("branch=", claim)
                self.assertIn("worktree=", claim)
                # a read side (detect a foreign claim) and a release side
                self.assertIn("Check", claim)
                self.assertIn("Release", claim)


if __name__ == "__main__":
    unittest.main()
