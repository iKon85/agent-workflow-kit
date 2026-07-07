---
name: security-audit
description: Run the whole application's security audit as an independent two-model pass — two AI models audit the same code separately — then harden the remediation plan before any fix lands. Use when the user wants a security audit / security review of the entire app ("audit the app for vulnerabilities", "is the app secure", "security check before release"), before a release, or after the attack surface changes (new endpoint, new input source, auth change, dependency bump). NOT for reviewing a single diff/PR (that is a code review) and NOT for infrastructure hardening (firewall/ports/TLS/SSH/backups — audited separately from the application layer).
---

# security-audit — application-layer security audit (two-model run)

Application-layer security audit of the whole repo. This skill is the **run
procedure**; the checklist itself lives in a **runbook you own per project**. The
generic runbook structure ships as a template you copy and fill:
**`docs/agents/security-audit-runbook-template.md`** — copy it into your project
(for example `docs/security/audit-runbook.md`), replace each `<placeholder>` with
your actual stack, and keep it as the checklist single source of truth. Read your
filled runbook first.

**Scope guard:** code + config only. Infrastructure (firewall, exposed ports,
TLS, SSH, backups) is audited **separately** — an exposed database port beats any
code fix. Keep the two audits apart.

## Workflow — two-model run

Run in a **fresh session** (token hygiene). Anchor the campaign to a single
tracking issue (an umbrella / cluster issue); open a new one per fresh audit.

1. **Model-A pass (read-only).** Work the runbook's audit prompt → a findings
   table with exact `file:line`, a severity, and a confirmed/suspected tag on
   every finding. Cite real evidence — never claim a vulnerability you did not
   locate in the code; prefer a flagged false positive over a silent omission.
   Write it to a scratch file.
2. **Model-B pass (read-only, independent).** Hand a *second* model the **same**
   prompt in its own read-only sandbox. A second model refutes the first model's
   false positives and catches what it missed — that independence is the whole
   point. Generic operational gotchas when the second model is Codex:
   - **Fresh session — never resume an existing one** during a parallel run:
     context bleeds across sessions and you get hallucinated, off-topic verdicts.
   - **Do not pipe the `--json` event stream through `grep`** (it can hang) —
     write the raw json to a file and parse the thread id separately.
   - The sandbox sees only tracked files; if you run it inside a git worktree,
     copy any hook config into the worktree, or it fails closed to deny-all.
3. **Consolidate.** Merge both passes into one report (the runbook's findings
   template). Where the two models **disagree**, the finding goes onto a "needs
   human verification" list — it is **never silently dropped**. Each finding keeps
   its confirmed/suspected tag together with its evidence.
4. **Harden the remediation plan.** Draft a remediation plan (which gaps, what
   fix, what order, what blast radius), then grill **the plan** with a plan-review
   pass: a relentless interview on scope and priority plus an adversarial
   second-model review of the plan until it is approved. The audit produced the
   *what*; the grill hardens the *how*. A human signs off before any code is
   touched. (Your project layer names the concrete plan-review skill.)
5. **Fix by slices.** Each confirmed gap → its own issue → a worktree → a
   test-first fix → live-verify → a PR linked under the tracking anchor. Tick the
   anchor's checklist on merge. Gaps discovered mid-fix → filed as their own
   issue, linked under the same anchor.

## Why two models + a grill

Security findings are the textbook "plausible-but-wrong" case — one model's miss
or false positive is expensive to catch later. An independent second model is
cheap adversarial verification; grilling the plan stops over- or under-fixing
before any code is touched.

## Project layer

Your project's runbook (copied from the template above) carries the stack-coupled
checklist — the concrete framework, ORM, auth library, and deploy platform, and
the exact commands to run. The standing tracking anchor and any category / board
wiring live there too, not in this generic skeleton.
