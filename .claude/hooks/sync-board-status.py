#!/usr/bin/env python3
"""
Sync GitHub Project status to the in-progress status when the current branch is
feat/<#>- or fix/<#>-.

Wired as SessionStart hook. Idempotent + scoped:
  - only the project + status field named in the board profile
  - only transitions {Idee, Triaged, Spec} -> In Arbeit (whitelist)
  - silent on every failure (never blocks session start)

Board-specific values (project ids, status option ids, repo slug) are NOT
inlined — they are read from the board profile (docs/agents/board-sync.md, parsed
by scripts/board_config.py, /setup-workflow-seeded per repo). So this hook works
unchanged in this repo and in a consumer install alike.

Lookup is TARGETED: it queries ONLY the active issue's project items (GraphQL
issue.projectItems), not the whole board. So it has no pagination cap (the old
`item-list --limit 500` silently dropped the newest issues on large boards) and
ignores every Done/closed/archived item elsewhere — those are never a transition
source, so reading them was pure noise.

Audit log: .claude/logs/board-sync.log
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "scripts"))
from _hook_utils import log, run_with_status as run  # noqa: E402
from board_config import load_board_config, ConfigError  # noqa: E402

# Status vocabulary = shipped workflow convention (German status names match the
# board-sync.md options /setup-workflow seeds). Opaque project/field ids come
# from the profile at runtime (see main).
ALLOWED_FROM = {"Idee", "Triaged", "Spec"}
TARGET_STATUS = "In Arbeit"
BRANCH_RE = re.compile(r"^(?:feat|fix)/([0-9]+)-")
HOOK_NAME = "board-sync"

# Fetch one issue's project items + their single-select field values. Matching
# the status by FIELD ID (not the display name "Status") keeps it profile-driven.
_ITEM_QUERY = (
    "query($owner:String!,$repo:String!,$number:Int!){"
    "repository(owner:$owner,name:$repo){issue(number:$number){"
    "projectItems(first:20){nodes{id project{number} "
    "fieldValues(first:20){nodes{"
    "... on ProjectV2ItemFieldSingleSelectValue{name "
    "field{... on ProjectV2SingleSelectField{id}}}"
    "}}}}}}}"
)


def resolve_status_from_items(issue, proj_number, field_id):
    """Pure decision core: given the already-parsed `data.repository.issue`
    node from the board-item GraphQL response, disambiguate this issue's item
    in `proj_number` and extract its value for `field_id`.

    No subprocess/network — parsed dict in, decision out. Returns
    (item_id, current_status) on a clean single-item match (current is ""
    when the field has never been set), or (None, reason) on any miss:
    issue not found, 0/2+ project items in the target project (incl. items
    that belong to a *different* project number), or a malformed item id.
    """
    if not issue:
        return None, "issue not found"

    nodes = (issue.get("projectItems") or {}).get("nodes") or []
    ours = [n for n in nodes if str((n.get("project") or {}).get("number")) == proj_number]
    if len(ours) != 1:
        return None, f"{len(ours)} project items in project {proj_number}"

    item_id = ours[0].get("id")
    if not isinstance(item_id, str) or not item_id.startswith("PVTI_"):
        return None, "item id missing or malformed"

    current = ""
    for fv in (ours[0].get("fieldValues") or {}).get("nodes") or []:
        if (fv.get("field") or {}).get("id") == field_id:
            current = fv.get("name", "")
            break
    return item_id, current


def fetch_board_item(repo_owner, repo_name, proj_number, field_id, issue_num):
    """(item_id, current_status) for issue_num's item in the project, or
    (None, reason) on any miss. Reads only this issue's items — no board-wide
    list, no pagination cap, blind to Done/archived items elsewhere."""
    rc, out = run([
        "gh", "api", "graphql",
        "-f", f"query={_ITEM_QUERY}",
        "-F", f"owner={repo_owner}",
        "-F", f"repo={repo_name}",
        "-F", f"number={issue_num}",
    ])
    if rc != 0 or not out:
        return None, "gh graphql failed"
    try:
        issue = json.loads(out)["data"]["repository"]["issue"]
    except (json.JSONDecodeError, KeyError, TypeError):
        return None, "invalid graphql response"
    return resolve_status_from_items(issue, proj_number, field_id)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Log intended action without writing")
    parser.add_argument("--issue", help="Override issue # (else parsed from current branch)")
    args = parser.parse_args()

    try:
        cfg = load_board_config()
    except ConfigError as e:
        log(HOOK_NAME, f"skip: board profile unavailable ({e})")
        return 0
    repo_owner, repo_name = cfg["repo"].split("/", 1)
    proj_number = str(cfg["project"]["number"])
    node_id = cfg["project"]["nodeId"]
    field_id = cfg["fields"]["status"]["id"]
    target_id = cfg["fields"]["status"]["options"].get(TARGET_STATUS)
    if not target_id:
        log(HOOK_NAME, f"skip: status {TARGET_STATUS!r} not in board profile options")
        return 0

    if args.issue:
        issue_num = args.issue
        branch = f"(override --issue {issue_num})"
    else:
        rc, branch_out = run(["git", "branch", "--show-current"])
        branch = branch_out.strip()
        if rc != 0 or not branch:
            return 0
        m = BRANCH_RE.match(branch)
        if not m:
            return 0
        issue_num = m.group(1)

    item_id, current = fetch_board_item(repo_owner, repo_name, proj_number, field_id, issue_num)
    if item_id is None:
        log(HOOK_NAME, f"branch={branch} issue={issue_num} skip: {current}")
        return 0

    if current not in ALLOWED_FROM:
        log(HOOK_NAME, f"branch={branch} issue={issue_num} item={item_id} status={current} skip: not in whitelist")
        return 0

    if args.dry_run:
        log(HOOK_NAME, f"branch={branch} issue={issue_num} item={item_id} before={current} DRY-RUN would set {TARGET_STATUS!r}")
        return 0

    rc, _ = run([
        "gh", "project", "item-edit",
        "--id", item_id,
        "--project-id", node_id,
        "--field-id", field_id,
        "--single-select-option-id", target_id,
    ])
    if rc == 0:
        log(HOOK_NAME, f"branch={branch} issue={issue_num} item={item_id} before={current} after={TARGET_STATUS}")
    else:
        log(HOOK_NAME, f"branch={branch} issue={issue_num} item={item_id} before={current} ERROR: item-edit failed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        log(HOOK_NAME, f"unexpected error: {e}")
        sys.exit(0)
