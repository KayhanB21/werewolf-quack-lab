# Implementation status

Snapshot of the parity work targeting `etc/post-013/werewolf-quack-lab/` to
match the browser post (`lib/post-definitions/013-werewolf-five-llms-one-browser/`)
and add capabilities the browser cannot have.

## Plan recap

**P0 (parity with browser):**

1. Seer/doctor night phases + save-cancels-kill
2. Multi-rotation wolf coordination with `done` signal
3. Real prompt context (alive, eliminated + roles, public events, public log,
   private notes)
4. Tie/abstain + role-reveal announcements

**P1 (lab differentiators):**

5. Signed per-call tokens with TTL
6. Scope-aware authorization via data table
7. Per-player Docker network isolation + resource caps

**P2 (referee + observability):**

8. Suspicion/knowledge writes from inside the agent
9. Durable referee event log
10. OTel-style federation timeline export

**P3 (eval framework):**

11. Per-turn instrumentation marker (`__TURN_STATS__`) with reasoning capture
12. Aggregator with prompt-following / game-shape / belief / performance metrics
13. Batch runner with profile JSON and concurrency control
14. Configurable wolf rotation cap

## Current state

P0, P1, P2, P3 all implemented and unit-tested. The agent shim drives real
LLMs via omlx today: Qwen3.5-9B-DeepSeek-V4-Flash-4bit produces clean JSON in
under 10 seconds per turn when `thinking_budget` is non-zero.

## Repository layout

```
bin/        # user-callable entry points
  labctl                  # Docker / lab control
  lab-web-server.ts      # HTTP shell (routing + sinks; orchestrator lives in lib/)
  lab-web-dev.ts         # dev mode: server with watch-and-reload
  referee.ts             # standalone CLI that runs one auto-game without HTTP
  smoke-test.sh           # runs every test then `labctl smoke`
  omlx-smoke-test.sh      # opt-in smoke against a host omlx server

container/  # scripts that run INSIDE Docker player / gateway containers
  agent-act.sh            # the LLM agent shim (one per turn)
  player-node.sh          # boots DuckDB on each player
  gateway-query.sh        # gateway-side scoped federated query
  gateway-smoke-test.sh   # in-container federation assertions

lib/        # importable / sourceable modules
  lab-web-actions.ts     # pure helpers: env, context, markers, game logic
  referee.ts             # orchestrator: runAutoGame + child supervision + sinks
  lab-span.sh             # emit_span / span_now_ms (federation timeline)
  mint-token.sh           # HMAC-SHA256 lab_check_token minter
  generate-compose.sh     # per-player compose generator

eval/       # eval framework
  aggregate.ts           # pure aggregator + CLI
  gates.ts               # hard/soft regression gates + CLI
  judge.ts               # LLM-as-judge deception pass (CLI + module)
  report.ts              # compare run dirs; Markdown/JSON report + bootstrap CIs
  run.ts                 # batch runner against /api/run, with concurrency
  promptfooconfig.yaml    # promptfoo matrix using the Node runner provider
  providers/
    werewolf-run.ts      # promptfoo custom JS provider
  inspect/
    werewolf_task.py      # Inspect AI wrapper around tsx eval/run.ts
  profiles/
    stub-smoke.json       # 3-game scripted pipeline sanity (strict gates)
    omlx-qwen35-mini.json # 5 games / 3 players — daily smoke
    omlx-qwen35.json      # 10 games / 5 players — default omlx baseline
    omlx-qwen35-nothink.json # thinking_budget=0 counterfactual
    omlx-qwen35-7p.json   # 10 games / 7 players — larger roster
    omlx-qwen35-hot.json  # temperature=0.7 variance probe
    omlx-large.json       # 50-game variance-analysis baseline
    anthropic-haiku.json  # hosted Claude Haiku 4.5 (prompt cached system)
  baseline-refresh.ts    # regenerate / verify eval/baselines/fixtures.json
  baselines/
    fixtures.json         # deterministic aggregate of eval/fixtures/
    README.md             # how to regenerate baselines
  fixtures/               # committed JSONL game logs for unit tests
    village-win.jsonl     # includes a target-override turn-stats event
    wolf-win.jsonl
    malformed-turn-stats.jsonl
    judged/
      with-judge-verdicts.jsonl  # exercises deception metric aggregation
  runs/                   # per-run output dirs (<profile>-<stamp>/)

tests/      # all test suites
  agent-act.sh
  mint-token.sh
  lab-authz.sh
  lab-span.sh
  generated-compose.sh
  lab-web.ts
  referee.ts             # sink abstraction + helpers + child supervision
  eval-aggregate.ts
  eval-gates.ts
  eval-judge.ts          # judge prompt builder + verdict parser + metric calc
  eval-run.ts
  eval-deep.ts           # multi-step scenarios: lifecycle, races, hostile inputs
  eval-report.ts

docs/       # roadmap, architecture, eval-plan, this status
  research-eval-plan.md   # research-grade eval workflow and benchmark mapping
```

Inside the player and gateway containers the paths become `/app/container/...`
and `/app/lib/...` to mirror the host layout. Callers (`labctl`,
`gateway-query.sh`, the generated compose) reference those container paths
explicitly.

## Test surface that runs without Docker

- `tests/agent-act.sh` — stub + OpenAI paths for every phase; wolf-done signal,
  abstain semantics, `CONTEXT_JSON` propagation into the OpenAI payload, role
  brief in the system prompt, `__BELIEFS__` marker shape, `__TURN_STATS__`
  marker for stub / object-parse / text-fallback paths, and
  `thinking_budget` / `temperature` / `max_tokens` threading.
- `tests/mint-token.sh` — token shape, deterministic signing, secret changes
  signature, TTL math.
- `tests/lab-authz.sh` — 17 cases against the real `duckdb` CLI exercising
  `lab_check_token` (good / expired / tampered) and `lab_authorize` (every
  scope happy path, wrong scope, missing scope, denied scope, private-table
  block including `eliminations`, cross-scope JOIN block, INSERT block,
  `lab_secret` block).
- `tests/generated-compose.sh` — per-player networks, resource caps,
  lab-secret distribution, no static tokens in `players.json`.
- `tests/lab-span.sh` — span emission shape, hosts list, denied scope, ms
  precision.
- `tests/lab-web.ts` — pure functions: `buildContextForAgent`,
  `chooseTarget`, `latestRowPerAgent`, `latestKillsPerWolf`,
  `resolveNightOutcome`, `resolveLynch`, plus `flow.ts` command classifiers,
  the `__BELIEFS__` and `__TURN_STATS__` parsers, durable-log round-trip,
  `buildLabEnv` threading of `thinkingBudget` / `temperature` / `maxTokens`.
- `tests/eval-aggregate.ts` — `parseGameLog`, `summarizeGame`, `aggregate`
  metric computation, filesystem load, empty / malformed / missing-field
  edge cases, scorecard summary string.
- `tests/eval-run.ts` — `validateProfile`, `buildRunRequestBody`,
  `extractDurableLogPath`, `extractDoneOk`, end-to-end against a mock HTTP
  server (3-game success path + 500-error failure path), output directory
  layout, manifest fields, scorecard/gates persistence, profile hash stability,
  and profile validation negatives.
- `tests/eval-omlx-preflight.ts` — missing key, bad URL, connection failure,
  401/403, invalid JSON, empty model list, expected-model mismatch, valid
  `/models` response, and API-key redaction.
- `tests/eval-promptfoo-provider.ts` — custom promptfoo provider contract:
  profile/server/game-count resolution, output directory handling, scorecard
  summary formatting, and negative cases for missing profile, invalid game
  count, failed run, and incomplete scorecards.
- `tests/generated-js-boundary.ts` — source-owned JavaScript/MJS stays out of
  project source paths; generated browser JS is restricted to `.generated/web`.
- `tests/eval-judge.ts` — judge prompt builder, verdict parsing, HTTP/JSON
  failure handling, confidence validation, and aggregation of judge-error or
  disagreement metadata.
- `tests/eval-report.ts` — normalized Markdown/JSON report output across at
  least two run directories, including gates, labels, confidence intervals, and
  deltas.

## What is working

### Core game (P0 + P1)

- Phase ordering: discussion → vote → wolf rotations → doctor → seer → night
  resolution → seer learns → reveal.
- Save-cancels-kill is a pure function with explicit no-kill / kill / saved
  outcomes. The "saved" outcome is hidden from `publicEvents` — both saved
  and no-kill emit the same public string ("no one died last night"). The
  internal `history` retains the distinction for post-game export.
- Plurality with abstain: tied top votes produce no lynch; empty / null
  targets count as abstain.
- Role reveals land as `role-reveal` rows in the eliminated player's own DB
  via `labctl ref-reveal`. Eliminations table mirrors via `labctl ref-elim`.
- Seer findings write into the seer's own `knowledge` table via
  `labctl ref-knowledge` AND into the orchestrator's `privateNotesByAgent`
  map so the next prompt for that seer carries the note.
- Token auth: bash `openssl dgst -sha256 -binary | base64` matches DuckDB
  `to_base64(unhex(sha256(secret || payload_b64)))`. Two real bugs caught
  during wiring (sha256 returns VARCHAR hex not BLOB; from_base64 → VARCHAR
  cast renders bytes as `\xNN` escapes) — both fixed by switching to
  `unhex(sha256(...))` and `decode(from_base64(...))`.
- Scope policy is data: `quack_scopes` table; the gateway tags every query
  with `/* scope: X */`; the macro looks the scope up rather than
  regex-matching SQL.
- Network isolation: each player only on `lab-<id>`; gateway on every
  `lab-<id>`. Players cannot reach each other at the Docker network layer.
  Per-service `mem_limit`, `cpus`, `pids_limit` configurable via env.

### Referee log + federation timeline (P2)

- Suspicion / knowledge writes: the LLM JSON schema accepts optional
  `suspicions[]` and `knowledge[]` arrays. `container/agent-act.sh` validates
  targets against the active roster, clamps `p_wolf` / `confidence` to
  [0, 1], caps each array at four entries, and emits `INSERT` statements
  alongside the intent row through the same FIFO. Each invocation prints a
  `__BELIEFS__ <json>` marker that the orchestrator captures into
  `beliefsByAgent`. The next round's `CONTEXT_JSON` carries a `beliefs`
  slice plus `own_intents` filtered from `publicLog`.
- Durable referee log: each `autoGame` run creates
  `.generated/games/<id>.jsonl` and appends `game-start`, `round-start`,
  `turn-stats`, `lynch`, `no-lynch`, `wolf-kill`, `wolf-saved`, `no-kill`,
  `seer-learn`, and `game-end` events. `serializeRefereeEvent` and
  `newRefereeGameId` are pure helpers tested in `tests/lab-web.ts`.
- Federation timeline: `lib/lab-span.sh` exposes `emit_span` and
  `span_now_ms`. `container/gateway-query.sh` wraps the DuckDB invocation
  with start / end timing and appends a `quack_query` span (scope, name,
  status, duration_ms, hosts) to `/data/timeline.jsonl` on the gateway.
  `labctl timeline` cats the file; `labctl timeline-clear` truncates it.

### Eval framework (P3)

- **Per-turn instrumentation**: `container/agent-act.sh` emits a
  `__TURN_STATS__ <json>` line per turn carrying: agent / role / phase /
  round, provider / model, `parse_path`
  (`stub` | `object` | `text` | `http-error`), `valid_json`, `raw_action`,
  `normalized_action`, `action_in_phase`, `finish_reason`, HTTP status,
  prompt / completion / reasoning token counts, latency (ms), suspicion /
  knowledge counts, and a truncated `reasoning_content` (configurable via
  `LLM_REASONING_LOG_LIMIT`, default 1200 chars).
- **Reasoning capture from `reasoning_content`**: omlx splits the model's
  CoT into a separate response field when `thinking_budget > 0`. The shim
  reads that field directly so the game decisions only consume the
  structured `content` while the reasoning is preserved for eval / post-game
  analysis.
- **`thinking_budget` / `temperature` / `max_tokens` are first-class env vars**
  on the shim and HTTP request body (`thinkingBudget`, `temperature`,
  `maxTokens`). `buildLabEnv` in `lib/lab-web-actions.ts` threads them
  into the child process environment.
- **Aggregator** (`eval/aggregate.ts`): pure module + CLI consuming a
  directory of `.jsonl` game logs. Scorecard sections:
  - `meta`: game / completed / provider / model counts
  - `prompt_following`: `valid_json_rate`, `action_in_phase_rate`,
    `http_error_rate`, parse-path histogram, finish-reason histogram,
    raw-action histogram
  - `game_shape`: `village_winrate`, `wolves_winrate`, `incomplete_rate`,
    `avg_rounds`, `lynch_rate_per_day`, `night_saved_rate`, `no_kill_rate`,
    rounds histogram
  - `belief_quality`: `belief_emit_rate`, `avg_suspicions_per_turn`,
    `avg_knowledge_per_turn`, `seer_targeting_wolf_rate`
  - `performance`: avg / p50 / p95 latency, avg + total tokens (prompt /
    completion / reasoning)
  - `per_game`: per-log summary
- **Batch runner** (`eval/run.ts`): POSTs N games to `/api/run` with
  configurable concurrency, captures the durable-log path from each
  game's result, copies the logs into
  `eval/runs/<profile>-<stamp>/game-NNN.jsonl`, then aggregates and
  writes `manifest.json`, `scorecard.json`, and `gates.json`.
- **Profiles**:
  - `eval/profiles/stub-smoke.json` — 3 games, scripted provider, no LLM.
  - `eval/profiles/omlx-qwen35-mini.json` — 5-game daily local OMLX smoke.
  - `eval/profiles/omlx-qwen35.json` — 10 games against local omlx with
    Qwen3.5-9B-DeepSeek-V4-Flash-4bit, `thinking_budget=400`,
    `temperature=0.1`, `max_tokens=800`.
  - `eval/profiles/omlx-qwen35-nothink.json` — thinking-budget counterfactual.
  - `eval/profiles/omlx-qwen35-7p.json` — seven-player larger roster.
  - `eval/profiles/omlx-qwen35-hot.json` — higher-temperature variance probe.
  - `eval/profiles/omlx-large.json` — 50-game variance profile.
  - `eval/profiles/anthropic-haiku.json` — hosted Claude Haiku 4.5 comparison.
- **Configurable wolf rotation cap**: `wolfRotationCap` in the HTTP body
  (clamped to [1, 6], default 3). Threaded from `eval/run.ts` profiles via
  `wolf_rotation_cap`.
- **Regression gates** (`eval/gates.ts`): hard floors on `valid_json_rate`,
  `action_in_phase_rate`, and hard ceilings on `http_error_rate` and
  `incomplete_rate`. Soft band checks on `village_winrate`, `avg_rounds`,
  and `belief_emit_rate`. Each profile can override defaults under a
  `gates` block (including `skip: true` for diagnostic runs). A profile
  can also point at a committed baseline via `baseline_path`; bands are
  auto-derived from the baseline (winrate ±0.20, rounds ±2, belief floor
  baseline−0.15) unless the profile explicitly overrides them.
  `eval/run.ts` evaluates gates after aggregation, writes `gates.json`,
  and exits non-zero on hard failure.
- **Aggregator order-invariance**: `tests/eval-aggregate.ts` runs 8
  seeded within-game event shuffles and asserts the scorecard is
  byte-identical, so any new aggregator state that introduces an event
  ordering dependency trips the test loudly.
- **Deep multi-step coverage** (`tests/eval-deep.ts`): 9 scenarios that
  each chain at least three steps. Locks in: (1) mutating a single
  game-end winner shifts only `game_shape`, never `prompt_following` /
  `performance` / `belief_quality`; (2) `runProfile` at concurrency=4 with
  randomized server delays still produces `results[i].gameIndex === i`;
  (3) hostile numeric inputs (`NaN`, `Infinity`, negative, strings,
  `tokens: null`) all clamp to 0 in the scorecard via the
  `safeNonNegative` boundary helper; (4) multiple `game-start` events
  in one log are latest-wins and do not double-count rounds; (5)
  `game-end` before `game-start` still summarizes correctly; (6) a
  missing durable-log file produces a per-result `copy_error` and a
  partial scorecard from games that did succeed; (7) `extractDurableLogPath`
  and `extractDoneOk` skip non-JSON noise interspersed with valid lines;
  (8) gate precedence `default <- baseline-derived <- profile` including
  profile-explicit `null` deleting a baseline-derived band and
  `skip: true` defeating all hard floors.
- **Fixtures + committed baseline**: `eval/fixtures/{village-win,wolf-win,
  malformed-turn-stats}.jsonl` are the canonical reference logs;
  `tests/eval-aggregate.ts` asserts the aggregator output matches
  `eval/baselines/fixtures.json` byte-for-byte after stripping the two
  non-deterministic fields (`meta.generated_at`, `per_game[].path`). Any
  aggregator change that shifts a metric trips this test loudly. The
  baseline regeneration recipe is in `eval/baselines/README.md`.

## Tested-against-omlx end to end

Direct invocation of `container/agent-act.sh` against
`http://localhost:8000/v1` with model
`MLX-Qwen3.5-9B-DeepSeek-V4-Flash-4bit`, `thinking_budget=300`,
`max_tokens=600` produces:

- `parse_path: object`, `valid_json: true`, `action_in_phase: true`
- `tokens.prompt ≈ 660`, `tokens.completion ≈ 380`
- `latency_ms ≈ 9000`
- `reasoning_content` populated separately from the answer JSON
- valid SQL written to the FIFO (`INSERT INTO intents ...` with the model's
  own rationale and public_text)

The critical knob that makes Qwen3.5-DeepSeek-V4-Flash-4bit usable is
`thinking_budget`: with the default (unset) the model loops on CoT for
8192+ tokens without ever closing a JSON object. With `thinking_budget`
set non-zero the omlx server splits the response and the model answers
in ~10 s.

## Game design quirks mirrored from the browser

- Doctor self-save is allowed. Flagged earlier as a deferred issue.
- Wolves do not see whether their kill was saved until the public reveal.

## End-to-end Docker smoke

`make test` was last run against Docker on 2026-05-22 with DuckDB v1.5.2
inside the containers. It runs the shell/unit suites and then the real Quack
smoke. The smoke assertions pass: whoami federation, public_log federation,
rationale not leaked, wolf_channel scoped, row filtering on player nodes,
post_game closed, and private intents rejected. The post-reorganization
container layout (`/app/container/...`, `/app/lib/...`) is exercised end to end.

## Recent additions (2026-05-20)

- **Orchestrator extraction** to `lib/referee.ts` with a tiny sink contract.
  Both `bin/lab-web-server.ts` (HTTP NDJSON sink) and the new
  `bin/referee.ts` CLI (stdout sink) drive the same code.
- **`target_override_rate`** in the aggregator + hard gate ceiling at 0.20.
  `container/agent-act.sh` now emits `raw_target` / `normalized_target` /
  `target_overridden` in the `__TURN_STATS__` marker.
- **`per_phase` breakdown** under `prompt_following.per_phase` so the
  scorecard distinguishes `day` / `vote` / `wolf` / `seer` / `doctor`
  prompt-following rates. Catches phase-specific regressions that a flat
  rate hides.
- **`__INTENT__` marker** on each agent turn: agent / role / phase / round /
  action / target / public_text / rationale. `lib/referee.ts` parses it
  and appends `agent-intent` events to the durable log.
- **LLM-as-judge deception pass** in `eval/judge.ts` + `tests/eval-judge.ts`.
  Walks `agent-intent` events, samples wolf day-phase utterances, calls a
  judge model (OpenAI-compatible by default; configurable provider+model),
  writes `judge-verdict` events. Aggregator folds them into
  `deception.deception_production_rate` and
  `deception.deception_detection_rate`.
- **Anthropic provider branch** (`anthropic`) in `container/agent-act.sh`:
  `/v1/messages` endpoint, `x-api-key` + `anthropic-version` headers,
  `system` as a cached text block (`cache_control: { type: "ephemeral" }`),
  `usage.input_tokens` / `output_tokens` normalized into the same
  `tokens.prompt` / `tokens.completion` shape as OpenAI. New profile
  `eval/profiles/anthropic-haiku.json`.
- **Research-grade eval layer**: durable logs now include derived
  `statement`, `belief`, and `wolf-consensus` events; the scorecard adds
  strategy, trust-dynamics, extended deception, and survival-curve metrics.
  `eval/run.ts` writes `manifest.json`, `eval/report.ts` compares runs with
  bootstrap CIs, and promptfoo / Inspect wrappers live under `eval/`.

## Backlog

1. ~~Promote the orchestrator out of `lab-web-server.ts`.~~ Done
   2026-05-20: `lib/referee.ts` owns `runAutoGame` + child supervision +
   `runStep` / `runStepCapture` / `runBufferedStep` / `runAgentPhase` /
   `runFilteredQuery` / `pickRows` / `winnerFor` / `clampInt`. A small
   sink contract (`{ write(type, payload) }`) lets HTTP, stdout, and
   array sinks drive the same code path. `bin/lab-web-server.ts` is now
   HTTP routing only; `bin/referee.ts` is a standalone CLI that runs
   one auto-game from a spec JSON.
2. Per-host `quack_query` spans: parse `duckdb_logs_parsed('Quack')` output
   and emit one span per remote call instead of the current aggregate span.
3. Browser-facing provider diagnostics: the eval runner and preflight now fail
   clearly, but the browser timeline can still use more provider-specific
   remediation text and a redacted diagnostic bundle.
4. Live-run baselines: deterministic fixture baselines are committed; decide
   whether `stub-smoke` and any OMLX live runs should become committed
   regression fixtures.
5. Hosted comparison breadth: Anthropic Haiku is present; an OpenAI profile can
   be added once API-key policy and cost controls are settled.
