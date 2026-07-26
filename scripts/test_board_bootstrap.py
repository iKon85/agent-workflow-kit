#!/usr/bin/env python3
"""Spec for `board_bootstrap.py` — offered board creation for /setup-workflow (#24).

Section D of `setup-workflow` used to refuse board creation outright. It now
OFFERS it, and the mechanical part (create → read back → validate → write the
profile) belongs to a deterministic helper rather than to prose.

Every path is exercised against a FAKE `gh` seam — this suite never touches the
live GitHub API and never creates a project:

  * approval    — the full sequence, ending in a profile `board_config` loads.
  * missing scope — refused before the first write.
  * decline     — no invocation at all (the prose contract lives in
                  `test_skill_setup_workflow_seeds.py`).
  * failure     — a failed create, a missing field on readback, or a status
                  option a role maps to but the board lacks: no profile file.

Run: python3 scripts/test_board_bootstrap.py
"""
from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory

import board_bootstrap as bb
import board_config

REPO = Path(__file__).resolve().parent.parent
SEED = REPO / ".claude/skills/setup-workflow/board-sync.md"

PROJECT_NODE = "PVT_fakeproject"
PROJECT_NUMBER = 7
OWNER = "octo"
REPO_SLUG = "octo/widgets"

AUTH_TEMPLATE = """github.com
  - Active account: true
  - Token scopes: {scopes}
"""

WORKFLOW_FIELD_NAMES = ("Wave", "Cluster", "Spec-Path", "Plan-Path")


def seed_config(path=SEED):
    return board_config.load_board_config(path)


def role_names(cfg=None):
    return bb.status_option_names(cfg or seed_config())


def field_list_payload(status_options=None, workflow=WORKFLOW_FIELD_NAMES):
    """A `gh project field-list --format json` payload in the shape the real CLI
    emits (verified against a live board on 2026-07-26)."""
    status_options = role_names() if status_options is None else status_options
    fields = [{"id": "PVTF_fakeTitle", "name": "Title", "type": "ProjectV2Field"}]
    fields.append({
        "id": "PVTSSF_fakeStatus",
        "name": "Status",
        "type": "ProjectV2SingleSelectField",
        "options": [{"id": f"opt{i}", "name": name} for i, name in enumerate(status_options)],
    })
    for name in workflow:
        fields.append({"id": f"PVTF_fake{name.replace('-', '')}", "name": name,
                       "type": "ProjectV2Field"})
    return {"fields": fields, "totalCount": len(fields)}


class FakeGh:
    """Records every `gh` argv and answers from scripted payloads."""

    def __init__(self, *, scopes="'gist', 'project', 'repo'", field_list=None,
                 fail_on_field=None, fail_on_create=False):
        self.scopes = scopes
        self.field_list = field_list_payload() if field_list is None else field_list
        self.fail_on_field = fail_on_field
        self.fail_on_create = fail_on_create
        self.calls: list[list[str]] = []

    @property
    def write_calls(self):
        return [c for c in self.calls if c[:2] in (["project", "create"],
                                                    ["project", "field-create"])]

    def _flag(self, args, flag):
        return args[args.index(flag) + 1]

    def __call__(self, args):
        args = list(args)
        self.calls.append(args)
        head = args[:2]
        if head == ["auth", "status"]:
            return AUTH_TEMPLATE.format(scopes=self.scopes)
        if head == ["project", "create"]:
            if self.fail_on_create:
                raise bb.BootstrapError("`gh project create` failed: HTTP 500")
            return json.dumps({"id": PROJECT_NODE, "number": PROJECT_NUMBER,
                               "title": self._flag(args, "--title"),
                               "url": f"https://github.com/users/{OWNER}/projects/{PROJECT_NUMBER}"})
        if head == ["project", "field-create"]:
            name = self._flag(args, "--name")
            if name == self.fail_on_field:
                raise bb.BootstrapError(f"`gh project field-create` failed: {name} rejected")
            return json.dumps({"id": f"PVTF_new{name}", "name": name})
        if head == ["project", "field-list"]:
            return json.dumps(self.field_list)
        raise AssertionError(f"unexpected gh call: {' '.join(args)}")


def run_create(fake, out_path, *, seed=SEED, extra=()):
    """Invoke the CLI with `fake` patched in; return (exit_code, stdout, stderr)."""
    argv = ["create", "--owner", OWNER, "--repo", REPO_SLUG, "--title", "Widgets Workflow",
            "--seed", str(seed), "--out", str(out_path), *extra]
    original = bb._gh
    bb._gh = fake
    out, err = io.StringIO(), io.StringIO()
    try:
        with redirect_stdout(out), redirect_stderr(err):
            code = bb.main(argv)
    finally:
        bb._gh = original
    return code, out.getvalue(), err.getvalue()


class ScopePreflight(unittest.TestCase):
    def test_project_scope_present_is_no_finding(self):
        self.assertEqual(bb.missing_scopes(AUTH_TEMPLATE.format(scopes="'repo', 'project'")), [])

    def test_project_scope_absent_is_reported(self):
        self.assertEqual(bb.missing_scopes(AUTH_TEMPLATE.format(scopes="'repo', 'gist'")),
                         ["project"])

    def test_missing_scope_refuses_before_any_write(self):
        fake = FakeGh(scopes="'repo', 'gist'")
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "board-sync.md"
            code, _, err = run_create(fake, out)
        self.assertEqual(code, bb.EXIT_MISSING_SCOPE)
        self.assertEqual(fake.write_calls, [], "no board may be created without the scope")
        self.assertIn("gh auth refresh -s project,read:project", err)
        self.assertFalse(out.exists(), "a scope failure must not write a profile")


class StatusOptionsComeFromTheProfile(unittest.TestCase):
    def test_option_names_are_the_seeded_role_names_in_role_order(self):
        cfg = seed_config()
        roles = board_config.status_roles(cfg)
        self.assertEqual(role_names(cfg),
                         [roles[key] for key in board_config.STATUS_ROLE_KEYS if key in roles])

    def test_a_non_english_roles_map_yields_its_own_option_names(self):
        cfg = seed_config()
        cfg["fields"]["status"]["roles"] = {"spec": "Spécification", "inProgress": "En cours",
                                            "done": "Terminé"}
        self.assertEqual(bb.status_option_names(cfg), ["Spécification", "En cours", "Terminé"])

    def test_an_empty_roles_map_is_a_hard_error_not_an_english_default(self):
        cfg = seed_config()
        cfg["fields"]["status"]["roles"] = {}
        with self.assertRaises(bb.BootstrapError):
            bb.status_option_names(cfg)

    def test_a_comma_in_an_option_name_is_refused(self):
        cfg = seed_config()
        cfg["fields"]["status"]["roles"] = {"spec": "Spec, draft"}
        with self.assertRaises(bb.BootstrapError):
            bb.status_option_names(cfg)


class ApprovalPath(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "board-sync.md"
        self.fake = FakeGh()
        self.code, self.stdout, self.stderr = run_create(self.fake, self.out)

    def test_exit_is_clean(self):
        self.assertEqual(self.code, 0, self.stderr)

    def test_the_sequence_is_create_then_fields_then_readback(self):
        shape = [tuple(c[:2]) for c in self.fake.calls]
        self.assertEqual(shape, [
            ("auth", "status"),
            ("project", "create"),
            *[("project", "field-create")] * (1 + len(WORKFLOW_FIELD_NAMES)),
            ("project", "field-list"),
        ])

    def test_status_is_created_with_its_options_in_one_call(self):
        call = next(c for c in self.fake.calls
                    if c[:2] == ["project", "field-create"] and "Status" in c)
        self.assertIn("--single-select-options", call)
        self.assertEqual(call[call.index("--single-select-options") + 1],
                         ",".join(role_names()))
        self.assertEqual(call[call.index("--data-type") + 1], "SINGLE_SELECT")

    def test_every_workflow_field_is_created(self):
        created = {c[c.index("--name") + 1] for c in self.fake.calls
                   if c[:2] == ["project", "field-create"]}
        self.assertEqual(created, {"Status", *WORKFLOW_FIELD_NAMES})

    def test_the_written_file_carries_the_filled_sentinel(self):
        first = self.out.read_text(encoding="utf-8").splitlines()[0]
        self.assertEqual(first, "<!-- setup-workflow: state=filled; mode=github-projects-v2 -->")

    def test_board_config_loads_the_written_profile(self):
        cfg = board_config.load_board_config(self.out)  # raises ConfigError on any gap
        self.assertEqual(cfg["repo"], REPO_SLUG)
        self.assertEqual(cfg["project"], {"number": PROJECT_NUMBER, "owner": OWNER,
                                          "nodeId": PROJECT_NODE})

    def test_ids_come_from_the_readback_not_from_the_create_calls(self):
        cfg = board_config.load_board_config(self.out)
        by_name = {f["name"]: f for f in self.fake.field_list["fields"]}
        self.assertEqual(cfg["fields"]["status"]["id"], by_name["Status"]["id"])
        self.assertEqual(cfg["fields"]["wave"], by_name["Wave"]["id"])
        self.assertEqual(cfg["fields"]["cluster"], by_name["Cluster"]["id"])
        self.assertEqual(cfg["fields"]["specPath"], by_name["Spec-Path"]["id"])
        self.assertEqual(cfg["fields"]["planPath"], by_name["Plan-Path"]["id"])
        self.assertEqual(cfg["fields"]["status"]["options"],
                         {o["name"]: o["id"] for o in by_name["Status"]["options"]})

    def test_every_status_role_resolves_to_a_real_option(self):
        cfg = board_config.load_board_config(self.out)
        options = cfg["fields"]["status"]["options"]
        roles = board_config.status_roles(cfg)
        self.assertTrue(roles)
        for role, name in roles.items():
            self.assertIn(name, options, f"role {role} maps to an option the board lacks")

    def test_no_placeholder_survives_in_the_profile(self):
        raw = self.out.read_text(encoding="utf-8")
        block = raw.split("<!-- board-sync:profile -->", 1)[1].split("```")[1]
        self.assertNotIn("<fill", block)
        self.assertNotIn("<owner>", block)

    def test_the_optional_phase_placeholder_is_not_claimed(self):
        cfg = board_config.load_board_config(self.out)
        self.assertIsNone(board_config.phase_field_id(cfg),
                          "an uncreated Phase field must not appear in the profile")

    def test_the_seed_conventions_survive(self):
        cfg = board_config.load_board_config(self.out)
        seed = seed_config()
        for key in ("labels", "branchPrefixes", "prMarkers", "headings", "titles", "wrapup"):
            self.assertEqual(cfg.get(key), seed.get(key), key)

    def test_the_documentation_body_survives(self):
        self.assertIn("## Board profile", self.out.read_text(encoding="utf-8"))


class FailurePathsWriteNoProfile(unittest.TestCase):
    def _run(self, fake, **kwargs):
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "board-sync.md"
            code, _, err = run_create(fake, out, **kwargs)
            return code, err, out.exists()

    def test_failed_project_create_writes_nothing(self):
        code, err, exists = self._run(FakeGh(fail_on_create=True))
        self.assertEqual(code, bb.EXIT_FAILURE)
        self.assertFalse(exists)
        self.assertIn("gh project create", err)

    def test_failed_field_create_writes_nothing_and_names_the_project(self):
        fake = FakeGh(fail_on_field="Spec-Path")
        code, err, exists = self._run(fake)
        self.assertEqual(code, bb.EXIT_FAILURE)
        self.assertFalse(exists, "a partial board must never produce a profile")
        self.assertIn(str(PROJECT_NUMBER), err, "the half-created project must be named")

    def test_a_field_missing_on_readback_fails_validation(self):
        fake = FakeGh(field_list=field_list_payload(workflow=("Wave", "Cluster", "Spec-Path")))
        code, err, exists = self._run(fake)
        self.assertEqual(code, bb.EXIT_FAILURE)
        self.assertFalse(exists)
        self.assertIn("Plan-Path", err)

    def test_a_status_option_missing_on_readback_fails_validation(self):
        fake = FakeGh(field_list=field_list_payload(status_options=role_names()[:-1]))
        code, err, exists = self._run(fake)
        self.assertEqual(code, bb.EXIT_FAILURE)
        self.assertFalse(exists)
        self.assertIn("role", err)

    def test_an_absent_status_field_fails_validation(self):
        payload = field_list_payload()
        payload["fields"] = [f for f in payload["fields"] if f["name"] != "Status"]
        code, err, exists = self._run(FakeGh(field_list=payload))
        self.assertEqual(code, bb.EXIT_FAILURE)
        self.assertFalse(exists)
        self.assertIn("Status", err)


class DestinationGuard(unittest.TestCase):
    def test_decision_table(self):
        self.assertEqual(bb.destination_action(None), "create")
        self.assertEqual(bb.destination_action(
            "<!-- setup-workflow: state=stub; mode=github-projects-v2 -->"), "fill")
        self.assertEqual(bb.destination_action(
            "<!-- setup-workflow: state=filled; mode=github-projects-v2 -->"), "refuse")
        self.assertEqual(bb.destination_action(
            "<!-- setup-workflow: state=not-applicable; mode=none -->"), "refuse")
        self.assertEqual(bb.destination_action("# Board sync"), "refuse")

    def test_a_filled_profile_is_never_overwritten_and_nothing_is_created(self):
        fake = FakeGh()
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "board-sync.md"
            out.write_text("<!-- setup-workflow: state=filled; mode=github-projects-v2 -->\n# x\n",
                           encoding="utf-8")
            code, _, err = run_create(fake, out)
            self.assertEqual(code, bb.EXIT_REFUSED)
            self.assertEqual(fake.calls, [], "the destination is checked before any gh call")
            self.assertIn("state=filled", err)
            self.assertTrue(out.read_text(encoding="utf-8").endswith("# x\n"))

    def test_a_stub_destination_is_filled(self):
        fake = FakeGh()
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "board-sync.md"
            out.write_text("<!-- setup-workflow: state=stub; mode=github-projects-v2 -->\nold\n",
                           encoding="utf-8")
            code, _, err = run_create(fake, out)
            self.assertEqual(code, 0, err)
            self.assertEqual(board_config.load_board_config(out)["repo"], REPO_SLUG)


class DryRun(unittest.TestCase):
    def test_dry_run_creates_nothing(self):
        fake = FakeGh()
        with TemporaryDirectory() as tmp:
            out = Path(tmp) / "board-sync.md"
            code, stdout, err = run_create(fake, out, extra=("--dry-run",))
        self.assertEqual(code, 0, err)
        self.assertEqual(fake.write_calls, [])
        self.assertFalse(out.exists())
        self.assertIn("gh project create", stdout)
        self.assertIn(",".join(role_names()), stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
