#!/usr/bin/env python3
"""Wave anchor titles take their prefix from the board profile, not a hardcoded
German literal — an optional `titles.wavePrefix` key with the literal default
`"Welle"` so every existing profile keeps working unchanged."""

from __future__ import annotations

import copy
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


BASE_PROFILE = {
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


def load_board_sync(profile_dict: dict, module_name: str):
    previous_profile = os.environ.get("BOARD_SYNC_PROFILE")
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as profile:
        profile.write("<!-- board-sync:profile -->\n```json\n")
        json.dump(profile_dict, profile)
        profile.write("\n```\n")
        profile_path = profile.name
    os.environ["BOARD_SYNC_PROFILE"] = profile_path
    spec = importlib.util.spec_from_file_location(
        module_name, Path(__file__).with_name("board-sync.py")
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    try:
        spec.loader.exec_module(module)
    finally:
        Path(profile_path).unlink()
        if previous_profile is None:
            os.environ.pop("BOARD_SYNC_PROFILE", None)
        else:
            os.environ["BOARD_SYNC_PROFILE"] = previous_profile
    return module


class WaveTitleDefaultPrefix(unittest.TestCase):
    """A profile without `titles.wavePrefix` keeps the historical `Welle` prefix."""

    @classmethod
    def setUpClass(cls):
        cls.bs = load_board_sync(copy.deepcopy(BASE_PROFILE), "board_sync_wave_default")

    def test_default_prefix_is_welle(self):
        self.assertEqual(self.bs.wave_title("Auth hardening", 7), "Welle 7 — Auth hardening")

    def test_repromote_is_idempotent(self):
        self.assertEqual(
            self.bs.wave_title("Welle 7 — Auth hardening", 9),
            "Welle 9 — Auth hardening",
        )

    def test_conventional_prefix_stripped_before_wave(self):
        self.assertEqual(
            self.bs.wave_title("fix: Welle 7 — Auth hardening", 29),
            "Welle 29 — Auth hardening",
        )

    def test_loading_board_sync_restores_the_caller_profile(self):
        before = os.environ.get("BOARD_SYNC_PROFILE")
        load_board_sync(copy.deepcopy(BASE_PROFILE), "board_sync_wave_isolation")
        self.assertEqual(os.environ.get("BOARD_SYNC_PROFILE"), before)


class WaveTitleProfilePrefix(unittest.TestCase):
    """A profile with `titles.wavePrefix` drives the anchor title language."""

    @classmethod
    def setUpClass(cls):
        profile = copy.deepcopy(BASE_PROFILE)
        profile["titles"] = {"wavePrefix": "Wave"}
        cls.bs = load_board_sync(profile, "board_sync_wave_custom")

    def test_configured_prefix_is_used(self):
        self.assertEqual(self.bs.wave_title("Auth hardening", 7), "Wave 7 — Auth hardening")

    def test_repromote_is_idempotent_for_configured_prefix(self):
        self.assertEqual(
            self.bs.wave_title("Wave 7 — Auth hardening", 9),
            "Wave 9 — Auth hardening",
        )

    def test_regex_metacharacters_in_prefix_are_literal(self):
        profile = copy.deepcopy(BASE_PROFILE)
        profile["titles"] = {"wavePrefix": "W+A"}
        bs = load_board_sync(profile, "board_sync_wave_meta")
        self.assertEqual(
            bs.wave_title("W+A 3 — Auth hardening", 4),
            "W+A 4 — Auth hardening",
        )


if __name__ == "__main__":
    unittest.main()
