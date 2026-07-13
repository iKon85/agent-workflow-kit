#!/usr/bin/env python3
"""Skill surface-reference lint (Welle 49 / Slice 2 / #1873).

Every `/skill-name` or backtick `` `skill-name` `` a SKILL.md names must
resolve to a skill that exists as a directory on the SAME surface the
referencing file lives on. `skill-manifest.json`'s `surfaces` array is the
SSOT for which trees (`.claude/skills`, `.agents/skills`) host a skill.

Two independent checks:

  MISMATCH — an exact backtick reference to a REAL manifest skill NOT hosted
  on the referencing file's surface (a Claude-only skill named from a
  Codex-surface file, or vice-versa). This is the class behind the
  Codex-escalation dangling-target finding and the `/code-review` dangling:
  a PUBLISHED skill can pass the existing publish audit
  (`auditSkillNameRefs` in `scripts/lib/audit-refs.mjs`, which only checks
  *publish status*) while still dangling on ONE surface — that audit has no
  concept of `surfaces` at all.

  NONEXISTENT — a `/name` slash-token styled as a catalog entry (a list item
  opening with an optionally-bold backtick slash-token, the convention every
  genuine skill listing in this repo uses, e.g. `- **`/tdd`** — ...`) that
  names NO manifest skill anywhere — a typo'd or dead name in a router list.

`class: "adapter"` skills (e.g. `codex-adapter-sync`) are exempt from
MISMATCH: their purpose is to be invoked FROM the opposite surface —
Claude-side prose runs the Codex-mirror-sync tool that itself lives only
under `.agents/skills` (manifest note: "published skills reference it as the
Claude→Codex mirror step"). That's the intended direction, not a dangler.

Deliberate exceptions: an inline marker on the line (`Claude Code only`, or
the generic `skill-surface-lint: ok`), or `PROSE_ALLOWLIST` below for
skill-system PROSE in files this slice doesn't touch (each entry carries its
own reason — an explicit, auditable allowlist, not a blanket exemption).

Run: python3 scripts/test_skill_surface_refs.py
"""
import json
import re
import unittest
from pathlib import Path

from test_skill_portability_lint import load_manifest, SKILL_DIRS

REPO_ROOT = Path(__file__).resolve().parent.parent
TREE_SURFACE = {".claude/skills": "claude", ".agents/skills": "codex"}

EXEMPT = "skill-surface-lint: ok"
CLAUDE_ONLY_MARKER = "Claude Code only"

# Slash-tokens a catalog bullet can legitimately name without matching any
# manifest skill: either a real command OUTSIDE this repo's manifest (a
# Claude Code CLI built-in, or — like `handoff` — a skill living in the
# user's global `~/.claude/skills`, never a repo skill directory; ask-matt
# names both, formatted exactly like a real catalog entry, `/compact` even
# self-annotates "(built-in)"), or a documented TEMPLATE PLACEHOLDER in
# third-party (vendored, not ours to rewrite) skill prose — `impeccable`'s
# recommended-actions template repeats `/command-name` as a fill-in-the-blank,
# not a specific skill.
EXTERNAL_COMMANDS = {"compact", "handoff", "command-name"}

# Deliberate skill-system PROSE that NAMES a skill without inviting an
# operator on THIS surface to invoke it — not a routing reference. Each is a
# file this slice does not edit (see #1873 scope); (relpath, distinctive
# line substring, reason).
PROSE_ALLOWLIST = [
    (".agents/skills/ask-matt/SKILL.md",
     "Folder↔upstream-name note:",
     "identity blockquote names its own upstream-name mapping (Matt "
     "Pocock's write-a-skill == upstream writing-great-skills), not a "
     "routing invocation"),
    (".agents/skills/sync-upstream-skills/SKILL.md",
     "write-a-skill` = upstream `writing-great-skills`",
     "folder↔upstream naming-convention example, not an invocation"),
    (".agents/skills/codex-adapter-sync/SKILL.md",
     "grill-with-docs-codex`, `grill-me-codex`, Chase AI's cross-model",
     "rule-doc prose naming the escalation-target-rewrite pattern by "
     "example, describing the very class this lint catches"),
]

# A markdown list item that OPENS with an (optionally bold) backtick
# slash-token — the sole convention every genuine skill-catalog entry in
# this repo uses (`- **`/tdd`** — ...`). Deliberately excludes inline/prose
# slash mentions (route examples, `/tmp`, upstream-repo slugs) which never
# open a bullet this way.
BULLET_ENTRY = re.compile(r"^\s*(?:[-*]|\d+\.)\s+\*{0,2}`([^`\n]+)`")
NAME_SHAPE = re.compile(r"^(/?)([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$")


def escape_name(name: str) -> str:
    return re.escape(name)


def name_pattern(name: str) -> re.Pattern:
    """A backtick-wrapped exact reference (`` `/name` `` or `` `name` ``) OR a
    boundary-guarded bare slash-token — mirrors the proven construction in
    `scripts/lib/audit-refs.mjs`'s `auditSkillNameRefs` (same repo, same
    problem shape: a name match that ignores doc paths / repo slugs, since
    `owner/name` and `skills/name` never satisfy either alternative — the
    char immediately before the match is excluded by the boundary guard)."""
    e = escape_name(name)
    return re.compile(rf"`/?{e}`|(?<![\w/-])/{e}(?![\w-])")


def is_allowlisted(relpath: str, line: str) -> bool:
    return any(relpath == path and substr in line
               for path, substr, _reason in PROSE_ALLOWLIST)


def find_mismatches(surface: str, relpath: str, text: str, manifest: dict) -> list[str]:
    """Lines on `surface` naming a real manifest skill not hosted there."""
    problems = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if EXEMPT in line or CLAUDE_ONLY_MARKER in line or is_allowlisted(relpath, line):
            continue
        for name, entry in manifest.items():
            if entry.get("class") == "adapter":
                continue
            if surface in entry.get("surfaces", []):
                continue
            if name_pattern(name).search(line):
                problems.append(
                    f"{relpath}:{lineno}: `{name}` not hosted on '{surface}' "
                    f"(hosted={entry.get('surfaces', [])}): {line.strip()}")
    return problems


def find_nonexistent(relpath: str, text: str, manifest: dict) -> list[str]:
    """Catalog-style bullets naming a slash-token that matches NO manifest
    skill anywhere and is not a known external command."""
    problems = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if EXEMPT in line:
            continue
        m = BULLET_ENTRY.match(line)
        if not m:
            continue
        shape = NAME_SHAPE.match(m.group(1))
        if not shape or not shape.group(1):
            continue
        name = shape.group(2)
        if name in manifest or name in EXTERNAL_COMMANDS:
            continue
        problems.append(f"{relpath}:{lineno}: `/{name}` names no skill anywhere: {line.strip()}")
    return problems


def iter_skill_markdown():
    """Yield (surface, relpath-as-posix-string, text) for every distributed
    *.md under every skill directory on both trees."""
    for tree in SKILL_DIRS:
        surface = TREE_SURFACE[tree]
        base = REPO_ROOT / tree
        if not base.is_dir():
            continue
        for skill_dir in sorted(p for p in base.iterdir() if p.is_dir()):
            for md in sorted(skill_dir.rglob("*.md")):
                relpath = md.relative_to(REPO_ROOT).as_posix()
                yield surface, relpath, md.read_text(encoding="utf-8")


class PatternDetectorFixtures(unittest.TestCase):
    """Fixture (a)+(c): a manufactured Codex-surface skill naming a
    Claude-only manifest skill is red unmarked, green once marked."""

    MANIFEST = {
        "claude-only-skill": {"class": "vendored", "surfaces": ["claude"]},
        "dual-skill": {"class": "generic", "surfaces": ["claude", "codex"]},
        "the-adapter": {"class": "adapter", "surfaces": ["codex"]},
    }

    def test_unmarked_claude_only_ref_on_codex_surface_is_red(self):
        text = "- **`/claude-only-skill`** — does a thing."
        problems = find_mismatches("codex", "fixture/SKILL.md", text, self.MANIFEST)
        self.assertEqual(len(problems), 1)
        self.assertIn("claude-only-skill", problems[0])

    def test_marked_claude_only_ref_is_green(self):
        text = "- **`/claude-only-skill`** (Claude Code only) — does a thing."
        self.assertEqual(find_mismatches("codex", "fixture/SKILL.md", text, self.MANIFEST), [])

    def test_dual_surface_ref_is_always_green(self):
        text = "- **`/dual-skill`** — does a thing."
        self.assertEqual(find_mismatches("codex", "fixture/SKILL.md", text, self.MANIFEST), [])

    def test_adapter_class_target_is_exempt_both_directions(self):
        text = "run **`/the-adapter`** after editing a skill."
        self.assertEqual(find_mismatches("claude", "fixture/SKILL.md", text, self.MANIFEST), [])

    def test_doc_path_and_repo_slug_are_not_matched(self):
        text = ("see `docs/agents/skills/claude-only-skill.md` or the upstream "
                "repo `someorg/claude-only-skill`")
        self.assertEqual(find_mismatches("codex", "fixture/SKILL.md", text, self.MANIFEST), [])

    def test_generic_exempt_marker_is_line_scoped(self):
        text = "- **`/claude-only-skill`** <!-- skill-surface-lint: ok -->"
        self.assertEqual(find_mismatches("codex", "fixture/SKILL.md", text, self.MANIFEST), [])


class NonexistentFixtures(unittest.TestCase):
    """Fixture (b): a catalog bullet naming a skill that exists nowhere."""

    MANIFEST = {"tdd": {"class": "vendored", "surfaces": ["claude", "codex"]}}

    def test_wholly_nonexistent_skill_bullet_is_red(self):
        text = "- **`/frobnicate-widget`** — does a thing that never existed."
        problems = find_nonexistent("fixture/SKILL.md", text, self.MANIFEST)
        self.assertEqual(len(problems), 1)
        self.assertIn("frobnicate-widget", problems[0])

    def test_known_skill_bullet_is_green(self):
        text = "- **`/tdd`** — test-driven development."
        self.assertEqual(find_nonexistent("fixture/SKILL.md", text, self.MANIFEST), [])

    def test_external_builtin_bullet_is_green(self):
        text = "- **`/handoff`** — compacts the conversation."
        self.assertEqual(find_nonexistent("fixture/SKILL.md", text, self.MANIFEST), [])

    def test_inline_prose_slash_mention_is_not_a_catalog_entry(self):
        text = "falling back to `/tmp` when $TMPDIR is unset."
        self.assertEqual(find_nonexistent("fixture/SKILL.md", text, self.MANIFEST), [])

    def test_route_example_list_is_not_flagged(self):
        text = "- Product signals: `/app/*`, `/dashboard`, `/settings`, forms."
        self.assertEqual(find_nonexistent("fixture/SKILL.md", text, self.MANIFEST), [])

    def test_exempt_marker_line_scoped(self):
        text = "- **`/frobnicate-widget`** <!-- skill-surface-lint: ok -->"
        self.assertEqual(find_nonexistent("fixture/SKILL.md", text, self.MANIFEST), [])


class AllowlistFixtures(unittest.TestCase):
    """Fixture (d): the deliberate skill-system-prose exceptions stay green."""

    MANIFEST = {"write-a-skill": {"class": "vendored", "surfaces": ["claude"]}}

    def test_ask_matt_identity_blockquote_is_allowlisted(self):
        text = ("> Homage. Folder↔upstream-name note: `/diagnose` = upstream "
                "`diagnosing-bugs`, `/write-a-skill` = upstream `writing-great-skills`.")
        problems = find_mismatches(
            "codex", ".agents/skills/ask-matt/SKILL.md", text, self.MANIFEST)
        self.assertEqual(problems, [])

    def test_sync_upstream_skills_naming_note_is_allowlisted(self):
        text = ("e.g. `diagnose` = upstream `diagnosing-bugs`, "
                "`write-a-skill` = upstream `writing-great-skills`")
        problems = find_mismatches(
            "codex", ".agents/skills/sync-upstream-skills/SKILL.md", text, self.MANIFEST)
        self.assertEqual(problems, [])

    def test_codex_adapter_sync_rule_doc_example_is_allowlisted(self):
        text = ("has no `.agents` mirror. Any Codex-side reference to that skill "
                "name is a dangling target (e.g. `grill-with-docs-codex`, "
                "`grill-me-codex`, Chase AI's cross-model Act-2 variants).")
        manifest = {"grill-with-docs-codex": {"class": "vendored", "surfaces": ["claude"]},
                    "grill-me-codex": {"class": "vendored", "surfaces": ["claude"]}}
        problems = find_mismatches(
            "codex", ".agents/skills/codex-adapter-sync/SKILL.md", text, manifest)
        self.assertEqual(problems, [])

    def test_allowlist_does_not_leak_to_other_files(self):
        """The allowlist is (path, substring)-scoped — the SAME prose in a
        DIFFERENT file must still be caught (regression guard)."""
        text = ("e.g. `diagnose` = upstream `diagnosing-bugs`, "
                "`write-a-skill` = upstream `writing-great-skills`")
        problems = find_mismatches("codex", "fixture/other-skill/SKILL.md", text, self.MANIFEST)
        self.assertEqual(len(problems), 1)


class RealRepoSurfaceRefs(unittest.TestCase):
    """The actual repo, end to end: every skill-name reference in every
    SKILL.md resolves on its own surface (AC: green on HEAD)."""

    def test_no_cross_surface_dangling_references(self):
        manifest = load_manifest()["skills"]
        problems = []
        for surface, relpath, text in iter_skill_markdown():
            problems.extend(find_mismatches(surface, relpath, text, manifest))
        self.assertEqual(
            problems, [],
            "skill reference dangles on its own surface — either the target "
            "doesn't ship there (mark `(Claude Code only)` / port a Codex "
            "mirror) or this is deliberate prose (add a PROSE_ALLOWLIST "
            "entry with a reason):\n" + "\n".join(problems))

    def test_no_wholly_nonexistent_catalog_entries(self):
        manifest = load_manifest()["skills"]
        problems = []
        for _surface, relpath, text in iter_skill_markdown():
            problems.extend(find_nonexistent(relpath, text, manifest))
        self.assertEqual(
            problems, [],
            "catalog bullet names a skill that exists on no surface — fix "
            "the name, remove the stale entry, or add it to "
            "EXTERNAL_COMMANDS if it's a real command outside this repo's "
            "manifest:\n" + "\n".join(problems))


if __name__ == "__main__":
    unittest.main(verbosity=2)
