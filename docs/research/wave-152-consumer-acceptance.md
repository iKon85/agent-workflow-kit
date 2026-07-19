# Wave 152 consumer acceptance and release checklist

Verified on 2026-07-19 for candidate `52ea49856a03f6e4bb13f24913990769126f81a8`.

## Candidate

- Source repository: `iKon85/agent-workflow-kit`
- Candidate tarball: `/tmp/wave152-final-candidate.8CRnlP/ikon85-agent-workflow-kit-0.28.0.tgz`
- Extracted kit: `/tmp/wave152-final-package.QQTOvE/package/dist-kit`
- Disposable consumer checkout: `/tmp/wave152-testreporter.ZZg8zY/checkout`
- Consumer base: `iKon85/Testreporter` `origin/main` at
  `76bcaa91`

The temporary paths record the exact acceptance input. They are not release
artifacts; a repeat run creates fresh temporary directories and a fresh
test-only marker identity.

## Repeatable procedure

1. Build the kit from the candidate commit, create an npm tarball, extract it,
   and run its `kit:build`. Install that built kit into a disposable checkout
   of the consumer's current `origin/main`.
2. Run `scripts/codex-exec.sh new` with the `review` profile and `read-only`
   mode. Capture the opaque run ID, resume it for round 2, verify both rounds
   return `OK`, then finalize and verify that the run state is deleted.
3. Run `scripts/codex-exec.sh new` with the `build` profile and
   `workspace-write` mode. Ask it to create only an allowlisted ignored scratch
   file containing a fixed sentinel, verify the sentinel, finalize the run,
   and remove the scratch file.
4. Create a disposable consumer issue through `scripts/board-sync.py` with a
   unique `wave-stub-source` marker. Resolve it through
   `scripts/find-by-marker.py`, verify one exact match, move its board status to
   Done, close it, and repeat the lookup. The terminal lookup must report the
   closed/user-decision branch and an all-open scan must find zero disposable
   issues.

## Acceptance evidence

| Smoke | Evidence | Result |
|---|---|---|
| `codex-review` read-only | Real new round returned `OK` with a thread; resume round 2 returned `OK`; finalize deleted run state. | PASS |
| `codex-build` workspace-write | Created only ignored `_ai_temp/wave152-build-smoke.txt` with `WAVE152_BUILD_SMOKE_OK`; finalize succeeded; scratch file removed. | PASS |
| Marker roundtrip | Identity `wave-stub-source=awkit-wave152-20260719-acceptance-52ea498` created Testreporter issue #2168 through board-sync; exact lookup was unique; board status became Done; issue was closed; final lookup selected closed/user-decision; `openDisposable=0`. | PASS |

No open disposable issue or scratch file remained after acceptance. The closed
issue remains deliberate cleanup evidence and is excluded from open productive
work by the all-state lookup's closed/user-decision result.

## Counted surface census: 31 of 31

The denominator is re-derived from the current skill manifest and the delivery
surfaces, not from the changed-file list.

| Surface class | Derivation | Covered |
|---|---|---:|
| Skill surfaces | Nine records from `.claude/skills/skill-manifest.json`: four Claude-only Codex skills (4), three dual-surface marker callers (6), dual-surface `to-issues` (2), and dual-surface `wrapup` (2). The four Codex skills intentionally have no invented `.agents` mirrors. | 14/14 |
| Bundle registrations | The five Wave helpers in `HELPER_FILES`, with their declared kind and mode. | 5/5 |
| Checked manifest entries | The same five helpers in the freshly built and checked `agent-workflow-kit.package.json`. | 5/5 |
| Test surfaces | Harness scenarios, thin-skill lifecycle, marker library/CLI, anchor renderer/promotion, wrapup contradiction absence, and bundle/manifest/tarball modes. | 6/6 |
| Shared board callsite | `scripts/board-sync.py` imports and uses the shared marker parser instead of retaining a second grammar. | 1/1 |
| **Total** | **No unexplained gap.** | **31/31** |

The exact manifest-derived skill set is:

- Claude-only: `codex-review`, `codex-build`, `grill-me-codex`,
  `grill-with-docs-codex`.
- Dual-surface: `to-prd`, `to-waves`, `board-to-waves`, `to-issues`, `wrapup`.

The five helper modes are:

- `scripts/marker_lib.py` — `0644`
- `scripts/find-by-marker.py` — `0755`
- `scripts/codex-exec.sh` — `0755`
- `scripts/codex_proc.py` — `0644`
- `scripts/render-anchor.py` — `0755`

## Release checklist

- [x] K1-K5 integrated into one candidate.
- [x] K1, K2, and K4 passed independent Standards and Spec reviews.
- [x] Candidate tarball passed all three real consumer smokes.
- [x] Disposable consumer issue and scratch file cleaned up; no open disposable
      issue remains.
- [x] Bundle, built-manifest, and npm-tarball mode assertions cover all five
      helpers.
- [x] Surface census is 31 of 31 with zero unexplained gaps.
- [x] Prepared the user-authorized single minor bump from 0.28.0 to 0.29.0 and
      refresh checked release state.
- [x] `release:prepare -- --version 0.29.0` completed its release guard, full
      test suite, manifest rebuild, and dry-run npm pack.
- [x] Re-ran the full suite (354 Node tests and 277 Python tests),
      `kit:staleness` (`OK`), and `release:guard` (`OK (minor)`).
- [x] Created and extracted the final `0.29.0` npm tarball (380 package
      entries); all five helper modes matched both pack metadata and extracted
      filesystem modes.
- [ ] After merge, let the trusted release workflow publish and verify
      `npm run release:status` reports `released` before declaring the release
      complete.
