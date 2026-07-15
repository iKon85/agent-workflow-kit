# Wave 43 script and hook census

Verified on 2026-07-15 against `agent-workflow-kit` commit
`2d47dce23d9204b44951334c3c370bdb997c0943` and Testreporter commit
[`458747ebe8d67f66840cb3c1e75284cf2be7fb20`](https://github.com/iKon85/Testreporter/tree/458747ebe8d67f66840cb3c1e75284cf2be7fb20).
This is the research input for issue #59. It records facts only; it does not make
ship, opt-in, profile-seam, or maintenance decisions.

## Method and reconciliation

The public-repository denominator is every tracked file below `scripts/**` and
`.claude/hooks/**`, excluding `test_*.py`, `*.test.mjs`, and the metadata file
`scripts/.npmignore`. The recount is:

```text
68 tracked entries
- 31 tests
-  1 metadata file
= 36 current script/hook entries
= 32 scripts + 4 hooks
= 30 shipped helpers + 6 maintainer-only helpers
```

The shipped/helper split is derived from
[`src/lib/bundle.mjs`](../../src/lib/bundle.mjs), whose `HELPER_FILES` list is
the public distribution authority. The historical input is the 26-candidate
list in [Testreporter #1976](https://github.com/iKon85/Testreporter/issues/1976),
originally reconciled as 11 portable plus 15 generalize-first candidates in
[Testreporter #1964](https://github.com/iKon85/Testreporter/issues/1964).

Fresh exact-path comparison:

```text
Historical candidates:                       26/26 accounted for
Still present at the exact Testreporter path: 26/26
Present at the exact public-repo path:         0/26
Proven exact rename in the public repo:        0/26
Explicitly retired by a locked decision:       0/26
```

Therefore every historical row is classified as **present in the current
consumer and absent from the current public denominator**. Related public
primitives are called out only as inputs to the later grill; similarity is not
treated as proof of a rename or as a ship decision.

## Fresh public denominator: 36 of 36

| Current path | Distribution status |
|---|---|
| `.claude/hooks/_hook_utils.py` | shipped helper |
| `.claude/hooks/drift-guard.py` | shipped helper |
| `.claude/hooks/skill-drift-hint.py` | shipped helper |
| `.claude/hooks/sync-board-status.py` | shipped helper |
| `scripts/anchor_table.py` | shipped helper |
| `scripts/board-sync.py` | shipped helper |
| `scripts/board_config.py` | shipped helper |
| `scripts/board_fields.py` | shipped helper |
| `scripts/build-kit.mjs` | maintainer-only |
| `scripts/census/delta.mjs` | shipped helper |
| `scripts/census/fingerprint.mjs` | shipped helper |
| `scripts/census/index.mjs` | shipped helper |
| `scripts/census/scan.mjs` | shipped helper |
| `scripts/census/state.mjs` | shipped helper |
| `scripts/census/transaction.mjs` | shipped helper |
| `scripts/check-kit-staleness.mjs` | maintainer-only |
| `scripts/execute-ready-check.py` | shipped helper |
| `scripts/grill-census-wiring-guard.mjs` | maintainer-only |
| `scripts/issue_deps.py` | shipped helper |
| `scripts/kit-release.mjs` | shipped helper |
| `scripts/kit-update-pr.mjs` | shipped helper |
| `scripts/lib/audit-refs.mjs` | maintainer-only |
| `scripts/lib/scrub.mjs` | maintainer-only |
| `scripts/loc_offender_core.py` | shipped helper |
| `scripts/loc_offender_gate.py` | shipped helper |
| `scripts/node_kind.py` | shipped helper |
| `scripts/portability_profile_scan.py` | maintainer-only |
| `scripts/pr-body-check.py` | shipped helper |
| `scripts/program_graph.py` | shipped helper |
| `scripts/program_graph_parse.py` | shipped helper |
| `scripts/program_graph_validate.py` | shipped helper |
| `scripts/program_sync.py` | shipped helper |
| `scripts/release-delta-guard.mjs` | shipped helper |
| `scripts/release-parity.mjs` | shipped helper |
| `scripts/release-state.mjs` | shipped helper |
| `scripts/wrapup-land.py` | shipped helper |

## Historical candidate crosswalk: 26 of 26

All Testreporter links below are pinned to the verified consumer commit. “No
dedicated tracked test found” means the fresh tracked-tree search found no test
named for that candidate; it is not a statement about runtime correctness.

| Historical candidate | Current public status and adjacent evidence | Current consumer dependency | Existing consumer test evidence |
|---|---|---|---|
| `scripts/audit_gate.py` | Exact path absent. | [`package.json#L44`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/package.json#L44) and `.githooks/pre-push` invoke it. | [`scripts/test_audit_gate.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/scripts/test_audit_gate.py), [`scripts/test_pre_push_audit_gate.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/scripts/test_pre_push_audit_gate.py) |
| `scripts/cleanup-worktrees.sh` | Exact path absent. Public `scripts/wrapup-land.py` has adjacent worktree-cleanup behavior, not a proven rename. | No separate tracked consumer found beyond direct/manual use. | No dedicated tracked test found. |
| `scripts/install-git-hooks.sh` | Exact path absent. | [`package.json#L45`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/package.json#L45) invokes it during postinstall. | [`scripts/test_install_git_hooks.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/scripts/test_install_git_hooks.py) |
| `scripts/ensure-gitleaks.sh` | Exact path absent. | [`package.json#L45`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/package.json#L45) invokes it during postinstall; `docs/security/secret-scan.md` documents it. | No dedicated tracked test found. |
| `.claude/hooks/block-bg-double-background.py` | Exact path absent. | [`.claude/settings.json#L85`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L85) wires it. | [`.claude/hooks/test_block_bg_double_background.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_block_bg_double_background.py) |
| `.claude/hooks/block-npm-install-in-pnpm.py` | Exact path absent. | [`.claude/settings.json#L75`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L75) wires it. | [`.claude/hooks/test_block_npm_install_in_pnpm.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_block_npm_install_in_pnpm.py) |
| `.claude/hooks/block-secrets.py` | Exact path absent. | [`.claude/settings.json#L56-L65`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L56-L65) wires it at two hook events. | [`.claude/hooks/test_block_secrets_smoke.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_block_secrets_smoke.py) |
| `.claude/hooks/branch-watch.py` | Exact path absent. | [`.claude/settings.json#L161`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L161) wires it. | [`.claude/hooks/test_branch_watch_smoke.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_branch_watch_smoke.py) |
| `.claude/hooks/grep-shim-guard.py` | Exact path absent. | [`.claude/settings.json#L80`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L80) wires it. | [`.claude/hooks/test_grep_shim_guard.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_grep_shim_guard.py) |
| `.claude/hooks/recon-size-hint.py` | Exact path absent. | [`.claude/settings.json#L134`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L134) wires it. | [`.claude/hooks/test_recon_size_hint.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_recon_size_hint.py) |
| `.claude/hooks/loc-offender-forewarn.py` | Exact path absent. Public `scripts/loc_offender_core.py` and `scripts/loc_offender_gate.py` are related shipped primitives, not a proven rename. | [`.claude/settings.json#L18`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L18) wires it. | [`scripts/test_loc_offender_forewarn.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/scripts/test_loc_offender_forewarn.py) |
| `scripts/bump-version.sh` | Exact path absent. Public `scripts/kit-release.mjs` contains tested SemVer and metadata-update behavior, not a proven rename. | No separate consumer wiring found; the script is directly invoked. | No dedicated tracked test found for the historical script. |
| `scripts/consolidate-memories.sh` | Exact path absent. | The two historical memory templates name it as their consolidator. | No dedicated tracked test found. |
| `scripts/memory-templates/meta_decision_layer_choice.md` | Exact path absent. | Input consumed by `scripts/consolidate-memories.sh`. | No dedicated tracked test found. |
| `scripts/memory-templates/meta_memory_lifecycle.md` | Exact path absent. | Input consumed by `scripts/consolidate-memories.sh`. | No dedicated tracked test found. |
| `scripts/setup-worktree.sh` | Exact path absent. Public workflow prose allows a project helper or plain `git worktree add`; that is not a rename. | Central Testreporter worktree, port, and local-env setup primitive referenced by workflow documentation. | [`scripts/setup-worktree.test.mjs`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/scripts/setup-worktree.test.mjs), [`scripts/test_pre_push_loc_gate.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/scripts/test_pre_push_loc_gate.py) |
| `.claude/hooks/baseline-capture-hint.py` | Exact path absent. | [`.claude/settings.json#L114`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L114) wires it. | [`.claude/hooks/test_baseline_capture_hint_smoke.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_baseline_capture_hint_smoke.py) |
| `.claude/hooks/branch-context.py` | Exact path absent. | [`.claude/settings.json#L13`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L13) wires it. | [`.claude/hooks/test_branch_context_smoke.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_branch_context_smoke.py) |
| `.claude/hooks/convention-drift-hint.py` | Exact path absent. Public `.claude/hooks/skill-drift-hint.py` and `drift-guard.py` are narrower adjacent mechanisms, not proven renames. | [`.claude/settings.json#L33`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L33) and rule `SOURCES.txt` files refer to it. | No dedicated tracked test found. |
| `.claude/hooks/enforce-worktree.py` | Exact path absent. | [`.claude/settings.json#L109`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L109) wires it. | [`.claude/hooks/test_enforce_worktree.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_enforce_worktree.py) |
| `.claude/hooks/enforce-worktree-cwd.py` | Exact path absent. | [`.claude/settings.json#L95`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L95) wires it. | [`.claude/hooks/test_enforce_worktree_cwd_smoke.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_enforce_worktree_cwd_smoke.py) |
| `.claude/hooks/enforce-worktree-discipline.py` | Exact path absent. | [`.claude/settings.json#L70`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L70) wires it. | [`.claude/hooks/test_enforce_worktree_discipline_smoke.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_enforce_worktree_discipline_smoke.py) |
| `.claude/hooks/migration-snapshot-reminder.py` | Exact path absent. | [`.claude/settings.json#L166`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L166) wires it. | [`.claude/hooks/test_migration_snapshot_reminder_smoke.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_migration_snapshot_reminder_smoke.py) |
| `.claude/hooks/pre-refactor-sweep.py` | Exact path absent. | [`.claude/settings.json#L23`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L23) wires it. | [`.claude/hooks/test_pre_refactor_sweep.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_pre_refactor_sweep.py) |
| `.claude/hooks/typecheck-on-stop.sh` | Exact path absent. | [`.claude/settings.json#L145`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L145) wires it. | No dedicated tracked test found. |
| `.claude/hooks/slice-handoff-hint.py` | Exact path absent. | [`.claude/settings.json#L44`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/settings.json#L44) wires it. | [`.claude/hooks/test_slice_handoff_hint_smoke.py`](https://github.com/iKon85/Testreporter/blob/458747ebe8d67f66840cb3c1e75284cf2be7fb20/.claude/hooks/test_slice_handoff_hint_smoke.py) |

## Inputs for the decision grill

The crosswalk establishes the decision set but intentionally leaves its verdict
columns blank. Issue #59 must decide, with the user, each row’s outcome, opt-in,
profile seam, security and maintenance cost, and ship verdict. In particular,
the adjacent public primitives identified above must be compared behaviorally
before any row is called replaced, redundant, or already shipped.
