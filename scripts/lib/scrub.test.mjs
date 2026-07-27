import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from './scrub.mjs';

// =========================================================================
// (a) private identity tokens  →  neutral placeholders
// =========================================================================
test('(a) repo slug + bare owner/repo', () => {
  assert.equal(scrub('see iKon85/Testreporter for x'), 'see <owner>/<repo> for x');
  assert.equal(scrub('github.com/iKon85/Testreporter/issues/5'),
    'github.com/<owner>/<repo>/issues/5');
  assert.equal(scrub('authored by iKon85.'), 'authored by <owner>.');
  assert.equal(scrub('the Testreporter board'), 'the <repo> board');
});

test('(a) deploy platform + domains', () => {
  assert.equal(scrub('gemerged → Coolify deployt `main`'),
    'gemerged → your deploy platform deployt `main`');
  assert.equal(scrub('curl https://testreporter.iverra.de/version.txt'),
    'curl https://<your-app-domain>/version.txt');
  assert.equal(scrub('api.testreporter.iverra.de/health'), '<your-app-domain>/health');
});

test('(a) person + home memory path', () => {
  assert.equal(scrub('↓ (Niko wählt Wellen)'), '↓ (<maintainer> wählt Wellen)');
  assert.equal(scrub('das war Nikos Call'), 'das war <maintainer>s Call');
  assert.equal(scrub('Note `~/.claude/projects/-home-x-testreporter/memory/foo`'),
    'Note `~/.claude/projects/<project>/memory/foo`');
  // $HOME form + the Claude project slug (which embeds the username) must go too
  assert.equal(scrub('ls "$HOME/.claude/projects/-home-niko-projects-testreporter/memory/"*.md'),
    'ls "$HOME/.claude/projects/<project>/memory/"*.md');
});

// =========================================================================
// (b) internal #NNN / HRn refs  →  removed, surrounding text normalized
// =========================================================================
test('(b) ref-only parenthetical removed cleanly', () => {
  assert.equal(scrub('fixed the guard (#824).'), 'fixed the guard.');
  assert.equal(scrub('coherence (#983, #1078) before merge'), 'coherence before merge');
  assert.equal(scrub('Verify / DoD (HR1): must assert'), 'Verify / DoD: must assert');
  assert.equal(scrub('the rule (#1010/#971) holds'), 'the rule holds');
});

test('(b) refs inside content-bearing paren stay readable', () => {
  assert.equal(scrub('(Lehre #1010/#971: erst prüfen)'), '(Lehre: erst prüfen)');
  assert.equal(scrub('(#983 Q2). `a`'), '(Q2). `a`');
});

test('(b) inline prose refs + prose-suffix form', () => {
  assert.equal(scrub('the #824 anchor guard'), 'the anchor guard');
  assert.equal(scrub('war der #599-Tracker'), 'war der Tracker');
  assert.equal(scrub('pro Strang (HR7/8). Sub'), 'pro Strang. Sub');
});

test('(b) code-embedded ref in a string message', () => {
  assert.equal(scrub('verfrüht (#824). `Part of #{parent}`'),
    'verfrüht. `Part of #{parent}`');
});

test('(b) connective-joined refs drop the dangling separator (no `,)` / `/):` / `:.`)', () => {
  // leading `/ ` connective → the slash goes with the ref
  assert.equal(scrub('its own slice (Fix A / #1010): foo'), 'its own slice (Fix A): foo');
  // leading `, ` connective before a close paren — whole ref-only paren goes
  // (Welle/Slice are provenance refs now too, so nothing content-bearing remains)
  assert.equal(scrub('(Welle 26 / Slice 1g, #983).'), '.');
  // leading `, ` connective before an em-dash
  assert.equal(scrub('(provenienz-neutral, #1342 — die Form)'), '(provenienz-neutral — die Form)');
  // leading `: ` connective (label: ref)
  assert.equal(scrub('Reference output: #1060.'), 'Reference output.');
  // trailing connective at paren-start (`(#NNN/Word…`)
  assert.equal(scrub('(#1069/Q4=A: tag once → free)'), '(Q4=A: tag once → free)');
  // paren-INITIAL ref + connective + SPACE + prose → drop ref+separator, keep `(`
  assert.equal(scrub('before any write (#1076, real path only)'),
    'before any write (real path only)');
  assert.equal(scrub('in place (#1076; own grammar, not anchor-sync)'),
    'in place (own grammar, not anchor-sync)');
  assert.equal(scrub('on every run (#983, proven by a double-run).'),
    'on every run (proven by a double-run).');
});

test('(b) connective handling preserves real separators with NO adjacent ref', () => {
  assert.equal(scrub('Verify / DoD: must assert'), 'Verify / DoD: must assert');
  assert.equal(scrub('def parse(): return a/b'), 'def parse(): return a/b');
  // a trailing-colon label keeps its colon (the ref before it is removed)
  assert.equal(scrub('(Lehre #1010/#971: erst prüfen)'), '(Lehre: erst prüfen)');
});

// =========================================================================
// (b) NEGATIVES — must be preserved verbatim
// =========================================================================
test('(b) preserves placeholders, hex colors, shell comments', () => {
  assert.equal(scrub('Body braucht `Part of #<parent>`'), 'Body braucht `Part of #<parent>`');
  assert.equal(scrub('use #<n> and #<anker>'), 'use #<n> and #<anker>');
  assert.equal(scrub('bg #0f172a text #dc2626'), 'bg #0f172a text #dc2626');
  assert.equal(scrub('color #1e293b;'), 'color #1e293b;');
  // an ALL-DIGIT hex prefix used to donate 3-5 digits to the issue-ref match,
  // and the connective rule then ate the CSS `:` with them
  assert.equal(scrub('  --door-text:#454E60;'), '  --door-text:#454E60;');
  assert.equal(scrub('  --door-bg:#272E3E;'), '  --door-bg:#272E3E;');
  assert.equal(scrub('a { background:#123456; }'), 'a { background:#123456; }');
  assert.equal(scrub('  --door-text: #454E60;'), '  --door-text: #454E60;');
  assert.equal(scrub('  --door-bg: #272E3E;'), '  --door-bg: #272E3E;');
  assert.equal(scrub('a { background: #123456; }'), 'a { background: #123456; }');
  assert.equal(scrub('linear-gradient(#123456, #0f172a)'), 'linear-gradient(#123456, #0f172a)');
  assert.equal(scrub('# noqa: E402'), '# noqa: E402');
  assert.equal(scrub('<issue-number> form'), '<issue-number> form');
  // a code interpolation that looks ref-ish must survive
  assert.equal(scrub('`closes #{issue}`'), '`closes #{issue}`');
});

// =========================================================================
// (b-prov) provenance refs (Welle N / Slice N / ADR-####) — citation-shaped only
// =========================================================================
test('(b-prov) ref-only provenance parens are consumed whole', () => {
  assert.equal(scrub('key (Welle 52) — literal getter'), 'key — literal getter');
  assert.equal(scrub('items (Welle 52 / Slice 3).'), 'items.');
  assert.equal(scrub("job (Welle 52 / Slice 1) — this stays"), 'job — this stays');
  assert.equal(scrub('the CLI adapter (ADR-0034).'), 'the CLI adapter.');
  assert.equal(scrub('`to-waves` (Slice 4) stamps'), '`to-waves` stamps');
  assert.equal(scrub('green path (Slice 1).'), 'green path.');
});

test('(b-prov) mixed provenance+issue paren still consumed', () => {
  assert.equal(scrub('coherence (Welle 26 / Slice 1g, #983) before'), 'coherence before');
});

test('(b-prov) the space-separated ADR spelling is stripped like the hyphenated one', () => {
  // Both spellings are the same citation; only the hyphenated one used to be
  // stripped, so `(ADR 0009)` shipped to consumers as an unresolvable ref.
  assert.equal(scrub('Deletion authority is decided at teardown (ADR-0009).'),
    'Deletion authority is decided at teardown.');
  assert.equal(scrub('Deletion authority is decided at teardown (ADR 0009).'),
    'Deletion authority is decided at teardown.');
  // still folds into a mixed citation paren
  assert.equal(scrub('the seam (ADR 0008, #983) holds'), 'the seam holds');
});

test('(b-prov) NEGATIVE: space-separated ADR in bare prose survives verbatim', () => {
  assert.equal(scrub('contradicts ADR 0007 — but worth reopening'),
    'contradicts ADR 0007 — but worth reopening');
  assert.equal(scrub('Contradicts ADR 0007 (event-sourced orders) — but'),
    'Contradicts ADR 0007 (event-sourced orders) — but');
});

test('(b-prov) NEGATIVE: bare prose / examples survive verbatim', () => {
  // synthetic PRD fixture prose (spec-self-critique/scenarios.md)
  assert.equal(scrub('Welle 1 covers 9 slices'), 'Welle 1 covers 9 slices');
  assert.equal(scrub("Welle 3 — 'Backend'. Welle 4 — 'Frontend'."),
    "Welle 3 — 'Backend'. Welle 4 — 'Frontend'.");
  // wave-prefix parser example (board-sync.py) — bare em-dash form
  assert.equal(scrub('a title like `fix: Welle 7 — X` only'), 'a title like `fix: Welle 7 — X` only');
  // illustrative ADR name in bare prose (improve-codebase-architecture)
  assert.equal(scrub('contradicts ADR-0007 — but worth reopening'),
    'contradicts ADR-0007 — but worth reopening');
  assert.equal(scrub('Contradicts ADR-0007 (event-sourced orders) — but'),
    'Contradicts ADR-0007 (event-sourced orders) — but');
  // template placeholder (wave-anchor-template) — Slice bare, non-ref paren kept
  assert.equal(scrub('Slice 1 — <Titel> · empf. <Modell>'), 'Slice 1 — <Titel> · empf. <Modell>');
});

// =========================================================================
// (c) project-coupled paths  →  project-root convention
// =========================================================================
test('(c) ../ paths collapse to root convention', () => {
  assert.equal(scrub('[X](../../.claude/skills/board-to-waves/SKILL.md)'),
    '[X](.claude/skills/board-to-waves/SKILL.md)');
});

test('(c) preserves relative code imports', () => {
  assert.equal(scrub("import { sha256File } from '../lib/hash.mjs';"),
    "import { sha256File } from '../lib/hash.mjs';");
  assert.equal(scrub("import { update } from './update.mjs';"),
    "import { update } from './update.mjs';");
});

// =========================================================================
// idempotency — scrub(scrub(x)) === scrub(x)
// =========================================================================
test('scrub is idempotent', () => {
  const samples = [
    'iKon85/Testreporter (#824) — Niko, Coolify, testreporter.iverra.de',
    '(Lehre #1010/#971: erst prüfen) the #824 anchor guard, war der #599-Tracker',
    'keep #<n> #0f172a # comment <issue-number>',
    'pro Strang (HR7/8). DoD (HR1): x',
  ];
  for (const s of samples) assert.equal(scrub(scrub(s)), scrub(s), `not idempotent: ${s}`);
});

// =========================================================================
// removal of single-spaced refs is clean (no empty parens, no new doubles)
// =========================================================================
test('removal of single-spaced refs leaves clean text', () => {
  const out = scrub('a (#824) b (#983, #1078) c (HR1) d');
  assert.equal(out, 'a b c d');
  assert.ok(!/\(\s*\)/.test(out), `empty paren in: ${out}`);
});

// =========================================================================
// ANTI-CORRUPTION — scrub must NOT touch code, filenames, or aligned whitespace
// (the failure modes an early global-normalize version introduced)
// =========================================================================
test('preserves code parens, filename dots, and aligned whitespace', () => {
  // code () must never be collapsed (an empty-paren cleanup would have nuked it)
  assert.equal(scrub('def foo(): pass'), 'def foo(): pass');
  assert.equal(scrub('build_parser().parse_args()'), 'build_parser().parse_args()');
  // a leading filename dot must keep its preceding space ("an .env check")
  assert.equal(scrub('after an .env/secret check'), 'after an .env/secret check');
  assert.equal(scrub('see [x](docs/agents/board-sync.md) here'),
    'see [x](docs/agents/board-sync.md) here');
  // intentional alignment / indentation (ASCII diagrams, tables) is preserved
  assert.equal(scrub('col1    col2    col3'), 'col1    col2    col3');
  assert.equal(scrub('board-to-waves   Board → STUB   ← HIER'),
    'board-to-waves   Board → STUB   ← HIER');
});
