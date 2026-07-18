#!/usr/bin/env python3
"""Behavior tests for bounded board operations; the fake seam never calls GitHub."""

from __future__ import annotations

import io
import json
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

import importlib.util
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "board_sync_operations_test", Path(__file__).with_name("board-sync.py"))
bs = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(bs)


class FakeGh:
    def __init__(self, responses=None, failures=None):
        self.responses = responses or {}
        self.failures = failures or {}
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        joined = " ".join(args)
        for needle, body in self.failures.items():
            if needle in joined:
                error = bs.GhError("injected failure")
                error.stdout = body
                raise error
        for needle, body in self.responses.items():
            if needle in joined:
                return body
        return ""


def run(fake, argv):
    old = bs._gh
    bs._gh = fake
    out = io.StringIO()
    try:
        with redirect_stdout(out):
            code = bs.main(argv)
    finally:
        bs._gh = old
    return code, out.getvalue()


class BoundedCalls(unittest.TestCase):
    def test_full_board_and_ordinary_calls_have_distinct_clear_timeouts(self):
        with patch.object(bs.subprocess, "run", side_effect=subprocess.TimeoutExpired("gh", 1)) as call:
            with self.assertRaisesRegex(bs.GhError, "15s"):
                bs._gh(["issue", "view", "1"])
            self.assertEqual(call.call_args.kwargs["timeout"], 15)
            with self.assertRaisesRegex(bs.GhError, "60s"):
                bs._gh(["project", "item-list", "3"])
            self.assertEqual(call.call_args.kwargs["timeout"], 60)

    def test_partial_create_prints_issue_and_replay_safe_repair(self):
        fake = FakeGh(
            {"issue list": "[]", "issue create": "https://github.com/x/y/issues/17\n"},
            {"project item-add": ""},
        )
        with patch.object(bs, "REPO", "x/y"):
            with self.subTest("created issue remains visible"):
                from tempfile import NamedTemporaryFile
                with NamedTemporaryFile("w") as body:
                    body.write("<!-- program-leaf-source: p/1 -->\n")
                    body.flush()
                    code, out = run(fake, ["create", "--title", "S", "--body-file", body.name])
        self.assertEqual(code, 1)
        self.assertIn("#17 https://github.com/x/y/issues/17", out)
        self.assertIn("board-sync.py add --issue 17", out)
        self.assertIn("idempotent", out)


class WaveLookup(unittest.TestCase):
    def test_search_finds_next_wave_without_full_scan(self):
        fake = FakeGh({"search/issues": json.dumps({"items": [
            {"title": f"{bs.WAVE_TITLE_PREFIX} 7 — Anchor"},
            {"title": f"{bs.WAVE_TITLE_PREFIX} 8 / Slice 1 — Leaf"},
        ]})})
        code, out = run(fake, ["next-wave"])
        self.assertEqual((code, out.strip()), (0, "9"))
        self.assertFalse(any("item-list" in " ".join(c) for c in fake.calls))

    def test_empty_search_falls_back_and_scan_skips_search(self):
        fake = FakeGh({"search/issues": '{"items":[]}', "item-list": '{"items":[{"wave":4}]}'})
        with redirect_stderr(io.StringIO()):
            self.assertEqual(run(fake, ["next-wave"])[1].strip(), "5")
        scan = FakeGh({"item-list": '{"items":[{"wave":9}]}'})
        self.assertEqual(run(scan, ["next-wave", "--scan"])[1].strip(), "10")
        self.assertFalse(any("search/issues" in " ".join(c) for c in scan.calls))

    def test_promotion_refuses_foreign_anchor_but_allows_same_issue(self):
        foreign = {"items": [{"number": 22, "title": f"{bs.WAVE_TITLE_PREFIX} 7 — Other"}]}
        message = bs.wave_collision_guard(foreign, 7, 21)
        self.assertIn("#22", message)
        self.assertIn("next-wave", message)
        self.assertIsNone(bs.wave_collision_guard(foreign, 7, 22))
        leaf = {"items": [{"number": 23, "title": f"{bs.WAVE_TITLE_PREFIX} 7 / Slice 1 — X"}]}
        self.assertIsNone(bs.wave_collision_guard(leaf, 7, 21))

    def test_promote_collision_fails_before_any_write(self):
        fake = FakeGh({
            "--json labels": "",
            "--json body": "Draft PRD\n",
            "graphql": '{"data":{"repository":{"issue":{"projectItems":{"nodes":[]}}}}}',
            "search/issues": json.dumps({"items": [
                {"number": 22, "title": f"{bs.WAVE_TITLE_PREFIX} 7 — Other"},
            ]}),
        })
        error = io.StringIO()
        with redirect_stderr(error):
            code, _ = run(fake, ["promote", "--issue", "21", "--wave", "7"])
        self.assertEqual(code, 1)
        self.assertIn("#22", error.getvalue())
        self.assertFalse(any(c[:2] == ["issue", "edit"] for c in fake.calls))


class TargetedLookup(unittest.TestCase):
    @staticmethod
    def payload(project):
        return {"data": {"repository": {"issue": {"projectItems": {"nodes": [{
            "id": "PVTI_x", "project": {"id": project}, "fieldValues": {"nodes": [
                {"number": 7, "field": {"id": bs.WAVE_FIELD_ID}},
                {"name": "Spec", "field": {"id": bs.STATUS_FIELD_ID}},
            ]},
        }]}}}}}

    def test_item_of_returns_configured_fields(self):
        fake = FakeGh({"graphql": json.dumps(self.payload(bs.PROJECT_NODE_ID))})
        code, out = run(fake, ["item-of", "--issue", "21"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out), {"itemId": "PVTI_x", "wave": 7,
                                           "status": "Spec", "cluster": None})

    def test_item_of_fails_clearly_when_absent(self):
        payload = {"data": {"repository": {"issue": {"projectItems": {"nodes": []}}}}}
        code, out = run(FakeGh({"graphql": json.dumps(payload)}),
                        ["item-of", "--issue", "99"])
        self.assertEqual((code, out.strip()), (1, "NOT-ON-BOARD"))


class ArchiveDone(unittest.TestCase):
    def item_payload(self, count=1):
        items = [{"id": f"D{i}", "status": bs.STATUS_ROLES["done"]} for i in range(count)]
        items += [{"id": "OPEN", "status": bs.STATUS_ROLES["inProgress"]},
                  {"id": "OLD", "status": bs.STATUS_ROLES["done"], "archived": True}]
        return json.dumps({"items": items, "totalCount": len(items)})

    def test_archive_defaults_to_dry_run_and_selects_only_active_done(self):
        fake = FakeGh({"item-list": self.item_payload()})
        code, out = run(fake, ["archive-done"])
        self.assertEqual(code, 0)
        self.assertIn("D0", out)
        self.assertNotIn("OPEN", out)
        self.assertNotIn("OLD", out)
        self.assertFalse(any("archiveProjectV2Item" in " ".join(c) for c in fake.calls))

    def test_apply_batches_at_thirty(self):
        class BatchGh(FakeGh):
            def __call__(self, args):
                self.calls.append(args)
                if "item-list" in args:
                    return self.responses["item-list"]
                count = " ".join(args).count("archiveProjectV2Item")
                return json.dumps({"data": {f"a{i}": {"item": {"id": f"x{i}"}}
                                             for i in range(count)}})
        fake = BatchGh({"item-list": self.item_payload(31)})
        code, out = run(fake, ["archive-done", "--apply"])
        self.assertEqual(code, 0)
        self.assertIn("31 of 31", out)
        calls = [c for c in fake.calls if "archiveProjectV2Item" in " ".join(c)]
        self.assertEqual([" ".join(c).count("archiveProjectV2Item") for c in calls], [30, 1])

    def test_truncated_input_refuses_without_mutation(self):
        fake = FakeGh({"item-list": '{"items":[{"id":"D","status":"Done"}],"totalCount":2}'})
        err = io.StringIO()
        with redirect_stderr(err):
            code, _ = run(fake, ["archive-done", "--apply"])
        self.assertEqual(code, 1)
        self.assertIn("partial archive", err.getvalue())
        self.assertFalse(any("archiveProjectV2Item" in " ".join(c) for c in fake.calls))

    def test_apply_reports_partial_failure_and_empty_replay_is_idempotent(self):
        body = json.dumps({"data": {"a0": {"item": {"id": "D0"}}, "a1": None},
                           "errors": [{"path": ["a1"], "message": "already archived"}]})
        fake = FakeGh({"item-list": self.item_payload(2)}, {"archiveProjectV2Item": body})
        code, out = run(fake, ["archive-done", "--apply"])
        self.assertEqual(code, 1)
        self.assertIn("1 of 2", out)
        self.assertIn("D1: already archived", out)
        empty = FakeGh({"item-list": json.dumps({"items": [], "totalCount": 0})})
        code, out = run(empty, ["archive-done", "--apply"])
        self.assertEqual(code, 0)
        self.assertIn("nothing to archive", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
