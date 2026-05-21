# Eval framework plan

## Status: what's landed (2026-05-19)

The eval framework is now built and tested. Highlights:

- **Per-turn instrumentation** in `container/agent-act.sh`: each agent turn
  emits a `__TURN_STATS__ <json>` marker on stdout. The orchestrator parses
  it (`parseTurnStatsMarkers` in `lib/lab-web-actions.mjs`) and appends a
  `turn-stats` event to the durable JSONL log.
- **Reasoning capture**: omlx's `reasoning_content` is captured separately
  from the answer JSON. Setting `LLM_THINKING_BUDGET=400` (or higher) is
  what makes Qwen3.5-DeepSeek-V4-Flash-4bit usable end-to-end — without
  the budget the model loops on CoT indefinitely. Tested at ~9 s per turn
  with clean JSON.
- **Aggregator** (`eval/aggregate.mjs`): pure module + CLI. Scorecard
  covers prompt-following, game-shape, belief-quality, and performance.
- **Batch runner** (`eval/run.mjs`): drives N games against `/api/run`,
  collects durable logs into `eval/runs/<profile>-<stamp>/`, writes
  `scorecard.json`.
- **Profiles**: `eval/profiles/stub-smoke.json` (3-game pipeline sanity)
  and `eval/profiles/omlx-qwen35.json` (10-game Qwen3.5 with
  `thinking_budget=400`).
- **Tests**: `tests/eval-aggregate.mjs` and `tests/eval-run.mjs` cover
  metric correctness, edge cases (empty / malformed / missing fields),
  end-to-end via mock HTTP, and HTTP failure paths.

**Landed since the original plan:**

- `eval/gates.mjs` — hard / soft regression gates with per-profile overrides;
  wired into `eval/run.mjs` (exits non-zero on hard failure, writes
  `gates.json` alongside `scorecard.json`); tested in `tests/eval-gates.mjs`.
- `eval/fixtures/{village-win,wolf-win,malformed-turn-stats}.jsonl` —
  committed reference game logs. `tests/eval-aggregate.mjs` loads them from
  disk and asserts that `aggregate(...)` matches the committed
  `eval/baselines/fixtures.json` exactly.
- `eval/baselines/fixtures.json` — deterministic baseline of the fixtures
  aggregate. See `eval/baselines/README.md` for the regeneration recipe.
- `eval/profiles/omlx-large.json` — 50-game omlx variance-analysis profile,
  wired via `make eval-large`.

**Not yet built (in this plan but deferred):** promptfoo wiring, the
Anthropic provider branch in `container/agent-act.sh`, LLM-as-judge
deception metrics, committed live-run baseline for `stub-smoke` (lazy;
requires Docker), `openai-mini` / `anthropic-haiku` profiles.

The rest of this document is the original design discussion — useful for
understanding why we chose this architecture and what's planned for the
deception-judge and hosted-provider phases.

## Prior art survey (2024–2026)

Before building a custom framework, surveyed what already exists.

### Werewolf-specific benchmarks

| Project | Year | Source | What it gives us |
|---|---|---|---|
| **Werewolf Arena** (Google) | 2024 | [arXiv 2407.13943](https://arxiv.org/abs/2407.13943) | Bidding-based dynamic turn-taking; LLM-vs-LLM matchups. Metric taxonomy for deception/persuasion. |
| **WOLF benchmark** | Dec 2025 | [arXiv 2512.09187](https://arxiv.org/abs/2512.09187) | Separable measurement of *deception production* vs *deception detection*. Strong metric definitions. |
| **WereWolf-Plus** (DSGBench update) | 2025 | [arXiv 2506.12841](https://arxiv.org/pdf/2506.12841) | Multi-model, multi-dimensional benchmarking platform. |
| **MultiAgentBench (Werewolf scenario)** | 2025 | [MultiAgentBench](https://www.emergentmind.com/topics/multiagentbench) | Werewolf as one of several social-deduction scenarios in a broader multi-agent benchmark. |
| **GameBench** | 2024 | [arXiv 2406.06613](https://arxiv.org/pdf/2406.06613) | Cross-domain strategic reasoning (board, card, deception games). |
| **Beyond Survival** | 2025 | [arXiv 2510.11389](https://arxiv.org/pdf/2510.11389) | Human-aligned strategy evaluation in social deduction games. |

**Verdict on werewolf benchmarks**: do **not** adopt any of these wholesale.
They are bench-style projects with their own game engines that conflict
with our DuckDB Quack federation. But **borrow their metric taxonomy**,
specifically WOLF's deception-production / deception-detection split and
Werewolf Arena's prompt-following + voting-accuracy framing.

### General multi-provider eval frameworks

| Tool | Strength | Weakness for this project |
|---|---|---|
| **promptfoo** (acquired by OpenAI Mar 2026) | 50+ providers OOTB; custom HTTP provider via webhook; CLI-first; scorecard + diff; multi-provider comparison is the headline feature | Designed for single-call prompt A/B more than stateful multi-turn games; still useful as the cross-provider runner shell |
| **Inspect AI** (UK AISI) | Best-in-class for agentic multi-turn tasks; clean task/scorer/solver abstractions; multi-provider | Python; we'd add a Python bridge to a Node orchestrator |
| **DeepEval** (Confident AI) | Pytest-style; 50+ metrics including multi-turn; MIT licensed | Python; pytest impedance with our bash/bun stack |
| **LangSmith / Phoenix / Galileo / Arize** | Observability + eval combined | SaaS-leaning; heavy for one self-contained game |
| **Braintrust** | Good observability, scoring, datasets | SaaS-leaning; overkill |

### Recommendation: hybrid — promptfoo as runner shell, custom aggregator for game metrics

The right shape for *this* project is:

1. **promptfoo as the cross-provider runner and scorecard layer.**
   - Each provider (stub / omlx / openai / anthropic) is a
     [promptfoo custom provider](https://www.promptfoo.dev/docs/providers/custom-api/)
     defined in YAML. The "provider" simply POSTs to our local
     `/api/run` (or to `eval/run.mjs`) and returns the path to the
     durable JSONL.
   - promptfoo handles: iteration count, parallelism, per-provider
     output capture, diff-vs-baseline view, the CLI ergonomics, and the
     html report. We do not reinvent any of that.
   - One YAML config (`eval/promptfooconfig.yaml`) describes the matrix
     of provider × profile × game-count.
2. **Custom `eval/aggregate.mjs` for game-specific metrics.**
   - promptfoo's per-output assertions cannot compute "did the seer's
     investigation hit a wolf?" or "what was the wolf consensus
     rotation?". Those require joining the durable log against the
     `game-start` event's role assignments.
   - The aggregator stays pure (input: array of parsed JSONL events,
     output: scorecard object) and is consumed by promptfoo as a
     [model-graded assertion via JS function](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/).
3. **Borrow metric definitions, not code, from WOLF and Werewolf Arena.**
   - From WOLF: split `deception_production_rate` (wolves lying in
     `public_text`) from `deception_detection_rate` (villagers
     correctly accusing wolves) — separable metrics that promote
     better debugging than a single "winrate".
   - From Werewolf Arena: include `vote_accuracy` (fraction of
     villagers' votes that targeted an actual wolf) and
     `survival_curve` (alive-count by round).

This gives us multi-provider comparison, a real UI, baselines, gates,
and a self-built core for game logic — no Python dependency, no SaaS
account, no fork of a research benchmark.

## Why this is needed

Every test in `tests/*.sh` and `tests/lab-web.mjs` exercises one of:

- the `stub` LLM provider (scripted, no real model),
- a fake `curl` shim that returns a hard-coded JSON object,
- pure helpers (`buildContextForAgent`, `resolveLynch`, `serializeRefereeEvent`, etc.).

What we have never measured:

- whether a real model (omlx local or OpenAI) follows the JSON contract,
- whether it picks alive, non-self, non-partner targets without orchestrator override,
- whether wolves converge in fewer than three rotations,
- whether the seer hit-rate is better than random,
- whether the win rates and round lengths stay stable across model changes.

The eval framework closes that gap. It runs N autoGames against the live
stack, harvests structured events from the durable referee log, and
produces a scorecard.

## Backend strategy: omlx primary, real hosted LLMs first-class

The eval framework runs against **multiple LLM backends in the same
pipeline**, not a single one. omlx (local MLX OpenAI-compatible server)
is the default and the committed baseline; hosted models (OpenAI,
Anthropic) are first-class supported providers that ship with their own
profiles and baselines. Every metric, every aggregator path, every
regression gate works identically across all backends.

Why this shape:

- **omlx as the daily-driver baseline.** Zero marginal cost means we can
  run N=50 games before each release without budgeting; reproducible
  pinned weights; offline; matches the post's thesis ("federated
  multi-agent on local infra"). The stack already wires it
  (`lib/lab-web-actions.mjs` uses the host bridge URL
  `http://host.docker.internal:8000/v1` and a 180s timeout).
- **Real hosted LLMs because they are the comparison that matters.**
  "How close does the local 7B model come to gpt-4o-mini / Claude
  Haiku?" is the question a reader of the blog post will ask. The eval
  needs to answer it with numbers, not handwaving. Hosted providers
  also let us catch prompt regressions that only fail on the local
  model, by showing they did not fail on the bigger model.
- **stub for pipeline sanity.** The `stub` provider exists so CI can
  exercise the entire eval flow (runner → game logs → aggregator →
  scorecard) without booting a model server or paying for API calls.

Concretely the eval framework supports four providers:

| Provider | `LLM_PROVIDER` value | Endpoint                                | Notes |
|----------|----------------------|-----------------------------------------|-------|
| stub     | `stub`               | n/a                                     | Scripted; pipeline sanity only |
| omlx     | `omlx`               | `http://host.docker.internal:8000/v1`   | Default baseline; local MLX server |
| openai   | `openai`             | `https://api.openai.com/v1`             | Hosted; gated on `OPENAI_API_KEY` |
| anthropic| `anthropic` (new)    | `https://api.anthropic.com/v1`          | Hosted; gated on `ANTHROPIC_API_KEY`; **requires a new provider path in `agent-act.sh`** since Claude's chat API is not OpenAI-compatible |

The Anthropic path is the only new-code chunk on the agent side. Plan it
as a small module `container/agent-act-anthropic.sh` (or a switch inside
`agent-act.sh`) that translates the same system + user messages into
Claude's `/messages` request, uses prompt caching for the system block,
and parses `content[0].text` as the JSON object. Everything downstream
(`__BELIEFS__` marker, `__TURN_STATS__` marker, durable log) is
provider-agnostic.

## Goals

1. Detect regressions when we change prompts, swap the local model, or
   refactor the orchestrator, across **every supported backend**.
2. Quantify prompt-following on each backend so we can see whether a
   prompt change helps or hurts a specific model.
3. Produce reproducible baselines for omlx, openai, and anthropic;
   commit them; diff on every change.
4. Gate CI on a tiny stub eval so the eval pipeline itself stays green.
5. Produce a head-to-head comparison table in the post-game scorecard
   when more than one backend is provided in a single run.

## Non-goals

- Continuous leaderboard hosted on the public site. We may add a
  leaderboard for the blog later; v1 just dumps scorecards.
- Statistical significance testing. We will eyeball deltas; later
  iterations can add bootstrap CIs.
- Replacing the existing unit tests. The eval is additive.
- Running the eval as part of `bun deploy` or any production build.
  Evals run on demand, locally.

## What we measure

### Prompt-following metrics (per LLM turn)

- `valid_json_rate` — fraction of LLM calls where the response parsed as a
  JSON object on the first try (no fallback through `text_turn_json`).
- `target_override_rate` — fraction of turns where the orchestrator
  rewrote the LLM's `target` because it was self / dead / a wolf partner.
- `action_in_phase_rate` — fraction of turns where the raw `action`
  matched the phase contract (`speak|accuse|investigate` for day,
  `wolf-kill|wolf-done` for wolf, etc.).
- `valid_suspicions_rate` — fraction of `suspicions[]` entries with target
  in the active roster.
- `belief_emit_rate` — fraction of LLM turns that emit at least one
  suspicion or knowledge entry.

### Game-shape metrics (per game)

- `winner` — `village`, `wolves`, or `undecided`.
- `rounds` — number of complete rounds played.
- `wolf_rotations_to_consensus` — average rotations across nights to reach
  the `wolf-done` sentinel; capped at three.
- `night_saved_rate` — fraction of nights where the doctor save cancelled
  a wolf kill.
- `seer_first_target_role` — distribution of roles among the seer's first
  pick each game (used to detect "always investigates first agent" bugs).
- `seer_accuracy` — among seer investigations, fraction whose targets are
  actually wolves.

### Belief-quality metrics (per game)

- `wolf_in_top_suspicion_rate` — for each village agent's final-round
  suspicion list, fraction where at least one actual wolf appears in the
  top half (ranked by `p_wolf`).
- `false_accuse_rate` — fraction of `accuse` actions targeting confirmed
  non-wolves (using post-game reveals from the durable log).

### Deception metrics (imported from WOLF benchmark taxonomy)

- `deception_production_rate` — fraction of wolves' day-phase
  `public_text` rows that contain a factual claim contradicting their
  private `rationale` or actual role. Scored by an LLM-as-judge pass
  over the post-game durable log (sampled, not exhaustive).
- `deception_detection_rate` — fraction of villagers' `accuse` actions
  whose target is an actual wolf, conditional on the wolf having
  produced at least one deceptive utterance up to that point.
- `vote_accuracy` — fraction of villager votes (across all rounds) that
  target a wolf. Distinct from `false_accuse_rate` because votes are a
  separate commitment.
- `survival_curve` — array of `alive_count` by round, per game.
  Aggregated into a mean curve for the batch; useful for visualizing
  game pacing differences across providers.

### Batch metrics (across the run)

- `village_winrate`, `wolf_winrate`, `undecided_rate`.
- Per-metric mean + min + max + stddev.
- Cost surrogate: `total_llm_calls`, `total_tokens` (if the provider
  returns usage data; OpenAI-compatible endpoints typically do).

## Required instrumentation (NOT YET BUILT)

These are the hooks the eval depends on. They are intentionally small and
should be merged behind a single PR before the eval framework lands.

### 1. Per-turn stats marker in `agent-act.sh`

Print one line per turn, alongside the existing `__BELIEFS__ <json>`:

```
__TURN_STATS__ {"agent":"agent-a","role":"wolf","phase":"wolf","round":1,
  "provider":"omlx","model":"qwen-2.5-7b-instruct",
  "raw_action":"kill","raw_target":"agent-d",
  "final_action":"wolf-kill","final_target":"agent-b",
  "had_json":true,"target_override":true,
  "suspicions_count":0,"knowledge_count":0,
  "usage":{"prompt_tokens":612,"completion_tokens":48}}
```

Sources for the fields:

- `had_json` — true if `model_content_turn_json` took the JSON branch.
- `target_override` — true if `raw_target` differs from the normalized
  `final_target`.
- `usage` — pulled from `response.usage` when present (omlx and OpenAI
  both return it).

### 2. Orchestrator capture

`runAgentPhase` in `lab-web-server.mjs` already captures stdout via
`runStepCapture` for the beliefs marker. Add a `parseTurnStatsMarkers`
helper next to `parseBeliefsMarkers` and append a `turn-stats` event to
the durable log for each marker. This keeps everything queryable from one
file per game.

### 3. Pre-elim role table per game

The durable log already includes `game-start` (with the role assignment)
and `wolf-kill` / `lynch` events that carry `revealed_role`. That is
sufficient for `seer_accuracy` and `false_accuse_rate`. No new event
needed; the aggregator just joins on `game-start.players`.

## Aggregator design

New file `eval/aggregate.mjs`. Pure function `aggregate(games)` where
`games` is an array of arrays of parsed JSONL events. Returns:

```ts
{
  batch: {
    games: number,
    village_winrate: number,
    wolf_winrate: number,
    undecided_rate: number,
    avg_rounds: number,
    avg_wolf_rotations_to_consensus: number,
    night_saved_rate: number,
  },
  prompt_following: {
    valid_json_rate: number,
    target_override_rate: number,
    action_in_phase_rate: number,
    valid_suspicions_rate: number,
    belief_emit_rate: number,
    per_phase: { day: {...}, vote: {...}, wolf: {...}, seer: {...}, doctor: {...} },
  },
  beliefs: {
    seer_accuracy: number,
    wolf_in_top_suspicion_rate: number,
    false_accuse_rate: number,
  },
  cost: {
    total_llm_calls: number,
    total_prompt_tokens: number,
    total_completion_tokens: number,
  },
  per_game: Array<{ game_id, winner, rounds, ... }>,
}
```

The function is deterministic and pure so it can be unit tested with
synthetic JSONL fixtures.

CLI mode: `eval/aggregate.mjs <glob>` walks the matching JSONL files,
parses each line, and prints the scorecard to stdout. `--json` flag emits
the machine-readable structure for diffing.

## Runner design

Two pieces, with promptfoo on the outside and a thin custom shim on the
inside.

### Outside: `eval/promptfooconfig.yaml`

```yaml
description: "werewolf-quack-lab cross-provider eval"
providers:
  - id: file://eval/providers/stub.mjs
    label: stub
  - id: file://eval/providers/omlx.mjs
    label: omlx-qwen-2.5-7b
    config:
      model: qwen-2.5-7b-instruct
      base_url: http://localhost:8000/v1
  - id: file://eval/providers/openai.mjs
    label: openai-gpt-4o-mini
    config:
      model: gpt-4o-mini
  - id: file://eval/providers/anthropic.mjs
    label: anthropic-haiku
    config:
      model: claude-haiku-4-5-20251001
tests:
  - vars:
      profile: omlx-default
      games: 25
    assert:
      - type: javascript
        value: file://eval/assertions/scorecard-gates.mjs
```

promptfoo iterates each provider × test row, invokes the provider
module, captures its return value (a scorecard summary plus durable-log
paths), and renders an HTML / Markdown comparison table.

### Inside: `eval/providers/<name>.mjs`

Each provider module exports a single `callApi(prompt, context, options)`
function. The module's only job is:

1. Build a `RunSpec` from `context.vars.profile` and the provider's
   config (model, base URL, API key env var).
2. POST it to the already-running lab UI on `LAB_WEB_PORT` `/api/run`.
   Loop for `games` iterations or fan out in parallel.
3. Collect the durable-log paths from each game's response.
4. Pass the parsed events to `eval/aggregate.mjs#aggregate` and
   return the scorecard. promptfoo treats this as the "output" of the
   provider for that test row.

Why a JS shim and not a direct promptfoo HTTP provider:

- promptfoo's built-in HTTP provider is single-call; our run is "N
  games" and needs a small client loop.
- The shim is the only place that needs to know about the lab UI; the
  rest of the framework (promptfoo, aggregator, gates) is provider-
  agnostic.

### Profiles ship as `eval/profiles/*.json`

Profile fields: `games`, `players` (count + role mix), `max_rounds`,
`seed_strategy`, `wolf_rotations_max`.

Profiles to ship:

- `stub-smoke.json` — 3 games, provider stub. Free, runs in CI as part
  of `bin/smoke-test.sh`. Pipeline sanity only.
- `omlx-default.json` — 25 games, provider omlx, local model. The
  default committed baseline.
- `omlx-large.json` — 100 games. Periodic deep baseline; not run on
  every change.
- `openai-mini.json` — 10 games, gpt-4o-mini. Comparison baseline.
- `anthropic-haiku.json` — 10 games, claude-haiku-4-5. Comparison
  baseline.

## Baselines and regression gates

- After each eval, write `eval/baselines/<profile>.json` (committed) and
  a diff against the last committed baseline.
- Define soft gates (warn) and hard gates (fail):
  - Hard: `valid_json_rate >= 0.85` for any non-stub profile.
  - Hard: `action_in_phase_rate >= 0.95`.
  - Hard: `target_override_rate <= 0.20`.
  - Soft: `village_winrate` within ±0.20 of baseline.
  - Soft: `avg_rounds` within ±2 of baseline.
- `eval/assertions/scorecard-gates.mjs` is the promptfoo JavaScript
  assertion that enforces hard gates and surfaces soft-gate warnings.
  promptfoo exits non-zero when any hard assertion fails, which is what
  CI keys off.

## Test strategy for the eval code itself

All in `tests/eval-aggregate.mjs`:

1. Empty input → all rates `null` / counts zero, no NaN.
2. Synthetic two-game JSONL fixtures stored under `eval/fixtures/`:
   one village win, one wolf win. Assert winrate, avg_rounds.
3. Fixture with deliberately corrupt `turn-stats` (missing keys, NaN
   values) → aggregator skips bad rows but counts the rest.
4. Fixture where the seer never investigates → `seer_accuracy` is `null`
   (not zero) so we do not lie about evidence we lack.
5. Fixture covering each phase exactly once → per-phase metrics are
   identical to the overall rates.
6. Property test: shuffling the event order within a game must not
   change the aggregated result (events are commutative for the metrics
   we compute).

For `eval/run.mjs`:

- Unit test the profile loader (`loadProfile`) against valid + invalid
  files.
- Unit test the HTTP client wrapper with a fake `fetch`.
- End-to-end test gated on `LAB_WEB_PORT` being set; otherwise skipped.
  Runs three stub games and asserts the scorecard exists.

## Directory layout

```
etc/post-013/werewolf-quack-lab/
  bin/                       # user-callable entry points
    labctl
    lab-web-server.mjs
    lab-web-dev.mjs
    smoke-test.sh
    omlx-smoke-test.sh
  container/                 # scripts that run INSIDE player / gateway containers
    agent-act.sh             # also where the Anthropic provider branch will live
    player-node.sh
    gateway-query.sh
    gateway-smoke-test.sh
  lib/                       # importable modules
    lab-web-actions.mjs      # parseTurnStatsMarkers lives here
    lab-span.sh
    mint-token.sh
    generate-compose.sh
  eval/                      # eval framework
    aggregate.mjs            # pure aggregator + CLI (landed)
    run.mjs                  # batch runner against /api/run (landed)
    profiles/
      stub-smoke.json        # landed
      omlx-qwen35.json       # landed
      # Forthcoming:
      # omlx-large.json
      # openai-mini.json
      # anthropic-haiku.json
    runs/                    # gitignored; <profile>-<stamp>/ outputs
    # Forthcoming (not yet built):
    # promptfooconfig.yaml
    # providers/{stub,omlx,openai,anthropic}.mjs
    # assertions/scorecard-gates.mjs
    # fixtures/{village-win,wolf-win,malformed-turn-stats}.jsonl
    # baselines/{stub-smoke,omlx-default,openai-mini}.json
  tests/                     # all test suites
    agent-act.sh
    mint-token.sh
    lab-authz.sh
    lab-span.sh
    generated-compose.sh
    lab-web.mjs              # also covers parseTurnStatsMarkers
    eval-aggregate.mjs       # unit tests for the aggregator
    eval-run.mjs             # unit + mock-HTTP tests for the runner
```

## Phased rollout

1. **Instrument**: add `__TURN_STATS__` marker, `parseTurnStatsMarkers`,
   and durable-log `turn-stats` event. Also adds an Anthropic provider
   path in `agent-act.sh` (or a sibling script) since Claude's API is
   not OpenAI-compatible. One PR, no new functionality.
2. **Aggregate**: ship `eval/aggregate.mjs` and the unit tests with
   synthetic fixtures. No live model needed.
3. **promptfoo wiring**: add `eval/promptfooconfig.yaml`, the four
   provider shims, and the gates assertion. Wire the `stub-smoke`
   profile to `bin/smoke-test.sh` so CI exercises the entire pipeline
   without booting a model server. Pin promptfoo version in
   `package.json` and document the `npx promptfoo@<ver> eval -c
   eval/promptfooconfig.yaml` invocation.
4. **Baselines**: commit baselines for `stub-smoke` and
   `omlx-default`. Hosted-provider baselines are committed lazily, only
   after a manual run with API keys present.
5. **Deception-metric judge**: ship the LLM-as-judge pass for
   `deception_production_rate`. Default judge: same provider as the
   batch under test (self-grading), with an option to override to a
   stronger model.
6. **Manual hosted runs**: document the workflow in
   `docs/eval-running-hosted.md`. Do not automate; both OpenAI and
   Anthropic cost money. Provide a `make eval-hosted PROVIDER=openai`
   shortcut that fails fast if the corresponding API key is missing.

## Open questions

- Should the durable log per-game include the role assignments in plain
  text, or rely on `wolf-kill` / `lynch` `revealed_role` fields plus the
  `game-start` event? Current state: both, redundantly. Leave as-is.
- Token usage: omlx sometimes returns `usage: null`. Anthropic returns
  `usage.input_tokens` / `output_tokens` with a different shape. Plan:
  normalize both into `prompt_tokens` / `completion_tokens` at the
  marker layer; aggregate missing values as a separate
  `usage_missing_rate` metric.
- Anthropic prompt caching: the system prompt is identical across every
  turn of a game. Should the Anthropic provider use
  `cache_control: { type: "ephemeral" }` on the system block? Yes, this
  is the whole point of running the eval on a hosted provider that
  supports caching — we want apples-to-apples cost numbers, not
  apples-to-rotten-apples.
- LLM-as-judge for `deception_production_rate` introduces a meta-eval
  problem: the judge can be wrong. Plan: report `deception_*` metrics
  with a `judge_model` and `judge_agreement_rate` (when two judges run,
  fraction of items they agreed on) so consumers know the noise floor.
- Variance: 25 games per omlx baseline is the starting point. May need
  to bump to 50 if metric stddev across runs is wider than the gates.
  Decide empirically.

## What this plan does not cover

- Promotion of the orchestrator out of `lab-web-server.mjs` into
  `bin/referee.mjs`. Independent of eval; still in the backlog.
- Per-host `quack_query` spans. The eval surfaces aggregated lab
  latency only; per-host attribution is a separate task.
- Multi-provider head-to-head (e.g., gpt-4o-mini vs Qwen on the same
  fixed wolf assignment). Future extension once single-profile baselines
  are stable.
