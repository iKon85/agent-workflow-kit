#!/usr/bin/env python3
"""Regression test for marker-aware board issue creation."""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


PROFILE = {
    "repo": "example/kit",
    "project": {"number": 1, "owner": "example", "nodeId": "PVT_test"},
    "fields": {
        "status": {"id": "STATUS", "options": {}},
        "wave": "WAVE",
        "cluster": "CLUSTER",
        "specPath": "SPEC",
        "planPath": "PLAN",
    },
    "labels": {
        "readyForAgent": "ready-for-agent",
        "typePrefix": "type:",
        "clusterType": "type:cluster",
        "waveStub": "wave-stub",
    },
    "branchPrefixes": ["feat", "fix"],
    "prMarkers": {"partOf": "Part of", "retroMarker": "Retro", "retroValues": []},
    "headings": {"vorBau": "Clarify Before Build"},
}


def load_board_sync():
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as profile:
        profile.write("<!-- board-sync:profile -->\n```json\n")
        json.dump(PROFILE, profile)
        profile.write("\n```\n")
        profile_path = profile.name
    os.environ["BOARD_SYNC_PROFILE"] = profile_path
    spec = importlib.util.spec_from_file_location(
        "board_sync_create_test", Path(__file__).with_name("board-sync.py")
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    Path(profile_path).unlink()
    return module


bs = load_board_sync()


class FakeGh:
    def __init__(self, marker: str):
        self.marker = marker
        self.created = False
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        joined = " ".join(args)
        if "issue list" in joined:
            if not self.created:
                return "[]"
            return json.dumps([
                {
                    "number": 101,
                    "url": "https://github.com/example/kit/issues/101",
                    "body": self.marker,
                }
            ])
        if "issue create" in joined:
            self.created = True
            return "https://github.com/example/kit/issues/101\n"
        if "project item-add" in joined:
            return '{"id":"PVTI_test"}'
        return ""


class MarkerAwareCreateTest(unittest.TestCase):
    def test_identical_program_leaf_retry_reuses_existing_issue(self):
        marker = "<!-- program-leaf-source: program-x/1a -->"
        fake = FakeGh(marker)
        original = bs._gh
        bs._gh = fake
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".md") as body:
                body.write(marker + "\nOutcome: test\n")
                body.flush()
                argv = ["create", "--title", "Slice 1a", "--body-file", body.name]
                self.assertEqual(bs.main(argv), 0)
                self.assertEqual(bs.main(argv), 0)
        finally:
            bs._gh = original

        creates = [call for call in fake.calls if "issue create" in " ".join(call)]
        self.assertEqual(len(creates), 1)


if __name__ == "__main__":
    unittest.main()
