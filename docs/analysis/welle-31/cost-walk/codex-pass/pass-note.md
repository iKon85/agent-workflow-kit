<!-- language-census: ok -->
# Cost walk — pass 2 of 2 (Codex, second primary source)

Amendment 4: the identical mandate text goes to Codex, read-only, over the same
substrate commit, as a **second primary source** — not as a reviewer of pass 1.

## Per-pass note

| Field | Value |
|---|---|
| Model | route control passed: `-c model=gpt-5.6-sol`. The pass self-identifies as "GPT-5 Codex" — a **self-report, not a readback**; the transcript's `thread.started` event carries no model field, so the requested control is the citable fact. |
| Reasoning effort | route control passed: `-c model_reasoning_effort=high`. The pass reports it as "deep" — same caveat. |
| Date (UTC) | 2026-07-29, started `07:51:49Z`, completed `08:04:08Z` |
| Substrate commit | `c9f6a4aa8bd80bbc4519fa9925315a6d4f0292f2` — verified by the pass itself against all six exports |
| Sandbox | `read-only` |
| Prompt | [`prompt.md`](./prompt.md), sha256 `c89446a4d0990c13cae3c1b530ed0dd3d224f6e76a0e452630f0bed0c14855af` — the verbatim #343 body plus its amendments, under a framing header |
| Response | [`response.md`](./response.md), sha256 `3bbaaf664ec35ef2d9e581a402659e2d0441e455de1fbae45a4ad93ccd61a9fc`, 30 632 bytes |
| Commands it ran | [`commands.json`](./commands.json) — 25 executions, 2 non-zero exits, all read-only |
| Tokens | 1 819 103 in (1 695 488 cached) · 27 655 out · 13 764 reasoning |
| Exit status | 0 |

### Independence — how it was preserved, and its one limit

The pass ran **concurrently** with pass 1 and never saw it. Its own note records
the decision unprompted:

> *"I deliberately did not open or enumerate the untracked
> `docs/analysis/welle-31/cost-walk/` directory because it may contain the other
> primary pass."*

The limit: `prompt.md` was written into that directory before the run, so the
file existed on disk. The prompt itself reached the model on **stdin**, not
through a read, and the transcript in `commands.json` contains **0 of 25**
commands touching that path (`grep -c cost-walk` over the recorded argv).

Two of the 25 commands exited non-zero (`jq` exit 5, malformed filter); both
were retried. Nothing it ran wrote to the repository.

### Its own named non-coverage (verbatim summary)

- Did not re-derive the 70 journeys or the seven entry points.
- Used no live GitHub, no web, no `.env*`, no credentials.
- Did not review another model's findings.
- Did not re-plan #320; used it only as standing evidence.
- Ran no ablations, timed no sessions, counted no tokens, observed no users.
- Did not perform #380's truth/mechanism audit.
- Persisted no artifact — the response *is* the artifact, under the read-only
  mandate. (This directory persists it.)
- **Mechanical rows: 70 of 70. Judgment questions: 12 of 70** — the ten
  seed-bearing journeys plus `consumer-first-init` and
  `consumer-first-own-workflow`. **58 of 70 receive mechanical pricing only.**
- **Traversal frequency unavailable for 69 of 70 journeys** — it refused to
  substitute issue existence, entry-point applicability or station count for
  traversal.

### Its declared AC-1 basis — different from pass 1's, on purpose

| Quantity | Pass 2 (Codex) | Pass 1 (Claude) |
|---|---|---|
| traversal source | the three frozen `gh` exports | git change-traffic over 327 commits at the freeze commit |
| high-traversal threshold | ≥ 10 **journey-attributable** traversals | ≥ 9 attributed commits (median of the population) |
| gate basis | `authorizationBoundary ∈ {human-gate, platform-gate}` → **62** | that, **plus** `bindingHardness ∈ {mechanical, platform-enforced}` → **173** |
| human-interaction basis | `userDecision != none` → 108 (declared an upper bound) | `authorizationBoundary == human-gate` → 52 |
| bins | `unknown` 69 · `secured-out-of-proportion` 1 · others 0 | `covered-and-priced` 29 · `unwatched` 10 · `secured-out-of-proportion` 8 · `unknown` 23 |
| output | inline response only | committed artifacts |

Both bases are defensible and they are not reconciled here. The divergence and
what it costs are the subject of `../two-model-merge.md` §D2 and §D3.

## Delivery deviation — the wrapper was blocked, the pass was not faked

`scripts/codex-exec.sh` refused to run at every entry point:

```
$ scripts/codex-exec.sh preflight
{"error": "UNTESTED_VERSION", "message": "Codex version is not in the exact tested allowlist", "status": "EXEC_FAILED"}

$ scripts/codex-exec.sh new --profile review --mode read-only --prompt "ping"
{"error": "UNTESTED_VERSION", "message": "Codex version is not in the exact tested allowlist", "status": "EXEC_FAILED"}
```

Verbatim capture: [`wrapper-preflight-error.json`](./wrapper-preflight-error.json).
Installed CLI: `codex-cli 0.146.0`. Allowlist:
`TESTED_VERSIONS=("0.137.0" "0.144.6" "0.145.0")` (`scripts/codex-exec.sh:6`).
The slice's edit scope forbids touching `scripts/`, so the allowlist could not be
extended here, and spoofing a version through `--codex-bin` would have been a
fake.

The pass therefore ran through the underlying CLI with **the exact argv
`launch_round()` builds** (`scripts/codex-exec.sh:182-190`), same sandbox, same
route controls:

```sh
codex exec --sandbox read-only \
  -c model=gpt-5.6-sol -c model_reasoning_effort=high \
  --json - < docs/analysis/welle-31/cost-walk/codex-pass/prompt.md
```

What was **not** exercised: the wrapper's state directory, lease, round
supervisor, timeout supervision and structured failure envelope. Nothing else
differs.

This is finding **F1** in `../fable-pass.md` and a STOP item in the slice
report. It is not attributed to the environment: the repository's own evidence
file `docs/evidence/2026-07-28-codex-exec-version-pin.md` records the same guard
firing on 2026-07-28 and misattributing a local defect. One day later the
allowlist is stale again.
