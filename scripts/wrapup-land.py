#!/usr/bin/env python3
"""wrapup-land.py — mechanical executor for the /make-landable + /land skills.

Replaces the former Sonnet phase-2 subagent: every enumerable
git/gh step of landing a slice runs here deterministically; judgment
(secret review, commit message, PR body text, drift-fallback candidates,
sibling propagation) stays with the calling agent.

Subcommands
  preflight       read-only context report (run in the worktree being landed)
  commit          .env hard block + secret grep + git commit (run in the worktree)
  land            push → PR → body-check → merge → teardown → sweeps → anchor-sync
                  (run FROM the main tree; refuses to run inside the worktree)
  content-claim   read-only: infer the durable content a planning session left
                  dirty in the main checkout, each path with its blob hash
  content-commit  land a confirmed claim of that content on a collision-checked
                  issue-less branch — explicit pathspecs only, bystanders
                  untouched, no teardown half (run in the main checkout)

Any born, attached worktree is first-class: a direct /land invocation is the
teardown authorization, including for worktrees an external tool created under
a foreign name and path. There is no naming or location gate, no persisted
attempt state, and no recovery flag — an interrupted landing is resumed by
re-running it, because every step verifies present state and skips what is
already done.

Branch retirement is authorized, never assumed: ancestry against the freshly
fetched integration branch deletes normally, and only the platform's own PR
record — the full tuple, head SHA equal to the tip re-read immediately before
the deletion — force-deletes.

Output: one JSON report on stdout. Exit 0 = ok, 1 = STOP (reason in JSON),
2 = usage/context error. On STOP nothing is forced — no --force, no
--no-verify, and no branch deletion the authority above did not clear; the
caller diagnoses.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import NamedTuple
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))

from marker_lib import marker_value  # noqa: E402

# Secret pattern mirrors the historical landing Step-0a grep (era).
SECRET_RE = re.compile(
    r"BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|secret|password|access[_-]?token|bearer)\s*[:=]",
    re.IGNORECASE,
)
ENV_PATH_RE = re.compile(r"(^|/)\.env(\.[^/]*)?$")
# ANNAHMEN.md drift-log line: "- #<n>: text" or "- #<n> §<section>: text"
DRIFT_LINE_RE = re.compile(r"^-\s*#(\d+)(?:\s*§([^:]+?))?\s*:\s*(.+)$")
RETRO_LINE_RE = re.compile(r"^\*\*Retro:\*\*", re.MULTILINE)
DRIFT_MARKER_RE = re.compile(r"<!--\s*annahme-drift:\s*(\{.*?\})\s*-->")
RED_CHECK_CONCLUSIONS = {
    "ACTION_REQUIRED",
    "CANCELLED",
    "FAILURE",
    "STALE",
    "STARTUP_FAILURE",
    "TIMED_OUT",
}
GREEN_CHECK_CONCLUSIONS = {"NEUTRAL", "SKIPPED", "SUCCESS"}
CHECK_WAIT_SECONDS = 20 * 60
CHECK_POLL_SECONDS = 10
MAX_EXTERNAL_DETAIL = 500
INFRA_FAILURE_RE = re.compile(
    r"(?:"
    r"account payments? (?:have )?failed|"
    r"billing issue|"
    r"spending limit|"
    r"no hosted parallelism|"
    r"no (?:hosted )?runners? (?:are )?available|"
    r"no runner matching|"
    r"runner (?:is )?unavailable|"
    r"failed to (?:acquire|assign) (?:a )?job|"
    r"job was not started"
    r")",
    re.IGNORECASE,
)


LIFECYCLE_PROFILE = "docs/agents/workflow-capabilities.json"
CLASSIFY_MODULE = "_wrapup_teardown_classify"
LIFECYCLE_PROFILE_MODULE = "_wrapup_lifecycle_profile"

# Census freshness is consumed read-only from the drift guard; this file owns no
# census logic of its own.
CENSUS_HOOK = ".claude/hooks/drift-guard.py"
CENSUS_STALE = "refresh_required"
CENSUS_ABSENT = "no_census"
CENSUS_UNREADABLE = "unreadable"
CENSUS_ISSUE_LIMIT = 1000
CENSUS_TRACKING_KIND = "census-refresh-source"
CENSUS_TRACKING_SLUG = "census-refresh"
CENSUS_TRACKING_TITLE = "census: the activated census needs a refresh"
CENSUS_CHECKOUT_NOTE = (
    "a census describes the tree it was scanned in — a refresh committed in a "
    "worktree is visible in that working tree only"
)
CENSUS_RECOVERY = (
    "run `$census-update` in the evaluated checkout and land the refresh as a "
    "dedicated pull request of its own — never mirror the census file from "
    "another checkout"
)
CENSUS_NOT_A_GATE = (
    "this finding never blocks a landing: topology drift is repo-wide and is "
    "usually not caused by the pull request that just merged"
)
CENSUS_OVERRIDE_NOTE = (
    "a change-local override greened the handoff gate; the verdict itself still "
    "asks for a refresh"
)


class Stop(Exception):
    def __init__(self, step: str, reason: str, detail: str = ""):
        super().__init__(reason)
        self.step, self.reason, self.detail = step, reason, detail


def run(cmd: list[str], cwd: str | None = None, check: bool = False,
        env: dict | None = None) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    if check and p.returncode != 0:
        raise Stop(cmd[0], f"command failed: {' '.join(cmd)}",
                   failed_process_detail(p))
    return p


def git(args: list[str], cwd: str | None = None, check: bool = False,
        env: dict | None = None) -> subprocess.CompletedProcess:
    return run(["git", *args], cwd=cwd, check=check, env=env)


# ---------- PR check gate ----------

def check_name(check: dict) -> str:
    return str(check.get("name") or check.get("context") or "?")


def check_conclusion(check: dict) -> str:
    # CheckRun entries carry `conclusion: null` while pending. Do not let a
    # simultaneously present legacy `state` field turn that explicit null green.
    value = check.get("conclusion") if "conclusion" in check else check.get("state")
    return str(value or "").upper()


def pending_checks(checks: list[dict]) -> list[dict]:
    pending = []
    for check in checks:
        conclusion = check_conclusion(check)
        status = str(check.get("status") or "").upper()
        if conclusion in RED_CHECK_CONCLUSIONS | GREEN_CHECK_CONCLUSIONS:
            continue
        if conclusion in {"EXPECTED", "IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"}:
            pending.append(check)
            continue
        if not conclusion or status not in {"", "COMPLETED"}:
            pending.append(check)
    return pending


def red_checks(checks: list[dict]) -> list[dict]:
    return [
        check for check in checks
        if check_conclusion(check) in RED_CHECK_CONCLUSIONS | {"ERROR"}
    ]


def _compact_external_detail(text: str) -> str:
    compact = re.sub(r"[\x00-\x1f\x7f]+", " ", text)
    return re.sub(r"\s+", " ", compact).strip()


def sanitize_external_detail(text: str) -> str:
    return _compact_external_detail(text)[:MAX_EXTERNAL_DETAIL]


def failed_process_detail(
    completed: subprocess.CompletedProcess,
    limit: int = 2000,
) -> str:
    """Keep Git's error and its hook's diagnostic even when they use different streams."""
    combined = "\n".join(
        stream for stream in (completed.stderr, completed.stdout)
        if isinstance(stream, str) and stream.strip()
    )
    return _compact_external_detail(combined)[-limit:]


def _check_text(check: dict) -> str:
    values = []
    for key in ("name", "context", "description", "title", "summary", "text"):
        value = check.get(key)
        if isinstance(value, str):
            values.append(value)
    return " ".join(values)


def _matching_actions_job(check: dict, jobs: list[dict]) -> dict | None:
    """Return the one Actions job represented by this check, never a run sibling."""
    candidates = [job for job in jobs if isinstance(job, dict)]
    details_url = check.get("link") or check.get("detailsUrl") or check.get("targetUrl")
    job_match = (
        re.search(r"/job/(\d+)(?:/|$)", details_url)
        if isinstance(details_url, str)
        else None
    )
    if job_match is not None:
        job_id = job_match.group(1)
        matching_ids = [
            job for job in candidates
            if str(job.get("databaseId") or "") == job_id
            or re.search(
                rf"/job/{re.escape(job_id)}(?:/|$)",
                str(job.get("url") or ""),
            )
        ]
        return matching_ids[0] if len(matching_ids) == 1 else None

    name = check_name(check)
    matching_names = [
        job for job in candidates if str(job.get("name") or "") == name
    ]
    return matching_names[0] if len(matching_names) == 1 else None


def _job_database_id(job: dict) -> str:
    database_id = job.get("databaseId")
    if database_id is not None:
        return str(database_id)
    match = re.search(r"/job/(\d+)(?:/|$)", str(job.get("url") or ""))
    return match.group(1) if match is not None else ""


def infrastructure_failure_diagnosis(
    check: dict,
    *,
    command_runner=run,
) -> str:
    """Classify known Actions billing/runner failures with bounded read-only detail."""
    if INFRA_FAILURE_RE.search(_check_text(check)):
        return "infrastructure failure (billing or runner unavailable)"

    details_url = check.get("link") or check.get("detailsUrl") or check.get("targetUrl")
    run_match = (
        re.search(r"/actions/runs/(\d+)(?:/|$)", details_url)
        if isinstance(details_url, str)
        else None
    )
    if run_match is None:
        return ""
    run_id = run_match.group(1)

    jobs_result = command_runner(
        ["gh", "run", "view", run_id, "--json", "jobs"]
    )
    matching_job = None
    if jobs_result.returncode == 0:
        try:
            jobs = json.loads(jobs_result.stdout).get("jobs") or []
        except (AttributeError, json.JSONDecodeError):
            jobs = []
        matching_job = _matching_actions_job(check, jobs)
        zero_step_failure = (
            matching_job is not None
            and str(matching_job.get("conclusion") or "").lower()
            in {"failure", "cancelled", "timed_out", "startup_failure"}
            and not (matching_job.get("steps") or [])
        )
        if zero_step_failure:
            return "infrastructure failure (failed Actions job had zero steps)"

    job_id = _job_database_id(matching_job) if matching_job is not None else ""
    if not job_id:
        return ""
    log_result = command_runner([
        "gh", "run", "view", run_id, "--job", job_id, "--log-failed"
    ])
    external = sanitize_external_detail(
        (log_result.stdout or "") + " " + (log_result.stderr or "")
    )
    if INFRA_FAILURE_RE.search(external):
        return "infrastructure failure (billing or runner unavailable)"
    return ""


def _pr_gate_snapshot(pr: str, command_runner) -> dict:
    result = command_runner([
        "gh", "pr", "view", pr, "--json",
        "state,mergeable,mergeStateStatus,statusCheckRollup,baseRefName",
    ])
    if result.returncode != 0:
        raise Stop(
            "0c merge-gate",
            "cannot inspect PR checks",
            sanitize_external_detail(result.stderr or result.stdout),
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Stop("0c merge-gate", "invalid PR check response", str(error)) from error


def _required_checks_snapshot(pr: str, command_runner) -> list[dict]:
    result = command_runner([
        "gh", "pr", "checks", pr, "--required", "--json",
        "name,state,link,bucket,workflow",
    ])
    # gh uses 1 for failed checks and 8 for pending checks. Both still carry
    # the authoritative JSON needed by this gate.
    if result.returncode not in {0, 1, 8}:
        raise Stop(
            "0c merge-gate",
            "cannot inspect required PR checks",
            sanitize_external_detail(result.stderr or result.stdout),
        )
    payload = (result.stdout or "").strip()
    if not payload:
        # An empty body is not an error: it is the platform saying no check run
        # has been reported yet — the ordinary state in the seconds after a PR
        # is opened, and precisely the state the poll below exists to wait
        # through. Parsing it as JSON blamed the platform for a race this
        # script opened itself.
        return []
    try:
        checks = json.loads(payload)
    except json.JSONDecodeError as error:
        raise Stop(
            "0c merge-gate",
            "malformed required PR check response",
            f"{error} — the response carried a body that is not JSON: "
            f"{sanitize_external_detail(payload)}",
        ) from error
    if not isinstance(checks, list) or not all(
        isinstance(check, dict) for check in checks
    ):
        raise Stop(
            "0c merge-gate",
            "invalid required PR check response",
            "expected a JSON array of checks",
        )
    return checks


def _configured_required_check_names(snapshot: dict, command_runner) -> set[str]:
    branch = snapshot.get("baseRefName")
    if not isinstance(branch, str) or not branch:
        raise Stop("0c merge-gate", "PR response has no base branch")
    repo_result = command_runner(["gh", "repo", "view", "--json", "nameWithOwner"])
    if repo_result.returncode != 0:
        raise Stop(
            "0c merge-gate",
            "cannot inspect repository identity",
            sanitize_external_detail(repo_result.stderr or repo_result.stdout),
        )
    try:
        repository = json.loads(repo_result.stdout)["nameWithOwner"]
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise Stop("0c merge-gate", "invalid repository identity response", str(error)) from error
    rules_result = command_runner([
        "gh", "api",
        f"repos/{quote(repository, safe='/')}/rules/branches/{quote(branch, safe='')}",
    ])
    if rules_result.returncode != 0:
        raise Stop(
            "0c merge-gate",
            "cannot inspect required-check rules",
            sanitize_external_detail(rules_result.stderr or rules_result.stdout),
        )
    try:
        rules = json.loads(rules_result.stdout)
    except json.JSONDecodeError as error:
        raise Stop("0c merge-gate", "invalid required-check rules response", str(error)) from error
    if not isinstance(rules, list):
        raise Stop("0c merge-gate", "invalid required-check rules response", "expected a JSON array")
    return {
        check["context"]
        for rule in rules
        if isinstance(rule, dict) and rule.get("type") == "required_status_checks"
        for check in (rule.get("parameters", {}).get("required_status_checks") or [])
        if isinstance(check, dict) and isinstance(check.get("context"), str)
    }


def _failed_check_detail(failed: list[dict], command_runner) -> str:
    details = []
    for check in failed:
        diagnosis = infrastructure_failure_diagnosis(
            check, command_runner=command_runner
        )
        suffix = f" — {diagnosis}" if diagnosis else ""
        details.append(f"{check_name(check)}{suffix}")
    return ", ".join(details)


def _waiting_checks(
    required_checks: list[dict],
    configured_required_names: set[str],
) -> list[dict]:
    waiting = pending_checks(required_checks)
    observed = {check_name(check) for check in required_checks}
    waiting.extend(
        {"name": f"{name} (awaiting discovery)"}
        for name in sorted(configured_required_names - observed)
    )
    return waiting


def wait_for_merge_gate(
    pr: str,
    *,
    timeout_seconds: float = CHECK_WAIT_SECONDS,
    poll_interval: float = CHECK_POLL_SECONDS,
    command_runner=run,
    clock=time.monotonic,
    sleeper=time.sleep,
    progress_stream=sys.stderr,
    configured_required_names: set[str] | None = None,
) -> bool:
    """Wait for pending checks. Return True when the PR was already merged."""
    started = clock()
    while True:
        snapshot = _pr_gate_snapshot(pr, command_runner)
        state = snapshot.get("state")
        if state == "MERGED":
            return True
        if state != "OPEN":
            raise Stop("0c merge-gate", f"PR state {state} — cannot merge")
        if snapshot.get("mergeable") == "CONFLICTING":
            raise Stop("0c merge-gate", "PR is CONFLICTING — rebase/resolve the branch")

        if configured_required_names is None:
            configured_required_names = _configured_required_check_names(
                snapshot, command_runner
            )
        checks = _required_checks_snapshot(pr, command_runner)
        failed = red_checks(checks)
        if failed:
            raise Stop(
                "0c merge-gate",
                "red checks on the PR",
                _failed_check_detail(failed, command_runner),
            )

        waiting = _waiting_checks(checks, configured_required_names)
        if not waiting:
            return False

        elapsed = clock() - started
        names = ", ".join(check_name(check) for check in waiting)
        if elapsed >= timeout_seconds:
            raise Stop(
                "0c merge-gate",
                "check wait budget exceeded",
                f"elapsed={elapsed:.1f}s; still pending: {names}",
            )
        print(
            f"land: waiting for PR #{pr} checks "
            f"({elapsed:.1f}s elapsed): {names}",
            file=progress_stream,
            flush=True,
        )
        sleeper(min(poll_interval, timeout_seconds - elapsed))


# ---------- context ----------

def worktree_map(cwd: str | None = None) -> tuple[str, dict[str, str]]:
    """Return (main_tree, {branch: worktree_path}) from `git worktree list`."""
    out = git(["worktree", "list", "--porcelain"], cwd=cwd, check=True).stdout
    main_tree, mapping, wt = "", {}, ""
    for line in out.splitlines():
        if line.startswith("worktree "):
            wt = line.split(" ", 1)[1]
            if not main_tree:
                main_tree = wt
        elif line.startswith("branch refs/heads/"):
            mapping[line.split("refs/heads/", 1)[1]] = wt
    return main_tree, mapping


def issue_from_branch(branch: str) -> str | None:
    """Derive the issue anchor from the branch — or None, which is first-class.

    Branch prefixes are a project convention read from the board profile, never
    inlined. A branch that carries no issue number (an externally created
    worktree, a spike) lands without an anchor instead of being refused.
    """
    prefixes = load_profile().get("branchPrefixes") or ()
    if not prefixes:
        return None
    pattern = re.compile(
        r"^(?:" + "|".join(re.escape(prefix) for prefix in prefixes) + r")/(\d+)-"
    )
    match = pattern.match(branch)
    return match.group(1) if match else None


def declared_close_targets(body: str) -> list:
    """Close authority for Step 5b: the PR body's ACTIVE close keywords, parsed
    by pr-body-check's one close grammar. A branch number is context, never
    closure authority — branch-derived closing once shut a Program-PRD that a
    PR deliberately referenced only via `Part of`."""
    spec = importlib.util.spec_from_file_location(
        "pr_body_check_grammar", Path(__file__).parent / "pr-body-check.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.active_close_targets(body)


def load_profile() -> dict:
    try:
        from board_config import load_board_config
        return load_board_config()
    except Exception:
        return {}


def load_module(name: str, path: Path, step: str):
    """Load one shipped helper module exactly once per process.

    Re-executing it would mint a second set of classes, so an assessment
    produced by one load could not be raised or matched against the other.
    """
    existing = sys.modules.get(name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise Stop(step, f"cannot load the shipped helper module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_teardown_classifier():
    """The one stateless teardown core — never a second copy here."""
    path = Path(__file__).resolve().parent / "worktree-lifecycle" / "classify.py"
    return load_module(CLASSIFY_MODULE, path, "4 teardown")


def load_lifecycle_profile_module():
    path = Path(__file__).resolve().parent / "worktree-lifecycle" / "profile.py"
    return load_module(LIFECYCLE_PROFILE_MODULE, path, "profile")


def lifecycle_settings(repo_root: str) -> dict:
    """The consumer's Worktree Lifecycle block, or {} when there is none.

    Read raw rather than through the module's loader: these structural facts —
    branch names, branch templates — are needed whether or not the consumer
    enabled the worktree lifecycle itself.
    """
    try:
        document = json.loads(
            (Path(repo_root) / LIFECYCLE_PROFILE).read_text(encoding="utf-8")
        )
        candidate = document.get("worktreeLifecycle")
    except (OSError, json.JSONDecodeError, AttributeError, TypeError):
        return {}
    return candidate if isinstance(candidate, dict) else {}


def branch_policy(repo_root: str) -> tuple[str, tuple[str, ...]]:
    """Return (integration branch, protected branches) from the consumer profile.

    The integration branch is never named inline. An absent or malformed
    profile falls back to the Worktree Lifecycle profile's own documented
    default, which is the single place in the kit that names a branch at all.
    """
    defaults = load_lifecycle_profile_module().DEFAULT_MAIN_BRANCHES
    raw = lifecycle_settings(repo_root)
    integration = tuple(raw.get("mainBranches") or defaults)
    protected = tuple(raw.get("protectedBranches") or integration)
    return integration[0], protected


def require_landable_head(step: str, cwd: str) -> str:
    """Return the worktree's branch, or STOP with the exact reason it has none.

    Detached and unborn are the two states a landing can never repair on its
    own, so each is a named refusal that says what the user does about it —
    never a silent skip.
    """
    symbolic = git(["symbolic-ref", "--quiet", "HEAD"], cwd=cwd)
    if symbolic.returncode != 0:
        raise Stop(
            step,
            "detached HEAD — /land lands a branch and this worktree is on none",
            f"{cwd}: attach one here (`git switch -c <branch>` keeps the work on a "
            "new branch, `git switch <branch>` moves to an existing one), then "
            "re-run the landing pair",
        )
    branch = symbolic.stdout.strip().removeprefix("refs/heads/")
    if git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], cwd=cwd).returncode != 0:
        raise Stop(
            step,
            f"unborn branch {branch} — it has no commits yet, so there is nothing to land",
            f"{cwd}: make the first commit (make-landable's `commit` step does it), then "
            "re-run the landing pair",
        )
    return branch


class TeardownTarget(NamedTuple):
    """What Step 4 may act on, decided before anything is removed."""

    worktree: str | None
    reason: str
    is_main_working_tree: bool = False


def resolve_teardown_target(main_tree: str, worktree: str | None) -> TeardownTarget:
    """Resolve the teardown target and its admissibility — before any removal.

    Deletion is the one irreversible half of a landing, so every state that
    refuses it is enumerated here, while nothing has been removed yet. The
    state that matters is the main working tree: teardown's safety argument is
    that ignored means "the repository declared this is not work", and that
    holds for a worktree this session is discarding — never for the checkout
    every other session lives in, where ignored means node_modules, planning
    artifacts and, once the worktree root is ignored, every sibling worktree of
    every parallel agent.

    Having no worktree to tear down is an ordinary outcome, not a refusal: the
    branch merged, and there is simply nothing to discard.
    """
    if worktree is None:
        return TeardownTarget(
            None, "teardown: no worktree holds this branch — nothing to tear down"
        )
    if os.path.realpath(worktree) == os.path.realpath(main_tree):
        return TeardownTarget(
            None,
            f"teardown: {worktree} is the main working tree — /land never tears "
            "that down, so there is nothing to tear down",
            is_main_working_tree=True,
        )
    if not Path(worktree).is_dir():
        return TeardownTarget(None, "teardown: the worktree is already removed")
    return TeardownTarget(worktree, "")


def declared_seed_paths(main_tree: str) -> tuple[str, ...]:
    """The seed paths the consumer's own profile declares, or none at all.

    The classifier takes the declaration as an argument and reads no profile
    itself, so resolving consumer configuration stays here — with the caller
    that already reads this profile. A malformed seed is named rather than
    silently degraded to "nothing declared": a declaration the consumer wrote
    and this run ignored would block the very file it was meant to clear.
    """
    module = load_lifecycle_profile_module()
    try:
        return module.seed_of(lifecycle_settings(main_tree)).paths
    except module.LifecycleError as error:
        raise Stop(
            "4 teardown", "the profile's seed declaration cannot be read", str(error)
        ) from error


def assess_teardown(wt: str, main_tree: str):
    """Classify the worktree's current state — the only teardown authority."""
    classify = load_teardown_classifier()
    try:
        return classify.assess(Path(wt), Path(main_tree), declared_seed_paths(main_tree))
    except classify.ClassificationError as error:
        raise Stop("4 teardown", "teardown cannot be classified", str(error)) from error


def remove_teardown_scratch(assessment) -> list[str]:
    """Delete exactly what the given assessment cleared, re-checked entry by entry."""
    classify = load_teardown_classifier()
    try:
        return list(classify.remove_scratch(assessment))
    except classify.ClassificationError as error:
        raise Stop("4 teardown", "teardown is blocked", str(error)) from error


def teardown_report(assessment) -> str:
    return load_teardown_classifier().render_report(assessment)


# ---------- drift log (ANNAHMEN.md) ----------

def parse_annahmen(text: str, default_section: str) -> tuple[list[dict], list[str]]:
    """Split drift-log lines into well-formed marker dicts and malformed leftovers."""
    wellformed, malformed = [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or not line.startswith("-"):
            continue
        m = DRIFT_LINE_RE.match(line)
        if m:
            wellformed.append({
                "target": f"#{m.group(1)}",
                "section": (m.group(2) or default_section).strip(),
                "op": "append",
                "text": m.group(3).strip(),
            })
        else:
            malformed.append(line)
    return wellformed, malformed


def marker_comment(marker: dict) -> str:
    payload = json.dumps(marker, ensure_ascii=False)
    return f"<!-- annahme-drift: {payload} -->"


def merge_markers_into_body(body: str, markers: list[dict]) -> str:
    """Append marker comments not already present (dedupe on target+text)."""
    have = set()
    for m in DRIFT_MARKER_RE.finditer(body):
        try:
            d = json.loads(m.group(1))
            have.add((d.get("target"), d.get("text")))
        except json.JSONDecodeError:
            continue
    add = [marker_comment(m) for m in markers if (m["target"], m["text"]) not in have]
    if not add:
        return body
    return body.rstrip("\n") + "\n\n" + "\n".join(add) + "\n"


# ---------- secret / .env checks ----------

def env_paths(porcelain: str) -> list[str]:
    hits = []
    for line in porcelain.splitlines():
        path = line[3:].split(" -> ")[-1].strip().strip('"')
        if ENV_PATH_RE.search(path):
            hits.append(path)
    return hits


def secret_hits_in(diff_text: str) -> list[str]:
    hits = []
    for n, line in enumerate(diff_text.splitlines(), 1):
        if line.startswith("+") and not line.startswith("+++") and SECRET_RE.search(line):
            hits.append(f"{n}: {line[:200]}")
    return hits


# ---------- dev-server kill ----------

def parse_dev_ports(text: str) -> list[str]:
    ports = []
    for line in text.splitlines():
        m = re.match(r"^(VITE_DEV_PORT|BACKEND_PORT)=(\d+)\s*$", line.strip())
        if m:
            ports.append(m.group(2))
    return ports


def self_ancestry() -> set[int]:
    pids, pid = set(), os.getpid()
    while pid > 1:
        pids.add(pid)
        try:
            with open(f"/proc/{pid}/status") as fh:
                pid = next(int(l.split()[1]) for l in fh if l.startswith("PPid:"))
        except (OSError, StopIteration):
            break
    return pids


def process_identity(pid: int) -> tuple[str, str] | None:
    """The pair that tells one PID apart from its recycled reuse: start time + cwd."""
    try:
        with open(f"/proc/{pid}/stat", "rb") as handle:
            fields = handle.read().rsplit(b")", 1)[1].split()
        started = fields[19].decode()
        return started, os.path.realpath(f"/proc/{pid}/cwd")
    except (OSError, IndexError):
        return None


def signal_listener(port: str, pid: int, identity: tuple[str, str]) -> str:
    """SIGKILL one attributed listener without ever hitting a recycled PID.

    `pidfd_open` (Linux 5.3+) pins the process, so the signal cannot land on a
    PID some other process inherited between the lookup and the kill. Without
    it the identity is re-read immediately before signalling — a narrower but
    honest guarantee, and still a refusal rather than a blind kill.
    """
    opener = getattr(os, "pidfd_open", None)
    sender = getattr(signal, "pidfd_send_signal", None)
    if opener is None or sender is None:
        if process_identity(pid) != identity:
            raise Stop(
                "2 process-kill",
                f"pid {pid} changed identity before it could be signalled",
                "the PID was recycled; re-run land once the ports are quiet",
            )
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            return ""
        return f"port {port} pid {pid} (recheck)"
    try:
        descriptor = opener(pid)
    except ProcessLookupError:
        return ""
    except OSError as error:
        raise Stop(
            "2 process-kill", f"cannot pin pid {pid} before signalling it", str(error)
        ) from error
    try:
        if process_identity(pid) != identity:
            raise Stop(
                "2 process-kill",
                f"pid {pid} changed identity before it could be signalled",
                "the PID was recycled; re-run land once the ports are quiet",
            )
        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
    except ProcessLookupError:
        return ""
    finally:
        os.close(descriptor)
    return f"port {port} pid {pid} (pidfd)"


def kill_worktree_processes(wt: str) -> list[str]:
    """Signal only the listeners on this worktree's own declared `.dev-ports`.

    Never signal on doubt. A listener whose working directory is not inside
    this worktree — or whose identity cannot be read at all — is a named STOP,
    not a kill: matching foreign processes by command name across the whole
    machine is how a landing run takes down someone else's server. Own shell
    ancestry stays excluded (the self-kill trap).
    """
    dev_ports = Path(wt) / ".dev-ports"
    if not dev_ports.is_file():
        return []
    ports = parse_dev_ports(dev_ports.read_text())
    protected = self_ancestry()
    worktree_root = os.path.realpath(wt)
    killed, unattributed = [], []
    for port in ports:
        listing = run(["lsof", "-ti", f":{port}"])
        for raw in listing.stdout.split():
            if not raw.isdigit() or int(raw) in protected:
                continue
            pid = int(raw)
            identity = process_identity(pid)
            if identity is None:
                unattributed.append(f"port {port} pid {pid}: identity unreadable")
                continue
            cwd = identity[1]
            if cwd != worktree_root and not cwd.startswith(worktree_root + os.sep):
                unattributed.append(f"port {port} pid {pid}: cwd {cwd}")
                continue
            entry = signal_listener(port, pid, identity)
            if entry:
                killed.append(entry)
    if unattributed:
        raise Stop(
            "2 process-kill",
            "a process on this worktree's declared ports cannot be attributed to it "
            "— never signal on doubt",
            "; ".join(unattributed),
        )
    return killed


# ---------- anchor completeness ----------

def anchor_complete_from_body(body: str) -> bool | None:
    """True when every slice-table row's Status cell is ✅; None when no table."""
    try:
        import anchor_table as at
        headers, rows = at.current_slice_table(body)
        idx = at.require_col_index(headers, "Status")
    except Exception:
        return None
    if not rows:
        return None
    return all(at.status_base(r[idx]).startswith("✅") for r in rows if len(r) > idx)


# ---------- remote sweep set ----------

def stale_remote_set(
    merged: set[str],
    remotes: set[str],
    open_prs: set[str],
    protected: set[str],
) -> list[str]:
    return sorted((merged & remotes) - open_prs - protected)


# ---------- subcommands ----------

def cmd_preflight(args) -> dict:
    cwd = os.getcwd()
    main_tree, _ = worktree_map(cwd)
    wt = git(["rev-parse", "--show-toplevel"], check=True).stdout.strip()
    branch = require_landable_head("preflight", cwd)
    _, protected = branch_policy(wt)
    # No naming or location gate: any born, attached worktree is first-class,
    # including one an external tool created under a foreign name and path.
    # Only the main checkout and a protected branch are refused.
    if os.path.realpath(wt) == os.path.realpath(main_tree):
        raise Stop("preflight", "run /make-landable in the worktree it should prepare",
                   f"wt={wt} is the main checkout — /land never tears that down")
    if branch in protected:
        raise Stop("preflight", f"{branch} is a protected branch",
                   f"wt={wt} — /land lands a slice branch, never the integration branch")

    porcelain = git(["status", "--porcelain"], check=True).stdout
    profile = load_profile()
    default_section = profile.get("headings", {}).get("vorBau", "Vor Bau zu klären")

    annahmen_path = Path(wt) / "ANNAHMEN.md"
    wellformed, malformed = ([], [])
    if annahmen_path.is_file():
        wellformed, malformed = parse_annahmen(annahmen_path.read_text(), default_section)

    diff_text = git(["diff", "HEAD"]).stdout
    untracked = [l[3:].strip() for l in porcelain.splitlines() if l.startswith("??")]
    hits = secret_hits_in(diff_text)
    for u in untracked:
        p = Path(wt) / u
        if p.is_file() and p.stat().st_size < 512_000:
            try:
                content = p.read_text(errors="ignore")
            except OSError:
                continue
            hits += [f"{u}:{h}" for h in secret_hits_in(
                "\n".join("+" + l for l in content.splitlines()))]

    issue = issue_from_branch(branch)
    parent = None
    if issue:
        p = run([sys.executable, str(Path(__file__).parent / "board-sync.py"), "parent-of", issue])
        parent = p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else "unknown"

    pr = {}
    p = run(["gh", "pr", "view", branch, "--json", "number,state,title,body"])
    if p.returncode == 0:
        d = json.loads(p.stdout)
        pr = {"number": d["number"], "state": d["state"], "title": d["title"],
              "has_retro_line": bool(RETRO_LINE_RE.search(d.get("body") or "")),
              "body": d.get("body") or ""}

    return {
        "wt": wt, "branch": branch, "main_tree": main_tree,
        "issue": issue, "parent": parent,
        "dirty": bool(porcelain.strip()), "dirty_files": porcelain.splitlines(),
        "env_files": env_paths(porcelain),
        "secret_hits": hits,
        "drift": {"wellformed": wellformed, "malformed": malformed,
                  "log_present": annahmen_path.is_file()},
        "existing_pr": pr or None,
        "profile": {"retro_values": profile.get("prMarkers", {}).get("retroValues", []),
                    "vor_bau": default_section,
                    "remote_sweep": bool(profile.get("wrapup", {}).get("remoteBranchSweep"))},
    }


def staged_paths(cwd: str | None = None) -> list[str]:
    """The paths the index holds against HEAD — one commit's exact subject."""
    return sorted(_zsplit(
        git(["diff", "--cached", "--name-only", "-z"], cwd=cwd, check=True).stdout
    ))


def cmd_commit(args) -> dict:
    cwd = os.getcwd()
    root = git(["rev-parse", "--show-toplevel"], check=True).stdout.strip()
    _, protected = branch_policy(root)
    symbolic = git(["symbolic-ref", "--quiet", "HEAD"], cwd=cwd)
    branch = symbolic.stdout.strip().removeprefix("refs/heads/") if symbolic.returncode == 0 else ""
    if not branch:
        raise Stop("commit", "detached HEAD — refusing to commit onto no branch",
                   f"{root}: attach a branch here (`git switch -c <branch>`), then re-run")
    if branch in protected:
        raise Stop("commit", f"on protected branch {branch} — refusing to commit")
    porcelain = git(["status", "--porcelain"], check=True).stdout
    if not porcelain.strip():
        return {"committed": False, "reason": "clean tree — nothing to commit"}
    envs = env_paths(porcelain)
    if envs:
        raise Stop("commit", ".env in the working tree — never commit", "\n".join(envs))
    # An index the caller already prepared is a decision, not a draft: this
    # commits exactly it. Staging the working tree is the fallback for an empty
    # index alone — a wholesale sweep would commit a different set than the
    # secret review upstream ever saw, which is how five screenshots and a
    # foreign session's trace files rode into a release commit.
    paths = staged_paths()
    prepared = bool(paths)
    if not prepared:
        git(["add", "-A"], check=True)
        paths = staged_paths()
    hits = secret_hits_in(git(["diff", "--cached"], check=True).stdout)
    if hits and not args.allow_matches:
        if not prepared:
            # Only what this step staged is unstaged again; the caller's own
            # index survives the refusal for them to review.
            git(["reset"])
        raise Stop("commit", "possible secrets in the staged diff — review; "
                   "false positive → re-run with --allow-matches, real secret → resolve first",
                   "\n".join(hits[:40]))
    p = git(["commit", "-m", args.message])
    if p.returncode != 0:
        # pre-commit hook (tsc/ESLint via core.hooksPath) failed — caller diagnoses
        # (many unrelated TS2307 in a node repo usually = stale worktree node_modules
        # → pnpm install --frozen-lockfile, then re-run; never --no-verify).
        raise Stop("commit", "git commit failed (pre-commit hook?)",
                   failed_process_detail(p, limit=3000))
    sha = git(["rev-parse", "HEAD"], check=True).stdout.strip()
    return {
        "committed": True,
        "sha": sha,
        "allowed_matches": bool(hits),
        "staged_from": "prepared-index" if prepared else "working-tree",
        "committed_paths": paths,
        "committed_path_count": len(paths),
    }


# ---------- Content route (durable content, no worktree) ----------
#
# A planning session has no worktree and no slice. What it produced — an ADR, a
# glossary update, a research note — sits dirty in the main checkout on the
# protected branch, and this is its landing door. Inference proposes; the user's
# explicit, hash-carrying claim decides; every claimed path is re-read
# immediately before staging; everything else in that tree is a bystander and
# comes out untouched. There is no teardown half here: the route lands and
# stops. It is invoked, never chained — no other route falls back into it.

CONTENT_CLAIM_STEP = "content claim"
CONTENT_STEP = "content commit"
CONTENT_RETURN_STEP = "content return"
CONTENT_CANDIDATE_LIMIT = 200
CONTENT_TOP_DIRECTORY_LIMIT = 5


class Claimed(NamedTuple):
    """One path with the blob identity it carried when it was read."""

    path: str
    oid: str
    mode: str

    def as_record(self) -> dict:
        return {"path": self.path, "oid": self.oid, "mode": self.mode}


def content_context(step: str) -> tuple[str, str, tuple[str, ...]]:
    """The route's three preconditions, each a named refusal.

    It lands what a planning session left in the main checkout, so a worktree
    and an unprotected branch both belong to the ordinary route, and a detached
    or unborn HEAD is a state no landing can repair for you.
    """
    main_tree, _ = worktree_map()
    here = git(["rev-parse", "--show-toplevel"], check=True).stdout.strip()
    if os.path.realpath(here) != os.path.realpath(main_tree):
        raise Stop(
            step, "the Content route lands from the main checkout",
            f"cwd={here} is a worktree — a slice lands through preflight/commit/land",
        )
    branch = require_landable_head(step, here)
    _, protected = branch_policy(main_tree)
    if branch not in protected:
        raise Stop(
            step, f"{branch} is not a protected branch",
            "the Content route lands what a planning session left on the protected "
            "branch; this branch lands through the ordinary route",
        )
    return main_tree, branch, protected


def _zsplit(payload: str) -> list[str]:
    return [part for part in payload.split("\0") if part]


def content_sources(main_checkout: str, step: str) -> tuple[list[str], list[str]]:
    """Split the dirty tree into claimable paths and named unclaimable ones.

    Teardown classification lives in worktree-lifecycle/classify.py and stays
    there. This asks a different question — what durable content is dirty — and
    reads the two plumbing lists that answer it directly, so the kit keeps
    exactly one porcelain-status parser and this is not a second one.
    """
    paths, unclaimable = [], []
    fields = iter(_zsplit(
        git(["diff", "--name-status", "-z", "HEAD"], cwd=main_checkout, check=True).stdout
    ))
    for letter in fields:
        path = next(fields, "")
        if not path:
            raise Stop(step, "malformed git diff record", letter)
        if letter[:1] in {"R", "C"}:
            renamed = next(fields, "")
            unclaimable.append(
                f"{path} → {renamed} — a staged rename lands through the ordinary route"
            )
        elif letter[:1] == "D":
            unclaimable.append(f"{path} — a deletion is not durable content this route lands")
        else:
            paths.append(path)
    paths.extend(_zsplit(
        git(["ls-files", "--others", "--exclude-standard", "-z"],
            cwd=main_checkout, check=True).stdout
    ))
    return paths, unclaimable


def content_oid(main_checkout: str, path: str, *, write: bool = False) -> str:
    """The blob OID git itself would record for this path, filters included."""
    args = ["hash-object", *(["-w"] if write else []), "--", path]
    result = git(args, cwd=main_checkout)
    return result.stdout.strip() if result.returncode == 0 else ""


def _blob_mode(metadata) -> str:
    return "100755" if metadata.st_mode & 0o111 else "100644"


def _content_candidate(main_checkout: str, path: str) -> tuple[Claimed | None, str]:
    """Judge one dirty path: a claimable candidate, or the reason it is not."""
    if ENV_PATH_RE.search(path):
        return None, "a .env* file never lands through any route"
    try:
        metadata = os.lstat(Path(main_checkout) / path)
    except OSError as error:
        return None, f"cannot be read ({error.strerror})"
    if stat.S_ISLNK(metadata.st_mode):
        return None, "a symlink is not durable content this route lands"
    if not stat.S_ISREG(metadata.st_mode):
        return None, "not a regular file"
    oid = content_oid(main_checkout, path)
    if not oid:
        return None, "git cannot hash it"
    return Claimed(path, oid, _blob_mode(metadata)), ""


def _content_summary(paths: list[str]) -> str:
    """Bounded: the count plus the top directories, never a path dump."""
    counts = Counter(str(PurePosixPath(path).parent) for path in paths)
    top = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
    listed = ", ".join(
        f"{'./' if name == '.' else name + '/'} ({count} files)"
        for name, count in top[:CONTENT_TOP_DIRECTORY_LIMIT]
    )
    return (
        f"{len(paths)} dirty paths in {len(counts)} directories: {listed} — ignore or "
        "remove the bulk, then run the claim again"
    )


def content_candidates(main_checkout: str, step: str) -> tuple[list[Claimed], list[str]]:
    """Infer the durable content a session left dirty. Inference only proposes."""
    paths, unclaimable = content_sources(main_checkout, step)
    if len(paths) > CONTENT_CANDIDATE_LIMIT:
        raise Stop(
            step, "the dirty tree is too large to infer durable content from",
            _content_summary(paths),
        )
    candidates = []
    for path in sorted(paths):
        entry, problem = _content_candidate(main_checkout, path)
        if entry is None:
            unclaimable.append(f"{path} — {problem}")
        else:
            candidates.append(entry)
    return candidates, sorted(unclaimable)


def load_claim(path: str) -> list[Claimed]:
    """Read the confirmed claim: concrete paths, each with the hash it carried.

    The recorded hash is what makes the claim verifiable, so a record without
    one is a refusal — re-hashing at staging time would confirm nothing. A
    record's `mode` travels for a lossless round-trip of the claim report and
    is never the identity: content is, and the file lands with the mode it has.
    """
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise Stop(CONTENT_STEP, "the claim file cannot be read", str(error)) from error
    records = document.get("claimed") if isinstance(document, dict) else document
    if not isinstance(records, list) or not records:
        raise Stop(CONTENT_STEP, "the claim names no path",
                   'expected {"claimed": [{"path": ..., "oid": ...}, ...]}')
    claim = []
    for record in records:
        path_value = record.get("path") if isinstance(record, dict) else None
        oid_value = record.get("oid") if isinstance(record, dict) else None
        if not isinstance(path_value, str) or not isinstance(oid_value, str) or not oid_value:
            raise Stop(
                CONTENT_STEP, "every claimed path needs the hash it was claimed with",
                json.dumps(record, ensure_ascii=False)[:200],
            )
        claim.append(Claimed(path_value, oid_value, str(record.get("mode") or "")))
    return claim


def _is_ignored(main_checkout: str, path: str) -> bool:
    """Git's own exclude sources decide what is Scratch."""
    return git(["check-ignore", "-q", "--", path], cwd=main_checkout).returncode == 0


def verify_claim(main_checkout: str, claim: list[Claimed], candidates: list[Claimed]):
    """Match the claim against the tree as it is right now.

    A hard block stops the whole route. A path whose content moved since the
    claim is dropped and named instead — a claim confirms exactly what the user
    read, so a changed file was never confirmed, and the rest still lands.
    """
    inferred = {entry.path: entry for entry in candidates}
    survivors, dropped, seen = [], [], set()
    for entry in claim:
        if ENV_PATH_RE.search(entry.path):
            raise Stop(CONTENT_STEP, "a .env* path was claimed — never commit one",
                       entry.path)
        if entry.path in seen:
            continue
        seen.add(entry.path)
        current = inferred.get(entry.path)
        if current is None:
            if _is_ignored(main_checkout, entry.path):
                raise Stop(
                    CONTENT_STEP,
                    "an ignored path was claimed — ignored content is scratch, never "
                    "durable content",
                    entry.path,
                )
            dropped.append(f"{entry.path} — no longer dirty durable content here")
        elif current.oid != entry.oid:
            dropped.append(
                f"{entry.path} — changed between the claim and staging "
                f"({entry.oid[:7]} → {current.oid[:7]})"
            )
        else:
            survivors.append(current)
    if not survivors:
        raise Stop(CONTENT_STEP, "nothing left to land — every claimed path dropped",
                   "\n".join(dropped))
    return survivors, dropped


def stage_content(main_checkout: str, claimed: list[Claimed]) -> str:
    """Write exactly the claimed paths into a private index; return the tree.

    Neither the repository index nor the working tree is touched here: the index
    is a throwaway file seeded from HEAD, and each entry is written by the blob
    OID the claim was verified against. No pathspec walk exists to widen, so
    `git add -A`, `git add .` and `git commit -a` are unreachable from this
    route rather than merely unused.
    """
    with tempfile.TemporaryDirectory() as scratch:
        environment = dict(os.environ, GIT_INDEX_FILE=str(Path(scratch) / "index"))
        git(["read-tree", "HEAD"], cwd=main_checkout, check=True, env=environment)
        for entry in claimed:
            written = content_oid(main_checkout, entry.path, write=True)
            if written != entry.oid:
                raise Stop(
                    CONTENT_STEP, f"{entry.path} changed while it was being staged",
                    f"{entry.oid[:7]} → {written[:7] or 'unreadable'}; run the claim again",
                )
            git(["update-index", "--add", "--cacheinfo",
                 f"{entry.mode},{entry.oid},{entry.path}"],
                cwd=main_checkout, check=True, env=environment)
        return git(["write-tree"], cwd=main_checkout, check=True,
                   env=environment).stdout.strip()


def verify_staged_tree(main_checkout: str, tree: str, claimed: list[Claimed]) -> None:
    """Assert the staged tree carries exactly the claim — by name and by OID."""
    changed = sorted(_zsplit(
        git(["diff-tree", "-r", "--name-only", "-z", "HEAD", tree],
            cwd=main_checkout, check=True).stdout
    ))
    expected = sorted(entry.path for entry in claimed)
    if changed != expected:
        raise Stop(CONTENT_STEP, "the staged tree is not exactly the claim",
                   f"staged {changed} against the claim {expected}")
    for entry in claimed:
        listed = git(["ls-tree", "--full-name", tree, "--", entry.path],
                     cwd=main_checkout, check=True).stdout.split()
        if listed[:3] != [entry.mode, "blob", entry.oid]:
            raise Stop(CONTENT_STEP, f"{entry.path} is staged as a different object",
                       " ".join(listed[:3]) or "absent from the staged tree")


def content_secret_gate(main_checkout: str, tree: str, allow_matches: bool) -> list[str]:
    """The ordinary secret scan, run on exactly the diff this route will commit."""
    patch = git(["diff-tree", "-p", "HEAD", tree], cwd=main_checkout, check=True).stdout
    hits = secret_hits_in(patch)
    if hits and not allow_matches:
        raise Stop(
            CONTENT_STEP,
            "possible secrets in the claimed content — review; false positive → re-run "
            "with --allow-matches, real secret → resolve first",
            "\n".join(hits[:40]),
        )
    return hits


def content_branch_name(main_checkout: str, slug: str, branch_type: str) -> str:
    """Render the issue-less branch from the profile's content template."""
    module = load_lifecycle_profile_module()
    template = (lifecycle_settings(main_checkout).get("contentBranchTemplate")
                or module.DEFAULT_CONTENT_BRANCH_TEMPLATE)
    try:
        branch = module.render_content_branch(template, slug, branch_type)
    except module.LifecycleError as error:
        raise Stop(CONTENT_STEP, "the content branch template cannot be rendered",
                   str(error)) from error
    if git(["check-ref-format", "--branch", branch], cwd=main_checkout).returncode != 0:
        raise Stop(CONTENT_STEP, f"{branch} is not a valid branch name",
                   "choose another slug or branch type")
    return branch


def check_content_collision(main_checkout: str, branch: str) -> list[str]:
    """A branch that exists anywhere is a collision — never reuse, never overwrite."""
    advice = "the Content route never reuses or overwrites a branch — choose another slug"
    if branch_tip(main_checkout, branch):
        raise Stop(CONTENT_STEP, f"branch {branch} already exists locally", advice)
    listed = git(["ls-remote", "--heads", "origin", branch], cwd=main_checkout)
    if listed.returncode != 0:
        return [
            f"the remote could not be queried, so the collision check for {branch} was "
            f"local only: {sanitize_external_detail(listed.stderr or listed.stdout)}"
        ]
    if listed.stdout.strip():
        raise Stop(CONTENT_STEP, f"branch {branch} already exists on the remote", advice)
    return []


def cut_content_branch(main_checkout: str, branch: str, tree: str, message: str,
                       claimed: list[Claimed]) -> str:
    """Cut the branch onto the verified tree, refreshing only the claimed paths."""
    paths = [entry.path for entry in claimed]
    parent = git(["rev-parse", "HEAD"], cwd=main_checkout, check=True).stdout.strip()
    commit = git(["commit-tree", tree, "-p", parent, "-m", message],
                 cwd=main_checkout, check=True).stdout.strip()
    git(["switch", "-c", branch], cwd=main_checkout, check=True)
    git(["update-ref", "-m", f"make-landable content claim: {branch}", "HEAD", commit, parent],
        cwd=main_checkout, check=True)
    git(["reset", "-q", "HEAD", "--", *paths], cwd=main_checkout, check=True)
    if git(["rev-parse", "HEAD"], cwd=main_checkout, check=True).stdout.strip() != commit:
        raise Stop(CONTENT_STEP, f"{branch} does not carry the verified commit", commit)
    if git(["diff", "--quiet", "HEAD", "--", *paths], cwd=main_checkout).returncode != 0:
        raise Stop(CONTENT_STEP, "the claimed paths are still dirty after the commit",
                   f"{branch} at {commit[:7]} — inspect before running the claim again")
    return commit


def return_to_protected(main_checkout: str, protected_branch: str, branch: str,
                        commit: str) -> str:
    """Return the checkout to the protected branch, or stop naming the blocker."""
    result = git(["switch", protected_branch], cwd=main_checkout)
    if result.returncode != 0:
        raise Stop(
            CONTENT_RETURN_STEP,
            f"cannot return the main checkout to {protected_branch} — nothing was "
            "forced and nothing was stashed",
            f"the content is safe on {branch} at {commit[:7]}, and the main checkout is "
            f"still on {branch}: " + (result.stderr or result.stdout).strip()[-1000:],
        )
    return protected_branch


def content_pr_reference(anchor: str | None, body_file: str | None):
    """`Part of` the anchor — a planning session's content never closes one."""
    warnings: list[str] = []
    if body_file:
        try:
            body = Path(body_file).read_text(encoding="utf-8")
        except OSError as error:
            raise Stop(CONTENT_STEP, "the PR body file cannot be read", str(error)) from error
        targets = declared_close_targets(body)
        if targets:
            raise Stop(
                CONTENT_STEP,
                "the PR body declares a close keyword — a planning session's content "
                "never closes its anchor",
                "declared: " + ", ".join(f"#{target}" for target in targets),
            )
    if not anchor:
        return None, warnings
    marker = (load_profile().get("prMarkers") or {}).get("partOf")
    if not marker:
        warnings.append("the board profile names no partOf marker, so no anchor "
                        "reference was rendered")
        return None, warnings
    return f"{marker} #{anchor}", warnings


def cmd_content_claim(args) -> dict:
    """Read-only: propose the durable content, each path with its hash."""
    main_checkout, branch, _ = content_context(CONTENT_CLAIM_STEP)
    candidates, unclaimable = content_candidates(main_checkout, CONTENT_CLAIM_STEP)
    return {
        "main_checkout": main_checkout,
        "branch": branch,
        "candidates": [entry.as_record() for entry in candidates],
        "unclaimable": unclaimable,
        "next": "confirm the durable paths with the user, then run content-commit "
                "--claim-file with exactly those records",
    }


def cmd_content_commit(args) -> dict:
    """Land the confirmed claim: verify, cut, commit, return. No teardown half."""
    main_checkout, protected_branch, _ = content_context(CONTENT_STEP)
    claim = load_claim(args.claim_file)
    candidates, _ = content_candidates(main_checkout, CONTENT_STEP)
    claimed, dropped = verify_claim(main_checkout, claim, candidates)
    tree = stage_content(main_checkout, claimed)
    verify_staged_tree(main_checkout, tree, claimed)
    hits = content_secret_gate(main_checkout, tree, args.allow_matches)
    reference, warnings = content_pr_reference(args.anchor, args.body_file)
    branch = content_branch_name(main_checkout, args.slug, args.type)
    warnings += check_content_collision(main_checkout, branch)
    commit = cut_content_branch(main_checkout, branch, tree, args.message, claimed)
    returned = return_to_protected(main_checkout, protected_branch, branch, commit)
    return {
        "branch": branch,
        "commit": commit,
        "returned_to": returned,
        "claimed": [entry.path for entry in claimed],
        "dropped": dropped,
        "allowed_matches": bool(hits),
        "pr_reference": reference,
        "warnings": warnings,
        "next": f"open and merge the PR with `land --branch {branch}` — it finds no "
                "worktree and tears nothing down",
    }


# ---------- branch deletion authority ----------

BRANCH_PR_RECORD = "pr-record"
BRANCH_ANCESTRY = "ancestry"
BRANCH_RETAINED = "retained"


class BranchAuthority(NamedTuple):
    """What this repository and the platform allow for exactly this branch tip."""

    branch: str
    decision: str
    tip: str
    reason: str
    pr: str | None = None
    degraded: bool = False

    def as_report(self) -> dict:
        return {
            "decision": self.decision,
            "pr": self.pr,
            "tip": self.tip,
            "reason": self.reason,
            "degraded": self.degraded,
        }


def branch_tip(main_tree: str, branch: str) -> str:
    """The branch's current tip OID, or "" when the branch does not exist."""
    result = git(
        ["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}"],
        cwd=main_tree,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def refresh_integration_branch(main_tree: str, integration: str) -> str:
    """Fetch the configured branch: a stale remote-tracking ref makes ancestry lie.

    Ancestry is read against a *freshly fetched* protected branch, and a fetch
    that fails stops rather than guesses.
    """
    tracking = f"refs/remotes/origin/{integration}"
    result = git(
        ["fetch", "origin", f"+refs/heads/{integration}:{tracking}"], cwd=main_tree
    )
    if result.returncode != 0:
        raise Stop(
            "5 branch-authority",
            f"cannot fetch {integration} — a stale ancestry check stops rather than guesses",
            (result.stderr or result.stdout).strip()[-1000:],
        )
    return tracking


def platform_json(command_runner, command: list[str]):
    """Read one read-only platform command's JSON; (None, why) when it cannot be."""
    try:
        result = command_runner(command)
    except OSError as error:  # the platform CLI is not installed at all
        return None, sanitize_external_detail(str(error))
    if result.returncode != 0:
        return None, sanitize_external_detail(result.stderr or result.stdout)
    try:
        return json.loads(result.stdout), ""
    except json.JSONDecodeError as error:
        return None, sanitize_external_detail(str(error))


def platform_repository(command_runner) -> tuple[str, str]:
    payload, error = platform_json(
        command_runner, ["gh", "repo", "view", "--json", "nameWithOwner"]
    )
    name = payload.get("nameWithOwner") if isinstance(payload, dict) else None
    if not isinstance(name, str) or "/" not in name:
        return "", error or "the platform did not name this repository"
    return name, ""


def head_pull_requests(repository: str, branch: str, command_runner):
    """Every pull request ever opened from this head ref, in any state.

    The historical query survives deleting the branch on the remote *and*
    locally, which is exactly the moment a landing needs it — measured against
    this platform, not assumed.
    """
    owner = repository.split("/", 1)[0]
    head = quote(f"{owner}:{branch}", safe=":")
    path = f"repos/{repository}/pulls?state=all&head={head}&per_page=100"
    records, error = platform_json(command_runner, ["gh", "api", path])
    if not isinstance(records, list):
        return None, error or "the platform returned no pull request list"
    return records, ""


def pull_request_by_number(repository: str, number: str, command_runner):
    """The one pull request `--pr` names — selected for the check, not exempt."""
    record, error = platform_json(
        command_runner, ["gh", "api", f"repos/{repository}/pulls/{quote(number, safe='')}"]
    )
    if not isinstance(record, dict):
        return None, error or f"pull request #{number} cannot be read"
    return record, ""


def _full_name(node) -> str:
    return str(node.get("full_name") or "") if isinstance(node, dict) else ""


def is_merged_record(record: dict) -> bool:
    """Merged state is `merged_at`, never `merged`.

    The list endpoint sends `merged: null` even for a genuinely merged pull
    request — measured on a live merged pull request — so reading `merged`
    there would classify every merged PR as unmerged and silently retain
    every branch.
    """
    return bool(record.get("merged_at"))


def matches_pr_tuple(record: dict, *, repository, branch, integration, tip) -> bool:
    """The full pull-request tuple — the head SHA carries the uniqueness.

    A reused head ref resolves to several pull requests, so the ref never
    establishes uniqueness on its own.
    """
    head = record.get("head") or {}
    base = record.get("base") or {}
    return (
        _full_name(base.get("repo")) == repository
        and _full_name(head.get("repo")) == repository
        and str(head.get("ref") or "") == branch
        and str(base.get("ref") or "") == integration
        and is_merged_record(record)
        and str(head.get("sha") or "") == tip
    )


def open_pull_requests_on_head(records, *, repository: str, branch: str) -> list:
    open_prs = []
    for record in records:
        head = record.get("head") or {}
        if (
            str(record.get("state") or "").lower() == "open"
            and str(head.get("ref") or "") == branch
            and _full_name(head.get("repo")) == repository
        ):
            open_prs.append(record)
    return open_prs


def _pr_numbers(records) -> str:
    return ", ".join(f"#{record.get('number')}" for record in records)


def _ancestry_only(branch: str, tip: str, integration: str, error: str) -> BranchAuthority:
    """Honest degradation: say that the platform was unreachable, never imply it agreed."""
    detail = f" ({error})" if error else ""
    return BranchAuthority(
        branch,
        BRANCH_RETAINED,
        tip,
        f"no platform access, so authority degrades to ancestry only — and {branch} "
        f"is not merged into {integration}{detail}",
        degraded=True,
    )


def authorize_branch_deletion(
    main_tree: str,
    branch: str,
    *,
    integration: str,
    pr: str | None = None,
    command_runner=None,
) -> BranchAuthority:
    """Decide what this branch's own state and the platform record allow.

    Ancestry against the freshly fetched integration branch deletes normally.
    Otherwise exactly one pull request matching the full tuple — this
    repository as base repo, the head repository equal to it, this head ref,
    the configured base ref, merged, head SHA equal to the branch tip —
    authorizes force deletion. Zero matches, several matches, an open pull
    request on the same head, or no platform access keep the branch.
    """
    command_runner = run if command_runner is None else command_runner
    tracking = refresh_integration_branch(main_tree, integration)
    tip = branch_tip(main_tree, branch)
    if not tip:
        return BranchAuthority(
            branch, BRANCH_RETAINED, "", "the local branch is already absent"
        )
    if git(["merge-base", "--is-ancestor", tip, tracking], cwd=main_tree).returncode == 0:
        return BranchAuthority(
            branch, BRANCH_ANCESTRY, tip,
            f"merged into the freshly fetched {integration}",
        )
    repository, error = platform_repository(command_runner)
    if not repository:
        return _ancestry_only(branch, tip, integration, error)
    records, error = head_pull_requests(repository, branch, command_runner)
    if records is None:
        return _ancestry_only(branch, tip, integration, error)
    open_prs = open_pull_requests_on_head(records, repository=repository, branch=branch)
    if open_prs:
        return BranchAuthority(
            branch, BRANCH_RETAINED, tip,
            f"an open pull request shares this head: {_pr_numbers(open_prs)}",
        )
    if pr is not None:
        record, error = pull_request_by_number(repository, pr, command_runner)
        if record is None:
            return BranchAuthority(branch, BRANCH_RETAINED, tip, error)
        records = [record]
    matching = [
        record for record in records
        if matches_pr_tuple(
            record, repository=repository, branch=branch,
            integration=integration, tip=tip,
        )
    ]
    if len(matching) == 1:
        return BranchAuthority(
            branch, BRANCH_PR_RECORD, tip,
            f"merged pull request #{matching[0].get('number')} matches this tip",
            pr=str(matching[0].get("number")),
        )
    if not matching:
        return BranchAuthority(
            branch, BRANCH_RETAINED, tip,
            f"no merged pull request in {repository} matches this branch tip "
            f"{tip[:7]} on {branch}",
        )
    return BranchAuthority(
        branch, BRANCH_RETAINED, tip,
        f"several merged pull requests match this tip ({_pr_numbers(matching)}) — "
        "ambiguous; name the one that authorizes deletion with --pr <number>",
    )


def delete_authorized_branch(main_tree: str, authority: BranchAuthority) -> tuple[bool, str]:
    """Delete exactly what the authority cleared, re-reading the tip last.

    The window between reading the platform record and deleting the branch is
    the whole point of the re-read: a tip that moved inside it keeps the branch.
    Ancestry deletes with git's own `-d` safety semantics; only the PR record
    authorizes the force flag.
    """
    if authority.decision == BRANCH_RETAINED:
        return False, authority.reason
    current = branch_tip(main_tree, authority.branch)
    if current != authority.tip:
        return False, (
            "the branch tip moved between authorization and deletion "
            f"({authority.tip[:7]} → {current[:7] or 'absent'})"
        )
    forced = authority.decision == BRANCH_PR_RECORD
    result = git(["branch", "-D" if forced else "-d", authority.branch], cwd=main_tree)
    if result.returncode != 0:
        return False, (result.stderr or result.stdout).strip()[:200]
    return True, authority.reason


def retire_local_branch(
    branch: str,
    main_tree: str,
    integration: str,
    report: dict,
    *,
    pr: str | None = None,
) -> None:
    """Fast-forward the integration branch, then retire the branch its authority
    clears. Already absent is a completed step, not a failure."""
    git(["fetch", "origin", "--prune"], cwd=main_tree)
    git(["checkout", integration], cwd=main_tree)
    p = git(["pull", "--ff-only"], cwd=main_tree)
    if p.returncode != 0:
        raise Stop("5 integration-ff",
                   f"no fast-forward possible — a diverged {integration} is an anomaly",
                   failed_process_detail(p, limit=1000))
    if not branch_tip(main_tree, branch):
        report["branch_retired"] = "already absent"
        report["skipped"].append("branch retire: local branch already absent")
        return
    if branch in worktree_map(main_tree)[1]:
        report["branch_retired"] = "refused: still checked out"
        report["warnings"].append(
            f"branch retire refused: {branch} is still checked out"
        )
        return
    authority = authorize_branch_deletion(
        main_tree, branch, integration=integration, pr=pr
    )
    report["branch_authority"] = authority.as_report()
    deleted, detail = delete_authorized_branch(main_tree, authority)
    report["branch_retired"] = deleted
    if not deleted:
        report["warnings"].append(f"branch {branch} retained: {detail}")


def pull_request_snapshot(branch: str) -> dict | None:
    """Read the platform's PR record — the resume authority for a re-run.

    There is no persisted attempt state. Whether the push, the PR
    and the merge already happened is answered by looking, every single time.
    """
    p = run(["gh", "pr", "view", branch, "--json", "number,state,body"])
    if p.returncode != 0:
        return None
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError as error:
        raise Stop("0c pr", "invalid PR response", str(error)) from error


def remote_branch_tip(main_tree: str, branch: str) -> str:
    result = git(["ls-remote", "--heads", "origin", branch], cwd=main_tree)
    if result.returncode != 0 or not result.stdout.strip():
        return ""
    return result.stdout.split()[0]


# ---------- census freshness (session-end finding, never a gate) ----------

def census_status(checkout: str) -> dict:
    """Read ONE named checkout's census freshness verdict, read-only.

    A census describes the tree it was scanned in, and the drift guard resolves
    its census root from the working directory it is called in. The checkout is
    therefore named here rather than inherited: the verdict that matters at
    session end belongs to the tree the next session starts from, and a
    worktree-green verdict must never stand in for it.

    A checkout without the hook, or without a census, answers `no_census` — the
    kit's ordinary silent degradation. Only an unreadable answer is
    `unavailable`, which the caller reports without ever acting on it.
    """
    hook = Path(checkout) / CENSUS_HOOK
    if not hook.is_file():
        return {"state": CENSUS_ABSENT, "reasons": []}
    completed = run([sys.executable, str(hook), "--census-status"], cwd=checkout)
    if completed.returncode != 0:
        return {"state": CENSUS_UNREADABLE,
                "reasons": [(completed.stderr or completed.stdout).strip()[-300:]]}
    try:
        verdict = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        return {"state": CENSUS_UNREADABLE, "reasons": [str(error)]}
    if not isinstance(verdict, dict):
        return {"state": CENSUS_UNREADABLE, "reasons": ["verdict is not an object"]}
    return verdict


def render_census_finding(verdict: dict, checkout: str) -> str:
    """State the verdict, its cause, the checkout it describes, and the route out."""
    reasons = ", ".join(str(reason) for reason in verdict.get("reasons") or [])
    lines = [
        f"CENSUS — session-end finding ({verdict.get('state')}):",
        f"  · {reasons or 'the activated census is stale'}",
        f"  · evaluated checkout: {checkout}",
        f"    ({CENSUS_CHECKOUT_NOTE})",
        f"  · recovery: {CENSUS_RECOVERY}",
        f"  · {CENSUS_NOT_A_GATE}",
    ]
    if verdict.get("override_applied"):
        lines.append(f"  · {CENSUS_OVERRIDE_NOTE}")
    return "\n".join(lines)


def census_tracking_issues(main_tree: str) -> tuple[list[int], str]:
    """Every OPEN issue carrying the tracking marker, plus a lookup error.

    Identity is the marker, never the title. Closed issues are history: a
    refresh that was already resolved must not wedge the next one out of a
    tracker of its own.
    """
    listed = run(["gh", "issue", "list", "--state", "open",
                  "--limit", str(CENSUS_ISSUE_LIMIT), "--json", "number,body"],
                 cwd=main_tree)
    if listed.returncode != 0:
        return [], (listed.stderr or listed.stdout).strip()[-500:]
    try:
        payload = json.loads(listed.stdout)
    except json.JSONDecodeError as error:
        return [], f"unreadable issue list: {error}"
    if not isinstance(payload, list):
        return [], "unreadable issue list: not an array"
    return [
        int(issue["number"]) for issue in payload
        if marker_value(issue.get("body") or "", CENSUS_TRACKING_KIND)
        == CENSUS_TRACKING_SLUG
    ], ""


def track_census_finding(main_tree: str, finding: str) -> dict:
    """Open or refresh the one tracking issue so the finding outlives the session.

    Idempotent by identity: no open match creates one through the board command,
    exactly one match is rewritten with the current verdict, and several matches
    write nothing and name them — guessing which one is the tracker is how a
    duplicate becomes permanent.
    """
    numbers, error = census_tracking_issues(main_tree)
    if error:
        return {"action": "none", "issue": None, "ok": False, "error": error}
    if len(numbers) > 1:
        named = ", ".join(f"#{number}" for number in numbers)
        return {"action": "none", "issue": None, "ok": False,
                "error": f"several open issues carry the tracking marker: {named}"}
    body = (f"<!-- {CENSUS_TRACKING_KIND}: {CENSUS_TRACKING_SLUG} -->\n\n"
            f"{finding}\n")
    with tempfile.NamedTemporaryFile(
        "w", suffix=".md", delete=False, encoding="utf-8"
    ) as handle:
        handle.write(body)
        body_file = handle.name
    try:
        if numbers:
            written = run(["gh", "issue", "edit", str(numbers[0]),
                           "--body-file", body_file], cwd=main_tree)
            return _census_tracking_result("updated", numbers[0], written)
        created = run([sys.executable, str(Path(__file__).parent / "board-sync.py"),
                       "create", "--title", CENSUS_TRACKING_TITLE,
                       "--body-file", body_file], cwd=main_tree)
        return _census_tracking_result(
            "created", _created_issue_number(created.stdout), created)
    finally:
        Path(body_file).unlink(missing_ok=True)


def _census_tracking_result(action: str, issue, completed) -> dict:
    ok = completed.returncode == 0
    return {
        "action": action if ok else "none",
        "issue": issue,
        "ok": ok,
        "error": None if ok else (completed.stderr or completed.stdout).strip()[-500:],
    }


def _created_issue_number(stdout: str):
    """Read the number back out of the board command's own `#<n> <url>` line."""
    for line in stdout.splitlines():
        head = line.strip().split(" ", 1)[0]
        if head.startswith("#") and head[1:].isdigit():
            return int(head[1:])
    return None


def census_step(main_tree: str, profile: dict, report: dict) -> None:
    """Give the freshness verdict a home at session end.

    `current` and `no_census` leave no trace at all — the same silent
    degradation the rest of the kit practises. Only `refresh_required` speaks,
    and it speaks as a finding: the landing has already happened and topology
    drift is repo-wide, so blocking here would punish an unrelated change.
    """
    verdict = census_status(main_tree)
    state = verdict.get("state")
    if state == CENSUS_UNREADABLE:
        detail = "; ".join(str(reason) for reason in verdict.get("reasons") or [])
        report["warnings"].append(
            f"census status unreadable for {main_tree}: {detail}")
        return
    if state != CENSUS_STALE:
        return
    finding = {
        "state": state,
        "evaluated_checkout": main_tree,
        "reasons": list(verdict.get("reasons") or []),
        "blocking": False,
        "finding": render_census_finding(verdict, main_tree),
    }
    report["census"] = finding
    if profile.get("wrapup", {}).get("censusTrackingIssue"):
        finding["tracking"] = track_census_finding(main_tree, finding["finding"])


def cmd_land(args) -> dict:
    report: dict = {"stops": [], "warnings": [], "skipped": []}
    main_tree, branches = worktree_map()
    here = os.path.realpath(os.getcwd())
    if here != os.path.realpath(main_tree):
        raise Stop("land", "run `land` from the main tree",
                   f"cwd={here} main={main_tree} — the in-worktree shell would survive "
                   "teardown and the process-kill step")
    branch = args.branch
    integration, protected = branch_policy(main_tree)
    if branch in protected:
        raise Stop("land", f"{branch} is a protected branch",
                   "/land lands a slice branch, never the integration branch")
    wt = branches.get(branch)
    wt_exists = wt is not None and Path(wt).is_dir()
    # Step 4's target is resolved here, before the merge and long before the
    # first deletion: a teardown a later step would refuse must refuse now,
    # while nothing has been removed yet.
    teardown = resolve_teardown_target(main_tree, wt)
    profile = load_profile()
    default_section = profile.get("headings", {}).get("vorBau", "Vor Bau zu klären")

    # drift markers from the build-time log — mechanical, no gate
    markers: list[dict] = []
    if wt_exists:
        require_landable_head("land", wt)
        if git(["status", "--porcelain"], cwd=wt, check=True).stdout.strip():
            raise Stop("land", "worktree dirty — run `commit` first", wt)
        annahmen = Path(wt) / "ANNAHMEN.md"
        if annahmen.is_file():
            markers, malformed = parse_annahmen(annahmen.read_text(), default_section)
            if malformed and not args.skip_malformed_drift:
                raise Stop("land", "malformed ANNAHMEN.md line(s) — no #<n> target; "
                           "fix the log or re-run with --skip-malformed-drift",
                           "\n".join(malformed))
    report["drift_markers"] = markers

    # Step 0c-a — read the PR record first: a merged PR means push, body and
    # merge are done, and this run resumes at teardown.
    snapshot = pull_request_snapshot(branch)
    already_merged = snapshot is not None and snapshot.get("state") == "MERGED"

    # Step 0b — push, unless the remote already carries this commit
    if wt_exists and already_merged:
        report["skipped"].append("push: the PR for this branch is already merged")
    elif wt_exists:
        local_tip = git(["rev-parse", "HEAD"], cwd=wt, check=True).stdout.strip()
        if remote_branch_tip(main_tree, branch) == local_tip:
            report["skipped"].append(f"push: origin/{branch} already at {local_tip[:7]}")
        else:
            p = git(["push", "-u", "origin", branch], cwd=wt)
            if p.returncode != 0:
                raise Stop("0b push", "push rejected",
                           failed_process_detail(p))

    # Step 0c — ensure PR + final body
    pr_body = ""
    if snapshot is not None:
        pr, pr_body = str(snapshot["number"]), snapshot.get("body") or ""
        report["pr_reused"] = True
    elif args.body_file:
        if not args.title:
            raise Stop("0c pr", "--title required to create a PR")
        run(["gh", "pr", "create", "--base", integration, "--head", branch,
             "--title", args.title, "--body-file", args.body_file], check=True)
        created = pull_request_snapshot(branch)
        if created is None:
            raise Stop("0c pr", "PR was created but cannot be read back")
        pr, pr_body = str(created["number"]), created.get("body") or ""
        report["pr_reused"] = False
    else:
        raise Stop("0c pr", "no open PR and no --body-file to create one")
    report["pr"] = pr

    if already_merged:
        report["skipped"].append("PR body + body-check: the PR is already merged")
    else:
        if args.body_file and report["pr_reused"]:
            pr_body = Path(args.body_file).read_text()
            final = merge_markers_into_body(pr_body, markers)
            tmp = Path(args.body_file).with_suffix(".final.md")
            tmp.write_text(final)
            run(["gh", "pr", "edit", pr, "--body-file", str(tmp)], check=True)
        elif markers:
            final = merge_markers_into_body(pr_body, markers)
            if final != pr_body:
                tmp = Path(f"/tmp/land-body-{pr}.md")
                tmp.write_text(final)
                run(["gh", "pr", "edit", pr, "--body-file", str(tmp)], check=True)

        # body-convention check: closes-vs-Part-of + E2E-exemption evidence
        p = run([sys.executable, str(Path(__file__).parent / "pr-body-check.py"),
                 "--branch", branch])
        report["body_check_exit"] = p.returncode
        if p.returncode == 1:
            raise Stop("0c body-check", "pr-body-check exit 1 — fix the body, never merge red",
                       (p.stdout + p.stderr).strip()[-2000:])
        if p.returncode == 2:
            report["warnings"].append("pr-body-check exit 2 (fail-open): "
                                      + (p.stdout + p.stderr).strip()[:300])

        # merge gate — wait boundedly for fresh-PR checks; already-MERGED resumes
        # directly at teardown. Progress stays on stderr so stdout remains one JSON.
        already_merged = wait_for_merge_gate(pr)

    # Step 1 — merge (= prod deploy; authorization = the user's /land invocation).
    # PR state is the authority, not gh's exit code: `--delete-branch` also tries
    # to delete the LOCAL branch, which fails while a worktree holds it — the
    # remote merge is through anyway (dogfood run PR).
    merge_err = ""
    if already_merged:
        report["skipped"].append("merge: the PR is already MERGED")
    else:
        p = run(["gh", "pr", "merge", pr, "--merge", "--delete-branch"], cwd=main_tree)
        if p.returncode != 0:
            merge_err = failed_process_detail(p)
    state = json.loads(run(["gh", "pr", "view", pr, "--json", "state"],
                           check=True).stdout)["state"]
    if state != "MERGED":
        raise Stop("1 merge", f"PR state after merge is {state}, not MERGED — aborting teardown",
                   merge_err)
    if merge_err:
        report["warnings"].append(f"gh pr merge exited non-zero but PR is MERGED: {merge_err[:300]}")
    report["merged"] = True

    # Step 2 — quiesce this worktree's own dev servers, then Step 4 — teardown.
    # Teardown runs on the target resolved above and on nothing else: a direct
    # /land invocation is its authorization, and the classifier's four rules
    # are the only protection once it does run.
    if teardown.worktree is None:
        report["skipped"].append(teardown.reason)
    else:
        wt = teardown.worktree
        git(["fetch", "origin", integration], cwd=main_tree, check=True)
        report["killed_processes"] = kill_worktree_processes(wt)
        assessment = assess_teardown(wt, main_tree)
        rendered = teardown_report(assessment)
        report["teardown"] = {
            "assumptions_read": (Path(wt) / "ANNAHMEN.md").is_file(),
            "report": rendered,
        }
        if not assessment.removable:
            raise Stop("4 teardown", "teardown is blocked", rendered)
        report["scratch_removed"] = remove_teardown_scratch(assessment)
        p = git(["worktree", "remove", wt], cwd=main_tree)
        if p.returncode != 0:
            raise Stop("4 worktree-remove", "git worktree remove refused — no --force; "
                       "check for surviving processes (lsof/pgrep)",
                       failed_process_detail(p, limit=1000))
        git(["worktree", "prune"], cwd=main_tree)
        report["worktree_removed"] = wt

    # Step 5 — integration ff + branch retirement by authority (after the pull).
    # Retirement checks out the integration branch first, so when the main
    # working tree is the checkout holding this branch it would switch that
    # tree off the branch it is sitting on. The landing reports and stops here.
    if teardown.is_main_working_tree:
        retired = "refused: the main working tree has this branch checked out"
        report["branch_retired"] = retired
        report["skipped"].append(f"branch retire: {retired}")
    else:
        retire_local_branch(branch, main_tree, integration, report, pr=args.pr)

    # Step 5b — verify declared auto-closes (backtick-swallowed `closes`
    # misses). Targets come from the merged PR body's close keywords, never
    # from the branch number.
    issue = issue_from_branch(branch)
    p = run(["gh", "pr", "view", pr, "--json", "body"])
    merged_body = (json.loads(p.stdout).get("body") or "") if p.returncode == 0 else ""
    targets = declared_close_targets(merged_body)
    if not targets:
        report["issue_close"] = "no close targets declared — nothing to verify"
    else:
        states = []
        for t in targets:
            q = run(["gh", "issue", "view", t, "--json", "state"])
            if q.returncode == 0 and json.loads(q.stdout)["state"] == "OPEN":
                run(["gh", "issue", "close", t, "-c",
                     f"Merged via PR #{pr} — auto-close didn't fire; closed manually."])
                states.append(f"#{t} closed manually")
            elif q.returncode == 0:
                states.append(f"#{t} already closed")
        report["issue_close"] = " · ".join(states)

    # Step 5c — local merged-branch sweep (-d only: unreachable-from-integration is refused)
    swept = []
    p = git(["branch", "--merged", integration, "--format=%(refname:short)"], cwd=main_tree)
    for b in p.stdout.split():
        if b in protected or b == branch or not b:
            continue
        if git(["branch", "-d", b], cwd=main_tree).returncode == 0:
            swept.append(b)
    report["swept_local"] = swept

    # Step 5d — remote merged-PR sweep (opt-in via wrapup.remoteBranchSweep;
    # PR-status-authoritative, ls-remote not branch -r —)
    merged_heads = set(run(["gh", "pr", "list", "--state", "merged", "--limit", "1000",
                            "--json", "headRefName", "-q", ".[].headRefName"],
                           check=True).stdout.split())
    open_heads = set(run(["gh", "pr", "list", "--state", "open", "--limit", "1000",
                          "--json", "headRefName", "-q", ".[].headRefName"],
                         check=True).stdout.split())
    remote_heads = set()
    for line in git(["ls-remote", "--heads", "origin"], cwd=main_tree, check=True).stdout.splitlines():
        if "refs/heads/" in line:
            remote_heads.add(line.split("refs/heads/", 1)[1].strip())
    stale = stale_remote_set(merged_heads, remote_heads, open_heads, set(protected))
    if not profile.get("wrapup", {}).get("remoteBranchSweep"):
        report["swept_remote"] = {"enabled": False, "stale_count": len(stale)}
    elif stale:
        p = git(["push", "origin", "--delete", *stale], cwd=main_tree)
        git(["fetch", "origin", "--prune"], cwd=main_tree)
        report["swept_remote"] = {"enabled": True, "deleted": stale if p.returncode == 0 else [],
                                  "error": None if p.returncode == 0 else p.stderr.strip()[-500:]}
    else:
        report["swept_remote"] = {"enabled": True, "deleted": []}

    # Step 5e.1 — anchor tracker sync + completeness; 5e.3 land sanity.
    # The anchor is optional: a branch that carries no issue number lands
    # without one instead of being refused.
    anchor = args.anchor
    if not anchor and issue:
        p = run([sys.executable, str(Path(__file__).parent / "board-sync.py"),
                 "parent-of", issue])
        out = p.stdout.strip()
        anchor = out if p.returncode == 0 and out.isdigit() else None
    if not anchor:
        report["anchor_sync"] = {"anchor": None,
                                 "skipped": "branch carries no issue anchor"}
    else:
        bs = str(Path(__file__).parent / "board-sync.py")
        dry = run([sys.executable, bs, "anchor-sync", str(anchor), "--dry-run"])
        wet = run([sys.executable, bs, "anchor-sync", str(anchor)])
        report["anchor_sync"] = {
            "anchor": anchor, "ok": wet.returncode == 0,
            "diff": dry.stdout.strip()[-2000:],
            "error": None if wet.returncode == 0 else (wet.stderr or wet.stdout).strip()[-1000:],
        }
        p = run(["gh", "issue", "view", str(anchor), "--json", "body"])
        if p.returncode == 0:
            report["anchor_complete"] = anchor_complete_from_body(
                json.loads(p.stdout).get("body") or "")
        audit = run([sys.executable, str(Path(__file__).parent / "execute-ready-check.py"),
                     "--issue", str(anchor), "--mode", "audit"])
        report["land_sanity"] = (audit.stdout + audit.stderr).strip()[-1500:]

        # Step 5e.1b — upward propagation: a wave anchor inside a program
        # bubbles the slice event up — the Program-PRD's Wellenplan Status/Issue
        # cells + mechanically completed Phasen-Gates refresh via program-sync.
        p = run([sys.executable, bs, "parent-of", str(anchor)])
        program = p.stdout.strip() if p.returncode == 0 and p.stdout.strip().isdigit() else None
        if program:
            pdry = run([sys.executable, bs, "program-sync", str(program), "--dry-run"])
            pwet = run([sys.executable, bs, "program-sync", str(program)])
            if "not a Program-PRD" in ((pwet.stderr or "") + (pwet.stdout or "")):
                report["program_sync"] = {"program": program,
                                          "skipped": "parent is not a Program-PRD"}
            else:
                report["program_sync"] = {
                    "program": program, "ok": pwet.returncode == 0,
                    "diff": pdry.stdout.strip()[-2000:],
                    "error": None if pwet.returncode == 0
                    else (pwet.stderr or pwet.stdout).strip()[-1000:],
                }

    # Step 5f — census freshness. The verdict is read for the main checkout,
    # because that is the tree the next session starts from; a stale one becomes
    # a named finding (and optionally durable work) instead of dying with this
    # session. It is a diagnostic, so nothing it can do may stop a landing that
    # already merged — hence the blanket catch.
    try:
        census_step(main_tree, profile, report)
    except Exception as error:  # noqa: BLE001 — a diagnostic never gates a landing
        report["warnings"].append(f"census step skipped: {error}")

    report["main_sha"] = git(["log", "--oneline", "-1"], cwd=main_tree,
                             check=True).stdout.strip()
    return report


def pull_request_number(value: str) -> str:
    """`--pr` names which pull request is checked — it never skips the check."""
    if not value.isdigit():
        raise argparse.ArgumentTypeError("--pr expects a pull request number")
    return value


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("preflight", help="read-only context report (run in the worktree)")
    c = sub.add_parser("commit", help="guarded commit (run in the worktree)")
    c.add_argument("-m", "--message", required=True)
    c.add_argument("--allow-matches", action="store_true",
                   help="proceed despite secret-grep matches (after human review)")
    l = sub.add_parser("land", help="push→PR→merge→teardown (run from the MAIN tree)")
    l.add_argument("--branch", required=True)
    l.add_argument("--title", help="PR title (create path)")
    l.add_argument("--body-file", help="final PR body (create or overwrite)")
    l.add_argument("--anchor", help="wave-anchor issue # (derived via parent-of when omitted)")
    l.add_argument("--pr", type=pull_request_number,
                   help="the PR that authorizes deleting this branch when a reused "
                        "head ref makes the record ambiguous (still validated "
                        "against the full tuple)")
    l.add_argument("--skip-malformed-drift", action="store_true")
    # No recovery flag exists: an interrupted landing is resumed by re-running
    # `land`, which re-checks present state at every step.
    sub.add_parser("content-claim",
                   help="read-only: infer durable content in the main checkout")
    c2 = sub.add_parser("content-commit",
                        help="land a confirmed content claim (run in the main checkout)")
    c2.add_argument("--claim-file", required=True,
                    help="the confirmed claim: the content-claim records the user picked")
    c2.add_argument("-m", "--message", required=True)
    c2.add_argument("--slug", required=True, help="branch slug for the content branch")
    c2.add_argument("--type", required=True, help="branch type for the content branch")
    c2.add_argument("--anchor", help="anchor issue # the content belongs to")
    c2.add_argument("--body-file", help="PR body to check (a close keyword is refused)")
    c2.add_argument("--allow-matches", action="store_true",
                    help="proceed despite secret-grep matches (after human review)")
    return ap


def main() -> int:
    args = build_parser().parse_args()

    handlers = {
        "preflight": cmd_preflight,
        "commit": cmd_commit,
        "land": cmd_land,
        "content-claim": cmd_content_claim,
        "content-commit": cmd_content_commit,
    }
    try:
        result = handlers[args.cmd](args)
        print(json.dumps({"ok": True, "cmd": args.cmd, **result}, ensure_ascii=False, indent=2))
        return 0
    except Stop as s:
        print(json.dumps({"ok": False, "cmd": args.cmd,
                          "stop": {"step": s.step, "reason": s.reason, "detail": s.detail}},
                         ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
