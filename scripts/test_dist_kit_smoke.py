#!/usr/bin/env python3
"""dist-kit smoke — proves the BUILT kit's `validate-graph` imports + runs
(Welle 52 / Slice 7 / #1936, PLAN Step 15).

Why: `bundle.mjs`'s HELPER_FILES allowlist is the only thing that ships
program_graph.py / program_graph_parse.py / program_graph_validate.py /
node_kind.py / board_fields.py / program_sync.py into dist-kit/scripts/ — all
six are imported UNCONDITIONALLY at board-sync.py's module top (not lazily
inside a subcommand handler), so a forgotten entry does not fail at build time,
it fails the FIRST time a consumer runs the shipped CLI (ImportError). This
test catches that class of regression by actually invoking `validate-graph`
against the built dist-kit/, not the scripts/ SSOT copy the rest of the suite
imports.

Fully offline: a throwaway consumer board profile (BOARD_SYNC_PROFILE env var)
stands in for a project layer, and a fake `gh` shim on PATH answers the two
read-only `gh` calls `validate-graph` makes (the PRD body + the empty
sub-issues/children query) — no network, no real gh auth, no live board.

Run: python3 scripts/test_dist_kit_smoke.py
"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist-kit"

# A minimal but structurally complete consumer profile (see board_config.py's
# _REQUIRED_PATHS) — distinct ids from Testreporter's own, so a leak would be
# obvious. `fields.phase` is included (with the same shape #1936 gives the
# real Testreporter profile) so the fixture also exercises the Phase-aware
# path in validate-graph, not just its defensive None-fallback.
FIXTURE_PROFILE = {
    "repo": "acme/widgets",
    "project": {"number": 7, "owner": "acme", "nodeId": "PVT_FIXTURE"},
    "fields": {
        "status": {"id": "PVTSSF_FIXTURE", "options": {"Spec": "opt-spec"}},
        "wave": "PVTF_FIXTURE_WAVE",
        "cluster": "PVTF_FIXTURE_CLUSTER",
        "specPath": "PVTF_FIXTURE_SPEC",
        "planPath": "PVTF_FIXTURE_PLAN",
        "phase": {"id": "PVTSSF_FIXTURE_PHASE",
                  "options": {"P1": "opt-p1", "P2": "opt-p2", "P3": "opt-p3"}},
    },
    "labels": {"readyForAgent": "ready-for-agent", "typePrefix": "type:",
               "clusterType": "type:cluster", "waveStub": "wave-stub"},
    "branchPrefixes": ["feat", "fix"],
    "prMarkers": {"partOf": "Part of", "retroMarker": "**Retro:**",
                  "retroValues": ["ran", "skipped"]},
    "headings": {"vorBau": "Clarify Before Build"},
}

# A minimal green Program-PRD body — one wave, two slices, full scope coverage,
# no cycles/backward-refs/gate warnings — the same shape as test_program_graph.py's
# GREEN_PRD fixture, duplicated here (not imported) so this smoke stays
# self-contained and independent of the SSOT test module's import side effects.
GREEN_PRD = (
    "<!-- prd: program -->\n"
    "**plan_revision:** r1\n\n"
    "## Scope\n"
    "- **S1:** Programm-Graph-Fundament\n"
    "- **S2:** Execute-Ready-Erweiterung\n\n"
    "## Wellenplan\n"
    "<!-- wellenplan:start -->\n"
    "| Welle | Name | Phase | Slices | Gate | covers |\n"
    "|---|---|---|---|---|---|\n"
    "| 1 | Fundament | P1 | 1a, 1b | — | S1,S2 |\n"
    "<!-- wellenplan:end -->\n\n"
    "## Phasen-Gates\n"
    "- [ ] P1: Fundament steht\n\n"
    "## Slices\n"
    "#### 1a — Graph-Modul\n"
    "<!-- wave: 1 -->\n"
    "<!-- phase: P1 -->\n"
    "<!-- area: scripts -->\n"
    "<!-- gate: — -->\n"
    "<!-- blocked_by: none -->\n\n"
    "#### 1b — Execute-Ready\n"
    "<!-- wave: 1 -->\n"
    "<!-- phase: P1 -->\n"
    "<!-- area: scripts -->\n"
    "<!-- gate: — -->\n"
    "<!-- blocked_by: 1a -->\n"
)

# A fake `gh` binary: answers the sub-issues/children GraphQL query (empty —
# no published stubs yet) and the PRD-body `issue view` read from a file, so
# `validate-graph` runs end to end without any real `gh` call.
FAKE_GH = """#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if "subIssues" in " ".join(args):
    sys.stdout.write('{"data":{"repository":{"issue":{"subIssues":{"nodes":[]}}}}}')
else:
    with open(os.environ["DIST_KIT_SMOKE_BODY"], encoding="utf-8") as fh:
        sys.stdout.write(fh.read())
"""


def _build_dist_kit():
    """Run the real build (subprocess — the maintainer's actual publish step).
    Returns (CompletedProcess, skip_reason); skip_reason is set only when node
    itself is unavailable in this environment (mirrors test_skill_publish_audit.py)."""
    build = REPO / "scripts/build-kit.mjs"
    try:
        r = subprocess.run(["node", str(build)], cwd=REPO,
                            capture_output=True, text=True, timeout=120)
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    return r, None


class DistKitValidateGraphSmoke(unittest.TestCase):
    """Builds dist-kit/ then runs `board-sync.py validate-graph` from the
    SHIPPED location — proves the whole program_graph* / node_kind / board_fields
    / program_sync import chain resolves in the actual publish artefact, and
    that the command produces the correct counted report on a known fixture."""

    def setUp(self):
        r, skip_reason = _build_dist_kit()
        if skip_reason:
            self.skipTest(f"node/build unavailable: {skip_reason}")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.board_sync_py = DIST / "scripts/board-sync.py"
        self.assertTrue(self.board_sync_py.exists(), "dist-kit/scripts/board-sync.py missing")

        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

        profile_md = ("<!-- board-sync:profile -->\n```json\n"
                      + json.dumps(FIXTURE_PROFILE) + "\n```\n")
        profile_path = self.tmp / "board-sync.md"
        profile_path.write_text(profile_md, encoding="utf-8")

        body_path = self.tmp / "prd-body.md"
        body_path.write_text(GREEN_PRD, encoding="utf-8")

        fake_gh_dir = self.tmp / "bin"
        fake_gh_dir.mkdir()
        gh_path = fake_gh_dir / "gh"
        gh_path.write_text(FAKE_GH, encoding="utf-8")
        gh_path.chmod(gh_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

        self.env = {
            **os.environ,
            "PATH": f"{fake_gh_dir}{os.pathsep}{os.environ.get('PATH', '')}",
            "BOARD_SYNC_PROFILE": str(profile_path),
            "DIST_KIT_SMOKE_BODY": str(body_path),
        }

    def test_validate_graph_runs_against_the_built_kit(self):
        result = subprocess.run(
            [sys.executable, str(self.board_sync_py), "validate-graph", "--issue", "42"],
            capture_output=True, text=True, timeout=30, env=self.env,
        )
        self.assertEqual(result.returncode, 0,
                          f"stdout={result.stdout!r} stderr={result.stderr!r}")
        self.assertIn("Scope-Abdeckung 2 von 2", result.stdout)
        self.assertIn("Rollup-Kette ✓", result.stdout)
        self.assertIn("zyklenfrei ✓", result.stdout)
        self.assertIn("Kapazität ✓", result.stdout)
        self.assertIn("Phasen-Optionen ✓", result.stdout)

    def test_no_german_status_vocabulary_ships(self):
        """kit#26 / #1947 acceptance, verbatim: a fresh consumer install must
        grep clean for testreporter's German board-status names. The status
        vocabulary lives ONLY in a board's own profile (fields.status.roles) —
        shipped scripts, skills, and doc templates speak role language. This
        greps the whole BUILT artefact, so any future spot the word-list
        census or the command lint can't see (a bare status name carries no
        German function word and no board-sync.py call) still fails here."""
        import re
        pat = re.compile(r"\bIn Arbeit\b|\bIdee\b")
        hits = []
        for path in sorted(DIST.rglob("*")):
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, PermissionError):
                continue
            for n, line in enumerate(text.splitlines(), 1):
                if pat.search(line):
                    hits.append(f"{path.relative_to(DIST)}:{n}: {line.strip()[:120]}")
        self.assertEqual(hits, [],
                         "German board-status vocabulary in the shipped kit — speak role "
                         "language (fields.status.roles / --status-role) instead:\n"
                         + "\n".join(hits))


if __name__ == "__main__":
    unittest.main(verbosity=2)
