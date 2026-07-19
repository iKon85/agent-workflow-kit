#!/usr/bin/env bash
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROC_HELPER="$SCRIPT_DIR/codex_proc.py"
TESTED_VERSIONS=("0.137.0" "0.144.6")
STATE_ROOT=${CODEX_EXEC_STATE_ROOT:-${TMPDIR:-/tmp}/codex-exec-state}

emit_json() {
  python3 - "$@" <<'PY'
import json, sys
fields = {}
for pair in sys.argv[1:]:
    key, value = pair.split("=", 1)
    fields[key] = value
print(json.dumps(fields, sort_keys=True))
PY
}

fail() {
  local error=$1 message=$2 status=${3:-EXEC_FAILED}
  emit_json "status=$status" "error=$error" "message=$message"
  return 1
}

positive_number() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import math, sys
try:
    value = float(sys.argv[1])
    assert math.isfinite(value) and value > 0
except (ValueError, AssertionError):
    raise SystemExit(1)
PY
}

find_state() {
  local run_id=$1
  [[ $run_id =~ ^[A-Za-z0-9]+$ ]] || return 1
  local candidate="$STATE_ROOT/codex-exec.$run_id"
  [[ -d $candidate && -f $candidate/run-id ]] || return 1
  [[ $(<"$candidate/run-id") == "$run_id" ]] || return 1
  printf '%s\n' "$candidate"
}

preflight() {
  local codex_bin=$1 quiet=${2:-false} version_text version auth help resume_help platform allowed=false
  if [[ ! -x $codex_bin ]] && ! command -v "$codex_bin" >/dev/null 2>&1; then
    fail CODEX_NOT_FOUND "Codex executable not found"
    return 1
  fi
  version_text=$("$codex_bin" --version 2>&1) || {
    fail VERSION_CHECK_FAILED "Unable to read Codex version"
    return 1
  }
  version=${version_text##* }
  for tested in "${TESTED_VERSIONS[@]}"; do
    [[ $version == "$tested" ]] && allowed=true
  done
  if [[ $allowed != true ]]; then
    fail UNTESTED_VERSION "Codex version is not in the exact tested allowlist"
    return 1
  fi
  platform=$(uname -s)
  if [[ $platform != Linux && $platform != Darwin ]] || ! python3 -c 'import os; assert hasattr(os, "setsid")' >/dev/null 2>&1; then
    fail MISSING_CAPABILITY "Platform cannot create an owned process group"
    return 1
  fi
  help=$("$codex_bin" exec --help 2>&1) || true
  if [[ $help != *--json* || $help != *--sandbox* || $help != *resume* ]]; then
    fail MISSING_CAPABILITY "Codex exec lacks required JSON, sandbox, or resume capability"
    return 1
  fi
  resume_help=$("$codex_bin" exec resume --help 2>&1) || true
  if [[ $resume_help != *--config* || $resume_help != *--json* ]]; then
    fail MISSING_CAPABILITY "Codex exec resume lacks required config or JSON capability"
    return 1
  fi
  auth=$("$codex_bin" login status 2>&1) || {
    fail AUTH_REQUIRED "$auth" AUTH
    return 1
  }
  [[ $quiet == true ]] || emit_json status=OK "version=$version" "auth=$auth" "platform=$platform"
}

parse_options() {
  CODEX_BIN=codex PROFILE= MODE= SANDBOX= PROMPT= PROMPT_FILE= RUN_ID= TIMEOUT= PROBE_TIMEOUT= DEBUG_RETAIN=false
  while (($#)); do
    case $1 in
      --codex-bin|--profile|--mode|--prompt|--prompt-file|--run-id|--timeout|--probe-timeout)
        (($# >= 2)) || { fail INVALID_ARGUMENT "Missing value for $1"; return 1; }
        case $1 in
          --codex-bin) CODEX_BIN=$2 ;;
          --profile) PROFILE=$2 ;;
          --mode) MODE=$2 ;;
          --prompt) PROMPT=$2 ;;
          --prompt-file) PROMPT_FILE=$2 ;;
          --run-id) RUN_ID=$2 ;;
          --timeout) TIMEOUT=$2 ;;
          --probe-timeout) PROBE_TIMEOUT=$2 ;;
        esac
        shift 2 ;;
      --debug-retain) DEBUG_RETAIN=true; shift ;;
      *) fail INVALID_ARGUMENT "Unknown option: $1"; return 1 ;;
    esac
  done
}

prepare_prompt() {
  local state_dir=$1
  TEMP_PROMPT="$state_dir/.prompt-input"
  if [[ -n $PROMPT_FILE ]]; then
    [[ -f $PROMPT_FILE ]] || { fail PROMPT_NOT_FOUND "Prompt file not found"; return 1; }
    cp "$PROMPT_FILE" "$TEMP_PROMPT"
  elif [[ -n $PROMPT ]]; then
    printf '%s' "$PROMPT" >"$TEMP_PROMPT"
  else
    fail PROMPT_REQUIRED "A prompt or prompt file is required"
    return 1
  fi
  chmod 600 "$TEMP_PROMPT"
}

launch_round() {
  local state_dir=$1 round=$2 thread_id=${3:-} result rc
  prepare_prompt "$state_dir" || return 1
  local command
  if [[ -z $thread_id ]]; then
    command=("$CODEX_BIN" exec --json --sandbox "$SANDBOX" -)
  else
    command=("$CODEX_BIN" exec resume "$thread_id" -c "sandbox_mode=$SANDBOX" --json -)
  fi
  python3 "$PROC_HELPER" run --state-dir "$state_dir" --round "$round" \
    --profile "$PROFILE" --sandbox "$SANDBOX" --timeout "$TIMEOUT" \
    --probe-timeout "$PROBE_TIMEOUT" --prompt-file "$TEMP_PROMPT" -- "${command[@]}"
  rc=$?
  rm -f "$TEMP_PROMPT"
  result="$state_dir/round-$round.result.json"
  if [[ -f $result ]]; then
    python3 - "$result" "$state_dir" "$round" <<'PY'
import json, pathlib, sys
result = json.loads(pathlib.Path(sys.argv[1]).read_text())
state = pathlib.Path(sys.argv[2])
if result.get("threadId"):
    (state / "thread-id").write_text(result["threadId"] + "\n")
(state / "next-round").write_text(str(int(sys.argv[3]) + 1) + "\n")
PY
  fi
  return "$rc"
}

new_run() {
  parse_options "$@" || return 1
  PROFILE=${PROFILE:-review}
  MODE=${MODE:-read-only}
  [[ $PROFILE == review || $PROFILE == build ]] || { fail INVALID_PROFILE "Profile must be review or build"; return 1; }
  [[ $MODE != danger-full-access ]] || {
    fail DANGER_FULL_ACCESS_REJECTED "danger-full-access is not a supported lifecycle mode"; return 1;
  }
  [[ $MODE == read-only || $MODE == workspace-write ]] || {
    fail INVALID_MODE "Mode must be read-only or workspace-write"; return 1;
  }
  SANDBOX=$MODE
  [[ -n $PROMPT || -n $PROMPT_FILE ]] || { fail PROMPT_REQUIRED "A prompt or prompt file is required"; return 1; }
  TIMEOUT=${TIMEOUT:-$([[ $PROFILE == review ]] && echo 600 || echo 1800)}
  PROBE_TIMEOUT=${PROBE_TIMEOUT:-$([[ $PROFILE == review ]] && echo 30 || echo 60)}
  positive_number "$TIMEOUT" && positive_number "$PROBE_TIMEOUT" || {
    fail INVALID_TIMEOUT "Timeouts must be finite positive numbers"; return 1;
  }
  preflight "$CODEX_BIN" true || return 1
  mkdir -p "$STATE_ROOT" && chmod 700 "$STATE_ROOT"
  python3 "$PROC_HELPER" cleanup --state-root "$STATE_ROOT" \
    --stale-seconds "${CODEX_EXEC_STALE_SECONDS:-604800}" \
    --max-delete "${CODEX_EXEC_STALE_MAX_DELETE:-8}" || {
      fail STALE_CLEANUP_FAILED "Bounded stale-state cleanup failed"; return 1;
    }
  local state_dir run_id
  state_dir=$(mktemp -d "$STATE_ROOT/codex-exec.XXXXXXXX") || return 1
  chmod 700 "$state_dir"
  run_id=${state_dir##*.}
  printf '%s\n' "$run_id" >"$state_dir/run-id"
  printf '%s\n' "$PROFILE" >"$state_dir/profile"
  printf '%s\n' "$SANDBOX" >"$state_dir/sandbox"
  printf '1\n' >"$state_dir/next-round"
  chmod 600 "$state_dir"/*
  launch_round "$state_dir" 1
}

resume_run() {
  parse_options "$@" || return 1
  [[ -n $RUN_ID ]] || { fail RUN_ID_REQUIRED "Resume requires --run-id"; return 1; }
  local state_dir stored_sandbox thread_id round
  state_dir=$(find_state "$RUN_ID") || { fail RUN_NOT_FOUND "Run state does not exist"; return 1; }
  stored_sandbox=$(<"$state_dir/sandbox")
  PROFILE=$(<"$state_dir/profile")
  if [[ -n $MODE && $MODE != "$stored_sandbox" ]]; then
    fail MODE_MISMATCH "Resume mode differs from persisted mode"
    return 1
  fi
  SANDBOX=$stored_sandbox
  [[ -f $state_dir/thread-id ]] || { fail NO_THREAD "Run has no resumable thread" NO-THREAD; return 1; }
  thread_id=$(<"$state_dir/thread-id")
  round=$(<"$state_dir/next-round")
  TIMEOUT=${TIMEOUT:-$([[ $PROFILE == review ]] && echo 600 || echo 1800)}
  PROBE_TIMEOUT=${PROBE_TIMEOUT:-$([[ $PROFILE == review ]] && echo 30 || echo 60)}
  positive_number "$TIMEOUT" && positive_number "$PROBE_TIMEOUT" || {
    fail INVALID_TIMEOUT "Timeouts must be finite positive numbers"; return 1;
  }
  preflight "$CODEX_BIN" true || return 1
  launch_round "$state_dir" "$round" "$thread_id"
}

finish_run() {
  local action=$1; shift
  parse_options "$@" || return 1
  [[ -n $RUN_ID ]] || { fail RUN_ID_REQUIRED "$action requires --run-id"; return 1; }
  local state_dir
  state_dir=$(find_state "$RUN_ID") || { fail RUN_NOT_FOUND "Run state does not exist"; return 1; }
  if [[ $action == abort ]]; then
    python3 "$PROC_HELPER" cancel --state-dir "$state_dir" || {
      fail ABORT_FAILED "Owned process group did not stop"; return 1;
    }
  elif [[ -f $state_dir/runtime.json ]]; then
    fail ACTIVE_RUN "Use abort for an active run"
    return 1
  fi
  if [[ $DEBUG_RETAIN == false ]]; then
    rm -rf -- "$state_dir"
  else
    : >"$state_dir/debug-retain"
  fi
  emit_json status=OK "action=$action" "runId=$RUN_ID" "retained=$DEBUG_RETAIN"
}

handle_failure() {
  local result= fallback_run_id= result_set=false parsed kind resolved output cleanup_output cleanup_rc=0
  while (($#)); do
    case $1 in
      --result|--run-id)
        (($# >= 2)) || { fail INVALID_ARGUMENT "Missing value for $1"; return 1; }
        if [[ $1 == --result ]]; then
          result=$2
          result_set=true
        else
          fallback_run_id=$2
        fi
        shift 2 ;;
      *) fail INVALID_ARGUMENT "Unknown option: $1"; return 1 ;;
    esac
  done
  [[ $result_set == true ]] || { fail RESULT_REQUIRED "handle-failure requires --result"; return 1; }

  parsed=$(python3 - "$result" "$fallback_run_id" <<'PY'
import json
import sys

raw, fallback = sys.argv[1:]
known_statuses = {
    "OK", "AUTH", "CANCELLED", "HUNG", "TIMEOUT", "SIGNALLED",
    "EXEC_FAILED", "MALFORMED-JSON", "NO-THREAD", "NO-VERDICT",
}
try:
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError
    status = result.get("status")
    if not isinstance(status, str) or status not in known_statuses:
        raise ValueError
except (json.JSONDecodeError, ValueError):
    parsed = {
        "kind": "malformed",
        "resolved": fallback,
        "output": {
            "status": "MALFORMED_RESULT",
            "error": "MALFORMED_RESULT",
            "message": "Failure result was empty or malformed",
        },
    }
else:
    if status == "OK":
        parsed = {
            "kind": "ok",
            "resolved": "",
            "output": {
                "status": "EXEC_FAILED",
                "error": "RESULT_NOT_FAILED",
                "message": "handle-failure requires a non-OK result",
            },
        }
    else:
        malformed_fields = any(
            key in result and not isinstance(result[key], str)
            for key in ("error", "message")
        )
        result_run_id = result.get("runId")
        malformed_run_id = (
            "runId" in result
            and (
                not isinstance(result_run_id, str)
                or not result_run_id
                or not result_run_id.isascii()
                or not result_run_id.isalnum()
            )
        )
        if malformed_fields or malformed_run_id:
            parsed = {
                "kind": "malformed",
                "resolved": fallback,
                "output": {
                    "status": "MALFORMED_RESULT",
                    "error": "MALFORMED_RESULT",
                    "message": "Failure result was empty or malformed",
                },
            }
        else:
            output = result
            if result_run_id:
                resolved = result_run_id
            else:
                resolved = fallback
            parsed = {"kind": "failure", "resolved": resolved, "output": output}
print(json.dumps(parsed, separators=(",", ":"), sort_keys=True))
PY
  ) || {
    fail MALFORMED_RESULT "Failure result was empty or malformed" MALFORMED_RESULT
    return 1
  }
  kind=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["kind"])' "$parsed")
  resolved=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["resolved"])' "$parsed")
  output=$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["output"], separators=(",", ":"), sort_keys=True))' "$parsed")

  if [[ $kind != ok && -n $resolved ]]; then
    cleanup_output=$(finish_run abort --run-id "$resolved") || cleanup_rc=$?
    if ((cleanup_rc)); then
      output=$(python3 - "$output" "$cleanup_output" <<'PY'
import json
import sys

original = json.loads(sys.argv[1])
try:
    cleanup = json.loads(sys.argv[2])
except json.JSONDecodeError:
    cleanup = {}
original["cleanupStatus"] = "FAILED"
original["cleanupError"] = cleanup.get("error", "CLEANUP_FAILED")
original["cleanupMessage"] = cleanup.get("message", "Run cleanup failed")
print(json.dumps(original, separators=(",", ":"), sort_keys=True))
PY
      )
    fi
  fi
  printf '%s\n' "$output"
  return 1
}

dispatch_run_id_action() {
  local action=$1; shift
  if (($#)) && [[ $1 != --* ]]; then
    local positional_run_id=$1; shift
    if [[ $action == resume ]]; then
      resume_run --run-id "$positional_run_id" "$@"
    else
      finish_run "$action" --run-id "$positional_run_id" "$@"
    fi
  elif [[ $action == resume ]]; then
    resume_run "$@"
  else
    finish_run "$action" "$@"
  fi
}

main() {
  local action=${1:-}
  [[ -n $action ]] || { fail ACTION_REQUIRED "Expected preflight, new, resume, finalize, abort, or handle-failure"; return 1; }
  shift
  case $action in
    preflight) parse_options "$@" && preflight "$CODEX_BIN" ;;
    new) new_run "$@" ;;
    resume|finalize|abort) dispatch_run_id_action "$action" "$@" ;;
    handle-failure) handle_failure "$@" ;;
    *) fail INVALID_ACTION "Unknown action: $action" ;;
  esac
}

main "$@"
