#!/usr/bin/env python3
"""wrapup-land.py — mechanical executor for the /wrapup skill.

Replaces the former Sonnet phase-2 subagent: every enumerable
git/gh step of landing a slice runs here deterministically; judgment
(secret review, commit message, PR body text, drift-fallback candidates,
sibling propagation) stays with the calling agent.

Subcommands
  preflight   read-only context report (run in the feature worktree)
  commit      .env hard block + secret grep + git commit (run in the worktree)
  land        push → PR → body-check → merge → teardown → sweeps → anchor-sync
              (run FROM the main tree; refuses to run inside the worktree)

Output: one JSON report on stdout. Exit 0 = ok, 1 = STOP (reason in JSON),
2 = usage/context error. On STOP nothing is forced — no --force, no -D,
no --no-verify; the caller diagnoses.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Secret pattern mirrors the historical /wrapup Step-0a grep (era).
SECRET_RE = re.compile(
    r"BEGIN [A-Z ]*PRIVATE KEY|(api[_-]?key|secret|password|access[_-]?token|bearer)\s*[:=]",
    re.IGNORECASE,
)
ENV_PATH_RE = re.compile(r"(^|/)\.env(\.[^/]*)?$")
ISSUE_BRANCH_RE = re.compile(r"^(feat|fix|chore|docs)/(\d+)-")
# ANNAHMEN.md drift-log line: "- #<n>: text" or "- #<n> §<section>: text"
DRIFT_LINE_RE = re.compile(r"^-\s*#(\d+)(?:\s*§([^:]+?))?\s*:\s*(.+)$")
RETRO_LINE_RE = re.compile(r"^\*\*Retro:\*\*", re.MULTILINE)
DRIFT_MARKER_RE = re.compile(r"<!--\s*annahme-drift:\s*(\{.*?\})\s*-->")
RED_CHECK_CONCLUSIONS = {"FAILURE", "CANCELLED", "TIMED_OUT"}


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
    m = ISSUE_BRANCH_RE.match(branch)
    return m.group(2) if m else None


def load_profile() -> dict:
    try:
        from board_config import load_board_config
        return load_board_config()
    except Exception:
        return {}


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


def kill_worktree_processes(wt: str) -> list[str]:
    """Kill port listeners (.dev-ports) + processes with cwd under the worktree.

    Own shell ancestry is excluded (the self-kill trap, mechanically)."""
    killed, protected = [], self_ancestry()
    ports = []
    dev_ports = Path(wt) / ".dev-ports"
    if dev_ports.is_file():
        ports = parse_dev_ports(dev_ports.read_text())
    for port in ports:
        p = run(["lsof", f"-ti:{port}"])
        for pid in p.stdout.split():
            if pid.isdigit() and int(pid) not in protected:
                run(["kill", "-9", pid])
                killed.append(f"port {port} pid {pid}")
    p = run(["pgrep", "-f", "tsx|vite|tsc|pnpm|node"])
    wt_real = os.path.realpath(wt)
    for pid in p.stdout.split():
        if not pid.isdigit() or int(pid) in protected:
            continue
        try:
            cwd = os.path.realpath(f"/proc/{pid}/cwd")
        except OSError:
            continue
        if cwd == wt_real or cwd.startswith(wt_real + os.sep):
            run(["kill", pid])
            killed.append(f"cwd pid {pid}")
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

def stale_remote_set(merged: set[str], remotes: set[str], open_prs: set[str]) -> list[str]:
    return sorted((merged & remotes) - open_prs - {"main"})


# ---------- subcommands ----------

def cmd_preflight(args) -> dict:
    cwd = os.getcwd()
    main_tree, _ = worktree_map(cwd)
    branch = git(["branch", "--show-current"], check=True).stdout.strip()
    wt = git(["rev-parse", "--show-toplevel"], check=True).stdout.strip()
    if os.path.realpath(wt) == os.path.realpath(main_tree) or branch == "main":
        raise Stop("preflight", "not in a feature worktree",
                   f"wt={wt} branch={branch} — /wrapup runs in the finished slice's worktree")

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
    branch = git(["branch", "--show-current"], check=True).stdout.strip()
    if branch == "main":
        raise Stop("commit", "on main — refusing to commit")
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


def cmd_land(args) -> dict:
    report: dict = {"stops": [], "warnings": []}
    main_tree, branches = worktree_map()
    here = os.path.realpath(os.getcwd())
    if here != os.path.realpath(main_tree):
        raise Stop("land", "run `land` from the main tree",
                   f"cwd={here} main={main_tree} — the in-worktree shell would survive "
                   "teardown and the process-kill step")
    branch = args.branch
    wt = branches.get(branch)
    wt_exists = wt is not None and Path(wt).is_dir()
    profile = load_profile()
    default_section = profile.get("headings", {}).get("vorBau", "Vor Bau zu klären")

    # drift markers from the build-time log — mechanical, no gate
    markers: list[dict] = []
    if wt_exists:
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

    # Step 0b — push
    if wt_exists:
        p = git(["push", "-u", "origin", branch], cwd=wt)
        if p.returncode != 0:
            raise Stop("0b push", "push rejected", (p.stderr or p.stdout).strip()[-2000:])

    # Step 0c — ensure PR + final body
    p = run(["gh", "pr", "view", branch, "--json", "number,state,body"])
    pr_body = ""
    if p.returncode == 0:
        d = json.loads(p.stdout)
        pr, pr_state, pr_body = str(d["number"]), d["state"], d.get("body") or ""
        report["pr_reused"] = True
    elif args.body_file:
        if not args.title:
            raise Stop("0c pr", "--title required to create a PR")
        run(["gh", "pr", "create", "--base", "main", "--head", branch,
             "--title", args.title, "--body-file", args.body_file], check=True)
        d = json.loads(run(["gh", "pr", "view", branch, "--json", "number,state,body"],
                           check=True).stdout)
        pr, pr_state, pr_body = str(d["number"]), d["state"], d.get("body") or ""
        report["pr_reused"] = False
    else:
        raise Stop("0c pr", "no open PR and no --body-file to create one")
    report["pr"] = pr

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

    # merge gate
    d = json.loads(run(["gh", "pr", "view", pr, "--json",
                        "state,mergeable,mergeStateStatus,statusCheckRollup"],
                       check=True).stdout)
    red = [c for c in (d.get("statusCheckRollup") or [])
           if (c.get("conclusion") or "").upper() in RED_CHECK_CONCLUSIONS]
    if red:
        raise Stop("0c merge-gate", "red checks on the PR",
                   ", ".join(c.get("name") or c.get("context", "?") for c in red))
    if d.get("mergeable") == "CONFLICTING":
        raise Stop("0c merge-gate", "PR is CONFLICTING — rebase/resolve the branch")
    already_merged = d.get("state") == "MERGED"
    if d.get("state") not in ("OPEN", "MERGED"):
        raise Stop("0c merge-gate", f"PR state {d.get('state')} — cannot merge")

    # Step 1 — merge (= prod deploy; authorization = the user's /wrapup invocation).
    # PR state is the authority, not gh's exit code: `--delete-branch` also tries
    # to delete the LOCAL branch, which fails while a worktree holds it — the
    # remote merge is through anyway (dogfood run PR).
    merge_err = ""
    if not already_merged:
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

    # Step 2 — kill the worktree's dev server, then Step 4 — teardown
    if wt_exists:
        report["killed_processes"] = kill_worktree_processes(wt)
        p = git(["worktree", "remove", wt], cwd=main_tree)
        if p.returncode != 0:
            raise Stop("4 worktree-remove", "git worktree remove refused — no --force; "
                       "check for surviving processes (lsof/pgrep)",
                       (p.stderr or p.stdout).strip()[-1000:])
        git(["worktree", "prune"], cwd=main_tree)
        report["worktree_removed"] = wt
    git(["fetch", "origin", "--prune"], cwd=main_tree)

    # Step 5 — main ff + local branch delete (-d only, after the pull)
    git(["checkout", "main"], cwd=main_tree)
    p = git(["pull", "--ff-only"], cwd=main_tree)
    if p.returncode != 0:
        raise Stop("5 main-ff", "no fast-forward possible — diverged main is an anomaly",
                   (p.stderr or p.stdout).strip()[-1000:])
    p = git(["branch", "-d", branch], cwd=main_tree)
    if p.returncode != 0 and branch in worktree_map()[1]:
        report["warnings"].append(f"branch -d {branch} refused (still checked out?) — never -D")
    elif p.returncode != 0:
        report["warnings"].append(f"branch -d {branch} refused: {(p.stderr or '').strip()[:200]}")

    # Step 5b — verify issue auto-close (backtick-swallowed `closes` misses)
    issue = issue_from_branch(branch)
    if issue:
        p = run(["gh", "issue", "view", issue, "--json", "state"])
        if p.returncode == 0 and json.loads(p.stdout)["state"] == "OPEN":
            run(["gh", "issue", "close", issue, "-c",
                 f"Merged via PR #{pr} — auto-close didn't fire; closed manually."])
            report["issue_close"] = f"#{issue} closed manually"
        elif p.returncode == 0:
            report["issue_close"] = f"#{issue} already closed"

    # Step 5c — local merged-branch sweep (-d only: unreachable-from-main is refused)
    swept = []
    p = git(["branch", "--merged", "main", "--format=%(refname:short)"], cwd=main_tree)
    for b in p.stdout.split():
        if b in ("main", branch) or not b:
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
    stale = stale_remote_set(merged_heads, remote_heads, open_heads)
    if not profile.get("wrapup", {}).get("remoteBranchSweep"):
        report["swept_remote"] = {"enabled": False, "stale_count": len(stale)}
    elif stale:
        p = git(["push", "origin", "--delete", *stale], cwd=main_tree)
        git(["fetch", "origin", "--prune"], cwd=main_tree)
        report["swept_remote"] = {"enabled": True, "deleted": stale if p.returncode == 0 else [],
                                  "error": None if p.returncode == 0 else p.stderr.strip()[-500:]}
    else:
        report["swept_remote"] = {"enabled": True, "deleted": []}

    # Step 5e.1 — anchor tracker sync + completeness; 5e.3 land sanity
    anchor = args.anchor
    if not anchor and issue:
        p = run([sys.executable, str(Path(__file__).parent / "board-sync.py"),
                 "parent-of", issue])
        out = p.stdout.strip()
        anchor = out if p.returncode == 0 and out.isdigit() else None
    if anchor:
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

    report["main_sha"] = git(["log", "--oneline", "-1"], cwd=main_tree,
                             check=True).stdout.strip()
    return report


def main() -> int:
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
    l.add_argument("--skip-malformed-drift", action="store_true")
    args = ap.parse_args()

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
