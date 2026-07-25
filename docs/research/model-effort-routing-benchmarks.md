# Benchmark evidence for model and effort routing

**Researched:** 2026-07-22  
**Question:** How should current benchmark evidence inform a provider-neutral,
user-owned routing policy without turning today's model and effort winners into
permanent Kit defaults?

## Conclusion

The evidence supports a **mutable, workload-specific routing policy**, not a
universal mapping such as `mechanical -> Luna/high`, `development ->
Terra/max`, or `judgment -> Fable/high`.

Three findings matter for the current design:

1. **Effort scaling is model-specific.** On DeepSWE, moving from `xhigh` to
   `max` adds about 9.4 pass-rate points for GPT-5.6 Terra and 10.3 points for
   Luna. For Claude Fable 5, `high`, `xhigh`, and `max` overlap within the
   reported uncertainty while average cost rises from $9.18 to $21.63 per
   trial.
2. **The best route depends on the workload and objective.** Sol leads the
   current Artificial Analysis coding-agent aggregate and DataCurve DeepSWE;
   Fable leads Sol on Artificial Analysis' repository-Q&A component and has
   separate strengths in knowledge work. Luna is exceptionally cost-efficient.
   Artificial Analysis' intelligence results place Luna and Sol, not Terra, on
   the cross-family cost/quality frontier.
3. **Benchmark rows are configurations, not timeless model facts.** Harness,
   effort, fallback behavior, benchmark version, provider pricing, retries, and
   access failures all affect the result. A model mapping inferred today can be
   stale when a new family, alias, effort level, or benchmark revision lands.

The Kit should therefore own a routing schema, evidence format, resolver, and
reconciliation workflow. The user or organization should own the current
model/effort choices. Benchmarks can generate a dated recommendation, but may
not silently rewrite that policy.

## Current evidence

### DataCurve DeepSWE v1.1

DeepSWE contains 113 original, long-horizon software-engineering tasks across
91 repositories and five languages. The current leaderboard was updated on
2026-07-21. Every row below uses the same `mini-swe-agent` harness and four
whole-benchmark runs; pass-rate uncertainty is DataCurve's reported 95%
run-to-run interval. Costs are average API cost per completed trial
([leaderboard](https://deepswe.datacurve.ai/),
[machine-readable leaderboard artifact](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json)).

| Configuration | Pass@1 | 95% half-width | Avg cost/task | Attempts |
|---|---:|---:|---:|---:|
| GPT-5.6 Luna medium | 11.3% | ±0.8 | $0.22 | 452 |
| GPT-5.6 Luna high | 44.2% | ±2.9 | $0.78 | 452 |
| GPT-5.6 Luna xhigh | 56.9% | ±2.2 | $1.54 | 452 |
| **GPT-5.6 Luna max** | **67.2%** | **±4.0** | **$3.03** | 448 |
| GPT-5.6 Terra medium | 35.1% | ±3.4 | $0.58 | 450 |
| GPT-5.6 Terra high | 53.8% | ±4.3 | $1.13 | 452 |
| GPT-5.6 Terra xhigh | 60.2% | ±2.1 | $2.13 | 452 |
| **GPT-5.6 Terra max** | **69.6%** | **±2.6** | **$4.95** | 451 |
| GPT-5.6 Sol medium | 61.1% | ±1.6 | $1.86 | 452 |
| **GPT-5.6 Sol high** | **69.4%** | **±1.4** | **$3.47** | 451 |
| GPT-5.6 Sol xhigh | 70.7% | ±0.8 | $4.70 | 451 |
| GPT-5.6 Sol max | 72.7% | ±2.8 | $8.39 | 450 |
| Claude Fable 5 medium | 65.4% | ±4.4 | $6.09 | 436 |
| **Claude Fable 5 high** | **68.6%** | **±1.1** | **$9.18** | 430 |
| Claude Fable 5 xhigh | 69.9% | ±3.2 | $13.41 | 452 |
| Claude Fable 5 max | 69.7% | ±4.0 | $21.63 | 436 |

What this does and does not establish:

- **Luna max is strongly efficient for this workload.** It reaches 67.2% for
  $3.03, statistically overlaps Terra max and Fable's higher-effort rows, and
  is cheaper than all of them.
- **Terra max is a real within-family improvement.** It gains 9.4 points over
  Terra xhigh and 15.9 over high. On point estimates across families, however,
  Sol xhigh is both slightly cheaper and slightly higher-scoring, so Terra max
  is not a universal Pareto winner.
- **Sol high is a defensible efficiency point.** Sol max adds 3.3 points to
  high for about 2.4 times the cost, and their confidence intervals overlap.
  Sol xhigh adds 1.3 points for about 1.36 times the cost. This supports the
  user's observation that `high` can be sufficient, but it does not prove the
  higher efforts never matter.
- **Fable high is the clearest “high is sufficient” result here.** High,
  xhigh, and max are statistically overlapping; max has a slightly lower point
  estimate than xhigh while costing 2.36 times high. The result argues against
  defaulting Fable to max for implementation work.

DeepSWE itself warns that adjacent frontier configurations often overlap in
confidence intervals. Its v1.1 execution grades only committed patches in a
fresh verifier container and removed dependency drift and flaky tests. It also
reports that 73 of Fable's 2,260 trials did not complete after access was
suspended during the sweep; Fable rates are calculated over completed trials
([v1.1 report](https://deepswe.datacurve.ai/blog/deepswe-v1-1)).

The standardized harness is both a strength and a limitation. It isolates the
model comparison, but gives every model one Bash tool and a shared prompt
instead of Codex's or Claude Code's native editing tools and prompts. DataCurve
explicitly says the leaderboard does not directly represent those native
products, and the corpus under-represents bug localization and refactoring
([DeepSWE methodology and limitations](https://deepswe.datacurve.ai/blog/deepswe#limitations)).

### Artificial Analysis

#### Current coding-agent comparison

Artificial Analysis' current Coding Agent Index v1.3 combines DeepSWE,
Terminal-Bench, and SWE-Atlas-QnA. The currently exposed Codex/Claude Code rows
use `max` effort. They are **agent + model + settings** measurements, not the
same mini-swe-agent experiment as DataCurve
([current comparison](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-codex),
[coding-agent methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)).

| Agent configuration | Coding Agent Index | DeepSWE | Terminal-Bench | SWE-Atlas-QnA | Avg cost/task |
|---|---:|---:|---:|---:|---:|
| Codex + GPT-5.6 Sol max | 66.57 | 68.73% | 87.70% | 43.28% | $7.08 |
| Codex + GPT-5.6 Terra max | 62.28 | 66.96% | 84.13% | 35.75% | $2.76 |
| Codex + GPT-5.6 Luna max | 58.66 | 63.42% | 79.76% | 32.80% | $1.57 |
| Claude Code + Fable 5 max | 65.85 | 66.08% | 82.54% | **48.92%** | $11.71 |

Sol narrowly leads the aggregate and the implementation/terminal components;
Fable leads repository Q&A. Luna gives up about 7.9 index points to Sol while
costing about 78% less per task. That supports different routes for repository
analysis, demanding implementation, and cost-sensitive execution rather than
one global “best model.”

Do not mix these figures with Artificial Analysis' July 9 launch chart without
a version label. The launch chart used the prior scoring contract and reported
80/77/77/75 for Sol/Terra/Fable/Luna. Coding Agent Index v1.2 changed
SWE-Atlas-QnA from rubric reward to binary all-criteria success and v1.3 refined
the alignment, so the current values are not a performance regression measured
on an unchanged scale
([launch analysis](https://artificialanalysis.ai/articles/gpt-5-6-has-landed),
[versioned methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)).

#### Intelligence-versus-cost by effort

Artificial Analysis Intelligence Index v4.1 is a broader, English text-only
composite: agents 34%, coding 24%, scientific reasoning 24%, and general
capability 18%. Artificial Analysis estimates the composite's 95% confidence
interval below ±1%, while warning that individual evaluations can be wider
([Intelligence Index methodology](https://artificialanalysis.ai/methodology/intelligence-benchmarking)).

Current model pages expose the following scores and weighted API cost per
Intelligence Index task:

| Model | Medium | High | Xhigh | Max |
|---|---:|---:|---:|---:|
| GPT-5.6 Sol | 54 / $0.314 | 56 / $0.453 | 58 / $0.682 | 59 / $1.037 |
| GPT-5.6 Terra | 46 / $0.175 | 49 / $0.336 | 52 / $0.477 | 55 / $0.825 |
| GPT-5.6 Luna | 38 / $0.050 | 46 / $0.095 | 49 / $0.139 | 51 / $0.209 |
| Claude Fable 5 | — | — | — | 60 / $2.750 |

Sources: Artificial Analysis model pages for
[Sol max](https://artificialanalysis.ai/models/gpt-5-6-sol),
[Sol high](https://artificialanalysis.ai/models/gpt-5-6-sol-high),
[Terra max](https://artificialanalysis.ai/models/gpt-5-6-terra),
[Terra high](https://artificialanalysis.ai/models/gpt-5-6-terra-high),
[Luna max](https://artificialanalysis.ai/models/gpt-5-6-luna),
[Luna high](https://artificialanalysis.ai/models/gpt-5-6-luna-high), and
[Fable max](https://artificialanalysis.ai/models/claude-fable-5).

Artificial Analysis' own cross-effort analysis concludes that Luna and Sol are
ahead of Terra at every point on this composite's intelligence-versus-cost
chart: for any Terra effort, a Luna or Sol configuration is at least as capable
for no more cost, or equally capable for less. Luna is the standout
cost-efficient family
([GPT-5.6 intelligence-versus-cost analysis](https://artificialanalysis.ai/articles/gpt-5-6-intelligence-vs-cost-across-sol-terra-luna)).

This result does **not** contradict Terra max's strong DeepSWE result. It shows
why a single benchmark or a single global Pareto frontier cannot determine the
route for every workload.

## Provider guidance and availability

OpenAI describes Sol, Terra, and Luna as durable capability tiers that can
advance independently. Codex users with access can select each tier and an
effort level; `max` is available across the family. OpenAI prices Sol at
$5/$30, Terra at $2.50/$15, and Luna at $1/$6 per million input/output tokens
([GPT-5.6 launch and availability](https://openai.com/index/gpt-5-6/)).

Anthropic exposes `low`, `medium`, `high`, `xhigh`, and `max` where supported.
It defines effort as a behavioral signal rather than a strict token budget and
says the effect varies by workload. For Fable 5, Anthropic recommends starting
at `high`, using `xhigh` only for the most capability-sensitive workloads, and
lowering effort for routine work. Its general guidance is to use `max` only
when the absolute highest capability justifies unconstrained token spending
([Anthropic effort guidance](https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-fable-5)).

The Artificial Analysis Fable results also require a provenance warning:
Fable's evaluated configuration uses adaptive reasoning at max effort with an
Opus 4.8 fallback. It is a routing-system result, not a pure Fable-only result
([Artificial Analysis Fable analysis](https://artificialanalysis.ai/articles/claude-fable-5-mythos)).

## Measurement caveats

- **Costs are estimates for the measured API traffic.** They include reported
  input/output and supported cache prices, but exclude subscription economics,
  developer supervision, CI, failed deployments, and the cost of rerunning an
  incorrect patch. Provider or gateway pricing can differ.
- **Retries differ by benchmark.** Artificial Analysis retries API failures up
  to 30 times and withholds persistently broken results; this is reliability
  handling, not multiple solution attempts. DeepSWE reports pass@1 over four
  repeated whole-benchmark runs and exposes incomplete attempts separately.
- **Pass rate is not expected project value.** A cheaper row can be worse if a
  failure causes an expensive human recovery. Conversely, paying for max on a
  highly constrained mechanical task can waste tokens without reducing risk.
- **Statistical overlap matters.** Point estimates such as Sol high versus max
  or Fable high versus max should not be treated as proven capability gaps when
  their intervals overlap.
- **Harness and task mix matter.** DataCurve's model-neutral Bash harness and
  Artificial Analysis' native Codex/Claude Code rows answer different
  questions. Neither directly measures this Kit's planning, grilling,
  orchestration, review, or release workflows.
- **Evidence expires.** Both leaderboards were updated during July 2026 and
  their benchmark contracts have already changed. A recommendation without a
  source date, benchmark version, and configuration identity is unsafe input
  to automation.

## Implication for the Kit routing policy

The durable issue contract should continue to contain provider-neutral work
intent. The mutable user or organization policy should be richer than a fixed
`tier -> model + effort` lookup:

```yaml
routing-intent: implementation
objective:
  quality-floor: normal
  optimize: expected-cost
risk:
  recovery-cost: medium
```

At reconciliation time, a surface adapter can evaluate the user's allowed
models against a dated evidence catalog and propose a concrete route. The
catalog entry must identify at least:

- provider, model or alias, and effort;
- benchmark name and version;
- workload tags and harness;
- score, uncertainty, average cost, and observation date;
- fallback behavior and important missing data.

The policy lifecycle should be:

1. `setup-workflow` installs the schema and defaults to `inherit`; it may offer
   an explicit user-local policy setup.
2. Kit releases update schemas, adapters, and an optional evidence snapshot,
   but never overwrite personal mappings.
3. A separate `routing-policy reconcile` compares current choices with
   available models and dated evidence, shows the relevant Pareto candidates,
   and asks before changing the user-global policy.
4. The resolver records the effective model and effort plus the policy/evidence
   revision in run evidence.
5. Local outcome telemetry and explicit user judgment may override public
   benchmark recommendations. Public data supplies a prior; the user's real
   workflow is the calibration set.

This permits a current personal preference such as Fable high for planning,
Sol or Terra for implementation, and Luna for cheap mechanical work without
claiming that those mappings are correct for every consumer—or even for the
same user after the next model or benchmark release.
