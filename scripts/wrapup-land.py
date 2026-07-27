#!/usr/bin/env python3
"""wrapup-land.py — mechanical executor for the /wrapup skill.

Replaces the former Sonnet phase-2 subagent: every enumerable
git/gh step of landing a slice runs here deterministically; judgment
(secret review, commit message, PR body text, drift-fallback candidates,
sibling propagation) stays with the calling agent.

Subcommands
  preflight   read-only context report (run in the worktree being landed)
  commit      .env hard block + secret grep + git commit (run in the worktree)
  land        push → PR → body-check → merge → teardown → sweeps → anchor-sync
              (run FROM the main tree; refuses to run inside the worktree)

Any born, attached worktree is first-class: a direct /wrapup invocation is the
teardown authorization (ADR 0009), including for worktrees an external tool
created under a foreign name and path. There is no naming or location gate, no
persisted attempt state, and no recovery flag — an interrupted landing is
resumed by re-running it, because every step verifies present state and skips
what is already done (ADR 0009).

Branch retirement is authorized, never assumed: ancestry against the freshly
fetched integration branch deletes normally, and only the platform's own PR
record — the full tuple, head SHA equal to the tip re-read immediately before
the deletion — force-deletes (ADR 0009 §3).

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
import subprocess
import sys
import time
from pathlib import Path
from typing import NamedTuple
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Secret pattern mirrors the historical /wrapup Step-0a grep (era).
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


class Stop(Exception):
    def __init__(self, step: str, reason: str, detail: str = ""):
        super().__init__(reason)
        self.step, self.reason, self.detail = step, reason, detail


def run(cmd: list[str], cwd: str | None = None, check: bool = False) -> subprocess.CompletedProcess:
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise Stop(cmd[0], f"command failed: {' '.join(cmd)}",
                   (p.stderr or p.stdout).strip()[-2000:])
    return p


def git(args: list[str], cwd: str | None = None, check: bool = False) -> subprocess.CompletedProcess:
    return run(["git", *args], cwd=cwd, check=check)


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


def sanitize_external_detail(text: str) -> str:
    compact = re.sub(r"[\x00-\x1f\x7f]+", " ", text)
    return re.sub(r"\s+", " ", compact).strip()[:MAX_EXTERNAL_DETAIL]


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
    try:
        checks = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise Stop(
            "0c merge-gate", "invalid required PR check response", str(error)
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
            f"wrapup: waiting for PR #{pr} checks "
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
    """The one stateless teardown core (ADR 0009) — never a second copy here."""
    path = Path(__file__).resolve().parent / "worktree-lifecycle" / "classify.py"
    return load_module(CLASSIFY_MODULE, path, "4 teardown")


def load_lifecycle_profile_module():
    path = Path(__file__).resolve().parent / "worktree-lifecycle" / "profile.py"
    return load_module(LIFECYCLE_PROFILE_MODULE, path, "profile")


def branch_policy(repo_root: str) -> tuple[str, tuple[str, ...]]:
    """Return (integration branch, protected branches) from the consumer profile.

    The integration branch is never named inline. An absent or malformed
    profile falls back to the Worktree Lifecycle profile's own documented
    default, which is the single place in the kit that names a branch at all.
    """
    defaults = load_lifecycle_profile_module().DEFAULT_MAIN_BRANCHES
    raw: dict = {}
    try:
        document = json.loads(
            (Path(repo_root) / LIFECYCLE_PROFILE).read_text(encoding="utf-8")
        )
        candidate = document.get("worktreeLifecycle")
        raw = candidate if isinstance(candidate, dict) else {}
    except (OSError, json.JSONDecodeError, AttributeError, TypeError):
        raw = {}
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
            "detached HEAD — /wrapup lands a branch and this worktree is on none",
            f"{cwd}: attach one here (`git switch -c <branch>` keeps the work on a "
            "new branch, `git switch <branch>` moves to an existing one), then "
            "re-run /wrapup",
        )
    branch = symbolic.stdout.strip().removeprefix("refs/heads/")
    if git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], cwd=cwd).returncode != 0:
        raise Stop(
            step,
            f"unborn branch {branch} — it has no commits yet, so there is nothing to land",
            f"{cwd}: make the first commit (wrapup's `commit` step does it), then "
            "re-run /wrapup",
        )
    return branch


def assess_teardown(wt: str, main_tree: str):
    """Classify the worktree's current state — the only teardown authority."""
    classify = load_teardown_classifier()
    try:
        return classify.assess(Path(wt), Path(main_tree))
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
    machine is how a wrapup run takes down someone else's server. Own shell
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
    # including one an external tool created under a foreign name and path
    # (ADR 0009). Only the main checkout and a protected branch are refused.
    if os.path.realpath(wt) == os.path.realpath(main_tree):
        raise Stop("preflight", "run /wrapup in the worktree it should land and tear down",
                   f"wt={wt} is the main checkout — /wrapup never tears that down")
    if branch in protected:
        raise Stop("preflight", f"{branch} is a protected branch",
                   f"wt={wt} — /wrapup lands a slice branch, never the integration branch")

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
    git(["add", "-A"], check=True)
    hits = secret_hits_in(git(["diff", "--cached"], check=True).stdout)
    if hits and not args.allow_matches:
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
                   (p.stderr + "\n" + p.stdout).strip()[-3000:])
    sha = git(["rev-parse", "HEAD"], check=True).stdout.strip()
    return {"committed": True, "sha": sha, "allowed_matches": bool(hits)}


# ---------- branch deletion authority (ADR 0009 §3) ----------

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
    that fails stops rather than guesses (ADR 0009 §3).
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
    """ADR 0009 §3's full tuple — the head SHA carries the uniqueness.

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
    request on the same head, or no platform access keep the branch (ADR 0009).
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
                   (p.stderr or p.stdout).strip()[-1000:])
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

    There is no persisted attempt state (ADR 0009). Whether the push, the PR
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
                   "/wrapup lands a slice branch, never the integration branch")
    wt = branches.get(branch)
    wt_exists = wt is not None and Path(wt).is_dir()
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
                           (p.stderr or p.stdout).strip()[-2000:])

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
                tmp = Path(f"/tmp/wrapup-body-{pr}.md")
                tmp.write_text(final)
                run(["gh", "pr", "edit", pr, "--body-file", str(tmp)], check=True)

        # body-convention check: closes-vs-Part-of + **Retro:** line
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

    # Step 1 — merge (= prod deploy; authorization = the user's /wrapup invocation).
    # PR state is the authority, not gh's exit code: `--delete-branch` also tries
    # to delete the LOCAL branch, which fails while a worktree holds it — the
    # remote merge is through anyway (dogfood run PR).
    merge_err = ""
    if already_merged:
        report["skipped"].append("merge: the PR is already MERGED")
    else:
        p = run(["gh", "pr", "merge", pr, "--merge", "--delete-branch"], cwd=main_tree)
        if p.returncode != 0:
            merge_err = (p.stderr or p.stdout).strip()[-2000:]
    state = json.loads(run(["gh", "pr", "view", pr, "--json", "state"],
                           check=True).stdout)["state"]
    if state != "MERGED":
        raise Stop("1 merge", f"PR state after merge is {state}, not MERGED — aborting teardown",
                   merge_err)
    if merge_err:
        report["warnings"].append(f"gh pr merge exited non-zero but PR is MERGED: {merge_err[:300]}")
    report["merged"] = True

    # Step 2 — quiesce this worktree's own dev servers, then Step 4 — teardown.
    # Teardown always runs: a direct /wrapup invocation is its authorization,
    # and the classifier's four rules are the only protection.
    if not wt_exists:
        report["skipped"].append("teardown: the worktree is already removed")
    else:
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
                       (p.stderr or p.stdout).strip()[-1000:])
        git(["worktree", "prune"], cwd=main_tree)
        report["worktree_removed"] = wt

    # Step 5 — integration ff + branch retirement by authority (after the pull)
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
    # `land`, which re-checks present state at every step (ADR 0009).
    return ap


def main() -> int:
    args = build_parser().parse_args()

    try:
        result = {"preflight": cmd_preflight, "commit": cmd_commit, "land": cmd_land}[args.cmd](args)
        print(json.dumps({"ok": True, "cmd": args.cmd, **result}, ensure_ascii=False, indent=2))
        return 0
    except Stop as s:
        print(json.dumps({"ok": False, "cmd": args.cmd,
                          "stop": {"step": s.step, "reason": s.reason, "detail": s.detail}},
                         ensure_ascii=False, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())
