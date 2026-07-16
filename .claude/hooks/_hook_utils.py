#!/usr/bin/env python3
"""
Shared helpers for .claude/hooks/*.py — logging, subprocess wrappers,
git inspection. Underscore-prefix signals "not a hook, not invoked by
Claude Code directly".

Python adds the script directory to sys.path automatically, so any hook
in this folder can `from _hook_utils import ...`.

Migration notes for hook refactors:
- `log(name, msg)` takes two args (per-hook name + message). Callers must
  pass their hook name as the first arg — there is no implicit per-module
  log-file binding. Recommended pattern: `HOOK_NAME = "<hook-name>"` as a
  module-level constant in each hook, then `log(HOOK_NAME, msg)` at the
  call sites.
- `run()` is silent-on-failure: exceptions return "" without logging. The
  pre-refactor `run()` in some hooks (notably enforce-worktree-cwd.py)
  logged `"exec failed: ..."` on subprocess exception. That diagnostic
  log is intentionally dropped — git/subprocess crashes are rare and the
  meaningful Audit-log entries (`BLOCKED cmd=...`) still get written.
"""
import re
import subprocess
import importlib.util
import sys
from datetime import datetime
from pathlib import Path

# Resolved relative to CWD at call time. Hooks are invoked from repo root
# (or from a linked worktree root), so this resolves to <root>/.claude/logs.
LOG_DIR = Path(".claude/logs")
_WORKTREE_CORE_MODULE = "_agent_workflow_kit_worktree_lifecycle"
_ADVISORY_CORE_MODULE = "_agent_workflow_kit_workflow_advisories"
_LOC_OFFENDER_GATE_MODULE = "_agent_workflow_kit_loc_offender_gate"


def rotate_log_if_needed(log_path: Path, max_bytes: int = 100_000, generations: int = 3) -> None:
    """
    If log_path exceeds max_bytes, rotate it: .log → .log.1 → .log.2 → ... → .log.<generations>,
    oldest dropped. Silent-on-failure.
    """
    try:
        if not log_path.exists():
            return
        if log_path.stat().st_size <= max_bytes:
            return
        # Drop the oldest generation
        oldest = log_path.with_suffix(log_path.suffix + f".{generations}")
        if oldest.exists():
            oldest.unlink()
        # Shift .log.<N-1> → .log.<N>, ..., .log.1 → .log.2
        for n in range(generations - 1, 0, -1):
            src = log_path.with_suffix(log_path.suffix + f".{n}")
            dst = log_path.with_suffix(log_path.suffix + f".{n+1}")
            if src.exists():
                src.rename(dst)
        # .log → .log.1
        log_path.rename(log_path.with_suffix(log_path.suffix + ".1"))
    except Exception:
        pass  # silent


def log(name: str, msg: str) -> None:
    """
    Append `<ISO-timestamp> <msg>\\n` to .claude/logs/<name>.log. Creates
    LOG_DIR if missing. Rotates first if file exceeds 100 KB. Silent-on-failure.
    """
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log_file = LOG_DIR / f"{name}.log"
        rotate_log_if_needed(log_file)
        with log_file.open("a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except Exception:
        pass


def run(cmd: list[str], timeout: int = 5) -> str:
    """
    Wrapper around subprocess.run. Returns stdout.strip() on success, "" on any failure.
    Failures are NOT logged here (caller decides whether to log).
    """
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def run_with_status(cmd: list[str], timeout: int = 15) -> tuple[int, str]:
    """
    Wrapper that returns (returncode, stdout) — for hooks that branch on exit code.
    Returns (-1, "") on exception.
    """
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout
    except Exception:
        return -1, ""


def is_main_worktree() -> bool:
    """True if GIT_DIR == GIT_COMMON_DIR (= main tree, not a linked worktree)."""
    git_dir = run(["git", "rev-parse", "--git-dir"])
    git_common = run(["git", "rev-parse", "--git-common-dir"])
    if not git_dir or not git_common:
        return False
    try:
        return Path(git_dir).resolve() == Path(git_common).resolve()
    except Exception:
        return False


def current_branch() -> str:
    """Returns current branch name or "" if detached/not a repo."""
    return run(["git", "branch", "--show-current"])


_BRANCH_ISSUE_RE = re.compile(r"^(?:feat|fix)/(\d+)-")


def parse_issue_from_branch(branch: str):
    """Issue number (str) from a `feat/<n>-…` / `fix/<n>-…` branch, else None.
    Shared so hooks don't each re-declare the convention regex."""
    m = _BRANCH_ISSUE_RE.match(branch or "")
    return m.group(1) if m else None


def repo_root() -> str:
    """Returns repo root or "" if not a repo."""
    return run(["git", "rev-parse", "--show-toplevel"])


def is_git_ignored(path: str) -> bool:
    """True if `path` is git-ignored (safe to edit anywhere — never enters a commit).

    Uses `git check-ignore -q`: exit 0 = ignored, 1 = not ignored, 128 = error.
    Only exit 0 counts as ignored; on not-matched OR error we return False so the
    caller errs toward enforcing discipline rather than silently allowing an edit.
    Caveat: a force-added tracked file that also matches an ignore pattern reports
    ignored — acceptable, that combination is vanishingly rare in this repo.
    """
    if not path:
        return False
    rc, _ = run_with_status(["git", "check-ignore", "-q", "--", path], timeout=5)
    return rc == 0


def has_feature_worktrees() -> bool:
    """True if at least one linked worktree exists with a non-main branch."""
    output = run(["git", "worktree", "list", "--porcelain"])
    if not output:
        return False
    for block in output.split("\n\n"):
        m = re.search(r"^branch refs/heads/(.+)$", block, re.MULTILINE)
        if m:
            branch = m.group(1).strip()
            if branch and branch not in ("main", "master"):
                return True
    return False


def count_worktrees() -> int:
    """Total number of worktrees (incl. main)."""
    output = run(["git", "worktree", "list"])
    if not output:
        return 0
    return len([line for line in output.splitlines() if line.strip()])


def normalize_to_repo_relative(file_path: str, root: str) -> str | None:
    """
    Converts absolute paths to repo-relative paths.
    - Relative passthrough.
    - Absolute inside root: relative-to-root.
    - Absolute outside root or empty input: None.
    """
    if not file_path:
        return None
    p = Path(file_path)
    if not p.is_absolute():
        return file_path
    if not root:
        return None
    try:
        rel = p.resolve().relative_to(Path(root).resolve())
        return str(rel)
    except ValueError:
        return None


def load_worktree_lifecycle_core():
    """Load the shipped Worktree Lifecycle core without requiring a Python package."""
    existing = sys.modules.get(_WORKTREE_CORE_MODULE)
    if existing is not None:
        return existing
    path = Path(__file__).resolve().parents[2] / "scripts" / "worktree-lifecycle" / "core.py"
    module_dir = str(path.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    spec = importlib.util.spec_from_file_location(_WORKTREE_CORE_MODULE, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load Worktree Lifecycle core from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_WORKTREE_CORE_MODULE] = module
    spec.loader.exec_module(module)
    return module


def load_workflow_advisories_core():
    """Load the shipped Workflow Advisories core without requiring a Python package."""
    existing = sys.modules.get(_ADVISORY_CORE_MODULE)
    if existing is not None:
        return existing
    path = Path(__file__).resolve().parents[2] / "scripts" / "workflow-advisories" / "core.py"
    spec = importlib.util.spec_from_file_location(_ADVISORY_CORE_MODULE, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load Workflow Advisories core from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_ADVISORY_CORE_MODULE] = module
    spec.loader.exec_module(module)
    return module


def load_loc_offender_gate():
    """Load the shipped LoC gate so advisories consume its contracts directly."""
    existing = sys.modules.get(_LOC_OFFENDER_GATE_MODULE)
    if existing is not None:
        return existing
    path = Path(__file__).resolve().parents[2] / "scripts" / "loc_offender_gate.py"
    module_dir = str(path.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    spec = importlib.util.spec_from_file_location(_LOC_OFFENDER_GATE_MODULE, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load LoC offender gate from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_LOC_OFFENDER_GATE_MODULE] = module
    spec.loader.exec_module(module)
    return module


def hook_event_output(event_name: str, context: str) -> dict:
    """Canonical non-blocking context payload for Claude hook events."""
    return {
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": context,
        }
    }
