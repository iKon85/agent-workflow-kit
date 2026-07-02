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
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from board_config import load_board_config  # noqa: E402

# --- Board profile (SSOT: docs/agents/board-sync.md `board-sync:profile`) ----
# No inline board IDs: board_config reads them from the profile so the published
# kit carries no project-private constants (a consumer's profile is seeded by
# /setup-workflow).
_CFG = load_board_config()
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
PROJECT_ITEM_LIST_LIMIT = 2000

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
    """Run `gh <args>`, return stdout. Raise GhError on non-zero exit."""
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if result.returncode != 0:
        raise GhError(f"gh {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def _gh_json(args: list[str]):
    return json.loads(_gh(args))


def _print_dry(args: list[str]) -> None:
    print("[dry-run] gh " + " ".join(args))


# --- pure logic (directly unit-tested) ---------------------------------------
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
    """Non-cluster `type:*` labels to remove so exactly one `type:*` remains.

    Board convention is one `type:*` per issue; promotion REPLACES the prior
    type (e.g. type:followup) with type:cluster rather than adding a second.
    """
    return [l for l in labels if l.startswith(TYPE_PREFIX) and l != CLUSTER_TYPE_LABEL]


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


# Existing `Welle <N> — ` prefix (any number, em-dash/en-dash/hyphen separator) —
# replaced on re-promote so the wave number never doubles up.
_WAVE_PREFIX_RE = re.compile(r"^\s*Welle\s+\d+\s*[—–-]\s*", re.IGNORECASE)
# Leading conventional-commit token (`fix:`, `feat(ui):`, `chore!:`) — anchors
# don't carry these, so strip it when present. Matches only a lowercase token,
# so prose titles like "Supabase-Residuen entfernen: …" are left intact.
_CONVENTIONAL_PREFIX_RE = re.compile(r"^[a-z]+(\([^)]*\))?!?:\s*")


def wave_title(current: str, wave: int) -> str:
    """Title for a wave anchor: `Welle <N> — <Thema>`.

    Replaces any existing `Welle X — ` prefix (idempotent re-promote) and strips a
    leading conventional-commit prefix, then re-prefixes with the given wave.
    """
    thema = _WAVE_PREFIX_RE.sub("", current)
    thema = _CONVENTIONAL_PREFIX_RE.sub("", thema).strip()
    return f"Welle {wave} — {thema}"


def title_edit_args(issue: int, title: str) -> list[str]:
    """The `gh issue edit` argv that sets an issue's title."""
    return ["issue", "edit", str(issue), "--repo", REPO, "--title", title]


# --- gh-backed helpers -------------------------------------------------------
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


def cmd_create(args) -> int:
    hitl_guard(getattr(args, "hitl", False), args.label or [])
    labels = list(args.label or [])
    # Phase-1: a ready-for-agent slice whose Blast-Radius names an offender
    # gets the marker planted INTO the body-file BEFORE `gh issue create`, so the
    # issue is never briefly ready-without-marker (no partial-ready window). Skip in
    # dry-run — that path must read no files / make no writes (parity tests).
    if READY_FOR_AGENT in labels and not args.dry_run:
        body = Path(args.body_file).read_text(encoding="utf-8")
        hits = loc_offender_hits(body, read_offenders())
        if hits:
            Path(args.body_file).write_text(plant_offender_marker(body, hits), encoding="utf-8")
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
    url = _gh(create_args).strip().splitlines()[-1]
    _add_and_stamp(url, args.wave, args.status, args.cluster, None, None, dry_run=False)
    print(f"#{issue_number_from_url(url)} {url}")
    return 0


def cmd_promote(args) -> int:
    """Promote a Draft-PRD to Anker: type:cluster label + Wave (+ Status), ordered.

    Requires an explicit --wave (caller reads `next-wave` first) so there is no
    in-promote race window. On a mid-transaction gh failure it prints what was
    already set + an idempotent repair command and exits non-zero (no silent
    half-promote).
    """
    url = f"https://github.com/{REPO}/issues/{args.issue}"
    rename = not args.no_rename
    if args.dry_run:
        _print_dry(promote_label_args(args.issue))
        if rename:
            print(f"[dry-run] gh issue edit {args.issue} --title 'Welle {args.wave} — <Thema>'")
        _add_and_stamp(url, args.wave, args.status, None, None, None, dry_run=True)
        return 0
    done: list[str] = []
    try:
        strip = type_labels_to_strip(_issue_type_labels(args.issue))
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
    marked = plant_offender_marker(body, hits)
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
        f.write(marked)
        tmp = f.name
    _gh(["issue", "edit", str(issue), "--repo", REPO, "--body-file", tmp])


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

ANCHOR_SLICES_QUERY = (
    "query($owner:String!,$repo:String!,$num:Int!){"
    "repository(owner:$owner,name:$repo){issue(number:$num){"
    "subIssues(first:100){nodes{number title "
    "closedByPullRequestsReferences(first:10,includeClosedPrs:true)"
    "{nodes{number state headRefName}} "
    "projectItems(first:10){nodes{s:fieldValueByName(name:\"Status\")"
    "{... on ProjectV2ItemFieldSingleSelectValue{name}}}}"
    "}}}}}"
)


def _anchor_board_data(num: int) -> dict:
    data = _gh_json(["api", "graphql", "--header", SUB_ISSUES_HEADER,
                     "-f", f"query={ANCHOR_SLICES_QUERY}",
                     "-F", f"owner={PROJECT_OWNER}", "-F", f"repo={REPO_NAME}",
                     "-F", f"num={num}"])
    return extract_anchor_board_data(data)


def cmd_anchor_sync(args) -> int:
    board = _anchor_board_data(args.issue)
    body = _gh(["issue", "view", str(args.issue), "--repo", REPO, "--json", "body", "-q", ".body"])
    headers, rows = current_slice_table(body)
    if not headers:
        print(f"#{args.issue}: no slice table found — nothing to sync", file=sys.stderr)
        return 1
    new_rows, appended = merge_slice_rows(headers, rows, board)
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
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8") as f:
        f.write(new_body)
        tmp = f.name
    _gh(["issue", "edit", str(args.issue), "--repo", REPO, "--body-file", tmp])
    print(f"synced #{args.issue} slice table from board{appended_note}")
    return 0


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

    cr = sub.add_parser("create", help="create an issue + add to board + stamp fields")
    cr.add_argument("--title", required=True)
    cr.add_argument("--body-file", required=True)
    cr.add_argument("--label", action="append", help="repeatable")
    cr.add_argument("--wave", type=int)
    cr.add_argument("--status", choices=list(STATUS_OPTIONS))
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
    pr.add_argument("--status", choices=list(STATUS_OPTIONS))
    pr.add_argument("--no-rename", action="store_true",
                    help="keep the title as-is (skip the `Welle <N> — ` prefix)")
    pr.add_argument("--dry-run", action="store_true")
    pr.set_defaults(func=cmd_promote)

    ad = sub.add_parser("add", help="add an existing issue to the board + stamp fields")
    g = ad.add_mutually_exclusive_group(required=True)
    g.add_argument("--issue", type=int)
    g.add_argument("--url")
    ad.add_argument("--wave", type=int)
    ad.add_argument("--status", choices=list(STATUS_OPTIONS))
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
    return p


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, GhError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
