# Wave Report Contracts

`src/lib/reportValidator.mjs` is the source of truth. The JSON blocks below are
machine-checked mirrors for hosts that must inline a schema and cannot import the
module. Do not edit a block without changing the exported constant first.

## Recon report

Required fields: <!-- fields:recon -->sliceId, plannedFiles, dependencyEdges

`plannedFiles[].role` is `edit`, `consume`, or `sharedMutable`.
`dependencyEdges` records directed slice dependencies as `from`/`to` IDs.

<!-- schema:recon:start -->
```json
{"type":"object","required":["sliceId","plannedFiles","dependencyEdges"],"additionalProperties":false,"properties":{"sliceId":{"type":"string","pattern":"^[0-9]+$"},"plannedFiles":{"type":"array","items":{"type":"object","required":["path","role"],"additionalProperties":false,"properties":{"path":{"type":"string"},"role":{"type":"string","enum":["edit","consume","sharedMutable"]}}}},"dependencyEdges":{"type":"array","items":{"type":"object","required":["from","to"],"additionalProperties":false,"properties":{"from":{"type":"string","pattern":"^[0-9]+$"},"to":{"type":"string","pattern":"^[0-9]+$"}}}}}}
```
<!-- schema:recon:end -->

## Builder report

Required fields: <!-- fields:builder -->status, filesTouched, testDecisions, commands, commitSha, stopItems, visualVerify

`status` discriminates the `oneOf`: PASS requires a full Git object ID and an
empty `stopItems`; STOP requires at least one stop item and permits a null SHA.
Schema validation intentionally accepts nonzero command exits. The orchestrator
must additionally call `semanticVerify` before accepting PASS.

<!-- schema:builder:start -->
```json
{"type":"object","required":["status","filesTouched","testDecisions","commands","commitSha","stopItems","visualVerify"],"additionalProperties":false,"properties":{"status":{"type":"string","enum":["pass","stop"]},"filesTouched":{"type":"array","items":{"type":"string"}},"testDecisions":{"type":"array","items":{"type":"string"}},"commands":{"type":"array","items":{"type":"object","required":["command","exitCode","summary"],"additionalProperties":false,"properties":{"command":{"type":"string"},"exitCode":{"type":"integer"},"summary":{"type":"string"}}}},"commitSha":{"anyOf":[{"type":"string","pattern":"^[0-9a-f]{40}$|^[0-9a-f]{64}$"},{"type":"null"}]},"stopItems":{"type":"array","items":{"type":"string"}},"visualVerify":{"type":"string"}},"oneOf":[{"required":["status","commitSha","stopItems"],"properties":{"status":{"const":"pass"},"commitSha":{"type":"string","pattern":"^[0-9a-f]{40}$|^[0-9a-f]{64}$"},"stopItems":{"type":"array","maxItems":0}}},{"required":["status","commitSha","stopItems"],"properties":{"status":{"const":"stop"},"commitSha":{"anyOf":[{"type":"string","pattern":"^[0-9a-f]{40}$|^[0-9a-f]{64}$"},{"type":"null"}]},"stopItems":{"type":"array","minItems":1}}}]}
```
<!-- schema:builder:end -->

## Semantic facts

Call `semanticVerify(report, { gitFacts, allowlist, requiredCommands })` with
independently collected Git facts: `objectFormat` (`sha1` or `sha256`), the
resolved `commitSha`, `baseIsAncestorOfCommit`, and `changedFiles`. The ancestry
fact means the integration base is an ancestor of the builder commit. The helper
verifies the full SHA against the repository object format and resolved commit, diff subset,
required command presence, command exits for PASS, and PASS/STOP exclusivity.
