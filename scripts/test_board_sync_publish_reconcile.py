#!/usr/bin/env python3
"""Publish is one idempotent reconciler run, not an observation machine.

The fixture publishes a whole wave through the fake `_gh` seam (never GitHub):
one body write per issue, no archive comment, no post-write refetch, and an
interrupted run repaired by a plain re-run instead of a resume state table.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path


PROFILE = {
    "repo": "example/kit",
    "project": {"number": 1, "owner": "example", "nodeId": "PVT_test"},
    "fields": {
        "status": {"id": "STATUS", "options": {"Spec": "opt-spec"}},
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
    "titles": {"wavePrefix": "Welle"},
}


def load_board_sync():
    previous = os.environ.get("BOARD_SYNC_PROFILE")
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as profile:
        profile.write("<!-- board-sync:profile -->\n```json\n")
        json.dump(PROFILE, profile)
        profile.write("\n```\n")
        path = profile.name
    os.environ["BOARD_SYNC_PROFILE"] = path
    spec = importlib.util.spec_from_file_location(
        "board_sync_publish_test", Path(__file__).with_name("board-sync.py")
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    try:
        spec.loader.exec_module(module)
    finally:
        Path(path).unlink()
        if previous is None:
            os.environ.pop("BOARD_SYNC_PROFILE", None)
        else:
            os.environ["BOARD_SYNC_PROFILE"] = previous
    return module


bs = load_board_sync()
ANCHOR = 400


class FakeBoard:
    """A stateful board: writes mutate it, so a re-run observes the real
    post-interruption state instead of a replayed script."""

    def __init__(self, title="Draft PRD", labels=None, wave=None, fail_on=None):
        self.issues = {ANCHOR: {"title": title, "body": "PRD body\n",
                                "labels": list(labels or [])}}
        self.wave = wave
        self.fail_on = fail_on
        self.calls: list[list[str]] = []
        self.next_number = 500

    def __call__(self, args: list[str]) -> str:
        self.calls.append(list(args))
        joined = " ".join(args)
        if self.fail_on and self.fail_on in joined:
            raise bs.GhError("injected failure")
        if "api graphql" in joined:
            return self._field_value_payload()
        if "search/issues" in joined:
            return json.dumps({"items": []})
        if "issue list" in joined:
            return json.dumps([
                {"number": num, "url": f"https://github.com/example/kit/issues/{num}",
                 "body": issue["body"]}
                for num, issue in self.issues.items() if num >= 500
            ])
        if "issue create" in joined:
            return self._create(args)
        if "issue view" in joined:
            return self._view(args)
        if "issue edit" in joined:
            return self._edit(args)
        if "project item-add" in joined:
            return '{"id":"PVTI_test"}'
        if "project item-edit" in joined:
            self._stamp(args)
        return ""

    # --- reads ---------------------------------------------------------
    def _field_value_payload(self) -> str:
        values = ([{"number": self.wave, "field": {"id": "WAVE"}}]
                  if self.wave is not None else [])
        return json.dumps({"data": {"repository": {"issue": {"projectItems": {"nodes": [
            {"id": "PVTI_test", "project": {"id": "PVT_test"},
             "fieldValues": {"nodes": values}}]}}}}})

    def _view(self, args: list[str]) -> str:
        issue = self.issues[int(args[2])]
        if "labels" in args:
            return "".join(f"{label}\n" for label in issue["labels"])
        if "title" in args:
            return issue["title"] + "\n"
        return issue["body"]

    # --- writes --------------------------------------------------------
    def _create(self, args: list[str]) -> str:
        number = self.next_number
        self.next_number += 1
        self.issues[number] = {
            "title": args[args.index("--title") + 1],
            "body": Path(args[args.index("--body-file") + 1]).read_text(encoding="utf-8"),
            "labels": [],
        }
        return f"https://github.com/example/kit/issues/{number}\n"

    def _edit(self, args: list[str]) -> str:
        issue = self.issues[int(args[2])]
        for index, token in enumerate(args):
            if token == "--body-file":
                issue["body"] = Path(args[index + 1]).read_text(encoding="utf-8")
            elif token == "--title":
                issue["title"] = args[index + 1]
            elif token == "--add-label":
                issue["labels"].append(args[index + 1])
            elif token == "--remove-label" and args[index + 1] in issue["labels"]:
                issue["labels"].remove(args[index + 1])
        return ""

    def _stamp(self, args: list[str]) -> None:
        if "--field-id" in args and args[args.index("--field-id") + 1] == "WAVE":
            self.wave = int(args[args.index("--number") + 1])

    # --- assertions ----------------------------------------------------
    def body_writes(self) -> list[int]:
        return [int(call[2]) for call in self.calls
                if call[:2] == ["issue", "edit"] and "--body-file" in call]

    def matching(self, needle: str) -> list[list[str]]:
        return [call for call in self.calls if needle in " ".join(call)]


def run(fake, argv) -> tuple[int, str]:
    original = bs._gh
    bs._gh = fake
    out = io.StringIO()
    try:
        with redirect_stdout(out), redirect_stderr(out):
            code = bs.main(argv)
    finally:
        bs._gh = original
    return code, out.getvalue()


def body_file(text: str) -> str:
    handle = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8")
    handle.write(text)
    handle.close()
    return handle.name


def publish_wave(fake, slices=("1a", "1b", "1c")) -> list[tuple[int, str]]:
    """One wave publish: every slice leaf, then the anchor reconciler."""
    results = []
    for slug in slices:
        path = body_file(f"<!-- program-leaf-source: w34/{slug} -->\nOutcome: {slug}\n")
        results.append(run(fake, ["create", "--title", f"Welle 34 / Slice {slug}",
                                  "--body-file", path]))
    anchor = body_file("**plan_revision:** r1\n\n**Welle 34 — Publish**\n")
    results.append(run(fake, ["publish-anchor", "--issue", str(ANCHOR),
                              "--wave", "34", "--body-file", anchor]))
    return results


class PlanIsPureAndStateless(unittest.TestCase):
    def test_board_state_alone_decides_what_is_left_to_write(self):
        unpublished = bs.anchor_publish_plan({"labels": [], "title": "Draft"}, 34, True)
        self.assertEqual(unpublished["body"], "write")
        self.assertEqual(unpublished["board"], "promote")
        published = bs.anchor_publish_plan(
            {"labels": ["type:cluster"], "title": "Welle 34 — Publish", "wave": 34}, 34, True)
        self.assertEqual((published["body"], published["board"]), ("current", "current"))
        self.assertTrue(published["published"])

    def test_a_half_written_board_state_is_not_a_state_of_its_own(self):
        partial = bs.anchor_publish_plan(
            {"labels": ["type:cluster"], "title": "Draft", "wave": None}, 34, True)
        self.assertEqual(partial["board"], "promote")
        self.assertFalse(partial["published"])


class OneBodyWritePerIssue(unittest.TestCase):
    def test_a_wave_publish_writes_each_issue_body_once(self):
        fake = FakeBoard()
        codes = [code for code, _ in publish_wave(fake)]
        self.assertEqual(codes, [0, 0, 0, 0])
        # every leaf body arrives with its `issue create`; the anchor body is
        # the single `issue edit --body-file` of the whole publish
        self.assertEqual(len(fake.matching("issue create")), 3)
        self.assertEqual(fake.body_writes(), [ANCHOR])
        self.assertEqual(fake.matching("issue comment"), [])

    def test_the_result_names_what_exists_and_what_it_created(self):
        fake = FakeBoard()
        _, out = publish_wave(fake)[-1]
        self.assertIn("body=written", out)
        self.assertIn("board=promoted", out)

    def test_the_write_is_never_re_read_to_verify_itself(self):
        fake = FakeBoard()
        publish_wave(fake)
        after_write = False
        for call in fake.calls:
            if call[:2] == ["issue", "edit"] and "--body-file" in call:
                after_write = True
            elif after_write and call[:2] == ["issue", "view"] and "body" in call:
                self.fail("publish re-read the body it had just written")


class ReRunRepairsWithoutDuplicating(unittest.TestCase):
    def test_an_interrupted_publish_is_repaired_by_re_running_it(self):
        fake = FakeBoard(fail_on="--add-label type:cluster")
        first = publish_wave(fake, slices=("1a", "1b"))
        self.assertEqual(first[-1][0], 1)
        self.assertIn("repair", first[-1][1])
        self.assertEqual(fake.body_writes(), [ANCHOR])

        fake.fail_on = None
        before = len(fake.calls)
        second = publish_wave(fake)
        self.assertEqual([code for code, _ in second], [0, 0, 0, 0])
        replay = fake.calls[before:]
        creates = [call for call in replay if call[:2] == ["issue", "create"]]
        self.assertEqual(len(creates), 1, "existing slices must be reused, not recreated")
        self.assertEqual(len(fake.issues), 4)
        self.assertEqual(fake.wave, 34)
        self.assertIn("type:cluster", fake.issues[ANCHOR]["labels"])

    def test_a_published_anchor_reconciles_to_a_no_op(self):
        fake = FakeBoard(title="Welle 34 — Publish", labels=["type:cluster"], wave=34)
        code, out = run(fake, ["publish-anchor", "--issue", str(ANCHOR), "--wave", "34",
                               "--body-file", body_file("anything\n")])
        self.assertEqual(code, 0)
        self.assertIn("body=current", out)
        self.assertIn("board=current", out)
        self.assertEqual(fake.body_writes(), [])
        self.assertEqual(fake.matching("project item-add"), [])


class PreviewBeforeApproval(unittest.TestCase):
    def test_dry_run_previews_the_whole_plan_and_writes_nothing(self):
        fake = FakeBoard()
        code, out = run(fake, ["publish-anchor", "--issue", str(ANCHOR), "--wave", "34",
                               "--body-file", body_file("body\n"), "--dry-run"])
        self.assertEqual(code, 0)
        self.assertIn("body=write", out)
        self.assertIn("board=promote", out)
        self.assertIn("[dry-run] gh issue edit", out)
        for call in fake.calls:
            self.assertNotEqual(call[:2], ["issue", "edit"])
            self.assertNotEqual(call[:1], ["project"])

    def test_a_different_wave_stays_a_hard_stop(self):
        fake = FakeBoard(wave=7)
        code, out = run(fake, ["publish-anchor", "--issue", str(ANCHOR), "--wave", "34",
                               "--body-file", body_file("body\n")])
        self.assertEqual(code, 1)
        self.assertIn("Wave=7", out)
        self.assertEqual(fake.body_writes(), [])


if __name__ == "__main__":
    unittest.main()
