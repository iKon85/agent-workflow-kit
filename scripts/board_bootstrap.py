#!/usr/bin/env python3
"""board_bootstrap.py — provision a GitHub-Projects board for /setup-workflow.

`setup-workflow` Section D used to refuse creation and hand out manual
instructions. It now OFFERS creation, and this helper owns the mechanical part
so the outcome is deterministic rather than prose-driven:

    gh project create                       # the project shell
    gh project field-create … Status        # single-select WITH its options
    gh project field-create … Wave/Cluster/Spec-Path/Plan-Path
    gh project field-list                   # discover the opaque ids

Four properties this file exists to guarantee:

  * Nothing is created before the destination is writable and `gh auth status`
    proves the write scope — a missing scope can never half-create a board.
  * The profile is written from the READ-BACK, never from what the create calls
    were asked to do. A field that did not survive creation cannot appear in it.
  * A failure anywhere (create, readback, validation) writes NO profile file.
    The caller falls back to the retryable stub path with the board it can see.
  * The Status option NAMES come from the seed profile's `fields.status.roles`,
    never from a literal in this file — a board in another language provisions
    its own stage names.

The offer/decline decision itself is NOT here: minting a project is an outward
action, so the user gate stays with the skill and this helper only runs after an
explicit yes.

Usage:
    python3 scripts/board_bootstrap.py preflight [--json]
    python3 scripts/board_bootstrap.py create --owner <owner> --repo <owner>/<repo> \\
        --title "<title>" --seed <seeded board-sync.md> --out docs/agents/board-sync.md \\
        [--dry-run]
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

import board_config

# Field NAMES for a NEW board. These are creation-time conventions (the profile
# stores ids under fixed keys and never carries a field name), documented in the
# seeded board-sync.md field table. Discovery matches the readback by them.
STATUS_FIELD_NAME = "Status"
WORKFLOW_FIELDS = (
    ("wave", "Wave", "NUMBER"),
    ("cluster", "Cluster", "TEXT"),
    ("specPath", "Spec-Path", "TEXT"),
    ("planPath", "Plan-Path", "TEXT"),
)

# `gh project create` + `field-create` need the write scope; the read scope is
# what every later board read uses, so the remedy asks for both at once.
REQUIRED_SCOPES = ("project",)
SCOPE_REMEDY = "gh auth refresh -s project,read:project"

SENTINEL = "<!-- setup-workflow: state=filled; mode=github-projects-v2 -->"
SENTINEL_RE = re.compile(
    r"^<!--\s*setup-workflow:\s*state=(stub|filled|not-applicable)"
    r"(?:;\s*mode=(github-projects-v2|none))?\s*-->\s*$")
PROFILE_MARKER_RE = re.compile(r"<!--\s*board-sync:profile\s*-->")
JSON_FENCE_RE = re.compile(r"(```json\s*\n)(.*?)(\n```)", re.DOTALL)
PLACEHOLDER_RE = re.compile(r"<[^<>\n]*>")

EXIT_FAILURE = 1
EXIT_REFUSED = 2
EXIT_MISSING_SCOPE = 3


class BootstrapError(RuntimeError):
    """Any condition that must abort before or instead of writing a profile."""


# --- the gh seam (tests replace `_gh`) ---------------------------------------
def _gh(args: list[str]) -> str:
    proc = subprocess.run(["gh", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()
        raise BootstrapError(f"`gh {' '.join(args)}` failed: {detail}")
    return proc.stdout


def _gh_json(args: list[str]):
    raw = _gh(args)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BootstrapError(f"`gh {' '.join(args)}` did not return JSON: {exc}") from exc


# --- pure decisions ----------------------------------------------------------
def missing_scopes(auth_status_text: str, required=REQUIRED_SCOPES) -> list[str]:
    """The required OAuth scopes `gh auth status` does NOT report."""
    granted: set[str] = set()
    for line in auth_status_text.splitlines():
        if "Token scopes:" in line:
            granted |= {part.strip().strip("'\"")
                        for part in line.split(":", 1)[1].split(",")}
    return [scope for scope in required if scope not in granted]


def status_option_names(cfg: dict) -> list[str]:
    """This board's Status option names, read from the seed profile's role map in
    role order (extra consumer roles keep their own order at the end)."""
    roles = board_config.status_roles(cfg)
    ordered = list(board_config.STATUS_ROLE_KEYS)
    ordered += [key for key in roles if key not in ordered]
    names: list[str] = []
    for key in ordered:
        name = roles.get(key)
        if name and name not in names:
            names.append(name)
    if not names:
        raise BootstrapError(
            "the seed profile carries no `fields.status.roles` — fill the role map "
            "with this board's stage names before creating the board.")
    commas = [name for name in names if "," in name]
    if commas:
        raise BootstrapError(
            f"status option name(s) {commas} contain a comma; "
            "`gh project field-create --single-select-options` is comma-separated. "
            "Rename the role value, or create the Status field by hand.")
    return names


def destination_action(first_line: str | None) -> str:
    """`create` / `fill` / `refuse` for the destination profile, per the
    setup-workflow idempotency contract: missing or `state=stub` may be written,
    everything else (filled, not-applicable, legacy without sentinel) is owned by
    the consumer and never overwritten."""
    if first_line is None:
        return "create"
    match = SENTINEL_RE.match(first_line.strip())
    if match:
        return "fill" if match.group(1) == "stub" else "refuse"
    return "refuse"


def index_fields(field_list) -> dict:
    fields = field_list.get("fields") if isinstance(field_list, dict) else field_list
    return {f["name"]: f for f in (fields or [])
            if isinstance(f, dict) and f.get("name")}


def build_profile(seed_cfg: dict, *, repo: str, owner: str, number, node_id: str,
                  field_list) -> dict:
    """The consumer profile assembled from the seed's conventions plus the ids
    read back off the board. Every id is best-effort: what is absent stays
    absent so `validate_profile` can report it instead of a claim being made."""
    by_name = index_fields(field_list)
    profile = copy.deepcopy(seed_cfg)
    profile["repo"] = repo
    profile["project"] = {"number": number, "owner": owner, "nodeId": node_id}

    status_field = by_name.get(STATUS_FIELD_NAME)
    status = {"options": {}, "roles": copy.deepcopy(board_config.status_roles(seed_cfg))}
    if status_field:
        status["id"] = status_field.get("id")
        status["options"] = {opt["name"]: opt["id"]
                             for opt in (status_field.get("options") or [])
                             if opt.get("name") and opt.get("id")}
    # A fresh profile carries only what was created and read back — the optional
    # `fields.phase` block stays out (the Program route is opt-in and manual).
    fields = {"status": status}
    for key, name, _ in WORKFLOW_FIELDS:
        field = by_name.get(name)
        if field and field.get("id"):
            fields[key] = field["id"]
    profile["fields"] = fields
    return profile


def validate_profile(profile: dict) -> list[str]:
    """Every reason this profile must not be written, as plain sentences."""
    problems: list[str] = []
    fields = profile.get("fields") or {}
    status = fields.get("status") or {}
    options = status.get("options") or {}
    if not status.get("id"):
        problems.append(f"the readback carries no `{STATUS_FIELD_NAME}` field")
    if not options:
        problems.append(f"the readback carries no `{STATUS_FIELD_NAME}` options")
    for role, name in (status.get("roles") or {}).items():
        if name not in options:
            problems.append(
                f"status role `{role}` maps to option {name!r}, which the board does not have")
    for key, name, _ in WORKFLOW_FIELDS:
        if not fields.get(key):
            problems.append(f"the readback carries no `{name}` field")
    project = profile.get("project") or {}
    if not project.get("nodeId"):
        problems.append("the project node id is missing")
    if not project.get("number"):
        problems.append("the project number is missing")
    if not profile.get("repo"):
        problems.append("the repository is missing")
    leftovers = sorted(set(PLACEHOLDER_RE.findall(
        json.dumps(profile, ensure_ascii=False))))
    if leftovers:
        problems.append(f"unresolved seed placeholder(s): {', '.join(leftovers)}")
    return problems


def render_document(seed_text: str, profile: dict) -> str:
    """The seeded board-sync.md with the filled sentinel and the profile block
    replaced — the documentation body around it survives byte-for-byte."""
    body = seed_text
    first, _, rest = body.partition("\n")
    if SENTINEL_RE.match(first.strip()):
        body = rest
    marker = PROFILE_MARKER_RE.search(body)
    if not marker:
        raise BootstrapError("the seed carries no `<!-- board-sync:profile -->` marker")
    fence = JSON_FENCE_RE.search(body, marker.end())
    if not fence:
        raise BootstrapError("the seed's profile marker is not followed by a ```json block")
    rendered = json.dumps(profile, indent=2, ensure_ascii=False)
    return SENTINEL + "\n" + body[:fence.start(2)] + rendered + body[fence.end(2):]


# --- the sequence ------------------------------------------------------------
def creation_plan(owner: str, title: str, status_options: list[str]) -> list[list[str]]:
    """The `gh` argv sequence, project-number placeholder `{number}` included —
    also what `--dry-run` prints."""
    plan = [["project", "create", "--owner", owner, "--title", title, "--format", "json"]]
    plan.append(["project", "field-create", "{number}", "--owner", owner,
                 "--name", STATUS_FIELD_NAME, "--data-type", "SINGLE_SELECT",
                 "--single-select-options", ",".join(status_options), "--format", "json"])
    for _, name, data_type in WORKFLOW_FIELDS:
        plan.append(["project", "field-create", "{number}", "--owner", owner,
                     "--name", name, "--data-type", data_type, "--format", "json"])
    plan.append(["project", "field-list", "{number}", "--owner", owner, "--format", "json"])
    return plan


def create_board(*, owner: str, repo: str, title: str, seed_cfg: dict) -> dict:
    """Create the board, read it back, and return the validated profile. Raises
    `BootstrapError` — with the created project named — on any failure."""
    options = status_option_names(seed_cfg)
    created = _gh_json(["project", "create", "--owner", owner, "--title", title,
                        "--format", "json"])
    number, node_id = created.get("number"), created.get("id")
    if not number or not node_id:
        raise BootstrapError(
            f"`gh project create` returned no project number/id: {created!r}")
    where = (f"project #{number} ({created.get('url') or owner}) was created; "
             "finish or delete it before retrying")
    try:
        _gh(["project", "field-create", str(number), "--owner", owner,
             "--name", STATUS_FIELD_NAME, "--data-type", "SINGLE_SELECT",
             "--single-select-options", ",".join(options), "--format", "json"])
        for _, name, data_type in WORKFLOW_FIELDS:
            _gh(["project", "field-create", str(number), "--owner", owner,
                 "--name", name, "--data-type", data_type, "--format", "json"])
        field_list = _gh_json(["project", "field-list", str(number), "--owner", owner,
                               "--format", "json"])
    except BootstrapError as exc:
        raise BootstrapError(f"{exc} — {where}") from exc
    profile = build_profile(seed_cfg, repo=repo, owner=owner, number=number,
                            node_id=node_id, field_list=field_list)
    problems = validate_profile(profile)
    if problems:
        raise BootstrapError(
            "the board readback does not satisfy the workflow profile:\n  - "
            + "\n  - ".join(problems) + f"\n{where}")
    return profile


def write_profile(out: Path, seed_text: str, profile: dict) -> None:
    """Write the document, then re-read it through the real loader. A profile the
    loader rejects is removed again — never left behind as a filled claim."""
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_document(seed_text, profile), encoding="utf-8")
    try:
        board_config.load_board_config(out)
    except board_config.ConfigError as exc:
        out.unlink(missing_ok=True)
        raise BootstrapError(f"the written profile does not load: {exc}") from exc


# --- CLI ---------------------------------------------------------------------
def _first_line(path: Path):
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    return text.splitlines()[0] if text.strip() else None


def _preflight(args) -> int:
    missing = missing_scopes(_gh(["auth", "status"]))
    if args.json:
        print(json.dumps({"missingScopes": missing, "remedy": SCOPE_REMEDY}))
    elif missing:
        print(f"missing scope(s): {', '.join(missing)} — run: {SCOPE_REMEDY}")
    else:
        print("scopes ok")
    return EXIT_MISSING_SCOPE if missing else 0


def _create(args) -> int:
    out = Path(args.out)
    first_line = _first_line(out)
    action = destination_action(first_line)
    if action == "refuse":
        observed = SENTINEL_RE.match((first_line or "").strip())
        state = f"state={observed.group(1)}" if observed else "no setup-workflow sentinel"
        print(f"{out} is consumer-owned ({state}) — refusing to overwrite it. "
              "Only a missing file or `state=stub` may be filled.", file=sys.stderr)
        return EXIT_REFUSED

    seed_text = Path(args.seed).read_text(encoding="utf-8")
    seed_cfg = board_config.load_board_config(args.seed)

    missing = missing_scopes(_gh(["auth", "status"]))
    if missing:
        print(f"`gh` is missing the {', '.join(missing)} scope — no board was created. "
              f"Run: {SCOPE_REMEDY}", file=sys.stderr)
        return EXIT_MISSING_SCOPE

    if args.dry_run:
        for call in creation_plan(args.owner, args.title, status_option_names(seed_cfg)):
            print(shlex.join(["gh", *call]))  # copy-pasteable, not just readable
        print(f"destination: {out} ({action})")
        return 0

    profile = create_board(owner=args.owner, repo=args.repo, title=args.title,
                           seed_cfg=seed_cfg)
    write_profile(out, seed_text, profile)
    print(f"board created: project #{profile['project']['number']} "
          f"({profile['project']['owner']}) — profile written to {out}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    pre = sub.add_parser("preflight", help="check the gh scopes board creation needs")
    pre.add_argument("--json", action="store_true")
    pre.set_defaults(func=_preflight)

    create = sub.add_parser("create", help="create the board and write the filled profile")
    create.add_argument("--owner", required=True)
    create.add_argument("--repo", required=True, help="owner/repo of the consumer repository")
    create.add_argument("--title", required=True)
    create.add_argument("--seed", required=True, help="the seeded board-sync.md template")
    create.add_argument("--out", required=True, help="destination, e.g. docs/agents/board-sync.md")
    create.add_argument("--dry-run", action="store_true")
    create.set_defaults(func=_create)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (BootstrapError, board_config.ConfigError) as exc:
        print(str(exc), file=sys.stderr)
        return EXIT_FAILURE


if __name__ == "__main__":
    sys.exit(main())
