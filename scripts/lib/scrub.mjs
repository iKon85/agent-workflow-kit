/**
 * scrub(text) — publish-time transforms that strip project-private tokens and
 * internal issue/HR references from a skill/script/doc BODY before it lands in
 * dist-kit. Pure function; the SOURCE is never modified (build-kit feeds it file
 * contents, PLAN scrub model). Generated credit files (LICENSE / NOTICES) are
 * NOT scrubbed — build-kit excludes them (Codex R1#2) so legitimate
 * maintainer/upstream names survive there.
 *
 * Three transform classes (PLAN Step 11):
 *   (a) private identity tokens   → neutral placeholders
 *   (b) internal #NNN / HRn refs  → removed, with ONE adjacent space
 *   (c) project-coupled ../ paths → project-root convention
 *
 * DESIGN — no global whitespace/punctuation normalization. An early version
 * collapsed all double-spaces (corrupting ASCII diagrams + aligned tables),
 * trimmed spaces before any `.` (corrupting `an .env`), and removed empty parens
 * (which would nuke code `()` like `build_parser()`). Instead each removal eats
 * exactly one adjacent space, and the ref-only-paren rule consumes COMPOUND refs
 * (`HR7/8`, `#1010/#971`) so it never leaves an empty `()` behind. Pre-existing
 * whitespace in untouched text is preserved verbatim.
 *
 * Negatives that MUST survive (tested): `#<n>` / `<issue-number>` placeholders,
 * hex colors (`#0f172a`, `#dc2626`, and the all-digit `#454E60` / `#123456`),
 * shell comments (`# foo`), code `#{issue}` interpolations and `()`. The
 * `{3,5}`-digit bound on issue refs plus the trailing `\b` are what keep those
 * out of the match set: a hex whose digits run into a letter or into a 6th digit
 * can no longer donate a 3-5 digit prefix to the match. The residual, inherent
 * collision is a 3- or 4-character ALL-DIGIT hex (`#123`, `#1234`) — that is
 * character-for-character an issue ref and no rule can tell them apart.
 *
 * The fail-closed publish audit (Step 13) is the backstop: any residual ref or
 * private token fails the build, so an imperfect scrub never leaks silently.
 */

// Issue ref, incl. slash-joined. The trailing `\b` is load-bearing: without it
// `#454E60` / `#123456` (all-digit hex colors) donate their first 3-5 digits to
// the match, and rule (b1b) then eats the CSS `:` with them (`--door-text:#454E60`
// → `--door-textE60`). `\b` requires the digit run to END the token, so a hex that
// continues into a letter or a 6th digit no longer matches at all.
const ISSUES = String.raw`#\d{3,5}\b(?:\s*/\s*#?\d{3,5}\b)*`;
const REF = String.raw`(?:#\d{3,5}\b|HR\d+)(?:/\d+)*`;      // issue OR HR, compound
// Provenance cross-refs a kit consumer cannot resolve (no docs/adr, no wave
// history). Stripped ONLY in citation position (a ref-only parenthetical) so
// bare-prose fixtures/examples ("Welle 1 covers 9 slices", "contradicts
// ADR-0007 — but", the `Welle 7 — X` parser example) survive untouched — those
// are NOT citation-shaped. Kept in sync with the publish audit's PROVENANCE_DENY.
// BOTH ADR spellings count: `ADR-0009` and `ADR 0009` are the same citation, and
// accepting only the hyphen let the spaced form ship unresolvable to consumers.
const PROV = String.raw`(?:ADR[ -]\d{3,4}|Welle \d+|Slice \d+[a-z]?)`;
// Any internal ref token — the union consumed inside a ref-only parenthetical.
const ANYREF = String.raw`(?:#\d{3,5}\b|HR\d+(?:/\d+)*|${PROV})`;

// (a) -----------------------------------------------------------------------
function privateTokens(s) {
  return s
    // deploy domains first (they contain "testreporter") → neutral domain
    .replace(/(?:[a-z0-9-]+\.)*iverra\.de/g, '<your-app-domain>')
    // repo slug before bare owner/repo
    .replace(/iKon85\/Testreporter/g, '<owner>/<repo>')
    // home memory path — both `~/` and `$HOME/` forms; the project slug
    // (`-home-<user>-projects-<project>`) leaks the username, so the WHOLE slug
    // is replaced (before the bare lowercase rule touches it).
    .replace(/(~|\$HOME)(\/\.claude\/projects\/)[^/\s)`]+(\/memory)/g, '$1$2<project>$3')
    .replace(/\bCoolify\b/g, 'your deploy platform')
    .replace(/\biKon85\b/g, '<owner>')
    .replace(/\bTestreporter\b/g, '<repo>')
    .replace(/\btestreporter\b/g, '<project>')
    .replace(/\bNikos\b/g, '<maintainer>s')         // German genitive before bare
    .replace(/\bNiko\b/g, '<maintainer>');
}

// (b) -----------------------------------------------------------------------
function internalRefs(s) {
  let out = s;
  // (b0) prose-suffix `#NNN-Word` → keep the descriptive word, drop the ref
  out = out.replace(/#\d{3,5}-(?=\p{L})/gu, '');
  // (b1) ref-only parenthetical `(#NNN[, HRn][/#MMM][, Welle N / Slice N][, ADR-####]…)`
  //      → '' (+ one leading space). ANYREF folds in provenance tokens, so a pure
  //      citation paren like `(Welle 52 / Slice 3)` or `(Welle 26 / Slice 1g, #983)`
  //      is consumed whole; a content-bearing paren (`(Welle 3 — 'Backend')`,
  //      `(Format aus Slice 7)`) keeps a non-ref token → is NOT matched here.
  out = out.replace(new RegExp(`[ \\t]?\\(${ANYREF}(?:[\\s,;/]*${ANYREF})*\\)`, 'g'), '');
  // (b1a2) paren-INITIAL ref + connective + space + prose: `(#NNN, prose` /
  //        `(#NNN; prose` → `(prose`. b1c only catches a connective with NO
  //        following space (`(#NNN/Word`); a `, `/`; ` with a space fell through
  //        and left a dangling `(, `/`(; ` after b2b stripped just the ref (#1949).
  out = out.replace(new RegExp(`\\(${ISSUES}[ \\t]*[,;][ \\t]+`, 'g'), '(');
  // (b1b) issue ref joined to PRECEDING text by a connective (`, ` `/ ` `; ` `: `)
  //       → drop the ref AND the joining separator. Without this, removing a
  //       mid-sentence ref leaves a dangling `,)` / `(Fix A /):` / `:.` / `, —`.
  //       Safe because the mandatory `#\d{3,5}` in ISSUES means a bare separator
  //       with no following ref is never matched (code `a/b`, prose `Verify / DoD`,
  //       `def f():` all survive — there is no `#NNN` after their separator).
  out = out.replace(new RegExp(`[ \\t]*[,/;:][ \\t]*${ISSUES}`, 'g'), '');
  // (b1c) issue ref FOLLOWED by a connective + non-space (paren-start `(#NNN/Word…`)
  //       → drop the ref + that trailing separator. `:` is excluded here so a
  //       trailing-colon label keeps its colon (`(Lehre #1010/#971: …)` → `(Lehre: …)`).
  out = out.replace(new RegExp(`${ISSUES}[ \\t]*[/;,](?=\\S)`, 'g'), '');
  // (b2a) inline issue ref WITH a leading space → eat the leading space
  out = out.replace(new RegExp(`[ \\t]${ISSUES}`, 'g'), '');
  // (b2b) remaining issue ref (line/paren-start) → eat one trailing space
  out = out.replace(new RegExp(`${ISSUES}[ \\t]?`, 'g'), '');
  // (b3-conn) HR ref joined by a connective → drop ref + separator (mirror of b1b)
  out = out.replace(/[ \t]*[,/;:][ \t]*HR\d+(?:\/\d+)*\b/g, '');
  // (b3a) HR ref (compound) with a leading space
  out = out.replace(/[ \t]HR\d+(?:\/\d+)*\b/g, '');
  // (b3b) remaining HR ref → eat one trailing space
  out = out.replace(/\bHR\d+(?:\/\d+)*\b[ \t]?/g, '');
  return out;
}

// (c) -----------------------------------------------------------------------
function projectPaths(s) {
  // `../../.claude/skills/...` → root-relative (cross-skill reach, PLAN c)
  return s.replace(/(?:\.\.\/)+(?=(?:\.claude|\.agents|docs|scripts)\/)/g, '');
}

export function scrub(text) {
  if (!text) return text;
  let out = privateTokens(text);
  out = internalRefs(out);
  out = projectPaths(out);
  return out;
}
