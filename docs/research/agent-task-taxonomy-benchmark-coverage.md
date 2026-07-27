# Agent task taxonomy and benchmark coverage

**Researched:** 2026-07-26
**Question:** Which agent task classes do recognized benchmark owners actually
distinguish, which of those classes carry evidence strong enough to pick a
model **and** an effort level, and how does that generalize the Kit's existing
frontend taxonomy?

## Verdict

Benchmark owners distinguish **more task classes than the Kit currently models,
but far fewer domains**. Of the seven candidate classes in the brief, six are
directly measured by an owner today; one (architecture/judgment work) exists
only as a static knowledge quiz, not as an agent measurement.

Three findings drive the proposed schema:

1. **Effort identity is the scarce resource, not the task class.** Only four
   sources publish a row that names model **and** reasoning effort **and**
   harness: DeepSWE, the Terminal-Bench leaderboard, Artificial Analysis'
   per-evaluation leaderboards, and Scale's SWE Atlas boards. Everything else
   collapses at least one of the three.
2. **Almost nobody reports per-domain scores.** Code Arena is the only source in
   this survey that publishes a separate score per subject-matter domain. Every
   other owner publishes one aggregate over a task mix whose composition is
   documented but not scored separately. The Kit's `domain` segment is therefore
   `general` for most of the taxonomy — that is a coverage fact, not a schema
   defect.
3. **No owner publishes cost per *completed* task.** Every cost figure found is
   cost per *attempted* task (or per whole run). Cost per success is derivable
   but is an inference the Kit must label as such.

## 0. Method: what counts as decisive

The repo already carries a per-source `decisive` boolean
(`src/lib/frontendWorkloads.mjs`). This note evaluates it against a three-part
test, because a single boolean turned out to hide the interesting failure mode:

| Dimension | Question | Failure mode |
|---|---|---|
| **Triple match** | Does the owner measure this exact `workload:domain:axis`, or is it an aggregate the Kit is slicing? | Aggregate laundering |
| **Configuration identity** | Does the published row name the reasoning effort? | Effort collapse |
| **Harness identity** | Does the published row name the agent/scaffold and its version? | Harness collapse |

**Decisive** = all three hold. **Diagnostic** = the owner measures something
relevant but at least one dimension is collapsed, estimated, or stale.

This is a stricter reading than the current boolean. Under it, two sources the
repo currently marks `decisive: true` are decisive on the triple and on harness,
but **not** on effort — see §4.

## 1. Proposed taxonomy: `workload:domain:axis`

The identity format is unchanged: three colon-free segments, exactly one axis
per observation (`evidenceWorkloadIdentity` in `src/lib/routingIntent.mjs`).

### 1.1 Containment of the existing frontend taxonomy

The existing frontend vocabulary is a **strict subset**, unchanged:

- workloads `frontend-greenfield`, `frontend-repository-repair` keep their
  identifiers and their meaning (lifecycle × repository context);
- all eight frontend domains (`general`, `reference-design`, `marketing`,
  `analytics`, `product`, `game`, `simulation`, `editor`) keep their identifiers
  and remain valid **only** for the two frontend workloads;
- all five existing axes keep their identifiers. Four (`visual-preference`,
  `visual-fidelity`, `accessibility`, `responsive`) stay frontend-scoped; one
  (`functional`) is promoted to the general executable-verifier axis, which is
  exactly how it is already used for `openhands-frontend`.

Nothing in `FRONTEND_SOURCE_CLAIMS`, `classifyFrontendWorkload`, or
`frontendEvidenceWorkload` needs a value change to fit under the general
taxonomy. The generalization is additive.

### 1.2 Workloads

A workload is **what the agent is asked to change or produce**, defined by
lifecycle × repository context — the same rule the frontend pair already
follows.

| Workload | Definition | Owner that measures it |
|---|---|---|
| `frontend-greenfield` | New UI from a prompt or prototype, isolated from a repo | [Code Arena WebDev](https://arena.ai/leaderboard/code/webdev) |
| `frontend-repository-repair` | Fix/extend UI inside an established repo | [SWE-bench Multimodal](https://www.swebench.com/multimodal), [OpenHands Index](https://index.openhands.dev/) |
| `repository-repair` | Issue → patch in an established non-frontend repo | [DeepSWE](https://deepswe.datacurve.ai/), [SWE-bench Verified](https://www.swebench.com/verified) |
| `repository-comprehension` | Answer questions about an existing system without changing it | [SWE Atlas Codebase QnA](https://labs.scale.com/leaderboard/sweatlas-qna) |
| `code-transformation` | Restructure code while preserving behavior (refactor, migration) | [SWE Atlas Refactoring](https://labs.scale.com/leaderboard/sweatlas-refactoring), [RefactorBench](https://arxiv.org/abs/2503.07832) |
| `test-authoring` | Write tests that catch a stated regression | [SWE Atlas Test Writing](https://labs.scale.com/leaderboard/sweatlas-tw) |
| `greenfield-application` | Build a new non-frontend app/library from a spec | [OpenHands Index](https://www.openhands.dev/blog/openhands-index) (commit0) |
| `algorithmic-synthesis` | Self-contained competitive-programming style problems | [LiveCodeBench](https://livecodebench.github.io/) |
| `terminal-operations` | End-to-end system/CLI work in a real environment | [Terminal-Bench](https://www.tbench.ai/leaderboard/terminal-bench/2.1) |
| `tool-orchestration` | Multi-turn tool use with a simulated user under a written policy | [τ²-bench / τ³-bench](https://github.com/sierra-research/tau2-bench), [BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html) |
| `knowledge-deliverable` | Produce a professional artifact (doc, sheet, slides, diagram) | [GDPval](https://arxiv.org/pdf/2510.04374), [GDPval-AA v2](https://artificialanalysis.ai/evaluations/gdpval-aa) |
| `architecture-reasoning` | Judge architectural trade-offs and system-level constraints | [SAKE](https://arxiv.org/abs/2606.29520) — **knowledge quiz only, not agentic** |
| `long-horizon-autonomy` | Cross-suite: how long an unattended run stays correct | [METR Time Horizon 1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/) |
| `long-context-operation` | Cross-suite: accuracy as a function of input length | [AA-LCR](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning), [NoLiMa](https://arxiv.org/abs/2502.05167) |

The last two are deliberately **cross-cutting** workloads rather than axes: their
owners run their own task suites, so an observation about them is not a slice of
another workload's evidence.

Mapping to the brief's candidate list:

| Candidate class in the brief | Verified? | Maps to |
|---|---|---|
| mechanical / refactoring | **yes** | `code-transformation` (SWE Atlas Refactoring is live: [Scale, 2026-05-07](https://scale.com/blog/swe-atlas-complete)) |
| algorithmics | **yes** | `algorithmic-synthesis` (LiveCodeBench scenarios) |
| debugging / repository repair | **yes** | `repository-repair` |
| frontend design | **yes** | `frontend-greenfield` (Code Arena domains) |
| architecture / judgment work | **partly** | `architecture-reasoning` exists only as multiple choice (SAKE); `knowledge-deliverable` is the closest *agentic* judgment proxy |
| long-horizon agentic work | **yes** | `long-horizon-autonomy` + `terminal-operations` |
| tool-use / orchestration | **yes** | `tool-orchestration` |

Two classes the brief did not name, but owners do distinguish and score
separately, were added: `repository-comprehension` and `test-authoring` — both
are separate SWE Atlas leaderboards, and `information gathering` / `software
testing` are separate OpenHands Index categories.

### 1.3 Domains

A domain is a **subject-matter partition the owner scores separately**. The rule
is deliberately strict: if the owner publishes only an aggregate, the domain is
`general`, even when the owner documents a richer task mix.

| Workload | Allowed domains | Basis |
|---|---|---|
| `frontend-greenfield`, `frontend-repository-repair` | the existing eight | Code Arena publishes per-domain boards derived from >250k clustered prompts ([category methodology](https://arena.ai/blog/new-categories-code-arena/)) |
| `tool-orchestration` | `general`, `airline`, `retail`, `telecom`, `banking` | Sierra ships the domains separately ([tau2-bench](https://github.com/sierra-research/tau2-bench)); AA publishes [τ²-Bench Telecom](https://artificialanalysis.ai/evaluations/tau2-bench) and [τ³-Banking](https://artificialanalysis.ai/evaluations/tau3-banking) as separate boards |
| everything else | `general` | owner publishes one aggregate |

Documented-but-unscored partitions (record as metadata, **never** as a domain
segment, or the Kit is laundering an aggregate):

- DeepSWE: 113 tasks over 91 repos, TypeScript 35 / Go 34 / Python 34 /
  JavaScript 5 / Rust 5 — one aggregate pass@1
  ([DeepSWE methodology](https://deepswe.datacurve.ai/blog/deepswe)).
- Terminal-Bench 2.x: software engineering, ML, security, data science, system
  administration — one aggregate accuracy
  ([tbench.ai](https://www.tbench.ai/), [arXiv 2601.11868](https://arxiv.org/abs/2601.11868)).
- SWE Atlas Codebase QnA: architecture, root-cause analysis, code onboarding,
  security, API integration — one aggregate resolve rate
  ([Scale blog](https://scale.com/blog/swe-atlas-complete)).
- GDPval: 44 occupations across 9 sectors; the AA leaderboard reports an
  aggregate Elo ([GDPval-AA v2](https://artificialanalysis.ai/evaluations/gdpval-aa)).
  Whether OpenAI's own release publishes per-occupation win rates is
  **unverified** — `openai.com/index/gdpval/` returned HTTP 403 to automated
  fetch on 2026-07-26; the paper is at
  [arXiv 2510.04374](https://arxiv.org/pdf/2510.04374).
- LiveCodeBench reports Easy/Medium/Hard columns. That is **difficulty, not
  domain** — putting it in the `domain` segment would be schema abuse.

### 1.4 Axes

An axis is the **quality dimension measured**. Five exist; six are proposed.

| Axis | Status | Meaning | Grader |
|---|---|---|---|
| `functional` | existing, generalized | executable verifier pass/fail | program |
| `visual-fidelity` | existing, frontend-scoped | similarity to a reference rendering | metric / VLM |
| `visual-preference` | existing, frontend-scoped | blinded human pairwise on rendered UI | human |
| `accessibility` | existing, frontend-scoped | WCAG-style conformance | tool / human |
| `responsive` | existing, frontend-scoped | correctness across a viewport matrix | program / VLM |
| `rubric-quality` | **new** | structured rubric score where no single pass/fail exists | rubric + judge |
| `answer-accuracy` | **new** | correctness of an answer about a system or document | judge / key |
| `blind-preference` | **new** | blinded pairwise ranking of a non-visual deliverable | human **or** LLM judge — record which |
| `policy-adherence` | **new** | compliance with a written domain policy during tool use | program |
| `time-horizon` | **new** | human task length at a fixed success probability | fitted from runs |
| `context-retention` | **new** | accuracy as a function of input length | program / judge |

`visual-preference` is conceptually the frontend special case of
`blind-preference`; it is kept as a distinct identifier for backward
compatibility, and because its grader is always human whereas GDPval-AA v2 uses
an LLM judge ([AA GDPval-AA](https://artificialanalysis.ai/evaluations/gdpval-aa))
while OpenAI's own GDPval uses human expert graders
([arXiv 2510.04374](https://arxiv.org/pdf/2510.04374)). An adapter that merges
those two grader types into one axis is fabricating comparability.

### 1.5 Cost is not an axis

`validateObservation` in `src/lib/routingCatalog.mjs` already carries
`cost.{amount,currency,unit}` on every observation. Cost must stay there. Making
it an axis would produce identities like `repository-repair:general:cost` that
have no owner behind them, and would let a cheap-but-failing configuration
outrank a working one. See §6 for what `unit` may legitimately contain.

## 2. Source table

`Decisive` uses the §0 three-part test. `Freshness` is what was observable on
2026-07-26; where an owner publishes no cadence statement, that is stated.

| Source | Workloads claimed | Axes | Decisive? | Freshness / cadence | Machine-ingestible artifact |
|---|---|---|---|---|---|
| **DeepSWE v1.1** (DataCurve) | `repository-repair:general` | `functional` | **Yes** — `reasoning_effort`, `harness: mini-swe-agent`, `config`, `ci_method` all in the JSON | `generated_at` 2026-07-25T03:13Z, latest job finished 2026-07-25; **no published cadence** | [`/artifacts/v1.1/leaderboard-live.json`](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json) (HTTP 200, ~62 KB) |
| **Terminal-Bench 2.1 leaderboard** (Laude Institute) | `terminal-operations:general` | `functional` | **Yes** — columns are Rank, Agent, Model, **Effort**, Accuracy ±CI, Date, Agent Org, Model Org, PR, Hacks, Cost | latest submissions 2026-07-11; **no cadence statement** | **None found.** `www.tbench.ai/api/leaderboard` → 404. Task registry only: [`registry.json`](https://raw.githubusercontent.com/harbor-framework/terminal-bench/main/registry.json). Run-log repos exist but are empty scaffolds ([terminal-bench-2-leaderboard](https://github.com/laude-institute/terminal-bench-2-leaderboard)) |
| **Artificial Analysis — per-evaluation boards** | `terminal-operations`, `tool-orchestration`, `knowledge-deliverable`, `long-context-operation`, `algorithmic-synthesis` (all `:general`) | `functional`, `policy-adherence`, `blind-preference`, `answer-accuracy` | **Yes** for boards that expose effort-variant rows — verified on [Terminal-Bench v2.1](https://artificialanalysis.ai/evaluations/terminalbench-v2-1) ("GPT-5.6 Sol (xhigh)", "GPT-5.6 Terra (max)", harness named as *Terminus 2 in an e2b sandbox*) | Intelligence Index v4.1 current; Coding Agent Index v1.3 current with a May–Jul 2026 change history; **AA states no fixed refresh schedule** ([methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking)) | [Data API](https://artificialanalysis.ai/data-api/docs) — snake_case JSON; cost lives under `artificial_analysis_intelligence_index_cost.cost_per_task`. **There is no `costPerTaskUsd` field** (see §6). Attribution required at all tiers |
| **Artificial Analysis — Coding Agent Index v1.3** | `repository-repair`, `terminal-operations`, `repository-comprehension` (`:general`) | `functional`, `answer-accuracy` | **No — effort collapse by design.** AA states: *"Unless otherwise specified, we use each agent's default reasoning settings so the benchmark reflects the default user experience"* | v1.3 current, history May–Jul 2026 | [coding-agents methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking) |
| **SWE Atlas** (Scale) — QnA / Test Writing / Refactoring | `repository-comprehension`, `test-authoring`, `code-transformation` (`:general`) | `answer-accuracy`, `rubric-quality` | **Yes on QnA and Test Writing** — rows read e.g. *"Opus 4.8 (Claude Code) xhigh"*; native scaffold named, effort in the label, resolve rate ± CI. **Refactoring: effort exposure unverified** — the rendered rows observed showed model + harness + `48.57±6.73` but no effort token | Refactoring board went live with [Scale's 2026-05-07 post](https://scale.com/blog/swe-atlas-complete); dataset repo pushed 2026-07-20; **no cadence statement** | Dataset + run config only, Apache-2.0: [scaleapi/SWE-Atlas](https://github.com/scaleapi/SWE-Atlas). **No results JSON found** |
| **Code Arena WebDev** (Arena) | `frontend-greenfield:{8 domains}` | `visual-preference` | **Partly.** Triple ✓ (only source with real per-domain boards), harness ✓ (encoded in labels such as `-codex`), **effort ✗** — the board columns are Rank, Model, Organization, License, Score, Votes, Price ($/M), Context Length; effort appears only when a lab bakes it into the model label | live pairwise voting; page timestamp 2026-07-24, 477,155 votes observed on the WebDev board; changes tracked in the [leaderboard changelog](https://arena.ai/blog/leaderboard-changelog/) | **No leaderboard API found.** Ranking code is open ([arena-rank](https://github.com/lmarena/arena-rank)); raw votes are released as a HF dataset (`lmarena-ai/arena-human-preference-140k`) but that is votes, not the published board |
| **OpenHands Index** | `repository-repair`, `greenfield-application`, `frontend-repository-repair`, `test-authoring`, `repository-comprehension` (`:general`) | `functional` | **No — effort collapse.** Harness ✓ (OpenHands Software Agent SDK), triple ✓, but no reasoning-effort dimension is reported | launched [2026-01-29](https://www.openhands.dev/blog/openhands-index); [3-months-out update 2026-05-11](https://www.openhands.dev/blog/openhands-index-3-months-out) states only *"looking to do some more frequent updates going forward"* | Board at [index.openhands.dev](https://index.openhands.dev/) (no export found); harness open-sourced at [OpenHands/benchmarks](https://github.com/OpenHands/benchmarks), pushed 2026-07-19 |
| **SWE-bench** (Verified / Multimodal / Lite / Multilingual) | `repository-repair:general`, `frontend-repository-repair:general` | `functional` | **No.** Submissions are self-reported with heterogeneous scaffolds; the *Verified* badge is opt-in (maintainers re-run a random subset). `metadata.yaml` may carry scaffold/effort, but it is not a guaranteed, uniform column | [SWE-bench/experiments](https://github.com/SWE-bench/experiments) last commit **2026-03-29** — ~4 months stale | Per-submission `all_preds.jsonl`/`preds.json`, `metadata.yaml`, `logs/*/report.json`, `trajs/` in [SWE-bench/experiments](https://github.com/SWE-bench/experiments) |
| **METR Time Horizon 1.1** | `long-horizon-autonomy:general` | `time-horizon` | **No — effort collapse.** Per-model p50/p80 horizons with bootstrapped CIs and a `scaffolds` list, but **no reasoning-effort field** in the entries inspected | TH1.1 published [2026-01-29](https://metr.org/blog/2026-1-29-time-horizon-1-1/); [time-horizons page](https://metr.org/time-horizons/) latest entry 2026-05-08, updated *"periodically whenever we have new measurements"*; [eval-analysis-public](https://github.com/METR/eval-analysis-public) pushed 2026-03-06 | [`benchmark_results_1_1.yaml`](https://metr.org/assets/benchmark_results_1_1.yaml) (HTTP 200, ~16 KB) — contains `p50_horizon_length`/`p80_horizon_length` with `ci_low`/`ci_high`, `average_score`, `release_date`, `scaffolds`, plus `doubling_time_in_days` |
| **BFCL V4** (Berkeley/Gorilla) | `tool-orchestration:general` | `functional` | **No — effort collapse.** Cost is *"an estimate of the cost for the entire benchmark"*; no per-row effort | last updated **2026-04-12**, evaluated at a pinned commit; *"will be updated periodically"* — no cadence | [ShishirPatil/gorilla](https://github.com/ShishirPatil/gorilla) (repo pushed 2026-04-13); categories in [TEST_CATEGORIES.md](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/TEST_CATEGORIES.md); [changelog](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/CHANGELOG.md) |
| **Aider polyglot** | `code-transformation:general` (instruction-following edit) | `functional` | **No — stale.** Effort *is* in the label (e.g. `gpt-5 (high)`) and cost is reported, but the data is ~10 months old | `polyglot_leaderboard.yml` last commit **2025-10-04** (repo itself pushed 2026-05-22) | [`polyglot_leaderboard.yml`](https://github.com/Aider-AI/aider/blob/main/aider/website/_data/polyglot_leaderboard.yml); also `refactor_leaderboard.yml`, `edit_leaderboard.yml` in the same directory |
| **LiveCodeBench** | `algorithmic-synthesis:general` | `functional` | **No.** Board columns are Rank, Model, Pass@1, Easy, Medium, Hard — no effort, no harness, no cost | official repo [LiveCodeBench/LiveCodeBench](https://github.com/LiveCodeBench/LiveCodeBench) pushed **2025-07-16**; AA's replication uses a May 2023–May 2024 problem window | [HF org](https://huggingface.co/livecodebench/); no leaderboard JSON found |
| **SWE-Lancer** (OpenAI) | `repository-repair:general`, `architecture-reasoning:general` (SWE Manager split) | `functional`, `answer-accuracy` | **No — frozen.** 1,400+ Upwork tasks worth $1M in real payouts; IC SWE graded by triple-verified end-to-end tests, manager tasks graded against the original hiring manager's choice | [openai/SWELancer-Benchmark](https://github.com/openai/SWELancer-Benchmark) **archived 2025-07-18**, redirected into `openai/preparedness`. No maintained leaderboard | [arXiv 2502.12115](https://arxiv.org/abs/2502.12115) |
| **SAKE** | `architecture-reasoning:general` | `answer-accuracy` | **No — not agentic.** 2,154 expert-curated 4-option MCQs over 8 architectural categories and 4 context-length levels, 11 models, zero-/five-shot | static paper artifact, [arXiv 2606.29520](https://arxiv.org/abs/2606.29520) | open-sourced evaluation scripts + results per the paper; no live board |
| **AA-LCR** | `long-context-operation:general` | `answer-accuracy` | **Partly** — 100 questions over 10k–100k-token documents, pass/fail via LLM judge, per-model cost/time/tokens per task. **Not segmented by context length in the published view** | part of Intelligence Index v4.1 (6% weight); no cadence statement | [AA-LCR board](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning) + Data API |
| **NoLiMa** | `long-context-operation:general` | `context-retention` | **No.** 13 models, latent-association needle retrieval; 11 of 13 fall below 50% of their short-context baseline at 32K | static paper, [arXiv 2502.05167](https://arxiv.org/abs/2502.05167); [adobe-research/NoLiMa](https://github.com/adobe-research/NoLiMa) | repo |
| **Chroma "Context Rot"** | `long-context-operation:general` | `context-retention` | **No.** 18 models, extended NIAH + LongMemEval (~113k tokens) + repeated-words | published **2025-07-14**, one-off report | [trychroma.com/research/context-rot](https://www.trychroma.com/research/context-rot) |
| **RefactorBench** (Microsoft) | `code-transformation:general` | `functional` | **No — static.** 100 handcrafted multi-file refactors, 3 instruction specificities; agents solved 22% vs 87% for a time-limited human developer | ICLR 2025 paper, static | [arXiv 2503.07832](https://arxiv.org/abs/2503.07832), [microsoft/RefactorBench](https://github.com/microsoft/RefactorBench) |
| **GDPval / GDPval-AA v2** | `knowledge-deliverable:general` | `blind-preference` | **AA board: yes on effort/cost; no on grader parity.** 220 tasks, 44 occupations, blind pairwise, Elo anchored to a human baseline of 1000, *"average cost per task (USD), broken down by input, cache hit, cache write, reasoning, and answer tokens"* plus average turns per task. OpenAI's own grading is human-expert; AA's is an LLM judge — the two are not the same axis instance | v2 current; no cadence statement | [GDPval-AA v2 board](https://artificialanalysis.ai/evaluations/gdpval-aa) + Data API; paper [arXiv 2510.04374](https://arxiv.org/pdf/2510.04374) |

## 3. What owners actually distinguish (question a)

Confirmed as **separately published task classes**, not inferred:

- Scale splits the engineering loop into **three separate leaderboards** —
  Codebase QnA (124 tasks), Test Writing (90), Refactoring (70) — and states the
  design intent: *"it targets underrepresented but practically important task
  categories, uses comprehensive category-specific evaluation protocols, and
  adopts under-specified, agentic task formulations"*
  ([arXiv 2605.08366](https://arxiv.org/abs/2605.08366)).
- OpenHands splits into **five categories**: issue resolution, greenfield
  development, frontend development, software testing, information gathering
  ([launch post](https://www.openhands.dev/blog/openhands-index)).
- LiveCodeBench splits into **four scenarios**: code generation, self-repair,
  test output prediction, code execution, and states that *"model performances
  are correlated across different scenarios"* yet relative rankings vary by task
  type ([livecodebench.github.io](https://livecodebench.github.io/)).
- SWE-bench splits by **repository population**, not by task type: Full, Lite,
  Verified, Multimodal, Multilingual ([swebench.com](https://www.swebench.com/SWE-bench/)).
  Multimodal is 517 visual-domain issues
  ([multimodal](https://www.swebench.com/multimodal)).
- SWE-Lancer splits **IC engineering vs managerial proposal selection**
  ([arXiv 2502.12115](https://arxiv.org/abs/2502.12115)).
- Code Arena splits by **subject-matter domain**, uniquely: Reference-Based
  Design (~29% of prompts), Brand/Marketing, Data & Analytics, Consumer Product,
  Gaming, Simulations (~15.3%), Content Creation & Editing Tools
  ([category methodology](https://arena.ai/blog/new-categories-code-arena/)).
- BFCL splits by **call shape and interaction mode**: `simple_{python,java,
  javascript}`, `parallel`, `multiple`, `parallel_multiple`, `irrelevance`,
  `live_irrelevance`, `live_relevance`, `multi_turn_{base,miss_func,miss_param,
  long_context}`, `memory_{kv,vector,rec_sum}`, `web_search_{base,no_snippet}`,
  `format_sensitivity` ([TEST_CATEGORIES.md](https://github.com/ShishirPatil/gorilla/blob/main/berkeley-function-call-leaderboard/TEST_CATEGORIES.md)).

What owners **explicitly say they do not cover** — this is the most useful
primary-source material in the survey:

- DeepSWE: *"bug localization and refactoring are under-represented, even though
  each is challenging in its own right"*, and *"Developers also don't use these
  models through mini-swe-agent in practice; they use them inside more
  sophisticated, model-native harnesses like Codex CLI, Claude Code, Cursor, and
  Gemini CLI, none of which the current leaderboard directly reflects"*
  ([limitations](https://deepswe.datacurve.ai/blog/deepswe)).
- SAKE: *"their ability to reason about software architecture remains largely
  unmeasured"* ([arXiv 2606.29520](https://arxiv.org/abs/2606.29520)).
- Scale, on why model-plus-scaffold is the unit: native agents
  *"(Claude Code, Codex CLI) perform 1.5-2x more exploration than generic
  harnesses"* ([Scale blog](https://scale.com/blog/swe-atlas-complete)).
- GDPval: automated grading reached only **66% agreement with human graders**,
  which is why the primary metric stays human head-to-head
  ([arXiv 2510.04374](https://arxiv.org/pdf/2510.04374)).

## 4. Decisive vs diagnostic (question b)

**Decisive today (all three dimensions intact):**

| Identity | Source |
|---|---|
| `repository-repair:general:functional` | DeepSWE v1.1 JSON |
| `terminal-operations:general:functional` | Terminal-Bench 2.1 board; AA Terminal-Bench v2.1 board |
| `repository-comprehension:general:answer-accuracy` | SWE Atlas Codebase QnA |
| `test-authoring:general:rubric-quality` | SWE Atlas Test Writing |
| `knowledge-deliverable:general:blind-preference` | AA GDPval-AA v2 (LLM judge — record the grader) |
| `tool-orchestration:{telecom,banking}:policy-adherence` | AA τ²-Telecom, AA τ³-Banking |

**Diagnostic only, with the reason:**

| Identity | Source | Collapsed dimension |
|---|---|---|
| `frontend-greenfield:{domain}:visual-preference` | Code Arena WebDev | **effort** — no effort column; only sometimes in the label |
| `frontend-repository-repair:general:functional` | OpenHands Index | **effort** — not a reported dimension |
| `code-transformation:general:rubric-quality` | SWE Atlas Refactoring | **effort** — unverified on the rendered rows |
| `greenfield-application:general:functional` | OpenHands Index | **effort** |
| `algorithmic-synthesis:general:functional` | LiveCodeBench | effort + harness + staleness (repo 2025-07) |
| `long-horizon-autonomy:general:time-horizon` | METR TH1.1 | **effort** |
| `long-context-operation:general:context-retention` | NoLiMa, Chroma | effort + harness + staleness |
| `architecture-reasoning:general:answer-accuracy` | SAKE | **not agentic at all** — MCQ knowledge |
| `repository-repair:general:functional` | SWE-bench Verified | heterogeneous self-reported scaffolds; staleness |

**Direct consequence for `src/lib/frontendWorkloads.mjs`:** the two entries
currently marked `decisive: true` (`code-arena-webdev`, `openhands-frontend`) are
decisive on triple and harness but **not on effort**. Under the current single
boolean, a resolver reading `decisive: true` may believe it can pick an effort
level from those sources. It cannot. Recommendation (not applied here): replace
the boolean with three flags — `measuresTriple`, `preservesEffort`,
`preservesHarness` — so an effort route requires `preservesEffort`, and let the
resolver fall back to a separate effort-curve source (DeepSWE, Terminal-Bench)
with the cross-source inference explicitly marked. That is the same rule
`docs/research/frontend-agent-benchmarks.md` §7.4 already states in prose; making
it a schema field prevents it from being forgotten.

## 5. Does a smaller model degrade on long runs / large context? (question c)

**No primary source in this survey reports long-run or long-context degradation
broken down by model tier or reasoning effort.** The intuition is widely held; it
is not measured that way by any owner found.

What *is* measured:

- **METR** fits a logistic curve of success probability against *human* task
  duration and reports the length at which the curve crosses 50% (and 80%). TH1.1
  expanded the suite from 170 to 228 tasks and moved from Vivaria to Inspect;
  8h+ tasks doubled from 14 to 31, but **only 5 of those 31 have measured human
  baselines** — the rest are estimated
  ([TH1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/)). CIs come from
  bootstrapping over task families, tasks, and runs. The published YAML records
  `scaffolds` per model but **no effort field** in the entries inspected
  ([benchmark_results_1_1.yaml](https://metr.org/assets/benchmark_results_1_1.yaml)).
  Reported doubling times: 187.8 days all-time, 128.7 days (CI 104.4–158.0) from
  2023 on. **This is per model, not per tier.**
- **Toby Ord's half-life model** ([arXiv 2505.05115](https://arxiv.org/abs/2505.05115))
  explains the METR curve with *"a constant rate of failing during each minute"*,
  giving each agent its own half-life. The abstract does **not** claim weaker
  models have systematically shorter half-lives — that stratification is an
  inference, not a result.
- **NoLiMa** ([arXiv 2502.05167](https://arxiv.org/abs/2502.05167)): 11 of 13
  models drop below 50% of their short-context baseline at 32K; even GPT-4o falls
  from 99.3% to 69.7%. It compares 13 different models — **not size variants
  within one family**.
- **Chroma "Context Rot"** ([2025-07-14](https://www.trychroma.com/research/context-rot))
  tested 18 models *including* three within-family size ladders (Qwen3-8B / 32B /
  235B-A22B and GPT-4.1 / mini / nano). It is therefore the only source that
  *could* have answered the tier question — and it explicitly does not. Its
  size-specific remarks are behavioural quirks, not degradation curves:
  *"We only observe non-attempts with Qwen3-8B, [which] make up 4.21% of tasks"*;
  *"GPT-4.1 mini attempts all tasks, but sometimes generates random words for the
  'Golden Gate Bridge'/'Golden Gate Park' combination."* Its headline finding is
  tier-agnostic: *"model performance degrades as input length increases, often in
  surprising and non-uniform ways."*
- **AA-LCR** reports one aggregate over 10k–100k-token documents; the published
  view is **not** segmented by context length
  ([AA-LCR](https://artificialanalysis.ai/evaluations/artificial-analysis-long-context-reasoning)).

**Verdict for the Kit:** "route a small model away from long unattended runs" is
currently a **defensible heuristic with no decisive backing**. The closest real
evidence is indirect and within-family effort, not tier: DeepSWE's
`mean_agent_steps` / `mean_output_tokens` / `mean_duration_seconds` fields let
the Kit observe that a low-effort configuration consumes a different trajectory
shape at the same task set. Publishing that as a tier claim would be an
inference. Mark it `unverified`.

## 6. Cost per completed task (question d)

**Verified correction to the brief: there is no `costPerTaskUsd` field.** The
Artificial Analysis Data API is snake_case; the cost object is
`artificial_analysis_intelligence_index_cost` containing `total_cost` and
`cost_per_task` (itself nested into `total_cost`, `input_cost`, `reasoning_cost`,
`answer_cost`) ([Data API docs](https://artificialanalysis.ai/data-api/docs)).

**More importantly: every source found reports cost per *attempted* task, never
cost per *completed* task.**

| Source | Cost metric published | Denominator |
|---|---|---|
| Artificial Analysis | *"Cost per Task ... calculated by multiplying input, cached, and output token prices by tokens consumed across the workload, weighted by the relative weights of each benchmark ... then dividing by task count"* | **task count** — attempted |
| AA Coding Agent Index | *"Cost to run: average pay per token API cost per task, based on provider token pricing rather than consumer plans"* ([methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)) | attempted |
| AA GDPval-AA v2 | *"average cost per task (USD), broken down by input, cache hit, cache write, reasoning, and answer tokens"* | attempted |
| DeepSWE | `mean_cost_usd`, `median_cost_usd` — per **attempt** | attempted |
| Terminal-Bench 2.1 board | `Cost` in USD for the whole submission run (e.g. $552.67) | whole run |
| BFCL V4 | *"an estimate of the cost for the entire benchmark, in USD"* | whole run |
| Aider polyglot | total run cost, divisible by 225 exercises | attempted |
| OpenHands Index | cost-accuracy curves per model; the [3-months-out post](https://www.openhands.dev/blog/openhands-index-3-months-out) gives only relative pricing, not absolute per-task figures | attempted |
| SWE-Lancer | $1M in Upwork **payouts earned**, not spend | neither — it is revenue, not cost |

Cost per completed task is `cost_per_attempt / pass_rate`. Both operands are
published by DeepSWE and by AA, so the Kit **can** compute it — but it is a
derived quantity and must be tagged as such, with the caveat that the two
operands must come from the same row. Concretely: `cost.unit` in
`routingCatalog.mjs` should carry `usd-per-attempt` (what owners publish) or
`usd-per-run`, and any `usd-per-success` value must be flagged as Kit-derived.

Also note the retry semantics differ and are not interchangeable: DeepSWE reports
pass@1 over four repeated whole-benchmark runs with a 95% run-to-run interval
(`ci_method: "95% run-to-run: SE across repeated whole-benchmark passes"`), AA
runs 3 attempts per task, and AA retries API failures for reliability rather than
as extra solution attempts.

## 7. Gaps

Task classes with **no decisive source**, and what would close each:

1. **Architecture / judgment work — the largest gap.** SAKE is 2,154 multiple
   choice questions, not an agent run; SWE-Lancer's manager split is the only
   agentic proxy and its repo has been archived since 2025-07-18. *Needed:* an
   owner-run board where an agent produces an architectural decision inside a
   real repository and is graded against the decision a senior engineer actually
   made, with effort and harness in the row. Until then the Kit's `judgment`
   routing workload rests on **no decisive evidence at all** — its closest proxy
   is `knowledge-deliverable` (GDPval-AA), which is not software architecture.
2. **Mechanical / refactoring at effort granularity.** SWE Atlas Refactoring is
   live and names the harness, but effort exposure on its rows is unverified;
   RefactorBench is a static 2025 paper; Aider's refactor/polyglot YAMLs are ~10
   months stale. *Needed:* one confirmation that the Refactoring board carries
   the effort token its sibling boards do. This is the cheapest gap to close —
   a single human look at the rendered board settles it.
3. **Any per-domain evidence outside frontend.** Code Arena is the sole source
   with per-domain boards. Terminal-Bench, DeepSWE, and SWE Atlas QnA all
   document a category mix and publish one aggregate. *Needed:* per-category
   score export from any of them; until then the Kit must not emit a non-`general`
   domain for those workloads.
4. **Tier- or effort-resolved long-horizon degradation.** §5. *Needed:* a source
   that reports success against task duration *per effort level*. DeepSWE already
   holds both halves (effort rows + per-run duration/step statistics) and is the
   most plausible candidate to publish it.
5. **Accessibility and responsiveness.** Unchanged from
   `docs/research/frontend-agent-benchmarks.md`: no current, broad, model-comparative
   board. `accessibility` and `responsive` remain axes with **zero** decisive
   sources.
6. **Cost per completed task.** No owner publishes it (§6). *Needed:* nothing
   external — the Kit derives it and labels it derived.
7. **Machine-ingestible artifacts for four otherwise-strong sources.**
   Terminal-Bench (no results endpoint; `/api/leaderboard` → 404), SWE Atlas (only
   dataset + run config), Code Arena (no board API), OpenHands Index (no export).
   Only DeepSWE, Artificial Analysis, METR, Aider, and SWE-bench/experiments can
   be ingested without scraping a rendered page. Three of those five are stale by
   more than 3 months.
8. **Cadence is undeclared almost everywhere.** Only two freshness statements
   were found in the whole survey: METR's *"periodically whenever we have new
   measurements"* and OpenHands' *"looking to do some more frequent updates going
   forward"*. Every other owner publishes dated artifacts with no promise. The
   catalog's `freshness.expiresAt` therefore has to be a **Kit-side policy
   decision per source**, not a value read from the owner.

## 8. Implication for the routing catalog

Minimal changes implied by the above, in order of value:

1. Split the `decisive` boolean into `measuresTriple` / `preservesEffort` /
   `preservesHarness` (§4). An effort route requires `preservesEffort`; a
   cross-source effort inference must be recorded as an inference.
2. Constrain `domain` to `general` unless the owner publishes a separate score
   for that domain (§1.3). Add a lint so a new adapter cannot introduce a domain
   the owner does not score.
3. Give `cost.unit` an explicit enum — `usd-per-attempt`, `usd-per-run`,
   `usd-per-success-derived` — so a derived number is never mistaken for a
   published one (§6).
4. Treat `long-horizon-autonomy` and `long-context-operation` as first-class
   workloads with their own suites, not as modifiers on other workloads (§1.2).
5. Keep the tier-degradation heuristic in the policy layer as an explicitly
   `unverified` prior, subject to override by local outcome telemetry (§5).
