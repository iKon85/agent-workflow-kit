#!/usr/bin/env python3
"""board-sync.py — single GitHub Projects-v2 board-sync / sub-issue helper.

Encapsulates the five board mechanics the planning skills used to inline as bare
`gh` snippets (board-to-waves, to-prd, to-issues):

  1. GraphQL-Link    — native parent↔child sub-issue link (`link`)
  2. one-parent-check — an issue may have only one parent (`parent-of`, folded into `link`)
  3. preview-header  — `GraphQL-Features: sub_issues` on every sub-issue call
  4. Wave-Stempel    — stamp the Wave (number) field (`--wave` on `create`/`add`)
  5. board-sync      — add an issue to the board + set Status/Wave/Cluster/Path fields

Board-specific values (field IDs, status names, labels) are NOT inlined here —
board_config reads them from the `board-sync:profile` block in
docs/agents/board-sync.md, so the published script carries no project-private
constants. Re-verify the IDs against a changed board with
`gh project field-list <n> --owner <owner> --format json`.

All write commands accept --dry-run (prints the gh argv it would run, no network).
The single `_gh` subprocess seam is monkeypatched in scripts/test_board_sync.py so
tests never touch the real API.
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_config import (  # noqa: E402
    ConfigError, load_board_config, phase_field_id, program_type_label,
    status_roles, wave_title_prefix, STATUS_ROLE_KEYS,
)
# stamp-batch / field-value / promote-guards — pure logic, see module docstring.
from board_fields import (  # noqa: E402
    build_stamps, chunk_stamps, build_stamp_mutation, parse_batch_response, repair_command,
    extract_field_value, wave_mismatch_guard, program_prd_refusal,
)
# Node-kind classifier — `promote`'s Program-PRD refusal + `program-sync`'s
# node-kind dispatch guard both need to tell a Program-PRD apart from a Welle-Anker.
from node_kind import classify_node, PROGRAM  # noqa: E402
# Blocked-by body mirror — pure render/splice/parse + the shared
# "open blocker" predicate, shared with the execute-ready drift check;
# native dependencies (API) are the truth.
from issue_deps import open_blocker_numbers, splice_blocked_by_section  # noqa: E402

# --- Board profile (SSOT: docs/agents/board-sync.md `board-sync:profile`) ----
# No inline board IDs: board_config reads them from the profile so the published
# kit carries no project-private constants (a consumer's profile is seeded by
# /setup-workflow). A bad/missing profile fails clean here (one-line stderr, exit
# 1) instead of a raw ConfigError traceback.
try:
    _CFG = load_board_config()
except ConfigError as exc:
    print(f"error: {exc}", file=sys.stderr)
    sys.exit(1)
REPO = _CFG["repo"]
REPO_NAME = REPO.split("/", 1)[1]
PROJECT_NUMBER = _CFG["project"]["number"]
PROJECT_OWNER = _CFG["project"]["owner"]
PROJECT_NODE_ID = _CFG["project"]["nodeId"]
STATUS_FIELD_ID = _CFG["fields"]["status"]["id"]
STATUS_OPTIONS = _CFG["fields"]["status"]["options"]
WAVE_FIELD_ID = _CFG["fields"]["wave"]
CLUSTER_FIELD_ID = _CFG["fields"]["cluster"]
SPEC_PATH_FIELD_ID = _CFG["fields"]["specPath"]
PLAN_PATH_FIELD_ID = _CFG["fields"]["planPath"]
READY_FOR_AGENT = _CFG["labels"]["readyForAgent"]
TYPE_PREFIX = _CFG["labels"]["typePrefix"]
CLUSTER_TYPE_LABEL = _CFG["labels"]["clusterType"]
WAVE_STUB_LABEL = _CFG["labels"]["waveStub"]
# Optional Programm-Flughöhe key — literal-default getter, so
# an existing profile without `labels.programType` keeps working unchanged.
PROGRAM_TYPE_LABEL = program_type_label(_CFG)
# Optional semantic role map — empty dict when the profile has no
# `fields.status.roles` yet; role-consuming paths degrade visibly (see
# `_status_roles_or_hint` / `resolve_status_role`), never crash.
STATUS_ROLES = status_roles(_CFG)


def _status_roles_or_hint(context: str) -> dict:
    """STATUS_ROLES, with a one-line stderr hint when the profile has no role
    map — status-name-based signals then read as 'open' (⬜) while PR-based
    signals keep working; the sync itself proceeds."""
    if not STATUS_ROLES:
        print(f"hint: {context}: no fields.status.roles in the board profile — "
              "board-status names can't be interpreted (PR signals still work); "
              "add the roles map (see docs/agents/board-sync.md)", file=sys.stderr)
    return STATUS_ROLES
PROJECT_ITEM_LIST_LIMIT = 2000
GH_TIMEOUT_SECONDS = 15  # a hanging gh prompt must not block a session indefinitely

# Sub-issues GraphQL API is behind a preview feature gate per account.
SUB_ISSUES_HEADER = "GraphQL-Features: sub_issues"

ADD_SUBISSUE_MUTATION = (
    "mutation($parent:ID!,$child:ID!){"
    "addSubIssue(input:{issueId:$parent,subIssueId:$child}){"
    "issue{number} subIssue{number}}}"
)
REMOVE_SUBISSUE_MUTATION = (
    "mutation($parent:ID!,$child:ID!){"
    "removeSubIssue(input:{issueId:$parent,subIssueId:$child}){"
    "issue{number} subIssue{number}}}"
)
PARENT_QUERY = (
    "query($owner:String!,$repo:String!,$num:Int!){"
    "repository(owner:$owner,name:$repo){issue(number:$num){parent{number title}}}}"
)
CHILDREN_QUERY = (
    "query($owner:String!,$repo:String!,$num:Int!){"
    "repository(owner:$owner,name:$repo){issue(number:$num){"
    "subIssues(first:100){nodes{number}}}}}"
)


class GhError(RuntimeError):
    """Raised when the gh CLI exits non-zero."""


# --- subprocess seam (the only thing tests monkeypatch) ----------------------
def _gh(args: list[str]) -> str:
    """Run `gh <args>`, return stdout. Raise GhError on non-zero exit or timeout."""
    try:
        result = subprocess.run(["gh", *args], capture_output=True, text=True,
                                 timeout=GH_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise GhError(f"gh {' '.join(args)} timed out after {GH_TIMEOUT_SECONDS}s") from exc
    if result.returncode != 0:
        # `gh api graphql` exits non-zero when the response body carries GraphQL
        # `errors` even alongside a partial `data` (stamp-batch's per-alias
        # failure case) — attach the raw stdout to the exception so a
        # caller that WANTS that partial body (stamp-batch) can still parse it,
        # without changing `_gh`'s raise-on-nonzero contract for every other
        # caller that doesn't look at `.stdout`.
        err = GhError(f"gh {' '.join(args)} failed: {result.stderr.strip()}")
        err.stdout = result.stdout
        raise err
    return result.stdout


def _gh_json(args: list[str]):
    return json.loads(_gh(args))


def _print_dry(args: list[str]) -> None:
    print("[dry-run] gh " + " ".join(args))


# --- pure logic (directly unit-tested) ---------------------------------------
_PROGRAM_CREATE_IDENTITY_RE = re.compile(
    r"<!--\s*(program-(?:stub|leaf)-source):\s*([^>]+?)\s*-->"
)


def extract_program_create_identity(body: str) -> Optional[str]:
    """Stable to-waves identity carried by a stub/leaf body, if present."""
    match = _PROGRAM_CREATE_IDENTITY_RE.search(body)
    return f"{match.group(1)}: {match.group(2).strip()}" if match else None


def _find_open_issue_by_program_identity(body: str) -> Optional[dict]:
    """Search-before-create for to-waves crash/retry safety.

    GitHub search does not index HTML comments, so fetch the bounded open set and
    compare the parsed marker locally. More than one match is drift: never pick a
    winner silently.
    """
    identity = extract_program_create_identity(body)
    if identity is None:
        return None
    issues = _gh_json([
        "issue", "list", "--repo", REPO, "--state", "open", "--limit", "500",
        "--json", "number,url,body",
    ])
    matches = [
        issue for issue in issues
        if extract_program_create_identity(issue.get("body") or "") == identity
    ]
    if len(matches) > 1:
        numbers = ", ".join(f"#{issue['number']}" for issue in matches)
        raise ValueError(f"duplicate {identity} issues: {numbers}")
    return matches[0] if matches else None


def compute_next_wave(items: list[dict]) -> int:
    """Next monotone wave number = max(assigned wave) + 1, or 1 if none."""
    waves = [it.get("wave") for it in items if it.get("wave") is not None]
    return max(waves) + 1 if waves else 1


def extract_parent_number(data: dict) -> Optional[int]:
    """Pull the parent issue number out of the parent-query GraphQL response."""
    issue = (data.get("data") or {}).get("repository", {}).get("issue")
    parent = issue.get("parent") if issue else None
    return parent["number"] if parent else None


def extract_children_numbers(data: dict) -> list[int]:
    """Pull the native sub-issue numbers out of the children-query response."""
    issue = (data.get("data") or {}).get("repository", {}).get("issue")
    nodes = ((issue or {}).get("subIssues") or {}).get("nodes") or []
    return [n["number"] for n in nodes]


def extract_item_id(item_add_json: dict) -> str:
    """The project item node id returned by `gh project item-add --format json`."""
    return item_add_json["id"]


def one_parent_decision(existing_parent: Optional[int], target_parent: int) -> str:
    """Decide what `link` should do given the child's current parent.

    Returns 'link' (free), 'already' (same parent — idempotent no-op), or
    'conflict' (foreign parent — skip, never silently re-parent).
    """
    if existing_parent is None:
        return "link"
    if existing_parent == target_parent:
        return "already"
    return "conflict"


def hitl_guard(hitl: bool, labels: list[str]) -> None:
    """A HITL child is not buildable yet — it must never carry ready-for-agent.

    AFK and HITL children are both Status Spec, so the status cannot discriminate;
    only the explicit --hitl signal can. Raises ValueError on the contradiction.
    """
    if hitl and READY_FOR_AGENT in (labels or []):
        raise ValueError(
            f"HITL issue must not carry '{READY_FOR_AGENT}' — a HITL slice is not "
            "buildable until grilled. Drop the label or drop --hitl.")


def resolve_status_option(name: str) -> str:
    if name not in STATUS_OPTIONS:
        raise ValueError(f"unknown status {name!r}; valid: {', '.join(STATUS_OPTIONS)}")
    return STATUS_OPTIONS[name]


_ROLES_MIGRATION_SNIPPET = (
    'no fields.status.roles in the board profile — add it to the profile block '
    'in docs/agents/board-sync.md, mapping each role to YOUR board\'s status '
    'option names (any language), e.g.:\n'
    '  "roles": {\n'
    '    "idea": "Idea", "triaged": "Triaged", "spec": "Spec",\n'
    '    "inProgress": "In Progress", "review": "Review", "done": "Done"\n'
    '  }')


def resolve_status_role(role: str, roles: dict) -> str:
    """Option NAME for a semantic role key, via the profile's roles map.
    Fails loud + instructive (missing map → migration snippet; unset role →
    the configured roles) — an explicit --status-role call never guesses."""
    if not roles:
        raise ValueError(_ROLES_MIGRATION_SNIPPET)
    name = roles.get(role)
    if not name:
        raise ValueError(
            f"status role {role!r} not set in fields.status.roles; "
            f"configured roles: {', '.join(sorted(roles))}")
    return name


def stamp_arg_list(item_id, wave, status, cluster, spec_path, plan_path) -> list[list[str]]:
    """Build one `project item-edit` argv per field that was provided."""
    base = ["project", "item-edit", "--id", item_id, "--project-id", PROJECT_NODE_ID]
    out: list[list[str]] = []
    if wave is not None:
        out.append([*base, "--field-id", WAVE_FIELD_ID, "--number", str(wave)])
    if status is not None:
        out.append([*base, "--field-id", STATUS_FIELD_ID,
                    "--single-select-option-id", resolve_status_option(status)])
    if cluster is not None:
        out.append([*base, "--field-id", CLUSTER_FIELD_ID, "--text", cluster])
    if spec_path is not None:
        out.append([*base, "--field-id", SPEC_PATH_FIELD_ID, "--text", spec_path])
    if plan_path is not None:
        out.append([*base, "--field-id", PLAN_PATH_FIELD_ID, "--text", plan_path])
    return out


def issue_number_from_url(url: str) -> int:
    return int(url.rstrip("/").rsplit("/", 1)[-1])


# --- native issue dependencies ----------------------------------------
# REST blocked_by endpoints (verified live 2026-07-09): the list response carries
# FULL issue objects and INCLUDES closed blockers — "blocked" always means
# "has OPEN blockers" downstream, so extraction keeps the state and the open
# filter is explicit. Writes take the numeric DATABASE id (`issue.id`), never
# `#number`/`node_id` — resolution stays encapsulated here (`_db_id`).
def extract_blockers(data: list) -> list[dict]:
    """Normalize the REST blocked_by list response to the four fields we use."""
    return [{"number": it["number"], "id": it["id"],
             "state": it["state"], "title": it.get("title", "")}
            for it in (data or [])]


# --- Phase-1 LoC-offender marker -------------------------------------
# At the buildability transition (create with ready-for-agent / add --bucket afk),
# if the slice's `## Blast-Radius` block names a still-listed offender, plant a
# machine-readable marker so the build session is forewarned (Phase 1b) — the
# authority remains the PR-push diff gate (Phase 2). Marker-before-ready ordering
# is enforced by the call sites; no substantiality decision happens here.
_BLAST_HEADING_RE = re.compile(r"^#{2,3}\s+Blast-Radius\b", re.IGNORECASE)
_NEXT_HEADING_RE = re.compile(r"^#{1,6}\s")
_BLAST_FIELD_RE = re.compile(r"^\*\*(?:Primary|Transitive):\*\*\s*(.+)$", re.IGNORECASE)
_OFFENDER_MARKER_RE = re.compile(r"^<!--\s*loc-offender:.*-->\s*$", re.MULTILINE)


def parse_blast_radius(body: str) -> set:
    """Paths listed under the `## Blast-Radius` block (Primary + Transitive)."""
    lines = (body or "").splitlines()
    start = next((i for i, ln in enumerate(lines) if _BLAST_HEADING_RE.match(ln)), None)
    if start is None:
        return set()
    paths: set = set()
    for ln in lines[start + 1:]:
        if _NEXT_HEADING_RE.match(ln):
            break
        m = _BLAST_FIELD_RE.match(ln.strip())
        if not m:
            continue
        for tok in m.group(1).split(","):
            tok = tok.strip().strip("`").strip()
            if tok and "/" in tok:
                paths.add(tok)
    return paths


def loc_offender_hits(body: str, offenders: set) -> list:
    """Sorted intersection of the Blast-Radius paths with the offender baseline."""
    return sorted(parse_blast_radius(body) & set(offenders))


def plant_offender_marker(body: str, hits: list) -> str:
    """Insert/replace the `<!-- loc-offender: … -->` marker at the top. Idempotent."""
    if not hits:
        return body
    body = _OFFENDER_MARKER_RE.sub("", body or "").lstrip("\n")
    marker = f"<!-- loc-offender: {','.join(hits)} -->"
    return f"{marker}\n{body}"


def read_offenders() -> set:
    """The offender baseline from the single SSOT (max-lines-allowlist.json)."""
    p = Path(__file__).resolve().parent.parent / "max-lines-allowlist.json"
    return set(json.loads(p.read_text(encoding="utf-8")).get("offenders", []))


def bucket_label_args(issue: int, bucket: Optional[str]) -> Optional[list[str]]:
    """`gh issue edit` argv for the workflow-label write of a bucket, or None.

    The sanctioned route for an existing leaf's workflow label (§5a forbids a bare
    `gh issue edit --add-label ready-for-agent`; the helper stays the owner).

      afk  → ADD ready-for-agent (buildable now).
      hitl → STRIP ready-for-agent (not buildable until grilled).

    Same invariant `create --hitl` enforces by *rejecting* a ready-for-agent label;
    here enforced by *stripping* — a HITL issue can never end up carrying it.
    """
    if bucket is None:
        return None
    base = ["issue", "edit", str(issue), "--repo", REPO]
    # Bucketing = to-issues' atomar publish (5b): the source stub becomes a build-ready
    # leaf, so it leaves the wave-stub planning list too. Strip is unconditional
    # (gh exits 0 on an absent label, verified 2026-06-15).
    if bucket == "afk":
        return [*base, "--add-label", READY_FOR_AGENT, "--remove-label", WAVE_STUB_LABEL]
    if bucket == "hitl":
        return [*base, "--remove-label", READY_FOR_AGENT, "--remove-label", WAVE_STUB_LABEL]
    raise ValueError(f"unknown bucket {bucket!r}; valid: afk, hitl")


def type_labels_to_strip(labels: list[str]) -> list[str]:
    """Non-cluster, non-program `type:*` labels to remove so exactly one
    `type:*` remains.

    Board convention is one `type:*` per issue; promotion REPLACES the prior
    type (e.g. type:followup) with type:cluster rather than adding a second
   . `PROGRAM_TYPE_LABEL` is excluded too — a Program-PRD's
    type label must never be caught by this strip, regardless of caller.
    """
    return [l for l in labels
            if l.startswith(TYPE_PREFIX) and l != CLUSTER_TYPE_LABEL and l != PROGRAM_TYPE_LABEL]


def promote_label_args(issue: int, strip: Optional[list[str]] = None) -> list[str]:
    """The `gh issue edit` argv that adds type:cluster and strips prior type:* labels.

    Also strips `wave-stub` and `ready-for-agent`: once promoted the issue is a
    planned Anker, no longer a board-to-waves candidate and never a buildable leaf —
    an Anker carries no buildability bucket (the post-promote audit invariant). A
    clean Draft-PRD has neither label, but an atomar→promote flip source can carry
    `ready-for-agent` (it was first wrongly published as an AFK leaf).
    Unconditional `--remove-label` is safe — gh exits 0 when the label is absent
    (verified 2026-06-15).
    """
    args = ["issue", "edit", str(issue), "--repo", REPO,
            "--add-label", CLUSTER_TYPE_LABEL,
            "--remove-label", WAVE_STUB_LABEL,
            "--remove-label", READY_FOR_AGENT]
    for label in strip or []:
        args += ["--remove-label", label]
    return args


# The wave-anchor title prefix word comes from the profile (`titles.wavePrefix`,
# literal default "Welle" — see board_config.wave_title_prefix).
WAVE_TITLE_PREFIX = wave_title_prefix(_CFG)
# Existing `<prefix> <N> — ` prefix (any number, em-dash/en-dash/hyphen
# separator) — replaced on re-promote so the wave number never doubles up.
_WAVE_PREFIX_RE = re.compile(
    rf"^\s*{re.escape(WAVE_TITLE_PREFIX)}\s+\d+\s*[—–-]\s*", re.IGNORECASE
)
# Leading conventional-commit token (`fix:`, `feat(ui):`, `chore!:`) — anchors
# don't carry these, so strip it when present. Matches only a lowercase token,
# so prose titles like "Supabase-Residuen entfernen: …" are left intact.
_CONVENTIONAL_PREFIX_RE = re.compile(r"^[a-z]+(\([^)]*\))?!?:\s*")


def wave_title(current: str, wave: int) -> str:
    """Title for a wave anchor: `<prefix> <N> — <topic>`.

    Strips a leading conventional-commit prefix FIRST, then any existing
    `<prefix> X — ` prefix underneath it (idempotent re-promote), then
    re-prefixes with the given wave. Order matters: a title like
    `fix: <prefix> 7 — X` only reveals its wave prefix once the conventional
    prefix is gone — stripping Wave first leaves it intact and doubles up into
    `<prefix> 29 — <prefix> 7 — X`.
    """
    thema = _CONVENTIONAL_PREFIX_RE.sub("", current)
    thema = _WAVE_PREFIX_RE.sub("", thema).strip()
    return f"{WAVE_TITLE_PREFIX} {wave} — {thema}"


def title_edit_args(issue: int, title: str) -> list[str]:
    """The `gh issue edit` argv that sets an issue's title."""
    return ["issue", "edit", str(issue), "--repo", REPO, "--title", title]


# --- gh-backed helpers -------------------------------------------------------
def _blocked_by_list(num: int) -> list[dict]:
    """Native blocked_by edges of an issue (open AND closed blockers)."""
    data = _gh_json(["api", f"repos/{REPO}/issues/{num}/dependencies/blocked_by?per_page=100"])
    return extract_blockers(data)


def _parent_of(num: int) -> Optional[int]:
    data = _gh_json(["api", "graphql", "--header", SUB_ISSUES_HEADER,
                     "-f", f"query={PARENT_QUERY}",
                     "-F", f"owner={PROJECT_OWNER}", "-F", f"repo={REPO_NAME}",
                     "-F", f"num={num}"])
    return extract_parent_number(data)


def _children_of(num: int) -> list[int]:
    data = _gh_json(["api", "graphql", "--header", SUB_ISSUES_HEADER,
                     "-f", f"query={CHILDREN_QUERY}",
                     "-F", f"owner={PROJECT_OWNER}", "-F", f"repo={REPO_NAME}",
                     "-F", f"num={num}"])
    return extract_children_numbers(data)


def _node_id(num: int) -> str:
    return _gh(["issue", "view", str(num), "--repo", REPO, "--json", "id", "-q", ".id"]).strip()


def _issue_type_labels(num: int) -> list[str]:
    """Current label names on an issue (one per line)."""
    out = _gh(["issue", "view", str(num), "--repo", REPO,
               "--json", "labels", "--jq", ".labels[].name"])
    return [l.strip() for l in out.splitlines() if l.strip()]


def _issue_title(num: int) -> str:
    """Current title of an issue."""
    return _gh(["issue", "view", str(num), "--repo", REPO,
                "--json", "title", "--jq", ".title"]).strip()


# --- field-value: read a Projects-v2 item's current field value ------
# ID-driven (matches by `fieldId`, never a field NAME) — the profile only ever
# carries opaque field ids, so this stays consistent with every other read/write
# in this file instead of introducing a new required "field name" key.
FIELD_VALUE_QUERY = (
    "query($owner:String!,$repo:String!,$num:Int!){"
    "repository(owner:$owner,name:$repo){issue(number:$num){"
    "projectItems(first:10){nodes{id project{id} "
    "fieldValues(first:20){nodes{"
    "... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{id}}} "
    "... on ProjectV2ItemFieldSingleSelectValue{name optionId field{... on ProjectV2FieldCommon{id}}} "
    "... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{id}}}"
    "}}}}}}}"
)


def _field_value(issue: int, field_id: str) -> Optional[dict]:
    data = _gh_json(["api", "graphql", "-f", f"query={FIELD_VALUE_QUERY}",
                     "-F", f"owner={PROJECT_OWNER}", "-F", f"repo={REPO_NAME}",
                     "-F", f"num={issue}"])
    return extract_field_value(data, PROJECT_NODE_ID, field_id)


def _write_issue_body(issue: int, new_body: str) -> None:
    """Write an issue body via a temp file + `gh issue edit --body-file` — the
    one shared write mechanic for every body-rewriting command in this file."""
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
        f.write(new_body)
        tmp = f.name
    _gh(["issue", "edit", str(issue), "--repo", REPO, "--body-file", tmp])


def _add_and_stamp(url, wave, status, cluster, spec_path, plan_path, dry_run) -> None:
    add_args = ["project", "item-add", str(PROJECT_NUMBER), "--owner", PROJECT_OWNER,
                "--url", url, "--format", "json"]
    if dry_run:
        _print_dry(add_args)
        for edit in stamp_arg_list("<ITEM_ID>", wave, status, cluster, spec_path, plan_path):
            _print_dry(edit)
        return
    item_id = extract_item_id(_gh_json(add_args))
    for edit in stamp_arg_list(item_id, wave, status, cluster, spec_path, plan_path):
        _gh(edit)


# --- commands ----------------------------------------------------------------
def cmd_next_wave(_args) -> int:
    items = _gh_json(["project", "item-list", str(PROJECT_NUMBER), "--owner", PROJECT_OWNER,
                      "--limit", str(PROJECT_ITEM_LIST_LIMIT), "--format", "json"]).get("items", [])
    print(compute_next_wave(items))
    return 0


def cmd_parent_of(args) -> int:
    parent = _parent_of(args.issue)
    print(parent if parent is not None else "FREI")
    return 0


def cmd_children_of(args) -> int:
    for num in _children_of(args.issue):
        print(num)
    return 0


def cmd_link(args) -> int:
    decision = one_parent_decision(_parent_of(args.child), args.parent)
    if decision == "already":
        print(f"#{args.child} already a sub-issue of #{args.parent} — skip (idempotent)")
        return 0
    if decision == "conflict":
        existing = _parent_of(args.child)
        print(f"#{args.child} already has parent #{existing} — skip, not re-parenting "
              f"(needs removeSubIssue on the old parent first)")
        # Foreign-parent drift: non-zero for reconcile/publish; zero only in audit mode.
        return 0 if getattr(args, "allow_drift_report", False) else 1
    link_args = ["api", "graphql", "--header", SUB_ISSUES_HEADER,
                 "-f", f"query={ADD_SUBISSUE_MUTATION}"]
    if args.dry_run:
        _print_dry([*link_args, "-f", f"parent=<#{args.parent} node-id>",
                    "-f", f"child=<#{args.child} node-id>"])
        return 0
    _gh([*link_args, "-f", f"parent={_node_id(args.parent)}", "-f", f"child={_node_id(args.child)}"])
    print(f"linked #{args.child} → #{args.parent}")
    return 0


def cmd_unlink(args) -> int:
    """Remove a native sub-issue link. Parent-checked + idempotent (mirror of cmd_link):
    only unlinks when the child's current parent IS args.parent — never touches a foreign
    parent. The reconcile counterpart for to-issues when a promoted stub still carries
    board-to-waves member sub-issues that are superseded by fresh slices."""
    current = _parent_of(args.child)
    if current is None:
        print(f"#{args.child} has no parent — skip (idempotent)")
        return 0
    if current != args.parent:
        print(f"#{args.child} parent is #{current}, not #{args.parent} — skip, "
              f"not unlinking a foreign parent")
        # Foreign-parent mismatch: non-zero for reconcile/publish; zero only in audit mode.
        return 0 if getattr(args, "allow_drift_report", False) else 1
    unlink_args = ["api", "graphql", "--header", SUB_ISSUES_HEADER,
                   "-f", f"query={REMOVE_SUBISSUE_MUTATION}"]
    if args.dry_run:
        _print_dry([*unlink_args, "-f", f"parent=<#{args.parent} node-id>",
                    "-f", f"child=<#{args.child} node-id>"])
        return 0
    _gh([*unlink_args, "-f", f"parent={_node_id(args.parent)}", "-f", f"child={_node_id(args.child)}"])
    print(f"unlinked #{args.child} from #{args.parent}")
    return 0


# --- native issue-dependency commands --------------------------------
def _sync_blocked_by_mirror(issue: int, blockers: list[dict]) -> None:
    """Rewrite the issue's `## Blocked by` body mirror from the given edge list.
    No-op when already in sync (anchor-sync's no-drift contract)."""
    body = _gh(["issue", "view", str(issue), "--repo", REPO, "--json", "body", "-q", ".body"])
    new_body = splice_blocked_by_section(body, blockers)
    if new_body == body:
        print(f"#{issue}: mirror in sync")
        return
    _write_issue_body(issue, new_body)
    print(f"#{issue}: mirror updated")


def cmd_dep_add(args) -> int:
    """Set a native blocked-by edge + refresh the body mirror.

    Idempotent AND self-healing: an existing edge skips the POST but still
    reconciles the mirror — a failed mirror write is repaired by re-running
    the same command. Dry-run makes NO gh calls (promote contract).
    """
    path = f"repos/{REPO}/issues/{args.issue}/dependencies/blocked_by"
    if args.dry_run:
        _print_dry(["api", "--method", "POST", path,
                    "-F", f"issue_id=<#{args.blocked_by} database-id>"])
        print(f"[dry-run] would refresh the ## Blocked by mirror of #{args.issue}")
        return 0
    existing = _blocked_by_list(args.issue)
    if args.blocked_by in [b["number"] for b in existing]:
        print(f"#{args.issue} already blocked by #{args.blocked_by} — skip (idempotent)")
        _sync_blocked_by_mirror(args.issue, existing)
        return 0
    # The write takes the numeric DATABASE id — resolved here, never by the caller.
    blocker = _gh_json(["api", f"repos/{REPO}/issues/{args.blocked_by}"])
    _gh(["api", "--method", "POST", path, "-F", f"issue_id={blocker['id']}"])
    print(f"#{args.issue} now blocked by #{args.blocked_by}")
    _sync_blocked_by_mirror(args.issue, existing + extract_blockers([blocker]))
    return 0


def cmd_dep_remove(args) -> int:
    """Remove a native blocked-by edge + refresh the body mirror.

    Idempotent + self-healing like dep-add; the blocker's DATABASE id comes
    straight from the edge list (path param on DELETE), no extra fetch.
    """
    if args.dry_run:
        _print_dry(["api", "--method", "DELETE",
                    f"repos/{REPO}/issues/{args.issue}/dependencies/blocked_by/"
                    f"<#{args.blocked_by} database-id>"])
        print(f"[dry-run] would refresh the ## Blocked by mirror of #{args.issue}")
        return 0
    existing = _blocked_by_list(args.issue)
    target = next((b for b in existing if b["number"] == args.blocked_by), None)
    if target is None:
        print(f"#{args.issue} not blocked by #{args.blocked_by} — skip (idempotent)")
        _sync_blocked_by_mirror(args.issue, existing)
        return 0
    _gh(["api", "--method", "DELETE",
         f"repos/{REPO}/issues/{args.issue}/dependencies/blocked_by/{target['id']}"])
    print(f"#{args.issue} no longer blocked by #{args.blocked_by}")
    _sync_blocked_by_mirror(args.issue,
                            [b for b in existing if b["number"] != args.blocked_by])
    return 0


def cmd_deps(args) -> int:
    """Print an issue's native blocked_by edges + the open-blocker count.
    --json emits the normalized list (execute-ready-check's machine seam)."""
    blockers = _blocked_by_list(args.issue)
    if getattr(args, "as_json", False):
        print(json.dumps(blockers, ensure_ascii=False))
        return 0
    if not blockers:
        print(f"#{args.issue}: no blockers")
        return 0
    for b in blockers:
        print(f"- #{b['number']} ({b['state']}) — {b['title']}".rstrip())
    print(f"open blockers: {len(open_blocker_numbers(blockers))}")
    return 0


def cmd_frontier(args) -> int:
    """Buildable frontier of a wave anchor from native edges (orchestrate-wave's
    reader). Per open sub-issue: FREI (0 open blockers) or BLOCKED by #…;
    closed sub-issues print as done. ONE GraphQL round-trip — reuses the
    anchor-sync sub-issues query (state + blockedBy per child), no per-child
    REST fan-out."""
    board = _anchor_board_data(args.issue)
    if not board:
        print(f"#{args.issue}: no native sub-issues — not a wave anchor?", file=sys.stderr)
        return 1
    for child, entry in board.items():
        if entry.get("state") != "open":
            print(f"#{child} done")
            continue
        blockers = open_blocker_numbers(entry.get("blocked_by") or [])
        if blockers:
            print(f"#{child} BLOCKED by {', '.join('#' + str(n) for n in blockers)}")
        else:
            print(f"#{child} FREI")
    return 0


def cmd_create(args) -> int:
    hitl_guard(getattr(args, "hitl", False), args.label or [])
    labels = list(args.label or [])
    body = None
    # Phase-1: a ready-for-agent slice whose Blast-Radius names an offender
    # gets the marker planted INTO the body-file BEFORE `gh issue create`, so the
    # issue is never briefly ready-without-marker (no partial-ready window). Skip in
    # dry-run — that path must read no files / make no writes (parity tests).
    if not args.dry_run:
        body = Path(args.body_file).read_text(encoding="utf-8")
    if READY_FOR_AGENT in labels and body is not None:
        hits = loc_offender_hits(body, read_offenders())
        if hits:
            body = plant_offender_marker(body, hits)
            Path(args.body_file).write_text(body, encoding="utf-8")
    create_args = ["issue", "create", "--repo", REPO, "--title", args.title,
                   "--body-file", args.body_file]
    if getattr(args, "wave_stub", False):
        labels.append(WAVE_STUB_LABEL)
    for label in labels:
        create_args += ["--label", label]
    if args.dry_run:
        _print_dry(create_args)
        _add_and_stamp("<new-url>", args.wave, args.status, args.cluster, None, None, dry_run=True)
        return 0
    existing = _find_open_issue_by_program_identity(body or "")
    if existing:
        issue_no = existing["number"]
        url = existing["url"]
        print(f"#{issue_no} {url} (existing)")
    else:
        url = _gh(create_args).strip().splitlines()[-1]
        issue_no = issue_number_from_url(url)
        # Print the number/URL immediately — a board-sync failure below must never
        # swallow it. A retry without this would blind-recreate a duplicate issue
        # (the create already succeeded, only the board-sync half failed).
        print(f"#{issue_no} {url}")
    try:
        _add_and_stamp(url, args.wave, args.status, args.cluster, None, None, dry_run=False)
    except GhError as exc:
        repair = f"python3 scripts/board-sync.py add --issue {issue_no}"
        if args.wave is not None:
            repair += f" --wave {args.wave}"
        if args.status:
            repair += f" --status {args.status}"
        if args.cluster:
            repair += f" --cluster {args.cluster}"
        print(f"board-sync of #{issue_no} FAILED after create: {exc}")
        print(f"  repair (idempotent): {repair}")
        return 1
    return 0


def cmd_promote(args) -> int:
    """Promote a Draft-PRD to Anker: type:cluster label + Wave (+ Status), ordered.

    Requires an explicit --wave (caller reads `next-wave` first) so there is no
    in-promote race window. On a mid-transaction gh failure it prints what was
    already set + an idempotent repair command and exits non-zero (no silent
    half-promote).

    Two guards run before any write (real path only — a dry-run makes NO
    gh calls at all, guards included, same contract as every other dry-run
    branch in this file): a Program-PRD is never a promote target (it is the
    native anchor OVER Wellen, not itself a Welle), and a stub already stamped
    with a DIFFERENT Wave than --wave refuses rather than silently overwriting.
    """
    url = f"https://github.com/{REPO}/issues/{args.issue}"
    rename = not args.no_rename
    if args.dry_run:
        _print_dry(promote_label_args(args.issue))
        if rename:
            print(f"[dry-run] gh issue edit {args.issue} --title '{WAVE_TITLE_PREFIX} {args.wave} — <topic>'")
        _add_and_stamp(url, args.wave, args.status, None, None, None, dry_run=True)
        return 0
    labels = _issue_type_labels(args.issue)
    body = _gh(["issue", "view", str(args.issue), "--repo", REPO, "--json", "body", "-q", ".body"])
    is_program = (classify_node({"body": body, "labels": labels},
                                cluster_type_label=CLUSTER_TYPE_LABEL,
                                wave_stub_label=WAVE_STUB_LABEL) == PROGRAM
                  or PROGRAM_TYPE_LABEL in labels)
    refusal = program_prd_refusal(is_program, args.issue)
    if refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return 1
    current = _field_value(args.issue, WAVE_FIELD_ID)
    mismatch = wave_mismatch_guard(current.get("number") if current else None, args.wave)
    if mismatch:
        print(f"error: {mismatch}", file=sys.stderr)
        return 1
    done: list[str] = []
    try:
        strip = type_labels_to_strip(labels)
        _gh(promote_label_args(args.issue, strip))
        done.append("type:cluster label"
                    + (f" (stripped {', '.join(strip)})" if strip else ""))
        if rename:
            new_title = wave_title(_issue_title(args.issue), args.wave)
            _gh(title_edit_args(args.issue, new_title))
            done.append(f"title={new_title!r}")
        _add_and_stamp(url, args.wave, args.status, None, None, None, dry_run=False)
        done.append(f"Wave={args.wave}" + (f", Status={args.status}" if args.status else ""))
    except GhError as exc:
        repair = f"python3 scripts/board-sync.py promote --issue {args.issue} --wave {args.wave}"
        if args.status:
            repair += f" --status {args.status}"
        if args.no_rename:
            repair += " --no-rename"
        print(f"promote of #{args.issue} FAILED mid-transaction: {exc}")
        print(f"  already set: {', '.join(done) or 'nothing'}")
        print(f"  repair (idempotent): {repair}")
        return 1
    print(f"promoted #{args.issue} → Anker (type:cluster, Wave={args.wave})")
    return 0


def _plant_marker_on_existing(issue: int) -> None:
    """Fetch the live issue body; if its Blast-Radius names an offender, rewrite the
    body with the marker via `gh issue edit --body-file`. No-op when no hit."""
    body = _gh(["issue", "view", str(issue), "--repo", REPO, "--json", "body", "-q", ".body"])
    hits = loc_offender_hits(body, read_offenders())
    if not hits:
        return
    _write_issue_body(issue, plant_offender_marker(body, hits))


def cmd_add(args) -> int:
    url = args.url or f"https://github.com/{REPO}/issues/{args.issue}"
    issue_no = args.issue or issue_number_from_url(url)
    _add_and_stamp(url, args.wave, args.status, args.cluster, args.spec_path, args.plan_path,
                   dry_run=args.dry_run)
    # Phase-1: for `--bucket afk`, plant the offender marker (fetch body →
    # edit body) BEFORE the ready-for-agent label below, so an agent never grabs a
    # ready issue whose body lacks the marker (Codex-R1-F6 ordering). Dry-run makes
    # no gh calls (the body fetch is a network read), so it only notes the step.
    if getattr(args, "bucket", None) == "afk":
        if args.dry_run:
            print(f"[dry-run] would check #{issue_no} Blast-Radius ∩ offenders + plant marker")
        else:
            _plant_marker_on_existing(issue_no)
    label_args = bucket_label_args(issue_no, getattr(args, "bucket", None))
    if label_args is not None:
        if args.dry_run:
            _print_dry(label_args)
        else:
            _gh(label_args)
    if not args.dry_run:
        print(f"synced {url} to board")
    return 0


# --- anchor-sync: regenerate the wave-anchor Slices-table volatile cells
# Pure table logic (parse/merge/refresh/render/splice) lives in anchor_table.py so
# it is independently testable without gh/config; this file keeps only the gh-backed
# board fetch + the command wiring. See anchor_table.py for the design rationale.
from anchor_table import (  # noqa: E402
    SLICE_TABLE_START, SLICE_TABLE_END,
    split_pipe_row, is_separator_row, parse_pipe_table, render_pipe_table,
    col_index, first_subissue_num,
    status_token_from_board, status_base, refresh_status_cell,
    branch_from_board, refresh_branch_cell, merge_slice_rows,
    locate_slice_table, current_slice_table, splice_slice_table,
    extract_anchor_board_data,
)

# Status fetched generically and matched by FIELD ID in the extractor
# — no `fieldValueByName(name:"Status")`, a consumer's field may be named anything.
ANCHOR_SLICES_QUERY = (
    "query($owner:String!,$repo:String!,$num:Int!){"
    "repository(owner:$owner,name:$repo){issue(number:$num){"
    "subIssues(first:100){nodes{number title state "
    "closedByPullRequestsReferences(first:10,includeClosedPrs:true)"
    "{nodes{number state headRefName}} "
    "blockedBy(first:20){nodes{number state}} "
    "projectItems(first:10){nodes{fieldValues(first:20){nodes{"
    "... on ProjectV2ItemFieldSingleSelectValue{name "
    "field{... on ProjectV2SingleSelectField{id}}}"
    "}}}}}}}}}"
)


def _anchor_board_data(num: int) -> dict:
    data = _gh_json(["api", "graphql", "--header", SUB_ISSUES_HEADER,
                     "-f", f"query={ANCHOR_SLICES_QUERY}",
                     "-F", f"owner={PROJECT_OWNER}", "-F", f"repo={REPO_NAME}",
                     "-F", f"num={num}"])
    return extract_anchor_board_data(data, STATUS_FIELD_ID)


def cmd_anchor_sync(args) -> int:
    board = _anchor_board_data(args.issue)
    body = _gh(["issue", "view", str(args.issue), "--repo", REPO, "--json", "body", "-q", ".body"])
    headers, rows = current_slice_table(body)
    if not headers:
        print(f"#{args.issue}: no slice table found — nothing to sync", file=sys.stderr)
        return 1
    new_rows, appended = merge_slice_rows(headers, rows, board,
                                          _status_roles_or_hint("anchor-sync"))
    new_body = splice_slice_table(body, render_pipe_table(headers, new_rows))
    appended_note = (f"; +{len(appended)} new sub-issue row(s): "
                     f"{', '.join('#' + str(s) for s in appended)}" if appended else "")
    if new_body == body:
        print(f"#{args.issue}: slice table already in sync (no drift)")
        return 0
    if args.dry_run:
        print(f"[dry-run] would update #{args.issue} slice table{appended_note}")
        print(render_pipe_table(headers, new_rows))
        return 0
    _write_issue_body(args.issue, new_body)
    print(f"synced #{args.issue} slice table from board{appended_note}")
    return 0


# --- validate-graph: counted Programm-Graph preflight for a Program-PRD
# All parsing/validation logic lives in program_graph.py (PURE — no gh/board_config);
# this handler stays thin: load config, read the PRD body + each native wave-stub's
# body via the existing `_gh` seam, call the module, print the counted report.
# Read-only by construction (only `_gh` reads, no mutating call on this path at
# all) — no mutation surface to guard against, regardless of read count.
from program_graph import (  # noqa: E402
    validate_program_graph, render_report, parse_wellenplan_table, render_wellenplan_table,
)

# A wave-stub's revision marker, stamped by to-waves (Welle 52 Slice 4, §6):
# `<!-- program-revision: rN -->`. Read back here so validate-graph can catch a
# stub whose plan shape drifted from a since-bumped PRD `plan_revision`.
_STUB_REVISION_RE = re.compile(r"<!--\s*program-revision:\s*r(\d+)\s*-->")


def _fetch_stub_revisions(prd_issue: int) -> list[dict]:
    """The PRD's native wave-stub children, each with its parsed program-revision
    (or None if the marker is missing) — `check_revision_coherence`'s input shape
    (`[{"label": str, "revision": int | None}, …]`). Pre-publish (no children yet)
    this loop never runs, so `[]` degrades revision-coherence to a no-op — the
    unchanged green path."""
    stubs = []
    for child in _children_of(prd_issue):
        body = _gh(["issue", "view", str(child), "--repo", REPO,
                    "--json", "body", "-q", ".body"])
        m = _STUB_REVISION_RE.search(body or "")
        stubs.append({"label": f"#{child}", "revision": int(m.group(1)) if m else None})
    return stubs


def cmd_validate_graph(args) -> int:
    body = _gh(["issue", "view", str(args.issue), "--repo", REPO,
                "--json", "body", "-q", ".body"])
    # Defensive read: `fields.phase` is an optional profile key (Welle 52 Slice 3
    # adds it) — absent today, so this must degrade to a visible setup-hint finding
    # inside program_graph, never a KeyError here (CRITICAL RECONCILIATION #2).
    phase_options = _CFG.get("fields", {}).get("phase", {}).get("options")
    stub_revisions = _fetch_stub_revisions(args.issue)
    report = validate_program_graph(body, phase_options=phase_options,
                                     stub_revisions=stub_revisions)
    print(render_report(report))
    return 1 if report.blocking else 0


# --- stamp-batch: alias-batched field-writes for N items (Wave/Phase) -
def cmd_stamp_batch(args) -> int:
    if args.items_file:
        items = json.loads(Path(args.items_file).read_text(encoding="utf-8"))
    else:
        if not args.item_id:
            raise ValueError("stamp-batch --issue requires --item-id")
        items = [{"issue": args.issue, "item_id": args.item_id,
                  "wave": args.wave, "phase": args.phase}]
    phase_cfg = _CFG.get("fields", {}).get("phase")
    stamps, skipped_phase = build_stamps(items, wave_field_id=WAVE_FIELD_ID, phase_cfg=phase_cfg)
    if skipped_phase:
        print(f"Phase-Feld nicht konfiguriert (`fields.phase` fehlt im Profil) — "
              f"{skipped_phase} Phase-Stempel sichtbar übersprungen (kein stiller Verlust)")
    if not stamps:
        print("stamp-batch: nothing to stamp")
        return 0
    if args.dry_run:
        for chunk in chunk_stamps(stamps):
            query, _ = build_stamp_mutation(chunk, PROJECT_NODE_ID)
            _print_dry(["api", "graphql", "-f", f"query={query}"])
        return 0
    succeeded: list = []
    failed: list = []
    for chunk in chunk_stamps(stamps):
        query, alias_map = build_stamp_mutation(chunk, PROJECT_NODE_ID)
        # Tolerate a non-zero exit that still carries a parseable partial
        # response (`errors` alongside partial `data` — the batched-mutation
        # per-alias failure case). A hard CLI/network failure (no recoverable
        # body) re-raises, same as every other `_gh` caller in this file.
        try:
            out = _gh(["api", "graphql", "-f", f"query={query}"])
        except GhError as exc:
            out = getattr(exc, "stdout", "") or ""
            if not out:
                raise
        s, f = parse_batch_response(json.loads(out), alias_map)
        succeeded += s
        failed += f
    print(f"stamp-batch: {len(succeeded)} von {len(stamps)} Feld-Stempel gesetzt")
    for stamp, msg in failed:
        print(f"  FEHLER #{stamp.issue} {stamp.field_name}: {msg}")
        print(f"    repair: {repair_command(stamp)}")
    return 1 if failed else 0


# --- field-value: read a project item's current field value ---------
def cmd_field_value(args) -> int:
    if args.field == "wave":
        field_id = WAVE_FIELD_ID
    else:
        field_id = phase_field_id(_CFG)
    if field_id is None:
        print(f"error: fields.{args.field} not configured in the board profile", file=sys.stderr)
        return 1
    value = _field_value(args.issue, field_id)
    if value is None:
        print("unset")
        return 0
    print(value.get("number", value.get("name", value.get("text"))))
    return 0


# --- program-sync: Wellenplan Status-resync for a Program-PRD -------
# Own grammar, own command (plan 9b(d): "program-sync statt anchor-sync-Über-
# ladung") — the actual parse/render/status logic lives in program_sync.py
# (pure) and program_graph.py's public Wellenplan renderer; this
# handler stays thin. `_anchor_board_data` is reused as-is: a Program-PRD's
# native sub-issues are its promoted Wave-Anchor stubs, fetched exactly like
# an Anchor fetches its Slice sub-issues — no second query needed.
from program_sync import (  # noqa: E402
    sync_wellenplan_status, splice_wellenplan_table, checkoff_phase_gates,
)


def cmd_program_sync(args) -> int:
    body = _gh(["issue", "view", str(args.issue), "--repo", REPO, "--json", "body", "-q", ".body"])
    labels = _issue_type_labels(args.issue)
    is_program = (classify_node({"body": body, "labels": labels},
                                cluster_type_label=CLUSTER_TYPE_LABEL,
                                wave_stub_label=WAVE_STUB_LABEL) == PROGRAM
                  or PROGRAM_TYPE_LABEL in labels)
    if not is_program:
        print(f"error: #{args.issue} is not a Program-PRD (no `<!-- prd: program -->` "
              f"marker or {PROGRAM_TYPE_LABEL!r} label) — use anchor-sync for a "
              "Welle-Anker.", file=sys.stderr)
        return 1
    waves = parse_wellenplan_table(body)
    if not waves:
        print(f"#{args.issue}: no Wellenplan table found — nothing to sync", file=sys.stderr)
        return 1
    board = _anchor_board_data(args.issue)
    new_waves = sync_wellenplan_status(waves, board,
                                       _status_roles_or_hint("program-sync"))
    include_phase = any(w.phase is not None for w in waves)
    new_table = render_wellenplan_table(new_waves, include_phase=include_phase)
    new_body = splice_wellenplan_table(body, new_table)
    # upward propagation: a phase whose waves are ALL ✅ checks off its
    # `## Phasen-Gates` entry (monotone, stamped once — see checkoff_phase_gates).
    new_body, checked_gates = checkoff_phase_gates(
        new_body, new_waves, datetime.date.today().isoformat())
    checked_note = (f"; Phasen-Gate(s) abgehakt: {', '.join(checked_gates)}"
                    if checked_gates else "")
    if new_body == body:
        print(f"#{args.issue}: Wellenplan status already in sync (no drift)")
        return 0
    if args.dry_run:
        print(f"[dry-run] would update #{args.issue} Wellenplan status{checked_note}")
        print(new_table)
        return 0
    _write_issue_body(args.issue, new_body)
    print(f"synced #{args.issue} Wellenplan status from board{checked_note}")
    return 0


def _add_status_flags(sp) -> None:
    """The shared --status / --status-role pair (mutually exclusive) on every
    status-writing subcommand — one wiring point, three subcommands."""
    g = sp.add_mutually_exclusive_group()
    g.add_argument("--status", choices=list(STATUS_OPTIONS))
    g.add_argument("--status-role", dest="status_role", choices=list(STATUS_ROLE_KEYS),
                   help="semantic role resolved via the profile's fields.status.roles")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="board-sync.py", description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("next-wave", help="print the next monotone wave number").set_defaults(func=cmd_next_wave)

    po = sub.add_parser("parent-of", help="print an issue's parent number or FREI")
    po.add_argument("issue", type=int)
    po.set_defaults(func=cmd_parent_of)

    co = sub.add_parser("children-of", help="print an anchor's native sub-issue numbers")
    co.add_argument("issue", type=int)
    co.set_defaults(func=cmd_children_of)

    ln = sub.add_parser("link", help="link child as sub-issue of parent (one-parent-checked)")
    ln.add_argument("--parent", type=int, required=True)
    ln.add_argument("--child", type=int, required=True)
    ln.add_argument("--allow-drift-report", action="store_true", dest="allow_drift_report",
                    help="report a foreign-parent conflict but exit 0 (read-only audit)")
    ln.add_argument("--dry-run", action="store_true")
    ln.set_defaults(func=cmd_link)

    ul = sub.add_parser("unlink", help="remove child as sub-issue of parent (parent-checked, idempotent)")
    ul.add_argument("--parent", type=int, required=True)
    ul.add_argument("--child", type=int, required=True)
    ul.add_argument("--allow-drift-report", action="store_true", dest="allow_drift_report",
                    help="report a foreign-parent mismatch but exit 0 (read-only audit)")
    ul.add_argument("--dry-run", action="store_true")
    ul.set_defaults(func=cmd_unlink)

    dp = sub.add_parser("deps", help="print an issue's native blocked_by edges")
    dp.add_argument("issue", type=int)
    dp.add_argument("--json", action="store_true", dest="as_json",
                    help="normalized machine-readable list")
    dp.set_defaults(func=cmd_deps)

    da = sub.add_parser("dep-add", help="set a native blocked-by edge + body mirror "
                                        "(idempotent, self-healing)")
    da.add_argument("--issue", type=int, required=True, help="the BLOCKED issue")
    da.add_argument("--blocked-by", type=int, required=True, dest="blocked_by",
                    help="the BLOCKING issue")
    da.add_argument("--dry-run", action="store_true")
    da.set_defaults(func=cmd_dep_add)

    dr = sub.add_parser("dep-remove", help="remove a native blocked-by edge + body mirror "
                                           "(idempotent)")
    dr.add_argument("--issue", type=int, required=True, help="the BLOCKED issue")
    dr.add_argument("--blocked-by", type=int, required=True, dest="blocked_by",
                    help="the BLOCKING issue")
    dr.add_argument("--dry-run", action="store_true")
    dr.set_defaults(func=cmd_dep_remove)

    fr = sub.add_parser("frontier", help="buildable frontier of a wave anchor from "
                                         "native edges: FREI/BLOCKED/done")
    fr.add_argument("issue", type=int, help="the wave-anchor issue number")
    fr.set_defaults(func=cmd_frontier)

    cr = sub.add_parser("create", help="create an issue + add to board + stamp fields")
    cr.add_argument("--title", required=True)
    cr.add_argument("--body-file", required=True)
    cr.add_argument("--label", action="append", help="repeatable")
    cr.add_argument("--wave", type=int)
    _add_status_flags(cr)
    cr.add_argument("--cluster")
    cr.add_argument("--hitl", action="store_true",
                    help="mark slice HITL — rejects a ready-for-agent label")
    cr.add_argument("--wave-stub", action="store_true", dest="wave_stub",
                    help="tag as board-to-waves candidate stub (wave-stub label; "
                         "stripped at promote / add --bucket)")
    cr.add_argument("--dry-run", action="store_true")
    cr.set_defaults(func=cmd_create)

    pr = sub.add_parser("promote", help="promote a Draft-PRD to Anker (type:cluster + Wave)")
    pr.add_argument("--issue", type=int, required=True)
    pr.add_argument("--wave", type=int, required=True,
                    help="explicit Wave (read `next-wave` first — no in-promote race)")
    _add_status_flags(pr)
    pr.add_argument("--no-rename", action="store_true",
                    help="keep the title as-is (skip the wave title prefix)")
    pr.add_argument("--dry-run", action="store_true")
    pr.set_defaults(func=cmd_promote)

    ad = sub.add_parser("add", help="add an existing issue to the board + stamp fields")
    g = ad.add_mutually_exclusive_group(required=True)
    g.add_argument("--issue", type=int)
    g.add_argument("--url")
    ad.add_argument("--wave", type=int)
    _add_status_flags(ad)
    ad.add_argument("--cluster")
    ad.add_argument("--spec-path", dest="spec_path")
    ad.add_argument("--plan-path", dest="plan_path")
    ad.add_argument("--bucket", choices=["afk", "hitl"],
                    help="workflow-label write: afk → add ready-for-agent; hitl → strip it")
    ad.add_argument("--dry-run", action="store_true")
    ad.set_defaults(func=cmd_add)

    asy = sub.add_parser("anchor-sync",
                         help="regenerate a wave-anchor Slices-table's volatile cells "
                              "(Status/Branch) from the board, in place")
    asy.add_argument("issue", type=int, help="the wave-anchor issue number")
    asy.add_argument("--dry-run", action="store_true")
    asy.set_defaults(func=cmd_anchor_sync)

    vg = sub.add_parser("validate-graph",
                        help="counted Programm-Graph preflight for a Program-PRD "
                             "(read-only)")
    vg.add_argument("--issue", type=int, required=True, help="the Program-PRD issue number")
    vg.set_defaults(func=cmd_validate_graph)

    sb = sub.add_parser("stamp-batch",
                        help="alias-batched GraphQL field-stamp (Wave/Phase) for N "
                             "items, chunked ~30 aliases/request")
    g_sb = sb.add_mutually_exclusive_group(required=True)
    g_sb.add_argument("--items-file", help="JSON list of {issue,item_id,wave?,phase?}")
    g_sb.add_argument("--issue", type=int, help="single-item form — also the repair target")
    sb.add_argument("--item-id", help="required together with --issue")
    sb.add_argument("--wave", type=int)
    sb.add_argument("--phase", help="Phase name, resolved via fields.phase.options")
    sb.add_argument("--dry-run", action="store_true")
    sb.set_defaults(func=cmd_stamp_batch)

    fv = sub.add_parser("field-value",
                        help="read a project field's current value for an issue "
                             "(— the promote-guard's read side)")
    fv.add_argument("--issue", type=int, required=True)
    fv.add_argument("--field", choices=["wave", "phase"], required=True)
    fv.set_defaults(func=cmd_field_value)

    ps = sub.add_parser("program-sync",
                        help="regenerate a Program-PRD's Wellenplan Status from the "
                             "board, in place (own grammar, not anchor-sync)")
    ps.add_argument("issue", type=int, help="the Program-PRD issue number")
    ps.add_argument("--dry-run", action="store_true")
    ps.set_defaults(func=cmd_program_sync)
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if getattr(args, "status_role", None):
            args.status = resolve_status_role(args.status_role, STATUS_ROLES)
        return args.func(args)
    except (ValueError, GhError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
