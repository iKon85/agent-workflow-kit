"""Verified search-shim breaker detection."""

from __future__ import annotations

import shlex

OPERATORS = {"|", "||", "&&", ";", "&", "|&"}


def _count_unescaped(value: str, character: str) -> int:
    count = index = 0
    while index < len(value):
        if value[index] == "\\":
            index += 2
            continue
        if value[index] == character:
            count += 1
        index += 1
    return count


def _pattern_and_flags(args: list[str]) -> tuple[str | None, set[str]]:
    pattern = None
    flags = set()
    after_options = False
    index = 0
    while index < len(args):
        value = args[index]
        if value == "--":
            after_options = True
        elif not after_options and value in {"-e", "--regexp"}:
            index += 1
            if index < len(args) and pattern is None:
                pattern = args[index]
        elif not after_options and value.startswith("--regexp="):
            if pattern is None:
                pattern = value.split("=", 1)[1]
        elif not after_options and value.startswith("-"):
            flags.add(value)
        elif pattern is None:
            pattern = value
        index += 1
    return pattern, flags


def _has_flag(flags: set[str], letter: str, long: str) -> bool:
    return long in flags or any(
        flag.startswith("-") and not flag.startswith("--") and letter in flag[1:]
        for flag in flags
    )


def _breaker(pattern: str, flags: set[str]) -> str | None:
    if _has_flag(flags, "F", "--fixed-strings"):
        return None
    if _count_unescaped(pattern, "(") != _count_unescaped(pattern, ")"):
        return "unbalanced parentheses"
    extended = _has_flag(flags, "E", "--extended-regexp") or _has_flag(
        flags, "P", "--perl-regexp"
    )
    if not extended and _count_unescaped(pattern, "|"):
        return "bare alternation without extended-regexp mode"
    return None


def scan(command: str, command_names: set[str]) -> tuple[str, str] | None:
    try:
        tokens = shlex.split(command, posix=True)
    except ValueError:
        return None
    index = 0
    while index < len(tokens):
        token = tokens[index]
        shim = token in command_names
        if token == "grep" and index and tokens[index - 1] in {"command", "git"}:
            shim = False
        if token == "grep" and index and tokens[index - 1] == "rtk":
            shim = True
        if not shim:
            index += 1
            continue
        end = index + 1
        args = []
        while end < len(tokens) and tokens[end] not in OPERATORS:
            args.append(tokens[end])
            end += 1
        pattern, flags = _pattern_and_flags(args)
        reason = _breaker(pattern, flags) if pattern is not None else None
        if reason:
            return reason, pattern
        index = end
    return None
