# Security-Audit Runbook — TEMPLATE

> **Copy this file into your project** (for example `docs/security/audit-runbook.md`),
> then replace every `<placeholder>` with your actual stack and delete the guidance
> lines. The `security-audit` skill is the *run procedure*; this runbook is the
> *checklist* it works through. The STRUCTURE below carries the value — keep all six
> Parts, fill them for your stack.
>
> **Scope: source code + config = the application layer only.** Infrastructure
> (firewall, exposed ports, TLS, SSH, backups) is audited **separately** — an exposed
> database port beats any code fix. Track the standing audit anchor issue in Part 0.

---

## Part 0 — Scope

Fill this once per project; re-confirm it each run (the attack surface moves).

| Question | Answer |
|---|---|
| **Public surface** | `<public URLs>` — which routes are reachable **unauthenticated** vs auth-gated. |
| **Trust boundary** (untrusted input) | `<HTTP body/query/params · file uploads · outbound fetch of user/admin-configured URLs · webhook payloads · SSE/websocket streams>` |
| **Crown jewels** | `<secrets/keys · third-party credentials · per-tenant data · the database · admin accounts>` |
| **Auth model** | `<session/token mechanism → authn gate → per-resource authorization → tenant/row scoping>` |
| **Deployment** | `<where it runs, which images/artifacts, what is internal-only, deploy trigger>` |
| **Tracking anchor** | `#<issue>` — the umbrella issue this audit's findings link under. |

---

## Part 1 — AI-runnable audit prompt

Open your AI code assistant (and a second, independent model — see Part 5) in the
repo root and paste a prompt shaped like this, tailored to your stack:

````text
You are performing a READ-ONLY security audit of THIS repository
(<framework> backend, <ORM> on <database>, <auth lib>, <frontend stack>,
<deploy platform>). Do NOT modify files.

For EACH checklist item: search the code (prefer ripgrep), report findings with an
exact `file:line`, classify severity (Critical/High/Medium/Low/Info), and give a
concrete fix. If an item does not apply, say "N/A" and why. End with a findings
table sorted by severity plus a "needs human verification" list.

Rules:
- Cite a real file:line for every finding. No finding without evidence
  (tag each: suspected / verified-with-evidence).
- Distinguish confirmed from suspected. Never claim a vuln you did not locate.
- Prefer a flagged false positive over a silent omission.

CHECKLIST: <paste the 12 headings from Part 2>
````

> The agent pass is a **lead generator, not a verdict**. Every finding is
> "suspected" until confirmed against the real code in Part 2.

---

## Part 2 — Manual checklist

Each section: **what & why**, **example commands** (swap in your paths/tools), a
**baseline** you record on the first run and re-verify every run (code moves), and a
**severity**. Read the surrounding code; never trust a grep hit alone. Anchor every
path from the repo root.

### 1. Secrets & credentials · **Critical**
- [ ] No secrets in tracked files **or git history** (treat any hit as compromised → **rotate**).
- [ ] Ignore files exclude `.env*`, key/credential files (from both VCS and the build image).
- [ ] Secrets read from the environment at runtime; no defaults baked into code.
- **Baseline:** `<record: committed secrets? history scanned? gaps + tracking issue>`

### 2. Authentication & authorization (IDOR + tenant scope) · **Critical**
- [ ] Every non-public route requires the authn guard, applied **before** the handler.
- [ ] Reads/writes verify the caller **owns / belongs to** the resource, not just "logged in".
- [ ] **Every** tenant-scoped query filters by `<tenant-scope column>` — no query forgets it.
- [ ] Admin routes check an admin role, not merely authentication.
- **Baseline:** `<record>`

### 3. Injection · **Critical**
- [ ] All DB access parameterized (query builder or bound params) — no user input concatenated.
- [ ] Any credential-decrypting / privileged DB function only ever receives bound params.
- [ ] No `child_process` / `exec` / `eval` / dynamic-code on untrusted data.
- **Baseline:** `<record — mark stack-irrelevant classes (NoSQL, templating, deserialization) N/A>`

### 4. XSS & output encoding · **High**
- [ ] User input rendered to HTML is escaped (most frameworks auto-escape by default).
- [ ] Any raw-HTML sink (`<raw-html API>`) is justified and sanitized if input is user-controlled.
- **Baseline:** `<record>`

### 5. Attack-surface & error exposure · **High**
- [ ] Generic 500s — no stack traces / internals returned to clients.
- [ ] CORS is an explicit allowlist; never `*` with credentials.
- [ ] Debug/test routes gated behind an env flag, off in production. No open redirects.
- [ ] Security headers present (`<header middleware / proxy config>`).
- **Baseline:** `<record>`

### 6. Input validation, uploads, path traversal, SSRF · **High**
- [ ] Request bodies validated against a schema, not trusted raw.
- [ ] Uploads enforce **type (real MIME, not just extension), size, safe path**; content scrubbed
      (for example spreadsheet formula injection on leading `=` `+` `-` `@` cells).
- [ ] No path traversal: user input never joined into a filesystem path without normalize + base-dir check.
- [ ] **SSRF:** any server-side fetch of a user/admin-supplied URL is allowlisted / blocks internal
      ranges (`169.254.169.254`, `localhost`, RFC1918).
- **Baseline:** `<record — SSRF and upload scrubbing are common blind spots; confirm this run>`

### 7. Auth tokens, sessions, cookies · **High**
- [ ] Session/token secret is strong and **from env**, never a hardcoded default.
- [ ] Cookies `HttpOnly` + `Secure` (prod) + `SameSite`; session invalidated on logout/deactivation.
- **Baseline:** `<record>`

### 8. Client-side / frontend leaks · **High**
- [ ] No secret/private key in any client-exposed env var or the shipped bundle (only public values).
- [ ] Source maps not deployed to prod (or access-restricted).
- [ ] Security enforced **server-side**; client checks are UX only.
- **Baseline:** `<record>`

### 9. Dependencies & supply chain · **High**
- [ ] No known-vulnerable deps; critical CVEs triaged.
- [ ] Dependencies pinned / lockfile committed.
- [ ] Automated alerts (Dependabot / Renovate / equivalent) enabled.
- **Baseline:** `<record + tracking issue for any automation gap>`

### 10. Config, logging & headers · **Medium**
- [ ] No default credentials anywhere (`user:user`, `admin:admin`, `changeme`, …).
- [ ] Secrets / tokens / PII never written to logs / error tracker / audit tables (sanitizer-covered).
- [ ] DB connects as a least-privilege user.
- **Baseline:** `<record>`

### 11. Repo & CI/CD hygiene · **Medium**
- [ ] Branch protection on the default branch; force-push disabled (or the local gate that stands in for it).
- [ ] 2FA on the org; write access + installed Apps/OAuth grants reviewed.
- [ ] Secret scanning in the commit/push gate.
- **Baseline:** `<record — name where the gate lives if you have no hosted required check>`

### 12. Container & image security · **High**
- [ ] **Non-root USER** in every Dockerfile.
- [ ] **Base image digest-pinned** (`@sha256:…`), not tag-only.
- [ ] No secrets in `ARG` / `ENV` / `RUN` (use build-time secret mounts or runtime env).
- [ ] Ignore file excludes `.git/`, `.env*`, keys (verify by listing the image, not trusting the file).
- [ ] Internal services **not published** to the host; only the proxy faces `0.0.0.0`; no docker socket mount.
- **Baseline:** `<record — mark N/A if you do not ship containers>`

---

## Part 3 — Tooling

Wire the fast scanners into your commit/push gate so the audit is continuous, not a
one-off. Swap in the tools your stack needs.

| Tool | Purpose | Quick start |
|------|---------|-------------|
| **gitleaks** | Secrets in tree **and git history** | `gitleaks detect --source . --redact` |
| **detect-secrets** | Pre-commit secret baseline | `detect-secrets scan > .secrets.baseline` |
| **semgrep** | Static analysis (injection / authz / XSS) | `semgrep --config auto .` |
| **trivy** | Vulns + secrets + IaC misconfig (also images) | `trivy fs --scanners vuln,secret,misconfig .` |
| **`<dep auditor>`** | Dependency CVEs | `<npm/pnpm/pip/... audit>` |

---

## Part 4 — Findings report template

Copy per run → `<docs/audits/YYYY-MM-security-audit/findings.md>` (date the folder per
run). **Severity:** Critical = fix today · High = this week · Medium = schedule ·
Low/Info = hygiene.

```markdown
# Security Audit — <project> — <YYYY-MM-DD> — auditor: <model A> + <model B>

Scope: <repo @ commit/branch>   Public surface: <…>   Crown jewels: <…>

## Summary
Critical: N   High: N   Medium: N   Low: N

## Findings
| # | Severity | Category | Location (file:line) | Issue | Fix | Verified-by | Status |
|---|----------|----------|----------------------|-------|-----|-------------|--------|
| 1 | High | Container | <Dockerfile> | runs as root | add USER | both | Open |

## Needs human verification
- <agent-flagged item, why unconfirmed, which model disagreed>

## Top 5 actions (by priority)
1. …
```

---

## Part 5 — Triage & the two-model run

Fix by **exploitability × impact**, not top-to-bottom:

1. **Secrets exposed** (§1, §8) → rotate immediately, then remove from code/history. Beats everything.
2. **Auth/authz holes** (§2) → IDOR / missing tenant scope leaks other tenants' data with no tooling.
3. **Injection** (§3) → SQL/command injection ≈ full data/host compromise.
4. **Exposed surface & XSS** (§5, §4) → debug routes, `*` CORS, reflected XSS.
5. **Everything else** (§6–§12) → validation, headers, deps, container, hygiene — defense-in-depth.

**One confirmed Critical outweighs ten Lows.** And remember: this is the *application*
layer — infrastructure is checked separately.

**The two-model run** is the `security-audit` skill's job: model A and model B work
this runbook independently and read-only, their findings are consolidated (disagreements
→ "needs human verification", never dropped), then the *remediation plan* is hardened
with a plan-review grill before any fix lands. This runbook is the *what*; the skill
drives the *how*.
