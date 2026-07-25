# Frontend-agent benchmarks

Research snapshot: 2026-07-22

## Verdict

Credible frontend benchmarks now exist, but **there is no single trustworthy
"frontend capability" score**. The field measures four materially different
things:

1. visual generation and design preference;
2. functional browser behaviour and interaction;
3. implementation or repair inside an existing frontend repository;
4. design taste, accessibility, and responsive behaviour.

The strongest evidence stack for routing today is:

- **Code Arena WebDev** as the current live signal for greenfield frontend and
  human preference;
- **Vision2Web** as the most promising controlled end-to-end benchmark once its
  current season has results;
- **SWE-bench Multimodal**, optionally through the OpenHands Index, for repair
  in existing JavaScript/frontend repositories;
- **DeepSWE** for model-effort curves, because the frontend sources generally
  do not isolate effort;
- local, dated outcomes for a project's actual stack, design system,
  accessibility requirements, and definition of quality.

The resolver must keep these evidence dimensions separate. Combining them is
reasonable; pretending that one benchmark jointly proves model quality,
effort, harness quality, frontend taste, and repository reliability is not.

## Evidence map

| Source | What it actually measures | Evaluation | Current routing value | Main limitation |
|---|---|---|---|---|
| [Code Arena WebDev](https://arena.ai/leaderboard/code/webdev) | Prompt-to-app generation under an agentic web-development harness | Blinded pairwise user preference over rendered, interactive outputs | High for current greenfield frontend model/harness preference | Preference is not a pass rate; model and harness are coupled; little comparable effort data |
| [Vision2Web](https://vision2web-bench.github.io/) | Static responsive pages, interactive multi-page frontends, and full-stack sites from prototypes and requirements | VLM visual judge plus workflow-driven GUI agent | Potentially highest controlled end-to-end value | The active season's leaderboard is still empty; older-season scores are not directly comparable |
| [SWE-bench Multimodal](https://www.swebench.com/multimodal) | Real issue resolution in visual JavaScript repositories | Repository tests, including visual tests for a subset | High for existing-repository repair | Does not measure greenfield design taste; historical public GitHub tasks create exposure risk |
| [OpenHands Index](https://www.openhands.dev/blog/openhands-index) | A verified SWE-bench Multimodal subset under one OpenHands SDK, with cost/runtime | Executable benchmark plus standardized harness | Useful model comparison for repair | OpenHands performance is not automatically Claude Code or Codex performance |
| [WebGen-Bench](https://proceedings.neurips.cc/paper_files/paper/2025/hash/6841eed8bb6a2ec49e49235c8115efee-Abstract-Datasets_and_Benchmarks_Track.html) | Multi-file websites generated from requirements, including interaction | 647 manually refined cases executed by a web-navigation agent; separate appearance judge | Good methodological reference for functionality | Published model set is old; automated verifier is fallible |
| [DesignBench](https://github.com/WebPAI/DesignBench) | Generation, edit, repair, and compile repair in React, Vue, Angular, and vanilla HTML/CSS | Render similarity, compilation/code checks, and an MLLM judge | Good diagnostic taxonomy and reproducible local eval | Static public dataset and older model coverage; small isolated projects rather than mature repositories |
| [ArtifactsBench](https://github.com/Tencent-Hunyuan/ArtifactsBenchmark) | Interactive visual artifacts, including components, SVGs, and games | Temporal screenshots plus checklist-guided MLLM judge | Useful automated secondary signal | Judge bias/circularity; artifact generation rather than repository maintenance |
| [UI-Bench](https://arxiv.org/abs/2508.20410) | Holistic visual craft of text-to-app products | 4,000+ blinded expert pairwise judgments | Strong evidence about tool/product output quality | Ranks whole tools, not base models; explicitly excludes accessibility, load time, and code quality |
| [Design2Code](https://arxiv.org/abs/2403.03163) | Screenshot-to-HTML reproduction | Automatic visual metrics validated against human rankings | Useful for visual-fidelity diagnostics | Static, mostly single-page reproduction; no repository or interaction evidence |

## 1. The best current live signal: Code Arena WebDev

Code Arena asks users to submit a web-development prompt, lets two anonymous
models build deployable apps, and has users interact with both outputs before
voting. The current implementation records the agent trajectory and aggregates
pairwise preferences using a Bradley-Terry-style ranking. Voters are instructed
to consider functionality, usability, fidelity, design, taste, and aesthetics
([methodology](https://arena.ai/blog/code-arena/),
[original WebDev methodology](https://arena.ai/blog/webdev-arena/)).

At this snapshot the official leaderboard reports 506,528 votes:

| Configuration | Score | Status |
|---|---:|---|
| Kimi K3 | 1678 ± 17 | preliminary |
| Claude Fable 5 | 1634 ± 12 | established |
| GPT-5.6 Sol `xhigh`, Codex harness | 1630 ± 11 | established |

Fable and Sol have overlapping intervals. Kimi's apparent lead is relevant but
must remain marked preliminary. These are **model-plus-harness observations**,
not intrinsic model constants: only the Sol label exposes a comparable effort
setting, and it explicitly names the Codex harness.

The source is stronger than a static visual benchmark because prompts are live,
outputs are interactive, identities are hidden during voting, and the pool
changes with deployed models. It is also weaker than executable pass/fail tests:
a preference vote blends correctness and taste, evaluator expertise varies, the
prompt population is self-selected, and leaderboard position changes with the
opponent pool.

The seven current domains are also important for routing: reference-based
design, brand/marketing, data/analytics, consumer products, gaming,
simulations, and content-creation/editing tools. They were derived from more
than 250,000 filtered prompts, and domain leaderboards use the same evaluation
method ([category methodology](https://arena.ai/blog/new-categories-code-arena/)).
Therefore the routing source should ingest category scores rather than collapse
everything into one `frontend` number.

## 2. The strongest prospective controlled benchmark: Vision2Web

Vision2Web most closely matches the missing end-to-end contract. Its 193 tasks
contain 918 prototype images and 1,255 test cases across 16 categories. It has
three progressively harder levels:

- static responsive webpages, evaluated separately on desktop, tablet, and
  mobile;
- interactive multi-page frontend applications;
- long-horizon full-stack websites.

It evaluates visual similarity with a VLM judge and functional behaviour with a
GUI-agent verifier. Submissions include the model **and** agent framework, which
is the right unit of evidence for an agent-routing system
([project](https://vision2web-bench.github.io/),
[paper](https://arxiv.org/abs/2603.26648),
[submission/evaluation contract](https://huggingface.co/datasets/zai-org/Vision2Web-Leaderboard)).

The leaderboard is seasonal: tasks and evaluators may change, old submissions
are re-evaluated where possible, and scores from different seasons are
explicitly not comparable. As of this snapshot, the **current season has no
results**. Historical scores visible on the project page are useful for
understanding the benchmark, but must not yet drive a current policy.

This is the first source worth promoting to a primary routing adapter once the
active season has enough submissions and reports judge versions, sample size,
and confidence. Until then it should be represented as `candidate`, not as an
empty score or inherited historical winner.

## 3. Existing-repository frontend work: SWE-bench Multimodal

SWE-bench Multimodal contains 517 test instances from 12 mainly JavaScript
repositories. Issues include screenshots of bugs, mockups, diagrams, and visual
error context. The underlying collection contains web frameworks, UI component
libraries, mapping, charting, diagramming, and syntax-highlighting projects.
Success requires the repository's fail-to-pass and pass-to-pass tests to pass
([benchmark overview](https://www.swebench.com/multimodal),
[ICLR paper](https://proceedings.iclr.cc/paper_files/paper/2025/file/07d6332ae36730707fddddba736d7b6c-Paper-Conference.pdf)).

This makes it the best available answer to:

> Can this agent-model-harness configuration understand a visual frontend issue,
> navigate an established JavaScript repository, and land a test-passing fix?

It does not answer whether the same configuration creates a tasteful new UI.
Only 69 tasks use pixel-level visual testing; many other tasks are correctness
or repository-navigation problems with visual context. The original baselines
are stale, and the current official leaderboard still mixes different agents
and models. Historical GitHub-derived tasks also remain exposed after release,
so future leaderboard improvements require contamination caution.

The OpenHands Index is useful as a normalized view: it runs a human-verified
frontend subset through one OpenHands SDK and reports ability, cost, and runtime
([Index methodology](https://www.openhands.dev/blog/openhands-index)). It should
be stored as a separate harness observation, not generalized to Claude Code or
Codex.

## 4. Functional greenfield work: WebGen-Bench and newer diagnostics

WebGen-Bench creates multi-file website codebases from 101 requirements and
tests them with 647 operation/expected-outcome cases. Two PhD reviewers refined
the cases. A WebVoyager-based agent executes them and returns `YES`, `NO`, or
`PARTIAL`; reported agreement with manual testing ranged from 86.1% to 94.4%
for the three evaluated model sets. Appearance was judged separately. In the
published evaluation, Claude 3.5 Sonnet led appearance at 3.0/5 while
DeepSeek-R1 led the general-model functional score at 27.8%
([paper and evaluator validation](https://proceedings.neurips.cc/paper_files/paper/2025/file/6841eed8bb6a2ec49e49235c8115efee-Paper-Datasets_and_Benchmarks_Track.pdf)).

That separation between functional and visual results is valuable. The scores
are not a present-day routing table: models and harnesses are old, only 101
projects are used, and an agent judging another agent adds a measurable error
layer.

DesignBench is a good reusable taxonomy for isolated frontend work. Its 900
samples span React, Vue, Angular, and vanilla HTML/CSS across initial generation,
edits, repair of visual defects, and compilation repair. Defect categories
include occlusion, crowding, overlap, alignment, color/contrast, and overflow.
It also found very low adoption of framework-native component structures and
low UI-issue detection accuracy in the tested 2024/2025-era models
([paper](https://arxiv.org/abs/2506.06251),
[harness](https://github.com/WebPAI/DesignBench)). It is suitable for local
diagnostic evaluation but not as a live winner feed.

ArtifactsBench offers 1,825 component, visualization, and interactive-artifact
tasks. It evaluates source plus three-step rendered screenshots against
task-specific checklists with a multimodal judge and reports 94.4% ranking
consistency with WebDev Arena. That makes it a useful automated corroborating
source, but not a substitute for independent human judgment
([official repository](https://github.com/Tencent-Hunyuan/ArtifactsBenchmark)).

FrontendBench is conceptually attractive: its paper describes 148 prompt/test
pairs across five component-complexity levels, browser execution, generated
test scripts, and roughly 90.5% expert agreement
([paper](https://arxiv.org/abs/2506.13832)). However, the paper's code/data
release is still described as forthcoming. Until runnable artifacts and stable
results exist, it is not practical as a source adapter.

## 5. Taste, accessibility, and responsiveness remain distinct gaps

UI-Bench is the strongest controlled evidence for **taste**. It uses 30 prompts,
300 generated sites, more than 4,000 comparisons, and 194 invited professionals.
Tool identities and left/right placement are hidden; the forced-choice question
is which project the expert would be more likely to deliver to a client. Its
authors deliberately avoid CLIP/FID-style automatic metrics as the primary
endpoint because those proxies can mis-rank aesthetic preference
([paper and protocol](https://ar5iv.labs.arxiv.org/html/2508.20410)).

But UI-Bench ranks complete text-to-app products, not base models. Templates,
asset pipelines, orchestration, repair passes, and post-processing all affect
the result. It also explicitly excludes accessibility, load time, and code
quality, and evaluates desktop layouts. It cannot justify a model route by
itself.

There are smaller accessibility studies. One tested eleven component patterns
from WCAG 2.1 across ChatGPT 4o, Copilot Pro, Claude 3.7 Sonnet, and Grok 3
([published study](https://doi.org/10.1007/s10209-025-01250-2)); another found
308 WCAG 2.2 and cognitive-accessibility errors across six generated sites
([ASSETS 2025 paper](https://doi.org/10.1145/3663547.3759755)). These establish
that accessibility is not implied by visual quality. Their tiny task/model sets
and stale versions make them diagnostics, not routing feeds.

Vision2Web is the clearest emerging responsiveness measure because Level 1 has
desktop, tablet, and mobile scores. With its current season empty, there is not
yet a current model comparison that jointly and robustly measures
responsiveness. DesignBench's overflow and contrast repairs are useful but do
not amount to WCAG conformance or a viewport matrix.

## 6. Benchmarks that do not qualify as frontend-building evidence

- WebArena, VisualWebArena, BrowserGym, WorkArena, and WebVoyager primarily test
  an agent **operating existing websites**. They are browser-use evidence, not
  evidence that the agent can implement those websites
  ([VisualWebArena](https://github.com/web-arena-x/visualwebarena),
  [BrowserGym](https://github.com/ServiceNow/BrowserGym)).
- WebSight is a synthetic screenshot/HTML training dataset, not a comparative
  agent benchmark.
- Design2Code is useful for screenshot fidelity but omits realistic
  interaction and repository integration.
- Raw JavaScript/TypeScript subsets of general coding benchmarks do not become
  frontend benchmarks unless the tasks actually exercise rendering,
  interaction, or visual requirements.

## 7. Implications for a routing evidence catalog

Every observation should preserve at least:

```yaml
workload:
  lifecycle: greenfield | edit | repair
  frontend_domain: reference-design | marketing | analytics | product | game | simulation | editor
  repository_context: isolated | existing-repository
  quality_axis: visual-preference | visual-fidelity | functional | accessibility | responsive

configuration:
  surface: codex | claude-code | openhands | other
  harness: concrete-version
  model: concrete-version
  effort: low | medium | high | xhigh | max | unknown

evidence:
  source: code-arena | vision2web | swe-bench-multimodal | other
  benchmark_revision: concrete-revision-or-season
  observed_at: yyyy-mm-dd
  score: value
  uncertainty: value-or-unknown
  sample_size: value-or-unknown
  status: established | preliminary | candidate | stale
```

Routing rules should then follow these constraints:

1. For greenfield frontend, prefer current Code Arena **domain-specific**
   evidence, tempered by local outcomes.
2. For existing-repository visual repair, prefer SWE-bench Multimodal or a
   normalized OpenHands view.
3. Promote Vision2Web when the active season has enough comparable submissions;
   never carry a previous-season winner forward silently.
4. Do not infer an effort curve from Code Arena. Combine its frontend evidence
   with a separate effort benchmark such as DeepSWE and mark the inference.
5. Treat model-plus-harness as the observed unit. A Claude model in OpenHands is
   not evidence for the same model in Claude Code without corroboration.
6. Accessibility and responsiveness require explicit constraints and local
   verification until broader current leaderboards exist.
7. Keep the maintainer's dated experience as legitimate local evidence. Public
   benchmarks calibrate it; they do not automatically overwrite it.

## Conclusion

Frontend routing is no longer evidence-free. Code Arena already supports the
claim that Kimi, Claude, and OpenAI configurations differ in real interactive
frontend preference, and it currently places Kimi K3 first provisionally, with
Fable 5 and Sol `xhigh` close behind. That result is not enough to derive a
universal model-effort rule.

The durable solution is a multi-source routing catalog: live human preference
for greenfield work, controlled visual/functional evaluation when Vision2Web is
populated, executable repository repair evidence, a separate effort curve, and
local calibration for the exact product and design system.
