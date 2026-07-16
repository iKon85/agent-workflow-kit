"""Profile-driven decisions for independently activatable Safety Guardrails."""

from __future__ import annotations

import json
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from search import scan as scan_search


@dataclass(frozen=True)
class GuardDecision:
    action: str
    message: str = ""
    log_message: str = ""


def load_profile(path: Path) -> dict[str, Any]:
    document = json.loads(path.read_text(encoding="utf-8"))
    section = document.get("safetyGuardrails")
    if not isinstance(section, dict):
        return {}
    return section


def inactive() -> GuardDecision:
    return GuardDecision("allow")


def _secret_name_is_sensitive(name: str, policy: dict[str, Any]) -> bool:
    suffixes = tuple(policy.get("safeTemplateSuffixes") or ())
    if name.startswith(".env"):
        return not any(name.endswith(suffix) for suffix in suffixes)
    return name in set(policy.get("sensitiveNames") or ())


def _secret_path_is_sensitive(path: str, policy: dict[str, Any]) -> bool:
    candidate = Path(path)
    if _secret_name_is_sensitive(candidate.name, policy):
        return True
    normalized = str(candidate).replace("\\", "/")
    return any(fragment in normalized for fragment in policy.get("sensitivePathFragments") or ())


def secret_decision(policy: dict[str, Any], payload: dict[str, Any]) -> GuardDecision:
    if policy.get("enabled") is not True:
        return inactive()
    tool = payload.get("tool_name")
    tool_input = payload.get("tool_input") or {}
    if tool == "Bash":
        return _secret_bash_decision(policy, str(tool_input.get("command") or ""))
    path = str(tool_input.get("file_path") or "")
    if not path or tool not in {"Read", "Edit", "Write", "MultiEdit"}:
        return inactive()
    if tool == "Write" and Path(path).name.startswith(".env"):
        return inactive()
    if not _secret_path_is_sensitive(path, policy):
        return inactive()
    return GuardDecision(
        "block",
        f"BLOCKED: access to sensitive path '{path}' is not allowed.",
        f"blocked tool={tool} path={path!r}",
    )


_DUMP_COMMANDS = {
    "cat", "head", "tail", "less", "more", "strings", "nl", "xxd", "od",
    "bat", "tac", "rev", "grep", "egrep", "fgrep", "rg", "ag", "awk", "sed", "cut",
}
_QUIET_GREP = {"grep", "egrep", "fgrep", "rg", "ag"}
_INSTALL_RE = re.compile(
    r"\b(?P<manager>npm|pnpm|yarn|bun)\s+(?:install|i|ci)\b"
)
_BACKGROUND_RE = re.compile(r"(?<![<>&])&[ \t]*(?:;|$)", re.MULTILINE)


def _secret_bash_decision(policy: dict[str, Any], command: str) -> GuardDecision:
    if not command:
        return inactive()
    try:
        segments = re.split(r"\n|;|&&|\|\||\|", command)
        for segment in segments:
            tokens = shlex.split(segment)
            dumps = set(tokens) & _DUMP_COMMANDS
            paths = [token for token in tokens if _secret_path_is_sensitive(token, policy)]
            if not dumps or not paths:
                continue
            if dumps <= _QUIET_GREP and any(flag == "--quiet" or flag.startswith("-q") for flag in tokens):
                continue
            return GuardDecision(
                "block",
                f"BLOCKED: command would print sensitive path '{paths[0]}' to the transcript.",
                f"blocked bash secret dump path={paths[0]!r}",
            )
    except ValueError:
        return inactive()
    return inactive()


def _effective_cwd(command: str, match_pos: int, fallback: Path) -> Path:
    target = None
    for match in re.finditer(r"(?:^|[;&|]\s*)cd\s+([^\s;&|]+)", command):
        if match.end() <= match_pos:
            target = match.group(1).strip("'\"")
    if target is None:
        return fallback
    path = Path(target).expanduser()
    return path if path.is_absolute() else fallback / path


def _detected_manager(policy: dict[str, Any], start: Path) -> tuple[str, Path] | None:
    lockfiles = policy.get("lockfiles") or {}
    try:
        current = start.resolve()
    except OSError:
        return None
    while True:
        for filename, manager in lockfiles.items():
            candidate = current / filename
            if candidate.is_file():
                return str(manager), candidate
        if current.parent == current:
            return None
        current = current.parent


def package_manager_decision(
    policy: dict[str, Any],
    payload: dict[str, Any],
    cwd: Path,
) -> GuardDecision:
    if policy.get("enabled") is not True or payload.get("tool_name") != "Bash":
        return inactive()
    command = str((payload.get("tool_input") or {}).get("command") or "")
    match = _INSTALL_RE.search(command)
    if match is None:
        return inactive()
    requested = match.group("manager")
    detected = _detected_manager(policy, _effective_cwd(command, match.start(), cwd))
    if detected is None or detected[0] == requested:
        return inactive()
    manager, lockfile = detected
    return GuardDecision(
        "block",
        f"BLOCKED: `{match.group(0)}` conflicts with {lockfile.name}. "
        f"Use `{manager} install` in this project.",
        f"blocked package-manager requested={requested} expected={manager} lock={lockfile}",
    )


def double_background_decision(
    policy: dict[str, Any],
    payload: dict[str, Any],
) -> GuardDecision:
    if policy.get("enabled") is not True or payload.get("tool_name") != "Bash":
        return inactive()
    surface = str(payload.get("surface") or "claude")
    if surface not in set(policy.get("surfaces") or ()):
        return inactive()
    tool_input = payload.get("tool_input") or {}
    is_background = tool_input.get("run_in_background") is True or (
        str(tool_input.get("run_in_background") or "").lower() == "true"
    )
    command = str(tool_input.get("command") or "")
    if not is_background or not _BACKGROUND_RE.search(command):
        return inactive()
    return GuardDecision(
        "block",
        "BLOCKED: run_in_background already detaches and captures this command; "
        "remove the inner `&` background operator.",
        "blocked double-background command",
    )


def search_shim_decision(
    policy: dict[str, Any],
    payload: dict[str, Any],
) -> GuardDecision:
    if (
        policy.get("enabled") is not True
        or policy.get("detected") is not True
        or payload.get("tool_name") != "Bash"
    ):
        return inactive()
    command = str((payload.get("tool_input") or {}).get("command") or "")
    finding = scan_search(command, set(policy.get("commandNames") or ()))
    if finding is None:
        return inactive()
    reason, pattern = finding
    return GuardDecision(
        "block",
        f"BLOCKED: search shim cannot safely evaluate pattern `{pattern}` ({reason}). "
        "Use `--fixed-strings` or `command grep`.",
        f"blocked search-shim breaker reason={reason}",
    )


def evaluate(kind: str, profile: dict[str, Any], payload: dict[str, Any]) -> GuardDecision:
    if kind == "secrets":
        return secret_decision(profile.get("secrets") or {}, payload)
    if kind == "package-manager":
        return package_manager_decision(
            profile.get("packageManager") or {},
            payload,
            Path.cwd(),
        )
    if kind == "double-background":
        return double_background_decision(
            profile.get("doubleBackground") or {},
            payload,
        )
    if kind == "search-shim":
        return search_shim_decision(
            profile.get("searchShim") or {},
            payload,
        )
    return inactive()
