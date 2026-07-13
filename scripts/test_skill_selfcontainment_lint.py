#!/usr/bin/env python3
"""Self-containment lint (Welle 26 / Slice 2 / #986): generic & vendored skills
must be portable.

Why: a published skill (npx/git-clone into a foreign repo, or a plugin cache)
cannot resolve `../../../docs/...` — the path does not exist there and `../`
escapes the plugin root. Project-specific content is found by *runtime
convention* (an inline project-root path like `docs/agents/board-sync.md` that
the model resolves from the project root), never a hardcoded `../` link.
project-private skills are exempt: they live in this repo forever and their
`../` refs are correct and clickable.

Scope: skills whose manifest class is `generic` or `vendored`. Every distributed
`*.md` file in the skill dir is scanned (SKILL.md + support docs), in both the
Claude source (`.claude/skills`) and the Codex mirror (`.agents/skills`).

A line carrying `self-containment-lint: ok` is exempt — line-scoped, for
deliberate "don't do this" doc examples.

Run: python3 scripts/test_skill_selfcontainment_lint.py
"""
import json
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST = REPO_ROOT / ".claude/skills/skill-manifest.json"
SKILL_DIRS = [".claude/skills", ".agents/skills"]
ENFORCED_CLASSES = {"generic", "vendored"}
PUBLISH_CLASSES = {"generic", "vendored", "adapter"}
VALID_CLASSES = {"generic", "vendored", "adapter", "project-private"}
VALID_SURFACES = {"claude", "codex"}

PARENT_REF = re.compile(r"\.\./")
EXEMPT = "self-containment-lint: ok"


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def find_parent_refs(text: str) -> list[tuple[int, str]]:
    """Return (line_no, line) for every line with a `../` reach, minus exempt lines."""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        if EXEMPT in line:
            continue
        if PARENT_REF.search(line):
            out.append((n, line.strip()))
    return out


def skill_dirs_on_disk(tree: str) -> set[str]:
    base = REPO_ROOT / tree
    if not base.is_dir():
        return set()
    # dot-dirs are tool caches (e.g. .impeccable/hook.cache.json, gitignored), not skills
    return {p.name for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")}


class Detector(unittest.TestCase):
    """The `../` detector itself behaves."""

    def test_flags_parent_link(self):
        self.assertEqual(len(find_parent_refs("see [x](../../../docs/y.md)")), 1)

    def test_flags_parent_in_code(self):
        self.assertEqual(len(find_parent_refs("import x from '../lib/y'")), 1)

    def test_ignores_same_dir_relative(self):
        self.assertEqual(find_parent_refs("see [x](./sub/y.md)"), [])

    def test_ignores_root_relative_convention(self):
        # the portable form: an inline project-root path, no `../`
        self.assertEqual(find_parent_refs("read `docs/agents/board-sync.md`"), [])

    def test_exempt_marker_line_scoped(self):
        self.assertEqual(
            find_parent_refs("bad: [x](../y) <!-- self-containment-lint: ok -->"), [])

    def test_exempt_is_line_scoped_not_file_wide(self):
        text = "ok line <!-- self-containment-lint: ok -->\n[x](../../bad)"
        self.assertEqual(len(find_parent_refs(text)), 1)


class ManifestValid(unittest.TestCase):
    def test_schema_and_classes(self):
        m = load_manifest()
        self.assertEqual(m.get("schema_version"), 1)
        for name, entry in m["skills"].items():
            self.assertIn(entry.get("class"), VALID_CLASSES, name)
            self.assertTrue(entry.get("surfaces"), f"{name}: no surfaces")
            for s in entry["surfaces"]:
                self.assertIn(s, VALID_SURFACES, f"{name}:{s}")
            # publish is a mandatory bool — build-kit + lints consume it, not class
            # (Slice 6 / #990 / Codex R2#3+#5).
            self.assertIsInstance(entry.get("publish"), bool,
                                  f"{name}: `publish` must be present and boolean")


class ManifestCompleteness(unittest.TestCase):
    """Manifest <-> filesystem, both trees (Codex R1#4 / R2#1)."""

    def test_every_disk_skill_classified(self):
        m = load_manifest()["skills"]
        problems = [f"{tree}/{d} on disk but missing from manifest"
                    for tree in SKILL_DIRS
                    for d in sorted(skill_dirs_on_disk(tree)) if d not in m]
        self.assertEqual(problems, [], "\n".join(problems))

    def test_every_entry_matches_its_surfaces(self):
        m = load_manifest()["skills"]
        claude = skill_dirs_on_disk(".claude/skills")
        agents = skill_dirs_on_disk(".agents/skills")
        problems = []
        for name, entry in m.items():
            surfaces = set(entry.get("surfaces", []))
            if "claude" in surfaces and name not in claude:
                problems.append(f"{name}: surfaces claude but no .claude/skills/{name}")
            if "codex" in surfaces and name not in agents:
                problems.append(f"{name}: surfaces codex but no .agents/skills/{name}")
            if name in claude and "claude" not in surfaces:
                problems.append(f"{name}: in .claude/skills but surfaces lacks claude")
            if name in agents and "codex" not in surfaces:
                problems.append(f"{name}: in .agents/skills but surfaces lacks codex")
        self.assertEqual(problems, [], "\n".join(problems))


class PublishExclusion(unittest.TestCase):
    """`publish` is authoritative; project-private skills never ship.

    Adapters MAY ship — `adapter` is in PUBLISH_CLASSES (above). A published
    skill can reference an adapter as a real workflow step (to-issues:59 +
    orchestrate-wave -> codex-adapter-sync mirror), in which case build-kit's
    shipped-deps-must-ship check (build-kit.mjs) *requires* the adapter to
    publish — that dependency check is the authoritative consistency guardrail.
    An adapter only ships when something published references it (spark-coordinator
    stays publish:false — nothing published references it). Narrowed from the
    original project-private+adapter rule (#990 R1#10/R2#3/#5) once a published
    skill was found to depend on codex-adapter-sync; the blanket adapter ban
    contradicted both PUBLISH_CLASSES and that dependency."""

    def test_project_private_not_published(self):
        m = load_manifest()["skills"]
        leaks = sorted(n for n, e in m.items()
                       if e["class"] == "project-private" and e.get("publish"))
        self.assertEqual(leaks, [], f"project-private marked publish:true: {leaks}")

    def test_published_skill_dirs_exist_per_surface(self):
        """every publish:true skill exists on disk in each surface it claims."""
        m = load_manifest()["skills"]
        claude = skill_dirs_on_disk(".claude/skills")
        agents = skill_dirs_on_disk(".agents/skills")
        problems = []
        for name, entry in m.items():
            if not entry.get("publish"):
                continue
            if "claude" in entry["surfaces"] and name not in claude:
                problems.append(f"{name}: publish:true, surfaces claude, but missing on disk")
            if "codex" in entry["surfaces"] and name not in agents:
                problems.append(f"{name}: publish:true, surfaces codex, but missing on disk")
        self.assertEqual(problems, [], "\n".join(problems))


class EnforcedSkillsSelfContained(unittest.TestCase):
    """generic & vendored skills carry no `../` reach, all .md files, both trees."""

    def test_no_parent_refs(self):
        m = load_manifest()["skills"]
        enforced = {n for n, e in m.items() if e["class"] in ENFORCED_CLASSES}
        problems = []
        for tree in SKILL_DIRS:
            for name in sorted(enforced):
                d = REPO_ROOT / tree / name
                if not d.is_dir():
                    continue
                for md in sorted(d.rglob("*.md")):
                    for ln, src in find_parent_refs(md.read_text(encoding="utf-8")):
                        problems.append(f"{md.relative_to(REPO_ROOT)}:{ln}: {src}")
        self.assertEqual(
            problems, [],
            "`../` reach in a generic/vendored skill — replace with a project-root "
            "convention path (e.g. `docs/agents/x.md`) + runtime fallback:\n"
            + "\n".join(problems))


class LookupContract(unittest.TestCase):
    """Skills migrated this slice reference project config by a project-root
    convention path (no `../`) AND state a runtime fallback (Codex R2#2)."""

    def test_migrated_skills_have_convention_path_and_fallback(self):
        for name in ("to-prd", "to-issues", "spec-self-critique"):
            txt = (REPO_ROOT / ".claude/skills" / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertRegex(txt, r"docs/(agents|conventions)/",
                             f"{name}: no project-root convention path")
            self.assertIn("/setup-workflow", txt, f"{name}: no fallback")
            # same scanner as the lint (honors the line-scoped exempt marker), not a
            # raw substring — keeps LookupContract consistent with the real check (R2#4)
            self.assertEqual(find_parent_refs(txt), [], f"{name}: still has a parent-dir reach")


class MockRepoLookup(unittest.TestCase):
    """Runtime-lookup contract against a mock consumer repo. The lookup itself is
    a model convention (no resolver to unit-test), so we assert both branches:
    project file present → resolves from the project root; absent → the skill's
    stated fallback path applies."""

    def test_present_resolves_absent_falls_back(self):
        import tempfile
        to_prd = (REPO_ROOT / ".claude/skills/to-prd/SKILL.md").read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "docs/agents/board-sync.md"
            self.assertFalse(target.exists())            # absent → fallback branch
            self.assertIn("/setup-workflow", to_prd)     # skill states the fallback
            target.parent.mkdir(parents=True)
            target.write_text("x", encoding="utf-8")
            self.assertTrue(target.exists())             # present → resolves from root

    def test_spec_self_critique_layer_present_absent(self):
        """spec-self-critique runs with the project layer (full pass) and without
        it (base pass + warning). Text/path contract — the skill names the layer
        path + a fallback; behavior is verified manually in the mock-repo run."""
        import tempfile
        skill = (REPO_ROOT / ".claude/skills/spec-self-critique/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("docs/agents/skills/spec-self-critique.md", skill)  # names the layer
        self.assertIn("/setup-workflow", skill)                            # states the fallback
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "docs/agents/skills/spec-self-critique.md"
            self.assertFalse(target.exists())            # absent → base pass + warning
            target.parent.mkdir(parents=True)
            target.write_text("x", encoding="utf-8")
            self.assertTrue(target.exists())             # present → full pass


class NegativeFixture(unittest.TestCase):
    """A real `../` in a scanned .md file is caught end-to-end (regression guard)."""

    def test_parent_ref_in_md_file_is_flagged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "SKILL.md"
            f.write_text("see [x](../../../docs/y.md)\n", encoding="utf-8")
            self.assertEqual(len(find_parent_refs(f.read_text(encoding="utf-8"))), 1)

    def test_exempt_line_in_md_file_is_not_flagged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "SKILL.md"
            f.write_text("anti: [x](../bad) <!-- self-containment-lint: ok -->\n", encoding="utf-8")
            self.assertEqual(find_parent_refs(f.read_text(encoding="utf-8")), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
