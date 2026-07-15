#!/usr/bin/env python3
"""Fail-closed publish audit for dist-kit/ (Welle 26 / Slice 6 / #990, Step 13).

The scrub (scripts/lib/scrub.mjs) removes project-private tokens at build time;
THIS audit is the BACKSTOP — it scans the assembled dist-kit/ and DENIES the
publish if anything private survived. Scrub may be imperfect; this fails loud so
nothing private ever ships silently.

Deny classes (each with a negative fixture below):
  - private repo slug `iKon85/Testreporter` + the bare project name
  - board node/field IDs (`PVT…`) + status/wave/cluster option hashes
  - private deploy domains (`*.iverra.de`), Coolify
  - email addresses
  - absolute home paths (`/home/<user>`)
  - residual issue refs (`#NNN`) / hard-rule refs (`HRn`)
  - unresolvable provenance cross-refs (`ADR-####` / `Welle N` / `Slice N`),
    with a documented fixture/example allowlist (PROVENANCE_FIXTURE_SUFFIXES)
  - `../` cross-skill reaches (skills/scripts/docs — NOT the CLI src, which
    legitimately imports `../lib/…`)
  - bare owner/maintainer names OUTSIDE the generated credit files
  - high-entropy secrets (after exempting the manifest's own sha256 file-hashes)

Allowlisted: the PUBLIC repo slug `iKon85/agent-workflow-kit`.
File-exempt (credits legitimately name people): LICENSE, README.md, PROVENANCE.md,
THIRD-PARTY-NOTICES.md — but these still may NOT carry board IDs / domains /
secrets / the private repo slug.

Run: python3 scripts/test_skill_publish_audit.py
"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC_SLUG = "iKon85/agent-workflow-kit"
CREDIT_FILES = {"LICENSE", "README.md", "PROVENANCE.md", "THIRD-PARTY-NOTICES.md"}
PRIVATE_SKILLS = {
    "drizzle", "migrations", "forecast-logic", "bug-bucketing", "iverra-brand",
    "ui-ux-pro-max",
}
# pin SHAs are legitimate attribution (full forms exempted from high-entropy)
KNOWN_PIN_HASHES = {
    "2bf70051928429983de3b5718d277150926f8c89",
    "ba71f82e8469395d3f7c4ed824334b16676e87a0",
}

# (label, regex) — denied EVERYWHERE, even in credit files.
HARD_DENY = [
    ("private repo slug", re.compile(r"iKon85/Testreporter")),
    ("board node/field id", re.compile(r"PVT(?:SSF|F)?_[A-Za-z0-9]")),
    ("private deploy domain", re.compile(r"[A-Za-z0-9.-]*\.iverra\.de")),
    ("Coolify reference", re.compile(r"\bCoolify\b")),
    ("email address", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("absolute home path", re.compile(r"/home/[A-Za-z0-9._-]+")),
    ("home-encoded project slug", re.compile(r"-home-[a-z0-9]+-projects")),
    ("issue ref", re.compile(r"#\d{3,5}\b")),
    ("hard-rule ref", re.compile(r"\bHR\d+\b")),
    ("project name", re.compile(r"[Tt]estreporter")),
    ("kit issue ref", re.compile(r"\bkit#\d+\b")),
]
# Provenance cross-refs a kit consumer cannot resolve (no docs/adr dir, no wave
# history). Denied EVERYWHERE except the documented fixture/example files below,
# where a Welle/Slice/ADR token is legitimate CONTENT — synthetic PRD scenarios,
# a template placeholder, illustrative ADR names, or board-sync's wave-prefix
# parser examples — not project provenance. Keep in sync with scrub.mjs's PROV
# class (which strips citation-shaped provenance from every other body/script).
PROVENANCE_DENY = [
    ("ADR ref", re.compile(r"\bADR-\d{3,4}\b")),
    ("Welle ref", re.compile(r"\bWelle \d+\b")),
    ("Slice ref", re.compile(r"\bSlice \d+[a-z]?\b")),
]
# Matched by dest-path SUFFIX so both surfaces (.claude/skills, .agents/skills)
# resolve with one entry each.
PROVENANCE_FIXTURE_SUFFIXES = (
    "spec-self-critique/scenarios.md",        # synthetic Program-PRD fixtures
    "to-issues/SKILL.md",                     # `Welle $WAVE / Slice 1a` title example
    "improve-codebase-architecture/SKILL.md",  # illustrative `ADR-0007` example
    "setup-workflow/domain.md",               # illustrative `ADR-0007` example
    "docs/agents/wave-anchor-template.md",     # `Slice 1` / `Welle <N>` placeholders
    "scripts/board-sync.py",                  # `Welle 7 — X` wave-prefix parser examples
)
# denied only OUTSIDE credit files (scrub should have neutralized these)
BARE_PRIVATE = [
    ("bare owner iKon85", re.compile(r"iKon85")),
    ("maintainer name", re.compile(r"\bNiko\b")),
]
PARENT_REF = re.compile(r"\.\./")
LONG_HEX = re.compile(r"\b[0-9a-f]{40,}\b")
GH_TOKEN = re.compile(r"\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}")


def _parent_ref_scan_text(rel: str, text: str) -> str:
    if rel != "scripts/loc_offender_core.py":
        return text
    # This is the portable path-traversal guard itself, not a cross-skill reach.
    return "\n".join(
        line for line in text.splitlines()
        if 'p.startswith("../")' not in line and '"/../" in p' not in line
    )


def _known_hashes(root: Path) -> set:
    hashes = set(KNOWN_PIN_HASHES)
    pkg = root / "agent-workflow-kit.package.json"
    if pkg.exists():
        data = json.loads(pkg.read_text(encoding="utf-8"))
        for f in data.get("files", []):
            if "sha256" in f:
                hashes.add(f["sha256"])
    return hashes


def _scan_file(rel: str, text: str, known_hashes: set) -> list:
    out = []
    base = Path(rel).name
    credit = base in CREDIT_FILES
    scan = text.replace(PUBLIC_SLUG, "")  # allowlist the public slug
    for label, pat in HARD_DENY:
        if pat.search(scan):
            out.append(f"{rel}: {label}")
    if not rel.endswith(PROVENANCE_FIXTURE_SUFFIXES):
        for label, pat in PROVENANCE_DENY:
            if pat.search(scan):
                out.append(f"{rel}: {label}")
    if not credit:
        for label, pat in BARE_PRIVATE:
            if pat.search(scan):
                out.append(f"{rel}: {label}")
    if not rel.startswith("src/") and PARENT_REF.search(_parent_ref_scan_text(rel, text)):
        out.append(f"{rel}: ../ parent reference")
    for m in LONG_HEX.finditer(text):
        if m.group(0) not in known_hashes:
            out.append(f"{rel}: high-entropy hex (possible secret)")
            break
    if GH_TOKEN.search(text):
        out.append(f"{rel}: GitHub-token-like string")
    return out


def audit_dir(root) -> list:
    """Return a list of violation strings ([] = clean = publishable)."""
    root = Path(root)
    known = _known_hashes(root)
    violations = []
    for f in sorted(root.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(root).as_posix()
        raw = f.read_bytes()
        if b"\x00" in raw:  # binary — skip
            continue
        violations += _scan_file(rel, raw.decode("utf-8", errors="replace"), known)
    # project-private skill dirs must never appear in the kit
    for surface in (".claude/skills", ".agents/skills"):
        d = root / surface
        if d.is_dir():
            for child in d.iterdir():
                if child.is_dir() and child.name in PRIVATE_SKILLS:
                    violations.append(f"{surface}/{child.name}: project-private skill shipped")
    return violations


# --------------------------------------------------------------------------- #
class AuditCatchesEachClass(unittest.TestCase):
    """Inject one violation per class into a clean fixture → it must be caught."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        # a minimal CLEAN kit
        (self.dir / "agent-workflow-kit.package.json").write_text(
            json.dumps({"kitVersion": "0.1.0", "files": [
                {"path": ".claude/skills/x/SKILL.md", "sha256": "a" * 64}]}),
            encoding="utf-8")
        self.skill = self.dir / ".claude/skills/x"
        self.skill.mkdir(parents=True)
        (self.skill / "SKILL.md").write_text("# clean skill\nuse `#<n>` and #0f172a\n",
                                             encoding="utf-8")

    def _body(self, content):
        (self.skill / "SKILL.md").write_text(content, encoding="utf-8")
        return audit_dir(self.dir)

    def test_clean_passes(self):
        self.assertEqual(audit_dir(self.dir), [])

    def test_private_slug(self):
        self.assertTrue(any("repo slug" in v for v in self._body("see iKon85/Testreporter")))

    def test_board_id(self):
        self.assertTrue(any("board" in v for v in self._body("id PVT_kwHOAuH31M4BVtcf")))

    def test_domain(self):
        self.assertTrue(any("domain" in v for v in self._body("curl testreporter.iverra.de")))

    def test_email(self):
        self.assertTrue(any("email" in v for v in self._body("ping a@b.com please")))

    def test_home_path(self):
        self.assertTrue(any("home path" in v for v in self._body("at /home/niko/x")))

    def test_home_encoded_slug(self):
        leak = '$HOME/.claude/projects/-home-niko-projects-x/memory'
        self.assertTrue(any("home-encoded" in v for v in self._body(leak)))

    def test_issue_ref(self):
        self.assertTrue(any("issue ref" in v for v in self._body("fixed in #824 now")))

    def test_hr_ref(self):
        self.assertTrue(any("hard-rule" in v for v in self._body("per HR16 rule")))

    def test_kit_issue_ref(self):
        self.assertTrue(any("kit issue ref" in v for v in self._body("see kit#27 §2")))

    def test_adr_ref(self):
        self.assertTrue(any("ADR ref" in v for v in self._body("per ADR-0034 rule")))

    def test_welle_ref(self):
        self.assertTrue(any("Welle ref" in v for v in self._body("built in Welle 52")))

    def test_slice_ref(self):
        self.assertTrue(any("Slice ref" in v for v in self._body("done in Slice 1g")))

    def test_parent_ref(self):
        self.assertTrue(any("parent" in v for v in self._body("[x](../../other/SKILL.md)")))

    def test_bare_owner_in_body(self):
        self.assertTrue(any("iKon85" in v for v in self._body("authored by iKon85")))

    def test_secret(self):
        self.assertTrue(any("secret" in v for v in self._body("token " + "d" * 50)))

    def test_gh_token(self):
        self.assertTrue(any("token" in v for v in self._body("ghp_" + "A" * 30)))

    def test_private_skill_dir_flagged(self):
        (self.dir / ".claude/skills/drizzle").mkdir(parents=True)
        self.assertTrue(any("project-private" in v for v in audit_dir(self.dir)))


class Exemptions(unittest.TestCase):
    """Public slug is allowlisted; credit files may legitimately name people."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        (self.dir / "agent-workflow-kit.package.json").write_text(
            '{"kitVersion":"0.1.0","files":[]}', encoding="utf-8")

    def _write(self, name, content):
        (self.dir / name).write_text(content, encoding="utf-8")

    def test_public_slug_allowed(self):
        self._write("README.md", "npx github:iKon85/agent-workflow-kit init")
        self.assertEqual(audit_dir(self.dir), [])

    def test_credit_file_may_name_maintainer(self):
        self._write("LICENSE", "Copyright (c) 2026 Niko (iKon85)\nMatt Pocock\nChase AI")
        self.assertEqual(audit_dir(self.dir), [])

    def test_credit_file_still_denies_board_id(self):
        self._write("LICENSE", "Niko (iKon85) PVT_leak")
        self.assertTrue(any("board" in v for v in audit_dir(self.dir)))

    def test_manifest_own_hashes_not_flagged_as_secret(self):
        # the package manifest's 64-hex file hashes are exempt (they ARE the kit's hashes)
        (self.dir / "agent-workflow-kit.package.json").write_text(
            json.dumps({"kitVersion": "0.1.0", "files": [
                {"path": "x", "sha256": "f" * 64}]}), encoding="utf-8")
        self.assertEqual(audit_dir(self.dir), [])

    def test_loc_offender_traversal_guard_allowed(self):
        p = self.dir / "scripts"
        p.mkdir()
        (p / "loc_offender_core.py").write_text(
            'if p == ".." or p.startswith("../") or "/../" in p or p.endswith("/.."):\n'
            '    return None\n',
            encoding="utf-8")
        self.assertEqual(audit_dir(self.dir), [])


class RealDistKitIsClean(unittest.TestCase):
    """Build dist-kit/ from SSOT and assert the audit passes (the publish gate)."""

    def test_built_dist_kit_passes_audit(self):
        build = REPO / "scripts/build-kit.mjs"
        try:
            r = subprocess.run(["node", str(build)], cwd=REPO,
                               capture_output=True, text=True, timeout=120)
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            self.skipTest(f"node/build unavailable: {e}")
        self.assertEqual(r.returncode, 0, r.stderr)
        violations = audit_dir(REPO / "dist-kit")
        self.assertEqual(violations, [], "\n".join(violations[:40]))

    def test_built_dist_kit_contains_publishable_census_without_foreign_reach(self):
        build = subprocess.run(
            ["node", str(REPO / "scripts/build-kit.mjs")], cwd=REPO,
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(build.returncode, 0, build.stderr)
        expected = (
            ".claude/skills/census-update/SKILL.md",
            ".agents/skills/census-update/SKILL.md",
            ".claude/skills/setup-workflow/census.md",
            ".agents/skills/setup-workflow/census.md",
            "scripts/census/index.mjs",
            "scripts/census/scan.mjs",
            "scripts/census/fingerprint.mjs",
            "scripts/census/delta.mjs",
            "scripts/census/state.mjs",
            "scripts/census/transaction.mjs",
        )
        for rel in expected:
            path = REPO / "dist-kit" / rel
            self.assertTrue(path.is_file(), f"missing published census resource: {rel}")
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("tools/agent-workflow-kit", text)
            self.assertNotIn("testreporter", text.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
