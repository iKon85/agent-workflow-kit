"""Profile-driven decision core for non-blocking Workflow Advisories."""
from __future__ import annotations

import fnmatch
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


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
        fnmatch.fnmatch(relative, pattern) for pattern in config.get("sourceGlobs", [])
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
            fnmatch.fnmatch(path, pattern)
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
            fnmatch.fnmatch(path, pattern)
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
