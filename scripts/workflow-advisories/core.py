"""Profile-driven decision core for non-blocking Workflow Advisories."""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

PROFILE_GLOBS_MODULE = "_agent_workflow_kit_profile_globs"


def load_profile_globs():
    """Load the one shared repository-relative glob dialect exactly once."""
    module = sys.modules.get(PROFILE_GLOBS_MODULE)
    if module is not None:
        return module
    path = Path(__file__).resolve().parents[1] / "profile_globs.py"
    spec = importlib.util.spec_from_file_location(PROFILE_GLOBS_MODULE, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load the shared profile glob dialect from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[PROFILE_GLOBS_MODULE] = module
    spec.loader.exec_module(module)
    return module


# Consumer profile globs are matched here exactly as Worktree Lifecycle matches
# its own: one dialect, so an advisory and a deletion decision can never
# disagree about which repository-relative paths a pattern selects.
path_glob_matches = load_profile_globs().path_glob_matches


@dataclass(frozen=True)
class Decision:
    context: str | None
    event_name: str


def load_profile(path: Path) -> dict:
    body = json.loads(path.read_text(encoding="utf-8"))
    section = body.get("workflowAdvisories", {})
    return section if section.get("enabled") is True else {}


def _line_count(path: Path) -> int:
    count = 0
    last = b""
    with path.open("rb") as handle:
        while chunk := handle.read(64 * 1024):
            count += chunk.count(b"\n")
            last = chunk[-1:]
    return count if not last or last == b"\n" else count + 1


def _bounded(message: str, budget: int) -> str:
    if budget <= 0 or len(message) <= budget:
        return message
    return message[: max(0, budget - 1)] + "…"


def large_read_decision(profile: dict, payload: dict) -> Decision:
    config = profile.get("largeRead", {})
    if payload.get("tool_name") not in config.get("tools", []):
        return Decision(None, "PreToolUse")
    raw_path = payload.get("tool_input", {}).get("file_path")
    if not raw_path:
        return Decision(None, "PreToolUse")
    path = Path(raw_path)
    try:
        lines = _line_count(path)
    except (OSError, ValueError):
        return Decision(None, "PreToolUse")
    threshold = int(config.get("lineThreshold", 0))
    if lines < threshold:
        return Decision(None, "PreToolUse")
    message = (
        f"Large read advisory: {path.name} has {lines} lines "
        f"(profile threshold {threshold}). Prefer a bounded read or delegated recon."
    )
    return Decision(_bounded(message, int(config.get("outputBudget", 500))), "PreToolUse")


def _repo_relative(root: Path, raw_path: str) -> str | None:
    try:
        return str(Path(raw_path).resolve().relative_to(root.resolve()))
    except (OSError, ValueError):
        return None


def _valid_baseline(path: Path, branch: str) -> bool:
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    return (
        body.get("branch") == branch
        and bool(body.get("capturedAt"))
        and bool(body.get("sources"))
    )


def baseline_decision(profile: dict, payload: dict, root: Path, branch: str) -> Decision:
    config = profile.get("baseline", {})
    if payload.get("tool_name") not in {"Edit", "Write", "MultiEdit"}:
        return Decision(None, "PreToolUse")
    if not re.search(config.get("branchRegex", r"$^"), branch):
        return Decision(None, "PreToolUse")
    raw_path = payload.get("tool_input", {}).get("file_path")
    relative = _repo_relative(root, raw_path) if raw_path else None
    if not relative or not any(
        path_glob_matches(relative, pattern)
        for pattern in config.get("sourceGlobs", [])
    ):
        return Decision(None, "PreToolUse")
    manifest = root / config.get("manifestPath", ".agent/baseline.json")
    if _valid_baseline(manifest, branch):
        return Decision(None, "PreToolUse")
    state_dir = root / config.get("stateDir", ".claude/logs/advisory-state")
    marker = state_dir / f"{re.sub(r'[^A-Za-z0-9._-]', '-', branch)}.hinted"
    if marker.exists():
        return Decision(None, "PreToolUse")
    state_dir.mkdir(parents=True, exist_ok=True)
    marker.write_text(f"{branch}\n", encoding="utf-8")
    message = (
        f"Baseline advisory for {branch}: capture a valid baseline before the first "
        f"impacting edit to {relative}. Empty or stale manifests do not count."
    )
    return Decision(_bounded(message, int(config.get("outputBudget", 500))), "PreToolUse")


def pre_refactor_decision(profile: dict, payload: dict, root: Path) -> Decision:
    config = profile.get("preRefactor", {})
    prompt = payload.get("prompt", "")
    if not any(
        re.search(pattern, prompt, re.IGNORECASE)
        for pattern in config.get("promptMatchers", [])
    ):
        return Decision(None, "UserPromptSubmit")
    changed = payload.get("changed_files", [])
    commands: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()
    for surface in config.get("surfaces", []):
        if not any(
            path_glob_matches(path, pattern)
            for path in changed
            for pattern in surface.get("globs", [])
        ):
            continue
        for command in surface.get("commands", []):
            key = tuple(command)
            if key not in seen:
                commands.append(command)
                seen.add(key)
    return _command_decision(
        commands, config, root, "Pre-refactor sweep:", "UserPromptSubmit",
    )


def _command_decision(
    commands: list[list[str]], config: dict, root: Path, heading: str, event_name: str,
) -> Decision:
    if not commands:
        return Decision(None, event_name)
    timeout = float(config.get("timeoutSeconds", 15))
    lines = [heading]
    for command in commands:
        try:
            result = subprocess.run(
                command, cwd=root, capture_output=True, text=True, timeout=timeout,
            )
            detail = (result.stdout + result.stderr).strip()
            verdict = "PASS" if result.returncode == 0 else f"FAIL (exit {result.returncode})"
        except subprocess.TimeoutExpired as error:
            detail = ((error.stdout or "") + (error.stderr or "")).strip()
            verdict = f"FAIL (timeout {timeout:g}s)"
        except OSError as error:
            detail = str(error)
            verdict = "FAIL (exec)"
        lines.append(f"- {verdict}: {' '.join(command)}")
        if detail:
            lines.append(f"  {detail}")
    return Decision(
        _bounded("\n".join(lines), int(config.get("outputBudget", 1000))),
        event_name,
    )


def stop_check_decision(profile: dict, payload: dict, root: Path) -> Decision:
    config = profile.get("stopChecks", {})
    changed = payload.get("changed_files", [])
    commands: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()
    for surface in config.get("surfaces", []):
        if not any(
            path_glob_matches(path, pattern)
            for path in changed
            for pattern in surface.get("globs", [])
        ):
            continue
        command = surface.get("command", [])
        key = tuple(command)
        if command and key not in seen:
            commands.append(command)
            seen.add(key)
    return _command_decision(
        commands, config, root, "Changed-surface stop checks:", "Stop",
    )


def git_commit_time(root: Path, relative_path: str) -> int | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "log", "-1", "--format=%ct", "--", relative_path],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    value = result.stdout.strip()
    return int(value) if result.returncode == 0 and value.isdigit() else None


def read_source_list(path: Path) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    return [
        line.strip() for line in lines
        if line.strip() and not line.strip().startswith("#")
    ]


def collect_stale_maps(
    root: Path, maps: list[tuple[str, list[str]]],
) -> list[tuple[str, list[str]]]:
    stale_maps: list[tuple[str, list[str]]] = []
    for document, sources in maps:
        document_time = git_commit_time(root, document)
        if document_time is None:
            continue
        stale = [
            source for source in sources
            if (source_time := git_commit_time(root, source)) is not None
            and source_time > document_time
        ]
        if stale:
            stale_maps.append((document, stale))
    return stale_maps


def collect_skill_stale(root: Path, skills_relative: str) -> list[tuple[str, list[str]]]:
    skills_dir = root / skills_relative
    maps = [
        (
            f"{skills_relative}/{sources_file.parent.name}/SKILL.md",
            read_source_list(sources_file),
        )
        for sources_file in sorted(skills_dir.glob("*/SOURCES.txt"))
    ] if skills_dir.is_dir() else []
    return [
        (Path(document).parent.name, sources)
        for document, sources in collect_stale_maps(root, maps)
    ]


def convention_freshness_decision(profile: dict, root: Path) -> Decision:
    config = profile.get("freshness", {})
    maps = [
        (entry.get("document", ""), entry.get("sources", []))
        for entry in config.get("documents", [])
        if entry.get("document")
    ]
    stale = collect_stale_maps(root, maps)
    if not stale:
        return Decision(None, "SessionStart")
    lines = ["Convention freshness advisory:"]
    for document, sources in stale:
        lines.append(f"- {document} is older than:")
        lines.extend(f"  - {source}" for source in sources)
    return Decision(
        _bounded("\n".join(lines), int(config.get("outputBudget", 1000))),
        "SessionStart",
    )


def _migration_session_marker(profile: dict, payload: dict, root: Path) -> Path | None:
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return None
    state_dir = root / profile.get("baseline", {}).get(
        "stateDir", ".claude/logs/advisory-state",
    )
    safe_session = re.sub(r"[^A-Za-z0-9._-]", "-", session_id)
    return state_dir / f"{safe_session}.migration.hinted"


def _unquoted_shell_text(command: str) -> str:
    visible: list[str] = []
    quote: str | None = None
    escaped = False
    for character in command:
        if escaped:
            visible.append(" " if quote else character)
            escaped = False
        elif character == "\\" and quote != "'":
            visible.append(" ")
            escaped = True
        elif quote:
            visible.append(" ")
            if character == quote:
                quote = None
        elif character in {"'", '"', "`"}:
            visible.append(" ")
            quote = character
        else:
            visible.append(character)
    return "".join(visible)


def migration_reminder_decision(
    profile: dict, payload: dict, root: Path,
) -> Decision:
    config = profile.get("migration", {})
    if payload.get("tool_name") != "Bash":
        return Decision(None, "PostToolUse")
    command = _unquoted_shell_text(payload.get("tool_input", {}).get("command", ""))
    if not any(
        re.search(pattern, command)
        for pattern in config.get("commandMatchers", [])
    ):
        return Decision(None, "PostToolUse")
    artifact = config.get("artifact")
    refresh = config.get("refreshCommand", [])
    if not artifact or not refresh:
        return Decision(None, "PostToolUse")
    marker = _migration_session_marker(profile, payload, root)
    if marker and marker.exists():
        return Decision(None, "PostToolUse")
    if marker:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(f"{payload['session_id']}\n", encoding="utf-8")
    message = (
        f"Migration advisory: refresh {artifact} with `{' '.join(refresh)}` "
        "before treating the migration result as complete."
    )
    return Decision(
        _bounded(message, int(config.get("outputBudget", 500))),
        "PostToolUse",
    )
