#!/usr/bin/env python3
"""Language census lint (Welle 50 / Slice 6 / #1897).

Mechanical proof that "the published skill prose is English" is COUNTED,
not remembered (HR23 "Vollständigkeit ist gezählt, nicht erinnert" — the same
principle behind `impact-census`, applied here to language instead of
blast-radius).

Denominator (Y): every skill with `publish: true` in the manifest
(`.claude/skills/skill-manifest.json`) — the same SSOT the other skill lints
use (see `test_skill_selfcontainment_lint.py`). Each skill's SKILL.md is read
from whichever surface actually hosts it — `.claude/skills` if `"claude"` is
in its `surfaces`, else `.agents/skills` (the sole surface for a Codex-only
adapter such as `codex-adapter-sync`).

Heuristic: a wordlist of common German function words, scanned whole-word
case-insensitive against the BODY only (frontmatter — the first `---`...`---`
block — is skipped; a skill's `description:` may legitimately quote German
trigger phrases the user actually types, e.g. board-to-waves).

False-positive guard: two short words in the list collide with real English
tokens — `mit` collides with the "MIT" license acronym (always uppercase in
this repo), and `die` collides with the English verb ("logs die"). Both are
treated as WEAK signals: a line is only flagged if it carries a STRONG hit
(a German word with no plausible English reading) or *multiple* WEAK hits
(a coincidence of two independent English collisions on one line is not
realistic). A single stray `mit`/`die` hit alone is not a violation.

Allowlist (each entry is why it's exempt, not prose to translate):

1. **Bilingual PRD example blocks** (`to-prd`) — the template deliberately
   pairs a `lang="de"` user-story example with a `lang="en"` one so a spec
   author can pick their spec's language; lines inside a
   `<user-story-example lang="de">...</user-story-example>` block are
   exempt.
2. **Cross-skill contract literals** kept German on purpose because another
   skill or the board-sync tooling consumes the exact string:
   - `## Vor Bau zu klären` — the `headings.vorBau` profile VALUE
     (`docs/agents/board-sync.md`); `to-issues`/`grill-with-docs(-codex)`/
     `wrapup` all reference this literal heading text.
   - (removed #1947: `In Arbeit`/`Triaged` were exempt as board Status option
     values — shipped skills now speak role language + `--status-role`, the
     vocabulary lives only in the profile's `fields.status.roles`, so the
     exemption is dead and stays removed.)
   - `Welle <N>` — the wave-anchor issue-title format `board-sync.py` parses.
   - `Trigger` / `Check` / `Korrektur` — the `## Self-Critique-Check` block
     format (`Trigger / Check / Korrektur`) that `setup-workflow`'s seed and
     `spec-self-critique` both parse verbatim; matched via a dedicated
     'Trigger/Check/Korrektur' regex, not the generic wordlist (none of
     those three words are in the wordlist itself).
   A line carrying ONLY these literals (no other wordlist hit) is exempt.
3. **`skill-surface-lint`'s `CLAUDE_ONLY_MARKER`** — `test_skill_surface_refs.py`
   greps prose for a literal marker string to suppress a Claude-only-skill
   cross-surface reference. It shipped as the German phrase "nur Claude Code"
   (Welle 26) and is now the English phrase "Claude Code only" (translated
   alongside `ask-matt`, the only skill that carries it, in this slice) — so
   this allowlist class exists for documentation/audit completeness but has
   no live match after the translation.

If the heuristic (after the allowlist) still flags a real hit in a
publish:true body, that is a residual finding: translate it, or — if it's a
genuine additional intentional literal — add it to `LINE_ALLOWLIST_LITERALS`
with a one-line reason.

Run: python3 -m unittest scripts.test_skill_language_census
     (or, from scripts/: python3 test_skill_language_census.py)
"""
import json
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST = REPO_ROOT / ".claude/skills/skill-manifest.json"

# STRONG: German function words with no realistic English reading.
STRONG_WORDS = [
    "der", "das", "und", "nicht", "wird", "werden", "muss", "kein", "oder",
    "für", "über", "eine", "einen", "auch", "nur", "schon",
]
# WEAK: collide with real English tokens (MIT license acronym; "die" the verb).
WEAK_WORDS = ["mit", "die"]

STRONG_PAT = re.compile(r"\b(" + "|".join(STRONG_WORDS) + r")\b", re.IGNORECASE)
WEAK_PAT = re.compile(r"\b(" + "|".join(WEAK_WORDS) + r")\b", re.IGNORECASE)

# Cross-skill contract literals: a line whose ONLY wordlist hit(s) come from
# inside one of these exact literals is exempt (§2 in the module docstring).
CONTRACT_LITERALS = [
    "## Vor Bau zu klären",
]
WAVE_TITLE = re.compile(r"\bWelle\s+\d+\b")

BILINGUAL_BLOCK_START = re.compile(r'<user-story-example\s+lang="de"\s*>')
BILINGUAL_BLOCK_END = re.compile(r"</user-story-example>")

LINE_EXEMPT_MARKER = "language-census: ok"


def load_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def publish_true_skills() -> dict:
    """name -> SKILL.md path, resolved to whichever surface hosts the skill."""
    manifest = load_manifest()["skills"]
    out = {}
    for name, entry in manifest.items():
        if not entry.get("publish"):
            continue
        surfaces = entry.get("surfaces", [])
        tree = ".claude/skills" if "claude" in surfaces else ".agents/skills"
        out[name] = REPO_ROOT / tree / name / "SKILL.md"
    return out


def strip_frontmatter(text: str) -> str:
    """Drop the leading `---`...`---` frontmatter block; description: may
    legitimately quote German trigger phrases (board-to-waves)."""
    if not text.startswith("---"):
        return text
    parts = text.split("---", 2)
    return parts[2] if len(parts) >= 3 else text


def _strip_contract_literals(line: str) -> str:
    """Remove known cross-skill contract literals from a line before wordlist
    matching, so a line consisting only of a literal (e.g. a heading
    `## Vor Bau zu klären`) doesn't trip the census."""
    stripped = line
    for literal in CONTRACT_LITERALS:
        stripped = stripped.replace(literal, "")
    stripped = WAVE_TITLE.sub("", stripped)
    return stripped


def _line_hits(line: str) -> bool:
    """True if this line carries a real (non-allowlisted) German-prose hit."""
    if LINE_EXEMPT_MARKER in line:
        return False
    scan = _strip_contract_literals(line)
    strong = STRONG_PAT.search(scan) is not None
    weak_count = len(WEAK_PAT.findall(scan))
    return strong or weak_count >= 2


def find_violations(name: str, path: Path) -> list:
    """Return [(lineno, line)] of real German-prose hits in a skill body."""
    if not path.is_file():
        return [(0, f"MISSING FILE: {path}")]
    text = path.read_text(encoding="utf-8")
    body = strip_frontmatter(text)

    violations = []
    in_bilingual_de_block = False
    for i, line in enumerate(body.splitlines(), start=1):
        if BILINGUAL_BLOCK_START.search(line):
            in_bilingual_de_block = True
        if in_bilingual_de_block:
            if BILINGUAL_BLOCK_END.search(line):
                in_bilingual_de_block = False
            continue  # allowlist §1: deliberate bilingual example block
        if _line_hits(line):
            violations.append((i, line.strip()))
    return violations


class LanguageCensus(unittest.TestCase):
    def test_all_publish_true_skills_are_english(self):
        skills = publish_true_skills()
        self.assertGreater(len(skills), 0, "no publish:true skills found — manifest read failed?")

        all_violations = {}
        for name, path in sorted(skills.items()):
            v = find_violations(name, path)
            if v:
                all_violations[name] = v

        total = len(skills)
        clean = total - len(all_violations)
        msg_lines = [f"Census: {clean} of {total} publish:true skills English."]
        for name, v in all_violations.items():
            msg_lines.append(f"\n{name}:")
            for lineno, line in v[:10]:
                msg_lines.append(f"  {lineno}: {line[:160]}")
        self.assertEqual(
            all_violations, {},
            "\n".join(msg_lines) +
            "\n\nTranslate the residual German prose, or — if it's a genuine "
            "intentional literal — add it to the allowlist (CONTRACT_LITERALS / "
            "a bilingual-block marker) with a one-line reason, or mark the "
            "single line with `language-census: ok`.",
        )


class HeuristicFixtures(unittest.TestCase):
    """The heuristic + allowlist mechanics, exercised in isolation."""

    def test_strong_word_is_flagged(self):
        self.assertTrue(_line_hits("Diese Änderung ist querschnittig und betrifft alles."))

    def test_single_weak_word_alone_is_not_flagged(self):
        # "MIT" license acronym collides with weak-word "mit"
        self.assertFalse(_line_hits("Adopted from Matt Pocock's skill (MIT license)."))
        # English verb "die" collides with weak-word "die"
        self.assertFalse(_line_hits("Untagged logs survive; tagged logs die."))

    def test_two_weak_words_together_are_flagged(self):
        self.assertTrue(_line_hits("mit der Kampagne verglichen"))

    def test_contract_literal_heading_alone_is_not_flagged(self):
        self.assertFalse(_line_hits("## Vor Bau zu klären"))

    def test_status_option_names_are_no_longer_exempt(self):
        # #1947: `In Arbeit` lost its contract-literal exemption — shipped
        # skills speak role language, so German option names in prose are a
        # finding again ("Arbeit" itself is not in the wordlist; the article
        # trips it, exactly like any other German prose).
        self.assertTrue(_line_hits("verschiebe das Item auf `In Arbeit`"))
        # An option name that carries no wordlist token stays invisible to the
        # heuristic — the census is a German-prose net, not a name detector.
        self.assertFalse(_line_hits("status `Triaged`"))

    def test_wave_title_alone_is_not_flagged(self):
        self.assertFalse(_line_hits("title **without** a `Welle 42` prefix"))

    def test_contract_literal_plus_real_prose_is_still_flagged(self):
        self.assertTrue(_line_hits("## Vor Bau zu klären und weitere Fragen für den Nutzer"))

    def test_inline_exempt_marker_suppresses_the_line(self):
        self.assertFalse(_line_hits("Dies ist deutsch und bleibt es.  <!-- language-census: ok -->"))

    def test_frontmatter_is_stripped(self):
        text = (
            "---\n"
            "name: x\n"
            'description: Use when "lass uns das Board durchgehen".\n'
            "---\n\n"
            "Body is English only.\n"
        )
        body = strip_frontmatter(text)
        self.assertNotIn("lass uns das Board durchgehen", body)

    def test_bilingual_example_block_is_exempt(self):
        path = REPO_ROOT / ".claude/skills/to-prd/SKILL.md"
        if not path.is_file():
            self.skipTest("to-prd SKILL.md not present")
        violations = find_violations("to-prd", path)
        flagged_lines = "\n".join(line for _, line in violations)
        self.assertNotIn("Als QA-Lead", flagged_lines)


if __name__ == "__main__":
    unittest.main(verbosity=2)
