#!/usr/bin/env python3
"""Forward proof: a clean public checkout builds and serves census consumers."""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FIXTURE = REPO / "test/fixtures/census-consumers/greenfield"


class CensusForwardContract(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="awk-census-forward-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.public = self.tmp / "public-kit"
        self.public.mkdir()
        archive = subprocess.Popen(
            ["git", "archive", "HEAD"], cwd=REPO, stdout=subprocess.PIPE
        )
        unpack = subprocess.run(
            ["tar", "-x", "-C", str(self.public)], stdin=archive.stdout,
            capture_output=True, timeout=30,
        )
        archive.stdout.close()
        archive_rc = archive.wait(timeout=30)
        self.assertEqual((archive_rc, unpack.returncode), (0, 0), unpack.stderr.decode())
        build = subprocess.run(
            ["node", "scripts/build-kit.mjs"], cwd=self.public,
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(build.returncode, 0, build.stderr)
        self.dist = self.public / "dist-kit"

    def test_built_public_checkout_exercises_both_surfaces_and_scanner(self):
        claude = (self.dist / ".claude/skills/census-update/SKILL.md").read_text()
        codex = (self.dist / ".agents/skills/census-update/SKILL.md").read_text()
        self.assertEqual(claude, codex)
        for public_export in ("scanCensus", "diffCensus", "activateCensus"):
            self.assertIn(public_export, claude)

        consumer = self.tmp / "consumer"
        shutil.copytree(FIXTURE, consumer)
        subprocess.run(["git", "init", "--quiet"], cwd=consumer, check=True)
        subprocess.run(["git", "add", "."], cwd=consumer, check=True)
        runner = (
            "import { scanCensus } from "
            + json.dumps((self.dist / "scripts/census/index.mjs").as_uri())
            + "; const result = await scanCensus({repoRoot: process.argv[1], enabled:true});"
            + "console.log(JSON.stringify({state:result.state,count:result.denominator.length}));"
        )
        run = subprocess.run(
            ["node", "--input-type=module", "--eval", runner, str(consumer)],
            cwd=self.public, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {"state": "bootstrap", "count": 2})
        self.assertNotIn("testreporter", run.stdout.lower())
        self.assertNotIn(str(REPO.parent), run.stdout)

    def test_public_pack_contains_complete_census_unit_without_foreign_reach(self):
        pack = subprocess.run(
            ["npm", "pack", "--dry-run", "--json"], cwd=self.public,
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(pack.returncode, 0, pack.stderr)
        paths = {entry["path"] for entry in json.loads(pack.stdout)[0]["files"]}
        expected = {
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
        }
        self.assertEqual(expected - paths, set())
        for path in expected:
            text = (self.public / path).read_text(encoding="utf-8")
            self.assertNotIn("tools/agent-workflow-kit", text)
            self.assertNotIn("testreporter", text.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
