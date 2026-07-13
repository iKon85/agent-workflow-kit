/**
 * audit-refs.mjs — fail-closed publish guard: a shipped skill body must not
 * reference an executable (helper script / hook / git-hook) that the kit does
 * NOT ship. Such a reference is dangling-on-arrival in a consumer repo — the
 * skill instructs the agent to run something that was never installed.
 *
 * The gap this closes: neither the publish scrub (token-level) nor the
 * portability lint (board constants) nor build-kit.test (helpers *exist*) looks
 * at whether a skill body points at a script/hook absent from the bundle. A
 * skill edit that names `scripts/foo.py` shipped silently until a consumer hit
 * the dead path. This audit catches it at build time, at the source.
 *
 * Scope = executable references only. A `*.json` data file the kit instructs the
 * consumer to *seed* (e.g. max-lines-allowlist.json via /setup-workflow) is not
 * an executable and is intentionally out of scope. A pattern mention
 * (`*.guard.test.ts`) is not a concrete path and does not match.
 */

// Concrete executable paths a skill body could tell the agent to run. Both the
// `scripts/` and `.claude/hooks/` trees ship `.py` AND `.sh` helpers, so a body
// that names a non-shipped shell script dangles exactly like a Python one.
const EXEC_REF = /(?:scripts\/[\w.-]+\.(?:py|sh)|\.claude\/hooks\/[\w.-]+\.(?:py|sh)|\.githooks\/[\w.-]+)/g;

/**
 * Refs that are intentionally NOT shipped at the referenced path. Two legit
 * classes: (a) a documented INSTALL TARGET — the skill ships the source under
 * its own `scripts/` dir and instructs the consumer to copy it to a hook path,
 * so the hook path never ships; (b) debt — knowingly not-yet-shippable, tracked
 * for follow-up. Each entry MUST carry a reason so the carve-out is visible,
 * never silent. Keep class (b) shrinking — debt is not a destination.
 */
export const EXEMPT_REFS = {
  // (a) install target: git-guardrails ships the source at its own
  // scripts/block-dangerous-git.sh (skill-relative, shipped) and documents
  // copying it into the consumer's .claude/hooks/. The hook path is a destination.
  '.claude/hooks/block-dangerous-git.sh': 'install target; source ships at the skill\'s scripts/',
  // (a) install targets: setup-pre-commit ships the generic template at its own
  // scripts/pre-commit.template.sh and instructs the consumer to CREATE these
  // .githooks/ entries from it (wired via core.hooksPath). They never ship.
  '.githooks/pre-commit': 'install target; setup-pre-commit ships scripts/pre-commit.template.sh',
  '.githooks/pre-push': 'install target; optional heavy-gate hook the consumer creates',
};

/**
 * @param {(path: string) => (string|null)} readShipped  returns the shipped
 *   (scrubbed) body for a dist path, or null if it is not a scannable text file.
 * @param {Array<{path: string, kind: string}>} manifestFiles  the shipped set.
 * @returns {Array<{file: string, ref: string}>} violations (empty = clean).
 */
export function auditExecRefs(manifestFiles, readShipped) {
  const shipped = new Set(manifestFiles.map((f) => f.path));
  const violations = [];
  for (const f of manifestFiles) {
    if (f.kind !== 'skill' || !f.path.endsWith('.md')) continue;
    const body = readShipped(f.path);
    if (body == null) continue;
    // A `scripts/foo.sh` mention in a skill body may be skill-relative — the
    // helper bundles INSIDE the skill (`<skillDir>/scripts/foo.sh`), not at the
    // repo root. A ref is satisfied if EITHER the repo-root path OR the
    // skill-relative path ships. skillDir = the SKILL.md's directory.
    const skillDir = f.path.slice(0, f.path.lastIndexOf('/'));
    for (const ref of new Set(body.match(EXEC_REF) ?? [])) {
      if (shipped.has(ref) || shipped.has(`${skillDir}/${ref}`) || ref in EXEMPT_REFS) continue;
      violations.push({ file: f.path, ref });
    }
  }
  return violations;
}

// `from foo import …` / `import foo` — capture the top-level module name.
const PY_IMPORT = /^[ \t]*(?:from[ \t]+(\w+)[ \t]+import|import[ \t]+(\w+))/gm;

/**
 * Sibling guard: a shipped Python helper must not `import` a repo-local module
 * the kit does not ship (the bug that left drift-guard.py importing an unshipped
 * _hook_utils — invisible to the skill-body scan above). Scope = the repo's OWN
 * modules; third-party/stdlib names are not in `localModules`, so they are
 * ignored. Sub-dependencies ride along because their files ship too.
 *
 * @param {Array<{path: string}>} manifestFiles  the shipped set.
 * @param {(path: string) => (string|null)} readShipped
 * @param {Iterable<string>} localModules  basenames of the repo's own *.py modules.
 * @returns {Array<{file: string, module: string}>} violations (empty = clean).
 */
export function auditModuleImports(manifestFiles, readShipped, localModules) {
  const shippedMods = new Set(
    manifestFiles
      .filter((f) => f.path.endsWith('.py'))
      .map((f) => f.path.split('/').pop().replace(/\.py$/, '')),
  );
  const local = new Set(localModules);
  const violations = [];
  for (const f of manifestFiles) {
    if (!f.path.endsWith('.py')) continue;
    const body = readShipped(f.path);
    if (body == null) continue;
    for (const m of body.matchAll(PY_IMPORT)) {
      const mod = m[1] ?? m[2];
      if (local.has(mod) && !shippedMods.has(mod)) {
        violations.push({ file: f.path, module: mod });
      }
    }
  }
  return violations;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/**
 * Sibling guard #2: a shipped skill body must not reference (by skill name)
 * another skill the kit does NOT publish. That reference is dangling-on-arrival
 * — the consumer is told to invoke a skill that was never installed (the
 * `to-issues → codex-adapter-sync` class, before that skill was published).
 *
 * A "reference" is a NAME match in one of two unambiguous forms — a backtick
 * code span (`name` / `/name`) or a slash-command token (`/name`, not preceded
 * by a path char). Plain prose and path segments (`scripts/migrations/up`) do
 * NOT match, so a word that merely coincides with a skill name (the DB concept
 * "migrations") is ignored. Only names KNOWN to the manifest are candidates;
 * the violation fires only when that known name is NOT in the publish set.
 *
 * @param {Array<{path: string, kind: string, ownerSkill?: string}>} manifestFiles  shipped set.
 * @param {(path: string) => (string|null)} readShipped
 * @param {{known: Iterable<string>, published: Iterable<string>}} skills
 * @returns {Array<{file: string, skill: string}>} violations (empty = clean).
 */
export function auditSkillNameRefs(manifestFiles, readShipped, { known, published }) {
  const pub = new Set(published);
  // Only known-but-unpublished names can dangle. Each is matched on its own
  // delimiter boundary, so a name that is a substring of another (e.g. a skill
  // whose name prefixes a longer one) is not falsely subsumed.
  const danglers = [...new Set(known)].filter((n) => !pub.has(n));
  const violations = [];
  for (const f of manifestFiles) {
    if (f.kind !== 'skill' || !f.path.endsWith('.md')) continue;
    const body = readShipped(f.path);
    if (body == null) continue;
    for (const name of danglers) {
      const e = escapeRe(name);
      // backtick span `name`/`/name`  OR  slash-command /name not inside a path
      const re = new RegExp('`/?' + e + '`|(?<![\\w/-])/' + e + '(?![\\w-])');
      if (re.test(body)) violations.push({ file: f.path, skill: name });
    }
  }
  return violations;
}
