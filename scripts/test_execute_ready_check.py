#!/usr/bin/env python3
"""
Tests for scripts/execute-ready-check.py — the single execute-ready coherence
checker shared by drift-guard.py, to-issues, grill-with-docs, wrapup.

Hyphen in the filename → loaded via importlib.
Run: python3 -m unittest scripts/test_execute_ready_check.py -v
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_PROFILE = tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8")
_PROFILE.write("""<!-- board-sync:profile -->
```json
{
  "repo": "example/repo",
  "project": { "number": 1, "owner": "example", "nodeId": "PVT_example" },
  "fields": {
    "status": {
      "id": "PVTSSF_status",
      "options": { "Spec": "spec", "In Progress": "in-progress", "Done": "done" }
    },
    "wave": "PVTSSF_wave",
    "cluster": "PVTSSF_cluster",
    "specPath": "PVTSSF_spec",
    "planPath": "PVTSSF_plan"
  },
  "labels": {
    "readyForAgent": "ready-for-agent",
    "typePrefix": "type:",
    "clusterType": "type:cluster"
  },
  "branchPrefixes": ["feat", "fix", "chore"],
  "prMarkers": {
    "partOf": "Part of",
    "retroMarker": "**Retro:**",
    "retroValues": ["done", "skipped"]
  },
  "headings": { "vorBau": "Vor Bau zu klären" }
}
```
""")
_PROFILE.close()
os.environ["BOARD_SYNC_PROFILE"] = _PROFILE.name

MOD_PATH = Path(__file__).parent / "execute-ready-check.py"
spec = importlib.util.spec_from_file_location("execute_ready_check", MOD_PATH)
erc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(erc)


def tearDownModule():
    Path(_PROFILE.name).unlink(missing_ok=True)


# The exact child-issue body template from to-issues/SKILL.md §5d — the golden
# layout the parser must handle (leading metadata HTML comments precede the marker).
CHILD_TEMPLATE = """<!-- slice-id: execute-ready-guard -->
<!-- parent-prd: #978 -->
**plan_revision:** r3

## What to build
End-to-end behavior of this vertical slice.

## Acceptance criteria
- [ ] Criterion 1
"""

ANCHOR_BODY = """<!-- prd-source-id: 978 -->
**plan_revision:** r3

## User Stories
...
"""


class TestParsePlanRevision(unittest.TestCase):
    def test_child_template_golden(self):
        rev, status = erc.parse_plan_revision(CHILD_TEMPLATE)
        self.assertEqual((rev, status), (3, "ok"))

    def test_missing(self):
        self.assertEqual(erc.parse_plan_revision("## What\nno marker"), (None, "missing"))

    def test_malformed_no_r(self):
        rev, status = erc.parse_plan_revision("**plan_revision:** 7\n\n## What")
        self.assertEqual(status, "malformed")

    def test_malformed_rX(self):
        rev, status = erc.parse_plan_revision("**plan_revision:** rX\n\n## What")
        self.assertEqual(status, "malformed")

    def test_multiple_markers(self):
        body = "**plan_revision:** r1\n**plan_revision:** r2\n\n## What"
        self.assertEqual(erc.parse_plan_revision(body)[1], "multiple")

    def test_quoted_old_body_ignored(self):
        # A marker inside a blockquote (quoted prior body) must NOT count.
        body = "**plan_revision:** r5\n\n## Old\n> **plan_revision:** r1\n"
        self.assertEqual(erc.parse_plan_revision(body), (5, "ok"))

    def test_misplaced_after_first_heading(self):
        body = "## What to build\nstuff\n\n**plan_revision:** r2\n"
        self.assertEqual(erc.parse_plan_revision(body)[1], "misplaced")


class TestParseBucket(unittest.TestCase):
    def test_afk(self):
        self.assertEqual(erc.parse_bucket(["ready-for-agent"], "## What\nok"), "afk")

    def test_hitl(self):
        body = "## What\n## Vor Bau zu klären\n- offene Frage"
        self.assertEqual(erc.parse_bucket([], body), "hitl")

    def test_ambiguous_both(self):
        body = "## Vor Bau zu klären\n- q"
        self.assertEqual(erc.parse_bucket(["ready-for-agent"], body), "ambiguous")

    def test_ambiguous_neither(self):
        self.assertEqual(erc.parse_bucket([], "## What\nok"), "ambiguous")


class TestInferIntent(unittest.TestCase):
    def test_marker_wins(self):
        self.assertEqual(erc.infer_intent("anything /grill", marker_intent="build"), "build")

    def test_grill_command_in_content(self):
        self.assertEqual(erc.infer_intent("start: /grill-with-docs over X"), "grill")
        self.assertEqual(erc.infer_intent("/grill-me then build"), "grill")

    def test_default_build(self):
        self.assertEqual(erc.infer_intent("cd worktree && /tdd"), "build")


class TestParseFinalCut(unittest.TestCase):
    def test_present(self):
        self.assertEqual(erc.parse_final_cut_depends("x <!-- final-cut-depends-on: #971 --> y"), 971)

    def test_present_with_space_and_hash(self):
        self.assertEqual(erc.parse_final_cut_depends("<!-- final-cut-depends-on: 42 -->"), 42)

    def test_absent(self):
        self.assertIsNone(erc.parse_final_cut_depends("no marker here"))


class TestIsLegacy(unittest.TestCase):
    def test_legacy_marker(self):
        self.assertTrue(erc.is_legacy("foo <!-- guard-legacy --> bar"))

    def test_not_legacy(self):
        self.assertFalse(erc.is_legacy("normal body"))


def _node(number, body, labels=None, state=None):
    n = {"number": number, "body": body, "labels": labels or []}
    if state is not None:
        n["state"] = state
    return n


class TestEvaluateGraph(unittest.TestCase):
    def test_atomar_afk_coherent(self):
        target = _node(983, "**plan_revision:** r1\n\n## What\nok", ["ready-for-agent"])
        r = erc.evaluate_graph(target, mode="handoff", intent="build")
        self.assertTrue(r["graph_coherent"])
        self.assertTrue(r["target_buildable"])
        self.assertFalse(r["deny_recommended"])

    def test_atomar_hitl_intent_build_denies(self):
        body = "**plan_revision:** r1\n\n## What\n## Vor Bau zu klären\n- q"
        target = _node(983, body, [])
        r = erc.evaluate_graph(target, mode="handoff", intent="build")
        self.assertTrue(r["graph_coherent"])        # HITL is a VALID state
        self.assertFalse(r["target_buildable"])     # but not buildable
        self.assertTrue(r["deny_recommended"])      # build-intent handoff blocked

    def test_atomar_hitl_intent_grill_allows(self):
        body = "**plan_revision:** r1\n\n## What\n## Vor Bau zu klären\n- q"
        target = _node(983, body, [])
        r = erc.evaluate_graph(target, mode="handoff", intent="grill")
        self.assertFalse(r["deny_recommended"])     # re-grill handoff is allowed

    def test_child_rev_mismatch_denies(self):
        parent = _node(978, "**plan_revision:** r3\n\n## Stories", [])
        child = _node(983, "**plan_revision:** r2\n\n## What\nok", ["ready-for-agent"])
        r = erc.evaluate_graph(child, parent=parent, siblings=[child],
                               mode="handoff", intent="build")
        self.assertFalse(r["graph_coherent"])
        self.assertTrue(r["deny_recommended"])
        self.assertTrue(any("!= anchor" in v for v in r["violations"]))

    def test_anchor_with_ready_label_is_violation(self):
        parent = _node(978, "**plan_revision:** r3\n\n## Stories", ["ready-for-agent"])
        child = _node(983, "**plan_revision:** r3\n\n## What\nok", ["ready-for-agent"])
        r = erc.evaluate_graph(child, parent=parent, siblings=[child],
                               mode="handoff", intent="build")
        self.assertFalse(r["graph_coherent"])
        self.assertTrue(any("anchor" in v for v in r["violations"]))

    def test_final_cut_closed_denies(self):
        body = ("**plan_revision:** r1\n\n## What\nok\n"
                "<!-- final-cut-depends-on: #971 -->")
        target = _node(983, body, ["ready-for-agent"])
        r = erc.evaluate_graph(target, mode="handoff", intent="build",
                               closed_lookup={971: "closed"})
        self.assertFalse(r["graph_coherent"])
        self.assertTrue(r["deny_recommended"])

    def test_final_cut_open_ok(self):
        body = ("**plan_revision:** r1\n\n## What\nok\n"
                "<!-- final-cut-depends-on: #971 -->")
        target = _node(983, body, ["ready-for-agent"])
        r = erc.evaluate_graph(target, mode="handoff", intent="build",
                               closed_lookup={971: "open"})
        self.assertTrue(r["graph_coherent"])

    def test_truncated_graph_denies(self):
        parent = _node(978, "**plan_revision:** r1\n\n## Stories", [])
        child = _node(983, "**plan_revision:** r1\n\n## What\nok", ["ready-for-agent"])
        r = erc.evaluate_graph(child, parent=parent, siblings=[child],
                               mode="handoff", intent="build", truncated=True)
        self.assertFalse(r["graph_coherent"])
        self.assertTrue(any("too large" in v for v in r["violations"]))

    def test_legacy_missing_rev_not_violation(self):
        target = _node(685, "## What\nold issue, no marker\n<!-- guard-legacy -->",
                       ["ready-for-agent"])
        r = erc.evaluate_graph(target, mode="handoff", intent="build")
        self.assertTrue(r["graph_coherent"])

    def test_audit_mode_hitl_not_denied(self):
        # audit mode never recommends deny on a valid HITL target unless intent=build
        body = "**plan_revision:** r1\n\n## What\n## Vor Bau zu klären\n- q"
        target = _node(983, body, [])
        r = erc.evaluate_graph(target, mode="audit", intent="build")
        self.assertTrue(r["graph_coherent"])
        self.assertFalse(r["deny_recommended"])     # audit mode → no block


class TestAnchorShapeAudit(unittest.TestCase):
    """#1342 provenance-neutral anchor shape audit — non-blocking, audit-only."""

    UNIFORM_ANCHOR = (
        "<!-- prd-source-id: 1342 -->\n**plan_revision:** r1\n\n"
        "**Welle 7 — Multi-Entry.**\n\n"
        "## Herkunft\n- Quelle: plan\n\n"
        "## Entscheidungen\n| a | b |\n\n"
        "## Slices\n| # | Status |\n"
    )
    DEFICIENT_ANCHOR = "<!-- prd-source-id: 1342 -->\n**plan_revision:** r1\n\n## Stories\n..."

    def _eval(self, anchor_body, mode):
        anchor = _node(1342, anchor_body, [])
        child = _node(1343, "**plan_revision:** r1\n\n## What\nok", ["ready-for-agent"])
        return erc.evaluate_graph(anchor, parent=anchor, siblings=[child],
                                  mode=mode, intent="build", target_is_anchor=True)

    def test_pure_shape_fn_uniform_clean(self):
        self.assertEqual(erc.evaluate_anchor_shape(self.UNIFORM_ANCHOR), [])

    def test_pure_shape_fn_deficient_warns(self):
        warns = erc.evaluate_anchor_shape(self.DEFICIENT_ANCHOR)
        self.assertTrue(any("Herkunft" in w for w in warns))
        self.assertTrue(any("Welle" in w for w in warns))

    def test_legacy_cluster_herkunft_satisfies(self):
        body = self.UNIFORM_ANCHOR.replace("## Herkunft", "## Cluster-Herkunft")
        self.assertEqual(erc.evaluate_anchor_shape(body), [])

    def test_deficient_anchor_warns_but_never_blocks(self):
        r = self._eval(self.DEFICIENT_ANCHOR, "audit")
        self.assertTrue(r["shape_warnings"])            # loud nudge present
        self.assertTrue(r["graph_coherent"])            # shape NOT a coherence violation
        self.assertFalse(r["deny_recommended"])         # never blocks handoff
        self.assertEqual(r["violations"], [])           # shape never enters violations

    def test_uniform_anchor_no_shape_warnings(self):
        self.assertEqual(self._eval(self.UNIFORM_ANCHOR, "audit")["shape_warnings"], [])

    def test_shape_audit_silent_in_handoff_mode(self):
        # handoff (drift-guard) mode must not surface shape noise — audit-only.
        self.assertEqual(self._eval(self.DEFICIENT_ANCHOR, "handoff")["shape_warnings"], [])


class TestLegacyAnchorGrandfathering(unittest.TestCase):
    """A legacy-tagged ANCHOR grandfathers its whole rooted graph (tag once,
    #1069/Q4=A). Constrained: pre-convention classes (plan_revision, rev-mismatch)
    suppressed graph-wide; ambiguous-bucket only for CLOSED children; OPEN children
    + structural checks (ready-on-anchor) stay live."""

    LEGACY_ANCHOR = "## Stories\nold pre-convention anchor\n<!-- guard-legacy -->"

    def test_legacy_anchor_suppresses_child_missing_rev(self):
        # Anchor carries <!-- guard-legacy -->; a child with NO plan_revision marker
        # (and not itself tagged) is grandfathered → graph coherent.
        parent = _node(978, self.LEGACY_ANCHOR, [])
        child = _node(983, "## What\nold merged child, no marker", ["ready-for-agent"])
        r = erc.evaluate_graph(child, parent=parent, siblings=[child],
                               mode="handoff", intent="build")
        self.assertTrue(r["graph_coherent"], r["violations"])
        self.assertFalse(r["deny_recommended"])

    def test_non_legacy_anchor_still_flags_child_missing_rev(self):
        # Inverse guard: without the anchor tag, the same child is a violation —
        # proves the suppression is conditional on the legacy marker.
        parent = _node(978, "**plan_revision:** r3\n\n## Stories", [])
        child = _node(983, "## What\nno marker", ["ready-for-agent"])
        r = erc.evaluate_graph(child, parent=parent, siblings=[child],
                               mode="handoff", intent="build")
        self.assertFalse(r["graph_coherent"])
        self.assertTrue(any("plan_revision missing" in v for v in r["violations"]))

    def test_legacy_anchor_suppresses_closed_child_ambiguous_bucket(self):
        # A CLOSED (merged) child with an ambiguous bucket is grandfathered.
        parent = _node(978, self.LEGACY_ANCHOR, [])
        child = _node(983, "## What\nmerged, neither label nor Vor-Bau", [], state="CLOSED")
        r = erc.evaluate_graph(child, parent=parent, siblings=[child],
                               mode="handoff", intent="build")
        self.assertTrue(r["graph_coherent"], r["violations"])

    def test_legacy_anchor_still_flags_open_child_ambiguous_bucket(self):
        # CONSTRAINT: an OPEN child newly attached under a legacy anchor keeps its
        # bucket check — new incoherence must stay visible, not be masked.
        parent = _node(978, self.LEGACY_ANCHOR, [])
        child = _node(983, "## What\nopen, ambiguous (neither label nor Vor-Bau)", [], state="OPEN")
        r = erc.evaluate_graph(child, parent=parent, siblings=[child],
                               mode="handoff", intent="build")
        self.assertFalse(r["graph_coherent"])
        self.assertTrue(any("ambiguous bucket" in v for v in r["violations"]))

    def test_legacy_anchor_does_not_suppress_ready_on_anchor(self):
        # Structural check stays live even on a grandfathered graph.
        parent = _node(978, self.LEGACY_ANCHOR, ["ready-for-agent"])
        child = _node(983, "## What\nold child", ["ready-for-agent"], state="CLOSED")
        r = erc.evaluate_graph(child, parent=parent, siblings=[child],
                               mode="handoff", intent="build")
        self.assertFalse(r["graph_coherent"])
        self.assertTrue(any("ready-for-agent on an anchor" in v for v in r["violations"]))

    def test_grandfathered_field_set_when_applied_else_none(self):
        legacy_parent = _node(978, self.LEGACY_ANCHOR, [])
        child = _node(983, "## What\nold child", ["ready-for-agent"], state="CLOSED")
        r = erc.evaluate_graph(child, parent=legacy_parent, siblings=[child],
                               mode="handoff", intent="build")
        self.assertEqual(r["grandfathered"], 978)
        # non-legacy anchor → None
        plain_parent = _node(978, "**plan_revision:** r3\n\n## Stories", [])
        ok_child = _node(983, "**plan_revision:** r3\n\n## What\nok", ["ready-for-agent"])
        r2 = erc.evaluate_graph(ok_child, parent=plain_parent, siblings=[ok_child],
                                mode="handoff", intent="build")
        self.assertIsNone(r2["grandfathered"])
        # atomar leaf → None
        r3 = erc.evaluate_graph(ok_child, mode="handoff", intent="build")
        self.assertIsNone(r3["grandfathered"])


class TestFailClosed(unittest.TestCase):
    """Once a handoff target is identified, a gh failure must fail-CLOSED
    (deny), never silently permit the stale handoff the guard exists to stop."""

    def test_gh_issue_fetch_failure_denies(self):
        with patch.object(erc, "_run", return_value=(-1, "")):
            r = erc.build_and_evaluate(983, "handoff", "build")
        self.assertTrue(r["deny_recommended"])
        self.assertFalse(r["graph_coherent"])

    def test_fail_closed_result_carries_grandfathered_key(self):
        # Schema consistency: every result dict must carry `grandfathered`
        # (default None) so consumers/tests don't hit mixed schemas.
        with patch.object(erc, "_run", return_value=(-1, "")):
            r = erc.build_and_evaluate(983, "handoff", "build")
        self.assertIn("grandfathered", r)
        self.assertIsNone(r["grandfathered"])

    def test_atomar_afk_full_gh_path_ok(self):
        body = "**plan_revision:** r1\n\n## What\nok"

        def fake_run(cmd, timeout=15):
            if cmd[:3] == ["gh", "issue", "view"]:
                return 0, '{"number":983,"body":' + json_dump(body) + \
                       ',"labels":[{"name":"ready-for-agent"}],"state":"OPEN"}'
            if "parent-of" in cmd:
                return 0, "FREI"
            if "children-of" in cmd:
                return 0, ""
            return -1, ""

        with patch.object(erc, "_run", side_effect=fake_run):
            r = erc.build_and_evaluate(983, "handoff", "build")
        self.assertFalse(r["deny_recommended"])
        self.assertTrue(r["graph_coherent"])


class TestMainAuditObservability(unittest.TestCase):
    def test_audit_prints_grandfathered_note(self):
        # Suppressed violations vanish silently → audit output must surface that a
        # legacy graph was grandfathered (Codex R1 #8).
        import io
        import contextlib
        fake = {"graph_coherent": True, "target_buildable": True,
                "deny_recommended": False, "violations": [], "grandfathered": 978}
        buf = io.StringIO()
        with patch.object(erc, "build_and_evaluate", return_value=fake), \
                patch("sys.argv", ["x", "--issue", "983", "--mode", "audit"]), \
                contextlib.redirect_stdout(buf):
            erc.main()
        out = buf.getvalue()
        self.assertIn("grandfathered", out)
        self.assertIn("978", out)

    def test_audit_no_note_when_not_grandfathered(self):
        import io
        import contextlib
        fake = {"graph_coherent": True, "target_buildable": True,
                "deny_recommended": False, "violations": [], "grandfathered": None}
        buf = io.StringIO()
        with patch.object(erc, "build_and_evaluate", return_value=fake), \
                patch("sys.argv", ["x", "--issue", "983", "--mode", "audit"]), \
                contextlib.redirect_stdout(buf):
            erc.main()
        self.assertNotIn("grandfathered", buf.getvalue())


def json_dump(s):
    import json as _j
    return _j.dumps(s)


if __name__ == "__main__":
    unittest.main(verbosity=2)
