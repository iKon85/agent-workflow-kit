#!/usr/bin/env python3
"""Run one Codex round in an owned process group and classify its result."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import selectors
import secrets
import signal
import shutil
import subprocess
import sys
import time
from pathlib import Path


REDACTIONS = (
    (re.compile(r"(?i)(token|api[_-]?key|password)=\S+"), r"\1=[REDACTED]"),
    (re.compile(r"(?i)bearer\s+\S+"), "Bearer [REDACTED]"),
)
CANCEL_REQUESTED = False
HEARTBEAT_INTERVAL_SECONDS = 0.1
CANCEL_WAIT_SECONDS = 2.0
OWNERSHIP_TOKEN = re.compile(r"^[0-9a-f]{64}$")
RESULT_NAME = re.compile(r"^round-[1-9][0-9]*\.result\.json$")


def request_cancel(_signum: int, _frame: object) -> None:
    global CANCEL_REQUESTED
    CANCEL_REQUESTED = True


def atomic_write(path: Path, text: str) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    fsync_directory(path.parent)


def exclusive_write(path: Path, text: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    fsync_directory(path.parent)


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def remove_durable(path: Path) -> None:
    path.unlink(missing_ok=True)
    fsync_directory(path.parent)


def read_object(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def publish_runtime(state_dir: Path, token: str, round_number: int, phase: str) -> None:
    atomic_write(
        state_dir / "runtime.json",
        json.dumps({
            "token": token,
            "round": round_number,
            "phase": phase,
            "heartbeat": time.time(),
        }, sort_keys=True) + "\n",
    )


def matching_cancel_request(state_dir: Path, token: str, round_number: int) -> bool:
    request = read_object(state_dir / "cancel.request")
    return bool(
        request
        and request.get("token") == token
        and request.get("round") == round_number
    )


def redact(data: bytes) -> bytes:
    text = data.decode("utf-8", errors="replace")
    for pattern, replacement in REDACTIONS:
        text = pattern.sub(replacement, text)
    return text.encode()


def terminate_group(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 0.3
    while time.monotonic() < deadline:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.02)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def parse_events(stdout: bytes) -> tuple[bool, str | None, str | None]:
    malformed = False
    thread_id = None
    verdict = None
    for raw_line in stdout.decode("utf-8", errors="replace").splitlines():
        if not raw_line.strip():
            continue
        try:
            event = json.loads(raw_line)
        except json.JSONDecodeError:
            malformed = True
            continue
        if not isinstance(event, dict):
            malformed = True
            continue
        if "item" in event and not isinstance(event["item"], dict):
            malformed = True
            continue
        if event.get("type") == "thread.started":
            candidate = event.get("thread_id")
            if not isinstance(candidate, str):
                malformed = True
            else:
                thread_id = candidate
        item = event.get("item", {})
        if event.get("type") == "item.completed" and item.get("type") == "agent_message":
            candidate = item.get("text")
            if not isinstance(candidate, str):
                malformed = True
            else:
                verdict = candidate or None
    return malformed, thread_id, verdict


def has_valid_thread_start(stdout: bytes) -> bool:
    _, thread_id, _ = parse_events(stdout)
    return thread_id is not None


def classification(reason: str | None, returncode: int, stdout: bytes) -> dict:
    malformed, thread_id, verdict = parse_events(stdout)
    signal_name = signal.Signals(-returncode).name if returncode < 0 else None
    if reason == "cancelled":
        status = "CANCELLED"
    elif reason == "hung":
        status = "HUNG"
    elif reason == "timeout":
        status = "TIMEOUT"
    elif returncode < 0:
        status = "SIGNALLED"
    elif returncode != 0:
        status = "EXEC_FAILED"
    elif malformed:
        status = "MALFORMED-JSON"
    elif not thread_id:
        status = "NO-THREAD"
    elif not verdict:
        status = "NO-VERDICT"
    else:
        status = "OK"
    return {
        "status": status,
        "threadId": thread_id,
        "verdict": verdict,
        "originalExitStatus": returncode if returncode >= 0 else None,
        "signal": signal_name,
    }


def drain_process(args: argparse.Namespace, process: subprocess.Popen[bytes],
                  token: str) -> tuple[bytes, int, str | None]:
    selector = selectors.DefaultSelector()
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    stdout_path = Path(args.state_dir) / f"round-{args.round}.stdout.jsonl"
    stderr_path = Path(args.state_dir) / f"round-{args.round}.stderr.log"
    state_dir = Path(args.state_dir)
    started_at = time.monotonic()
    last_pre_thread_activity = started_at
    last_heartbeat = 0.0
    saw_thread = False
    reason = None
    terminated = False
    with stdout_path.open("xb") as stdout_file, stderr_path.open("xb") as stderr_file:
        for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            now = time.monotonic()
            if now - last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
                publish_runtime(state_dir, token, args.round, "running")
                last_heartbeat = now
            if matching_cancel_request(state_dir, token, args.round) or CANCEL_REQUESTED:
                reason = "cancelled"
            elif now - started_at >= args.timeout:
                reason = "timeout"
            elif not saw_thread and now - last_pre_thread_activity >= args.probe_timeout:
                reason = "hung"
            if reason and not terminated:
                terminate_group(process)
                terminated = True
            for key, _ in selector.select(timeout=0.03):
                try:
                    chunk = os.read(key.fileobj.fileno(), 65_536)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if not saw_thread:
                    last_pre_thread_activity = time.monotonic()
                buffers[key.data].extend(chunk)
                if key.data == "stdout":
                    stdout_file.write(chunk)
                    if has_valid_thread_start(bytes(buffers["stdout"])):
                        saw_thread = True
            if process.poll() is not None and not selector.get_map():
                break
        stderr_file.write(redact(bytes(buffers["stderr"])))
        stdout_file.flush()
        stderr_file.flush()
        os.fsync(stdout_file.fileno())
        os.fsync(stderr_file.fileno())
        return bytes(buffers["stdout"]), process.wait(), reason


def settle_before_publication(args: argparse.Namespace, token: str,
                              reason: str | None) -> str | None:
    state_dir = Path(args.state_dir)
    publish_runtime(state_dir, token, args.round, "settling")
    marker = os.environ.get("CODEX_EXEC_TEST_SETTLE_MARKER")
    if marker:
        atomic_write(Path(marker), token + "\n")
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            publish_runtime(state_dir, token, args.round, "settling")
            if matching_cancel_request(state_dir, token, args.round) or CANCEL_REQUESTED:
                return "cancelled"
            time.sleep(0.02)
    if matching_cancel_request(state_dir, token, args.round) or CANCEL_REQUESTED:
        return "cancelled"
    return reason


def publish_result(args: argparse.Namespace, result: dict) -> None:
    state_dir = Path(args.state_dir)
    if result.get("threadId"):
        atomic_write(state_dir / "thread-id", result["threadId"] + "\n")
    atomic_write(state_dir / "next-round", f"{args.round + 1}\n")
    result_path = state_dir / f"round-{args.round}.result.json"
    exclusive_write(result_path, json.dumps(result, sort_keys=True) + "\n")
    atomic_write(state_dir / "latest", result_path.name + "\n")
    print(json.dumps(result, sort_keys=True), flush=True)
    remove_durable(state_dir / "runtime.json")


def run_round(args: argparse.Namespace) -> int:
    state_dir = Path(args.state_dir)
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        raise SystemExit("process command is required")
    prompt_path = state_dir / f"round-{args.round}.prompt.txt"
    if prompt_path.exists():
        raise SystemExit(f"round {args.round} already exists")
    prompt_path.write_bytes(Path(args.prompt_file).read_bytes())
    signal.signal(signal.SIGINT, request_cancel)
    signal.signal(signal.SIGTERM, request_cancel)
    token = secrets.token_hex(32)
    with prompt_path.open("rb") as prompt:
        process = subprocess.Popen(
            command,
            stdin=prompt,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        publish_runtime(state_dir, token, args.round, "running")
        stdout, returncode, reason = drain_process(args, process, token)
    reason = settle_before_publication(args, token, reason)
    result = classification(reason, returncode, stdout)
    result.update({
        "runId": (state_dir / "run-id").read_text().strip(),
        "stateDir": str(state_dir),
        "round": args.round,
        "profile": args.profile,
        "sandbox": args.sandbox,
    })
    publish_result(args, result)
    return 0 if result["status"] == "OK" else 1


def cancel(args: argparse.Namespace) -> int:
    state_dir = Path(args.state_dir)
    runtime = state_dir / "runtime.json"
    if not runtime.exists():
        return 0 if terminal_result_ready(state_dir) else 1
    ownership = read_object(runtime)
    if not ownership:
        return 1
    token = ownership.get("token")
    round_number = ownership.get("round")
    if not isinstance(token, str) or not OWNERSHIP_TOKEN.fullmatch(token):
        return 1
    if not isinstance(round_number, int) or isinstance(round_number, bool) or round_number < 1:
        return 1
    atomic_write(
        state_dir / "cancel.request",
        json.dumps({
            "token": token,
            "round": round_number,
            "requestedAt": time.time(),
        }, sort_keys=True) + "\n",
    )
    deadline = time.monotonic() + CANCEL_WAIT_SECONDS
    while runtime.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    return 0 if not runtime.exists() and terminal_result_ready(state_dir) else 1


def terminal_result_ready(state_dir: Path) -> bool:
    try:
        result_name = (state_dir / "latest").read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return False
    if not RESULT_NAME.fullmatch(result_name):
        return False
    result = read_object(state_dir / result_name)
    return bool(result and isinstance(result.get("status"), str))


def live_runtime(runtime_path: Path, now: float, stale_seconds: float) -> bool:
    runtime = read_object(runtime_path)
    if not runtime:
        return False
    token = runtime.get("token")
    round_number = runtime.get("round")
    phase = runtime.get("phase")
    heartbeat = runtime.get("heartbeat")
    return bool(
        isinstance(token, str) and OWNERSHIP_TOKEN.fullmatch(token)
        and isinstance(round_number, int) and not isinstance(round_number, bool) and round_number >= 1
        and phase in {"running", "settling"}
        and isinstance(heartbeat, (int, float)) and not isinstance(heartbeat, bool)
        and math.isfinite(heartbeat)
        and 0 <= now - heartbeat < stale_seconds
    )


def cleanup(args: argparse.Namespace) -> int:
    root = Path(args.state_root)
    now = time.time()
    removed = 0
    candidates = sorted(root.glob("codex-exec.*"), key=lambda path: path.stat().st_mtime)
    for state_dir in candidates:
        if removed >= args.max_delete:
            break
        run_id = state_dir.name.removeprefix("codex-exec.")
        identity = state_dir / "run-id"
        protected = (
            (state_dir / "debug-retain").exists()
            or live_runtime(state_dir / "runtime.json", now, args.stale_seconds)
        )
        try:
            valid = identity.read_text().strip() == run_id
        except (FileNotFoundError, OSError):
            valid = False
        if valid and not protected and now - state_dir.stat().st_mtime >= args.stale_seconds:
            shutil.rmtree(state_dir)
            removed += 1
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="action", required=True)
    run = commands.add_parser("run")
    run.add_argument("--state-dir", required=True)
    run.add_argument("--round", required=True, type=int)
    run.add_argument("--profile", required=True)
    run.add_argument("--sandbox", required=True)
    run.add_argument("--timeout", required=True, type=float)
    run.add_argument("--probe-timeout", required=True, type=float)
    run.add_argument("--prompt-file", required=True)
    run.add_argument("command", nargs=argparse.REMAINDER)
    stop = commands.add_parser("cancel")
    stop.add_argument("--state-dir", required=True)
    stale = commands.add_parser("cleanup")
    stale.add_argument("--state-root", required=True)
    stale.add_argument("--stale-seconds", required=True, type=float)
    stale.add_argument("--max-delete", required=True, type=int)
    return root


if __name__ == "__main__":
    parsed = parser().parse_args()
    actions = {"run": run_round, "cancel": cancel, "cleanup": cleanup}
    sys.exit(actions[parsed.action](parsed))
