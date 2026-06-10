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
import subprocess
import sys
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

# Sub-issues GraphQL API is behind a preview feature gate per account.
SUB_ISSUES_HEADER = "GraphQL-Features: sub_issues"

ADD_SUBISSUE_MUTATION = (
    "mutation($parent:ID!,$child:ID!){"
    "addSubIssue(input:{issueId:$parent,subIssueId:$child}){"
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
    if bucket == "afk":
        return [*base, "--add-label", READY_FOR_AGENT]
    if bucket == "hitl":
        return [*base, "--remove-label", READY_FOR_AGENT]
    raise ValueError(f"unknown bucket {bucket!r}; valid: afk, hitl")


def type_labels_to_strip(labels: list[str]) -> list[str]:
    """Non-cluster `type:*` labels to remove so exactly one `type:*` remains.

    Board convention is one `type:*` per issue; promotion REPLACES the prior
    type (e.g. type:followup) with type:cluster rather than adding a second.
    """
    return [l for l in labels if l.startswith(TYPE_PREFIX) and l != CLUSTER_TYPE_LABEL]


def promote_label_args(issue: int, strip: Optional[list[str]] = None) -> list[str]:
    """The `gh issue edit` argv that adds type:cluster and strips prior type:* labels."""
    args = ["issue", "edit", str(issue), "--repo", REPO, "--add-label", CLUSTER_TYPE_LABEL]
    for label in strip or []:
        args += ["--remove-label", label]
    return args


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
                      "--limit", "500", "--format", "json"]).get("items", [])
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


def cmd_create(args) -> int:
    hitl_guard(getattr(args, "hitl", False), args.label or [])
    create_args = ["issue", "create", "--repo", REPO, "--title", args.title,
                   "--body-file", args.body_file]
    for label in args.label or []:
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
    if args.dry_run:
        _print_dry(promote_label_args(args.issue))
        _add_and_stamp(url, args.wave, args.status, None, None, None, dry_run=True)
        return 0
    done: list[str] = []
    try:
        strip = type_labels_to_strip(_issue_type_labels(args.issue))
        _gh(promote_label_args(args.issue, strip))
        done.append("type:cluster label"
                    + (f" (stripped {', '.join(strip)})" if strip else ""))
        _add_and_stamp(url, args.wave, args.status, None, None, None, dry_run=False)
        done.append(f"Wave={args.wave}" + (f", Status={args.status}" if args.status else ""))
    except GhError as exc:
        repair = f"python3 scripts/board-sync.py promote --issue {args.issue} --wave {args.wave}"
        if args.status:
            repair += f" --status {args.status}"
        print(f"promote of #{args.issue} FAILED mid-transaction: {exc}")
        print(f"  already set: {', '.join(done) or 'nothing'}")
        print(f"  repair (idempotent): {repair}")
        return 1
    print(f"promoted #{args.issue} → Anker (type:cluster, Wave={args.wave})")
    return 0


def cmd_add(args) -> int:
    url = args.url or f"https://github.com/{REPO}/issues/{args.issue}"
    _add_and_stamp(url, args.wave, args.status, args.cluster, args.spec_path, args.plan_path,
                   dry_run=args.dry_run)
    label_args = bucket_label_args(args.issue or issue_number_from_url(url),
                                   getattr(args, "bucket", None))
    if label_args is not None:
        if args.dry_run:
            _print_dry(label_args)
        else:
            _gh(label_args)
    if not args.dry_run:
        print(f"synced {url} to board")
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

    cr = sub.add_parser("create", help="create an issue + add to board + stamp fields")
    cr.add_argument("--title", required=True)
    cr.add_argument("--body-file", required=True)
    cr.add_argument("--label", action="append", help="repeatable")
    cr.add_argument("--wave", type=int)
    cr.add_argument("--status", choices=list(STATUS_OPTIONS))
    cr.add_argument("--cluster")
    cr.add_argument("--hitl", action="store_true",
                    help="mark slice HITL — rejects a ready-for-agent label")
    cr.add_argument("--dry-run", action="store_true")
    cr.set_defaults(func=cmd_create)

    pr = sub.add_parser("promote", help="promote a Draft-PRD to Anker (type:cluster + Wave)")
    pr.add_argument("--issue", type=int, required=True)
    pr.add_argument("--wave", type=int, required=True,
                    help="explicit Wave (read `next-wave` first — no in-promote race)")
    pr.add_argument("--status", choices=list(STATUS_OPTIONS))
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
