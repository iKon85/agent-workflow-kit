#!/usr/bin/env python3
"""Portability lint v2 (Welle 26 / Slice 2 follow-up / #1019): generic & vendored
skills must carry NO hardcoded, project-coupled board CONSTANTS.

Why: a published skill (npx/git-clone into a foreign repo, or a plugin cache)
must read every board-specific value from the project profile
(`docs/agents/board-sync.md`, parsed by `scripts/board_config.py`,
`/setup-workflow`-seeded per consumer), NEVER an inline constant. An opaque
board/project/field node id or a status/wave/cluster option hash means NOTHING
in another repo — and these specific tokens slip past BOTH existing nets: the
publish scrub (`scripts/lib/scrub.mjs`) does not touch them, and the publish
audit only denies 40+-char hex, so an 8-hex option id would ship silently. This
lint closes that gap AT THE SOURCE, in both the Claude tree (`.claude/skills`)
and the Codex mirror (`.agents/skills`).

Scope: skills whose manifest class is `generic` or `vendored`. Owner/repo/domain
tokens are deliberately NOT re-detected here — they are already double-covered
(scrub + publish audit) and survive at source only inside runnable example
commands. Generic label vocab (`type:cluster`, `ready-for-agent`, `wave-stub`)
is a shipped convention, not a leak, and is out of scope.

A line carrying `portability-lint: ok` is exempt — line-scoped, for deliberate
doc counterexamples.

This file also asserts mirror parity:
- every dual-surface skill has the same set of distributed `*.md` files in both
  trees (catches a forgotten mirror file);
- generic/vendored dual-surface skill bodies match after stripping paired
  `mirror-xform` regions. The paired marker convention lets codex-adapter-sync
  keep legitimate Codex body translations local instead of maintaining a central
  model-mapping table.

Run: python3 scripts/test_skill_portability_lint.py
"""
import importlib.util
import json
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST = REPO_ROOT / ".claude/skills/skill-manifest.json"

# Profile-VALUE literal scan (#1878, Welle 49 Slice 7) — extracted to its own
# module (see docstring there) rather than growing this already-large file;
# loaded via spec_from_file_location (test_board_config.py convention) so it
# resolves regardless of how this test file itself is invoked.
_PVL_SPEC = importlib.util.spec_from_file_location(
    "portability_profile_scan", Path(__file__).parent / "portability_profile_scan.py")
pvl = importlib.util.module_from_spec(_PVL_SPEC)
_PVL_SPEC.loader.exec_module(pvl)

SKILL_DIRS = [".claude/skills", ".agents/skills"]
ENFORCED_CLASSES = {"generic", "vendored"}
EXEMPT = "portability-lint: ok"
MIRROR_XFORM_START = re.compile(r"^\s*<!--\s*mirror-xform:start(?:\s+([^>]*?))?\s*-->\s*$")
MIRROR_XFORM_END = re.compile(r"^\s*<!--\s*mirror-xform:end\s*-->\s*$")

# Opaque, project-coupled board constants — meaningless in a foreign repo.
CONSTANT_PATTERNS = [
    # GitHub Projects v2 node/field ids: PVT_… (project), PVTSSF_… (single-select
    # field), PVTF_… (field). e.g. PVT_kwHOAuH31M4BVtcf, PVTSSF_lAHO…, PVTF_lAHO…
    ("board/project/field node id", re.compile(r"PVT(?:SSF|F)?_[A-Za-z0-9]+")),
    # status/wave/cluster single-select OPTION ids: bare 8-hex (e.g. 1db44002).
    # Hex colors are 6, full SHAs 40 (no \b…\b match inside a longer run), so this
    # is tight. A legitimate 8-hex (rare) gets the line-scoped exempt marker.
    ("status/option id hash", re.compile(r"\b[0-9a-f]{8}\b")),
]


def find_constants(text: str) -> list[tuple[int, str, str]]:
    """Return (line_no, label, line) for every project-coupled constant found,
    minus lines carrying the exempt marker."""
    out = []
    for n, line in enumerate(text.splitlines(), 1):
        if EXEMPT in line:
            continue
        for label, pat in CONSTANT_PATTERNS:
            if pat.search(line):
                out.append((n, label, line.strip()))
    return out


# board-sync.py invocations in shipped skill prose must use `--status-role
# <role>` (resolved via the profile's fields.status.roles), never a literal
# option NAME — a name is board-private vocabulary and breaks on any board
# that names its stages differently (#1947, ADR-0057). `--status <name>`
# stays legal in scripts/docs for free-name use; in SHIPPED skill bodies it
# is a leak. Line-scoped exempt marker for deliberate free-name examples.
STATUS_LITERAL_CMD = re.compile(r"board-sync\.py.*--status(?!-role)\s+\S")


def find_status_literal_commands(text: str) -> list[tuple[int, str]]:
    """(line_no, line) for every shipped `board-sync.py ... --status <literal>`
    command, minus exempt-marked lines. Shell continuations (trailing `\\`)
    are joined first — skills wrap long board-sync.py calls over several
    lines, and a `--status Spec` on a continuation line is the same leak."""
    joined: list[tuple[int, str]] = []
    for n, line in enumerate(text.splitlines(), 1):
        if joined and joined[-1][1].rstrip().endswith("\\"):
            first_n, prev = joined[-1]
            joined[-1] = (first_n, prev.rstrip().rstrip("\\") + " " + line.strip())
        else:
            joined.append((n, line))
    out = []
    for n, line in joined:
        if EXEMPT in line:
            continue
        if STATUS_LITERAL_CMD.search(line):
            out.append((n, line.strip()))
    return out


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def markdown_body(text: str) -> str:
    lines = text.splitlines()
    if lines and lines[0] == "---":
        for i, line in enumerate(lines[1:], 1):
            if line == "---":
                return "\n".join(lines[i + 1:]).strip()
    return text.strip()


def strip_mirror_xform_regions(text: str) -> str:
    out = []
    in_region = False
    for line in text.splitlines():
        if MIRROR_XFORM_START.match(line):
            if in_region:
                raise ValueError("nested mirror-xform region")
            in_region = True
            continue
        if MIRROR_XFORM_END.match(line):
            if not in_region:
                raise ValueError("mirror-xform end without start")
            in_region = False
            continue
        if not in_region:
            out.append(line.rstrip())
    if in_region:
        raise ValueError("mirror-xform start without end")
    return "\n".join(out).strip()


def normalized_mirror_body(text: str) -> str:
    return strip_mirror_xform_regions(markdown_body(text))


def mirror_xform_sequence(text: str) -> list[str]:
    seq = []
    in_region = False
    for line in markdown_body(text).splitlines():
        start = MIRROR_XFORM_START.match(line)
        if start:
            if in_region:
                raise ValueError("nested mirror-xform region")
            seq.append((start.group(1) or "").strip())
            in_region = True
            continue
        if MIRROR_XFORM_END.match(line):
            if not in_region:
                raise ValueError("mirror-xform end without start")
            in_region = False
    if in_region:
        raise ValueError("mirror-xform start without end")
    return seq


def mirror_content_drift(name: str, rel: str, claude_text: str, codex_text: str) -> list[str]:
    try:
        claude_seq = mirror_xform_sequence(claude_text)
        codex_seq = mirror_xform_sequence(codex_text)
        if claude_seq != codex_seq:
            return [f"{name}/{rel}: mirror-xform marker mismatch"]
        claude = normalized_mirror_body(claude_text)
        codex = normalized_mirror_body(codex_text)
    except ValueError as exc:
        return [f"{name}/{rel}: invalid mirror-xform marker: {exc}"]
    if claude == codex:
        return []
    return [f"{name}/{rel}: unmarked mirror content drift"]


HEADING_RE = re.compile(r"^#{1,6} .*$", re.MULTILINE)


def heading_sequence(text: str) -> list[str]:
    """Ordered list of markdown section-heading lines (any level), after
    stripping frontmatter and paired mirror-xform regions."""
    return HEADING_RE.findall(normalized_mirror_body(text))


def structure_drift(name: str, rel: str, claude_text: str, codex_text: str) -> list[str]:
    """Section-heading-only parity check (Welle 49 / #1874): lighter than
    mirror_content_drift — a project-private dual-surface skill is allowed to
    have Codex-specific body wording, but its section STRUCTURE (the ordered
    heading list) must still match, or an unmirrored section silently exists
    on only one surface (#1593: api-contracts carried a 21-line
    DB-column-rename section on the Claude side only)."""
    try:
        claude_seq = mirror_xform_sequence(claude_text)
        codex_seq = mirror_xform_sequence(codex_text)
        if claude_seq != codex_seq:
            return [f"{name}/{rel}: mirror-xform marker mismatch"]
        claude_headings = heading_sequence(claude_text)
        codex_headings = heading_sequence(codex_text)
    except ValueError as exc:
        return [f"{name}/{rel}: invalid mirror-xform marker: {exc}"]
    if claude_headings == codex_headings:
        return []
    return [f"{name}/{rel}: structure drift — section headings differ "
            f"(claude={claude_headings!r} codex={codex_headings!r})"]


def enforced_skills() -> set[str]:
    return {n for n, e in load_manifest()["skills"].items()
            if e["class"] in ENFORCED_CLASSES}


def skill_md_set(tree: str, name: str) -> set[str]:
    """Relative posix paths of every distributed *.md under one tree's skill dir."""
    d = REPO_ROOT / tree / name
    if not d.is_dir():
        return set()
    return {p.relative_to(d).as_posix() for p in d.rglob("*.md")}


def dual_surface_skills() -> list[str]:
    """Skills the manifest hosts on BOTH the Claude and Codex surfaces."""
    return [n for n, e in load_manifest()["skills"].items()
            if {"claude", "codex"} <= set(e.get("surfaces", []))]


def enforced_dual_surface_skills() -> list[str]:
    """Portable dual-surface skills whose mirrors must stay content-synced."""
    enforced = enforced_skills()
    return [n for n in dual_surface_skills() if n in enforced]


def project_private_dual_surface_skills() -> list[str]:
    """project-private dual-surface skills — outside ENFORCED_CLASSES, so
    MirrorContentParity never checks them and a section can drift onto only
    one surface unnoticed (#1874). Structure-parity (below) covers them."""
    manifest = load_manifest()["skills"]
    return [n for n in dual_surface_skills() if manifest[n]["class"] == "project-private"]


# project-private dual-surface skills whose Codex mirror is a documented FULL
# adaptation — not a section-local mirror-xform transform — and are therefore
# exempt from structure-parity entirely (MirrorPresenceParity's file-set check
# still applies). Each entry needs a one-line reason; keep in lockstep with
# the skill-manifest note that documents the divergence.
STRUCTURE_PARITY_FULL_ADAPTATION_EXEMPT = {
    # NOTE: orchestrate-wave was here while project-private with a full Codex
    # adaptation. It is now generic/published (#1958) → it sits inside
    # ENFORCED_CLASSES, so MirrorContentParity enforces full body parity and the
    # Codex mirror is a codex-adapter-sync content-identical copy (differences
    # only inside paired mirror-xform regions). No structure-parity exemption.
    # manifest note: "local third-party frontend design skill installed on
    # Claude, Codex, and GitHub skill surfaces" — the Codex mirror carries its
    # own extensive Codex-only sections (sub-agent gate, Run Notes, AGENTS.md
    # vs CLAUDE.md, `$command` vs `/command`) installed independently of
    # codex-adapter-sync, not a local transform (#1874 census).
    "impeccable",
}


class Detector(unittest.TestCase):
    """The constant detector itself behaves."""

    def test_flags_project_node_id(self):
        hits = find_constants("nodeId PVT_kwHOAuH31M4BVtcf")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][1], "board/project/field node id")

    def test_flags_single_select_field_id(self):
        self.assertEqual(len(find_constants("status PVTSSF_lAHOAuH31M4BVtcfzhRHT")), 1)

    def test_flags_option_hash(self):
        hits = find_constants("Triaged: 1db44002")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][1], "status/option id hash")

    def test_ignores_hex_color(self):
        self.assertEqual(find_constants("color #0f172a and #dc2626"), [])

    def test_ignores_clean_convention_path(self):
        self.assertEqual(find_constants("read `docs/agents/board-sync.md`"), [])

    def test_exempt_marker_line_scoped(self):
        self.assertEqual(
            find_constants("bad PVT_kwHOAuH31M4BVtcf <!-- portability-lint: ok -->"), [])

    def test_exempt_is_line_scoped_not_file_wide(self):
        text = "ok PVT_a1b2c3 <!-- portability-lint: ok -->\nleak 1db44002"
        self.assertEqual(len(find_constants(text)), 1)


class ProfileValueLiteralDetector(unittest.TestCase):
    """The profile-VALUE literal detector (portability_profile_scan.py, #1878)
    behaves — a published skill must reference `prMarkers.retroValues` /
    `headings.vorBau` by KEY, never mandate the configured VALUE."""

    def test_flags_mandated_retro_value(self):
        hits = pvl.find_profile_value_literals(
            "add the line `**Retro:** `gefahren` — Findings unter ## Retro")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][1], "prMarkers.retroValues literal")

    def test_flags_mandated_vorbau_heading(self):
        hits = pvl.find_profile_value_literals(
            "set the leaf to HITL, add `## Vor Bau zu klären`")
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][1], "headings.vorBau literal")

    def test_ignores_key_referenced_retro_value(self):
        text = ("one of the `prMarkers.retroValues` words (testreporter aktuell "
                 "`gefahren`/`übersprungen`)")
        self.assertEqual(pvl.find_profile_value_literals(text), [])

    def test_ignores_key_referenced_vorbau_heading(self):
        text = "the `headings.vorBau` heading (testreporter aktuell `Vor Bau zu klären`)"
        self.assertEqual(pvl.find_profile_value_literals(text), [])

    def test_ignores_plain_german_verb_gefahren(self):
        """'gefahren' unquoted is the ordinary German past participle of
        'fahren' ('Retro schon gefahren?') — not the retroValues literal."""
        self.assertEqual(
            pvl.find_profile_value_literals("Retro schon gefahren? (a) ja / weiter"), [])

    def test_exempt_marker_line_scoped(self):
        text = "add `## Vor Bau zu klären` <!-- portability-lint: ok -->"
        self.assertEqual(pvl.find_profile_value_literals(text), [])


class StatusLiteralCommandDetector(unittest.TestCase):
    """The `--status <literal>` command detector (#1947) behaves."""

    def test_flags_status_literal_command(self):
        hits = find_status_literal_commands(
            "python3 scripts/board-sync.py add --issue 5 --status Spec")
        self.assertEqual(len(hits), 1)

    def test_flags_quoted_literal(self):
        self.assertEqual(len(find_status_literal_commands(
            "board-sync.py add --issue <n> --status 'In Arbeit'")), 1)

    def test_ignores_status_role_form(self):
        self.assertEqual(find_status_literal_commands(
            "python3 scripts/board-sync.py add --issue 5 --status-role spec"), [])

    def test_ignores_status_mention_without_command(self):
        # prose about the Status field, no board-sync.py invocation
        self.assertEqual(find_status_literal_commands(
            "the board Status field moves to the in-progress role"), [])

    def test_exempt_marker_line_scoped(self):
        self.assertEqual(find_status_literal_commands(
            "board-sync.py add --status MyName <!-- portability-lint: ok -->"), [])

    def test_flags_literal_on_shell_continuation_line(self):
        text = ('python3 scripts/board-sync.py create --title "t" \\\n'
                "  --status Triaged\n")
        hits = find_status_literal_commands(text)
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0][0], 1)

    def test_status_role_on_continuation_is_clean(self):
        text = ('python3 scripts/board-sync.py create --title "t" \\\n'
                "  --status-role triaged\n")
        self.assertEqual(find_status_literal_commands(text), [])


class EnforcedSkillsPortable(unittest.TestCase):
    """generic & vendored skills carry no opaque board constant, all .md, both trees."""

    def test_no_status_literal_commands_in_shipped_skills(self):
        enforced = enforced_skills()
        problems = []
        for tree in SKILL_DIRS:
            for name in sorted(enforced):
                d = REPO_ROOT / tree / name
                if not d.is_dir():
                    continue
                for md in sorted(d.rglob("*.md")):
                    for ln, src in find_status_literal_commands(
                            md.read_text(encoding="utf-8")):
                        problems.append(f"{md.relative_to(REPO_ROOT)}:{ln}: {src}")
        self.assertEqual(
            problems, [],
            "shipped board-sync.py command with a status-NAME literal — use "
            "`--status-role <idea|triaged|spec|inProgress|review|done>` (resolved via "
            "the profile's fields.status.roles) instead, or exempt a deliberate "
            "free-name example with `<!-- portability-lint: ok -->`:\n"
            + "\n".join(problems))

    def test_no_hardcoded_constants(self):
        enforced = enforced_skills()
        problems = []
        for tree in SKILL_DIRS:
            for name in sorted(enforced):
                d = REPO_ROOT / tree / name
                if not d.is_dir():
                    continue
                for md in sorted(d.rglob("*.md")):
                    for ln, label, src in find_constants(md.read_text(encoding="utf-8")):
                        problems.append(f"{md.relative_to(REPO_ROOT)}:{ln}: {label}: {src}")
        self.assertEqual(
            problems, [],
            "hardcoded board constant in a generic/vendored skill — read it from the "
            "project profile (docs/agents/board-sync.md via scripts/board_config.py) "
            "instead, or exempt a deliberate doc example with "
            "`<!-- portability-lint: ok -->`:\n" + "\n".join(problems))

    def test_no_hardcoded_profile_value_literals(self):
        enforced = enforced_skills()
        problems = []
        for tree in SKILL_DIRS:
            for name in sorted(enforced):
                d = REPO_ROOT / tree / name
                if not d.is_dir():
                    continue
                for md in sorted(d.rglob("*.md")):
                    for ln, label, src in pvl.find_profile_value_literals(
                            md.read_text(encoding="utf-8")):
                        problems.append(f"{md.relative_to(REPO_ROOT)}:{ln}: {label}: {src}")
        self.assertEqual(
            problems, [],
            "hardcoded profile-VALUE literal (prMarkers.retroValues / headings.vorBau) "
            "in a generic/vendored skill — reference the profile KEY instead (see "
            "docs/agents/board-sync.md), or exempt a deliberate doc example with "
            "`<!-- portability-lint: ok -->`:\n" + "\n".join(problems))


class NegativeFixture(unittest.TestCase):
    """A real constant in a scanned .md is caught end-to-end (regression guard)."""

    def test_planted_node_id_is_flagged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "SKILL.md"
            f.write_text("project PVT_kwHOAuH31M4BVtcf\n", encoding="utf-8")
            self.assertEqual(len(find_constants(f.read_text(encoding="utf-8"))), 1)

    def test_exempt_line_in_md_is_not_flagged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "SKILL.md"
            f.write_text("ex PVT_x1y2 <!-- portability-lint: ok -->\n", encoding="utf-8")
            self.assertEqual(find_constants(f.read_text(encoding="utf-8")), [])


class ProfileValueLiteralNegativeFixture(unittest.TestCase):
    """A mandated profile-value literal in a scanned .md is caught end-to-end
    (regression guard, #1878) — and a profile-key reference stays green."""

    def test_planted_mandatory_heading_literal_is_flagged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "SKILL.md"
            f.write_text("HITL: add `## Vor Bau zu klären`\n", encoding="utf-8")
            self.assertEqual(
                len(pvl.find_profile_value_literals(f.read_text(encoding="utf-8"))), 1)

    def test_key_referenced_heading_in_md_is_not_flagged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "SKILL.md"
            f.write_text(
                "HITL: add the `headings.vorBau` heading (testreporter aktuell "
                "`## Vor Bau zu klären`)\n", encoding="utf-8")
            self.assertEqual(pvl.find_profile_value_literals(f.read_text(encoding="utf-8")), [])

    def test_exempt_marker_in_md_is_not_flagged(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "SKILL.md"
            f.write_text(
                "HITL: add `## Vor Bau zu klären` <!-- portability-lint: ok -->\n",
                encoding="utf-8")
            self.assertEqual(pvl.find_profile_value_literals(f.read_text(encoding="utf-8")), [])


class MirrorPresenceParity(unittest.TestCase):
    """LEAN mirror parity: a dual-surface skill has the SAME set of distributed
    *.md files in both trees. Presence/file-set only — not content (codex-adapter-sync
    legitimately translates body model-dispatch; full content parity is a follow-up).
    Catches a forgotten / orphaned mirror file (Codex R1#11 first half)."""

    def test_dual_surface_md_filesets_match(self):
        problems = []
        for name in sorted(dual_surface_skills()):
            claude = skill_md_set(".claude/skills", name)
            codex = skill_md_set(".agents/skills", name)
            only_claude = claude - codex
            only_codex = codex - claude
            for f in sorted(only_claude):
                problems.append(f"{name}: .claude/skills/{name}/{f} has no codex mirror")
            for f in sorted(only_codex):
                problems.append(f"{name}: .agents/skills/{name}/{f} has no claude source")
        self.assertEqual(
            problems, [],
            "mirror file-set drift — run codex-adapter-sync to add/remove the mirror "
            "file:\n" + "\n".join(problems))


class MirrorContentParity(unittest.TestCase):
    """Dual-surface generic/vendored skills keep body content mirrored.

    Codex-specific rewrites are allowed only inside paired `mirror-xform` regions;
    frontmatter stays covered by the Codex skill-frontmatter validation.
    """

    def test_dual_surface_markdown_body_content_matches(self):
        problems = []
        for name in sorted(enforced_dual_surface_skills()):
            for rel in sorted(skill_md_set(".claude/skills", name)):
                claude = REPO_ROOT / ".claude/skills" / name / rel
                codex = REPO_ROOT / ".agents/skills" / name / rel
                if not codex.exists():
                    continue
                problems.extend(mirror_content_drift(
                    name,
                    rel,
                    claude.read_text(encoding="utf-8"),
                    codex.read_text(encoding="utf-8"),
                ))
        self.assertEqual(
            problems,
            [],
            "unmarked mirror content drift — run codex-adapter-sync to refresh the "
            "mirror, or bracket an intentional source/mirror rewrite with paired "
            "`<!-- mirror-xform:start <reason> -->` / `<!-- mirror-xform:end -->` "
            "regions:\n" + "\n".join(problems))


class MirrorParityFixture(unittest.TestCase):
    """The file-set comparison catches an orphaned mirror file (regression guard)."""

    def test_extra_mirror_file_is_detected(self):
        claude = {"SKILL.md", "tests.md"}
        codex = {"SKILL.md"}
        self.assertEqual(claude - codex, {"tests.md"})
        self.assertEqual(codex - claude, set())


class MirrorContentParityFixture(unittest.TestCase):
    """Content parity catches functional source/mirror drift."""

    def test_unmarked_deleted_paragraph_is_detected(self):
        claude = """---
name: example
description: A Claude source description.
---

# Example

Keep this paragraph.

This behavior must stay mirrored.
"""
        codex = """---
name: example
description: "A Codex-safe quoted description."
---

# Example

Keep this paragraph.
"""
        self.assertTrue(mirror_content_drift("example", "SKILL.md", claude, codex))

    def test_marked_transform_region_is_ignored(self):
        claude = """---
name: example
description: A Claude source description.
---

# Example

Keep this paragraph.

<!-- mirror-xform:start codex-dispatch -->
Use the Agent tool with model: sonnet.
<!-- mirror-xform:end -->

Continue here.
"""
        codex = """---
name: example
description: "A Codex-safe quoted description."
---

# Example

Keep this paragraph.

<!-- mirror-xform:start codex-dispatch -->
Use spawn_agent with model: gpt-5.4-mini.
<!-- mirror-xform:end -->

Continue here.
"""
        self.assertEqual(mirror_content_drift("example", "SKILL.md", claude, codex), [])

    def test_unpaired_transform_marker_is_detected(self):
        claude = """# Example

Keep this paragraph.

<!-- mirror-xform:start missing-codex-pair -->
This behavior must stay mirrored.
<!-- mirror-xform:end -->
"""
        codex = """# Example

Keep this paragraph.
"""
        self.assertTrue(mirror_content_drift("example", "SKILL.md", claude, codex))


class StructureParityFixture(unittest.TestCase):
    """Structure-parity (Welle 49 / #1874) catches a section artificially
    removed on one side — project-private skills sit outside
    MirrorContentParity's ENFORCED_CLASSES, so only the section HEADING list
    is compared, not full body wording."""

    def test_removed_heading_is_detected(self):
        claude = """---
name: example
description: A Claude source description.
---

# Example

## Kept Section

Body text.

## Only On Claude

This section was never mirrored to Codex (#1593-shaped drift).
"""
        codex = """---
name: example
description: "A Codex-safe quoted description."
---

# Example

## Kept Section

Body text.
"""
        self.assertTrue(structure_drift("example", "SKILL.md", claude, codex))

    def test_reworded_body_with_matching_headings_is_not_flagged(self):
        claude = """# Example

## Kept Section

Body text differs but headings match.
"""
        codex = """# Example

## Kept Section

Different body wording is fine here — structure-parity only compares headings.
"""
        self.assertEqual(structure_drift("example", "SKILL.md", claude, codex), [])

    def test_mirror_xform_region_headings_are_ignored(self):
        claude = """# Example

## Kept Section

<!-- mirror-xform:start codex-dispatch -->
## Claude-Only Subsection Inside Xform

Uses the Agent tool.
<!-- mirror-xform:end -->

## After
"""
        codex = """# Example

## Kept Section

<!-- mirror-xform:start codex-dispatch -->
## Codex-Only Subsection Inside Xform

Uses spawn_agent.
<!-- mirror-xform:end -->

## After
"""
        self.assertEqual(structure_drift("example", "SKILL.md", claude, codex), [])


class StructureParityProjectPrivate(unittest.TestCase):
    """project-private dual-surface skills (drizzle, migrations, api-contracts,
    ...) sit outside MirrorContentParity's ENFORCED_CLASSES ({generic,
    vendored}), so a documented section can silently exist on only one
    surface — api-contracts' #1593 DB-column-rename section was Claude-only
    until #1874. This compares SECTION HEADINGS ONLY (not full body content)
    after stripping mirror-xform regions, so a deliberately-adapted Codex
    mirror (different wording, same structure) stays legal. Skills that are
    documented FULL rewrites (STRUCTURE_PARITY_FULL_ADAPTATION_EXEMPT, e.g.
    orchestrate-wave) are exempt outright."""

    def test_dual_surface_section_headings_match(self):
        problems = []
        for name in sorted(project_private_dual_surface_skills()):
            if name in STRUCTURE_PARITY_FULL_ADAPTATION_EXEMPT:
                continue
            claude_files = skill_md_set(".claude/skills", name)
            codex_files = skill_md_set(".agents/skills", name)
            for rel in sorted(claude_files & codex_files):
                claude = REPO_ROOT / ".claude/skills" / name / rel
                codex = REPO_ROOT / ".agents/skills" / name / rel
                problems.extend(structure_drift(
                    name,
                    rel,
                    claude.read_text(encoding="utf-8"),
                    codex.read_text(encoding="utf-8"),
                ))
        self.assertEqual(
            problems,
            [],
            "dual-surface section-heading drift on a project-private skill — sync "
            "the missing/changed section onto the other surface, bracket a "
            "deliberate rewrite in a paired `<!-- mirror-xform:start <reason> -->` "
            "/ `<!-- mirror-xform:end -->` region, or add a documented entry to "
            "STRUCTURE_PARITY_FULL_ADAPTATION_EXEMPT for a full-rewrite skill:\n"
            + "\n".join(problems))


class InlineSizeThresholdBan(unittest.TestCase):
    """#1419: the max-lines size threshold is a single SSOT (`maxLines` in
    max-lines-allowlist.json). New kit code/skills/templates must READ it, never
    re-hardcode it as an assignment — else a consumer with a different profile
    silently runs the wrong gate. Narrowly scoped to the `max[-_]lines [:=] 300`
    DEFINITION form so it cannot false-positive on unrelated 300s (ports, timeouts)."""

    THRESHOLD_RE = re.compile(r"max[-_]?[lL]ines\s*[:=]\s*300")
    SCAN_GLOBS = [
        ("scripts", "*.py"),
        (".claude/skills", "**/*.md"),
        (".agents/skills", "**/*.md"),
        ("docs/agents", "*.md"),
    ]
    SSOT = "max-lines-allowlist.json"

    def test_no_hardcoded_size_threshold_outside_ssot(self):
        hits = []
        for sub, glob in self.SCAN_GLOBS:
            for path in (REPO_ROOT / sub).glob(glob):
                if path.name == self.SSOT:
                    continue
                for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                    if EXEMPT in line:
                        continue
                    if self.THRESHOLD_RE.search(line):
                        hits.append(f"{path.relative_to(REPO_ROOT)}:{i}: {line.strip()}")
        self.assertEqual(hits, [], "hardcoded size threshold — read maxLines from "
                         f"{self.SSOT} instead (or add `{EXEMPT}`):\n" + "\n".join(hits))


if __name__ == "__main__":
    unittest.main(verbosity=2)
