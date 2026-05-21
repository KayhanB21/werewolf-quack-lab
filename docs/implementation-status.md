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
  lab-web-server.mjs      # HTTP shell (routing + sinks; orchestrator lives in lib/)
  lab-web-dev.mjs         # dev mode: server with watch-and-reload
  referee.mjs             # standalone CLI that runs one auto-game without HTTP
  smoke-test.sh           # runs every test then `labctl smoke`
  omlx-smoke-test.sh      # opt-in smoke against a host omlx server

container/  # scripts that run INSIDE Docker player / gateway containers
  agent-act.sh            # the LLM agent shim (one per turn)
  player-node.sh          # boots DuckDB on each player
  gateway-query.sh        # gateway-side scoped federated query
  gateway-smoke-test.sh   # in-container federation assertions

lib/        # importable / sourceable modules
  lab-web-actions.mjs     # pure helpers: env, context, markers, game logic
  referee.mjs             # orchestrator: runAutoGame + child supervision + sinks
  lab-span.sh             # emit_span / span_now_ms (federation timeline)
  mint-token.sh           # HMAC-SHA256 lab_check_token minter
  generate-compose.sh     # per-player compose generator

eval/       # eval framework
  aggregate.mjs           # pure aggregator + CLI
  gates.mjs               # hard/soft regression gates + CLI
  judge.mjs               # LLM-as-judge deception pass (CLI + module)
  report.mjs              # compare run dirs; Markdown/JSON report + bootstrap CIs
  run.mjs                 # batch runner against /api/run, with concurrency
  promptfooconfig.yaml    # promptfoo matrix using the Node runner provider
  providers/
    werewolf-run.mjs      # promptfoo custom JS provider
  inspect/
    werewolf_task.py      # Inspect AI wrapper around node eval/run.mjs
  profiles/
    stub-smoke.json       # 3-game scripted pipeline sanity (strict gates)
    omlx-qwen35-mini.json # 5 games / 3 players — daily smoke
    omlx-qwen35.json      # 10 games / 5 players — default omlx baseline
    omlx-qwen35-nothink.json # thinking_budget=0 counterfactual
    omlx-qwen35-7p.json   # 10 games / 7 players — larger roster
    omlx-qwen35-hot.json  # temperature=0.7 variance probe
    omlx-large.json       # 50-game variance-analysis baseline
    anthropic-haiku.json  # hosted Claude Haiku 4.5 (prompt cached system)
  baseline-refresh.mjs    # regenerate / verify eval/baselines/fixtures.json
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
  lab-web.mjs
  referee.mjs             # sink abstraction + helpers + child supervision
  eval-aggregate.mjs
  eval-gates.mjs
  eval-judge.mjs          # judge prompt builder + verdict parser + metric calc
  eval-run.mjs
  eval-deep.mjs           # multi-step scenarios: lifecycle, races, hostile inputs
  eval-report.mjs

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
- `tests/lab-web.mjs` — pure functions: `buildContextForAgent`,
  `chooseTarget`, `latestRowPerAgent`, `latestKillsPerWolf`,
  `resolveNightOutcome`, `resolveLynch`, plus `flow.mjs` command classifiers,
  the `__BELIEFS__` and `__TURN_STATS__` parsers, durable-log round-trip,
  `buildLabEnv` threading of `thinkingBudget` / `temperature` / `maxTokens`.
- `tests/eval-aggregate.mjs` — `parseGameLog`, `summarizeGame`, `aggregate`
  metric computation, filesystem load, empty / malformed / missing-field
  edge cases, scorecard summary string.
- `tests/eval-run.mjs` — `validateProfile`, `buildRunRequestBody`,
  `extractDurableLogPath`, `extractDoneOk`, end-to-end against a mock HTTP
  server (3-game success path + 500-error failure path), output directory
  layout, scorecard.json persistence.

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
  `newRefereeGameId` are pure helpers tested in `tests/lab-web.mjs`.
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
  `maxTokens`). `buildLabEnv` in `lib/lab-web-actions.mjs` threads them
  into the child process environment.
- **Aggregator** (`eval/aggregate.mjs`): pure module + CLI consuming a
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
- **Batch runner** (`eval/run.mjs`): POSTs N games to `/api/run` with
  configurable concurrency, captures the durable-log path from each
  game's result, copies the logs into
  `eval/runs/<profile>-<stamp>/game-NNN.jsonl`, then aggregates and
  writes `scorecard.json`.
- **Profiles**:
  - `eval/profiles/stub-smoke.json` — 3 games, scripted provider, no LLM.
  - `eval/profiles/omlx-qwen35.json` — 10 games against local omlx with
    Qwen3.5-9B-DeepSeek-V4-Flash-4bit, `thinking_budget=400`,
    `temperature=0.1`, `max_tokens=800`.
- **Configurable wolf rotation cap**: `wolfRotationCap` in the HTTP body
  (clamped to [1, 6], default 3). Threaded from `eval/run.mjs` profiles via
  `wolf_rotation_cap`.
- **Regression gates** (`eval/gates.mjs`): hard floors on `valid_json_rate`,
  `action_in_phase_rate`, and hard ceilings on `http_error_rate` and
  `incomplete_rate`. Soft band checks on `village_winrate`, `avg_rounds`,
  and `belief_emit_rate`. Each profile can override defaults under a
  `gates` block (including `skip: true` for diagnostic runs). A profile
  can also point at a committed baseline via `baseline_path`; bands are
  auto-derived from the baseline (winrate ±0.20, rounds ±2, belief floor
  baseline−0.15) unless the profile explicitly overrides them.
  `eval/run.mjs` evaluates gates after aggregation, writes `gates.json`,
  and exits non-zero on hard failure.
- **Aggregator order-invariance**: `tests/eval-aggregate.mjs` runs 8
  seeded within-game event shuffles and asserts the scorecard is
  byte-identical, so any new aggregator state that introduces an event
  ordering dependency trips the test loudly.
- **Deep multi-step coverage** (`tests/eval-deep.mjs`): 9 scenarios that
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
  `tests/eval-aggregate.mjs` asserts the aggregator output matches
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

`bin/labctl smoke` was last run against Docker on 2026-05-18 with DuckDB
v1.5.2 inside the containers. All eight assertions pass: whoami federation,
public_log federation, rationale not leaked, wolf_channel scoped, row
filtering on player nodes, post_game closed, private intents rejected. The
`quack_serve(token => 'lab-server')` placeholder is fine in practice; Quack
does not require server_token to match anything specific.

After the 2026-05-19 reorganization the in-container paths changed
(`/app/container/...`, `/app/lib/...`); the Dockerfile was updated to copy
those directories. The next `bin/labctl smoke` run will exercise the new
layout end to end.

## Recent additions (2026-05-20)

- **Orchestrator extraction** to `lib/referee.mjs` with a tiny sink contract.
  Both `bin/lab-web-server.mjs` (HTTP NDJSON sink) and the new
  `bin/referee.mjs` CLI (stdout sink) drive the same code.
- **`target_override_rate`** in the aggregator + hard gate ceiling at 0.20.
  `container/agent-act.sh` now emits `raw_target` / `normalized_target` /
  `target_overridden` in the `__TURN_STATS__` marker.
- **`per_phase` breakdown** under `prompt_following.per_phase` so the
  scorecard distinguishes `day` / `vote` / `wolf` / `seer` / `doctor`
  prompt-following rates. Catches phase-specific regressions that a flat
  rate hides.
- **`__INTENT__` marker** on each agent turn: agent / role / phase / round /
  action / target / public_text / rationale. `lib/referee.mjs` parses it
  and appends `agent-intent` events to the durable log.
- **LLM-as-judge deception pass** in `eval/judge.mjs` + `tests/eval-judge.mjs`.
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
  `eval/run.mjs` writes `manifest.json`, `eval/report.mjs` compares runs with
  bootstrap CIs, and promptfoo / Inspect wrappers live under `eval/`.

## Backlog

1. ~~Promote the orchestrator out of `lab-web-server.mjs`.~~ Done
   2026-05-20: `lib/referee.mjs` owns `runAutoGame` + child supervision +
   `runStep` / `runStepCapture` / `runBufferedStep` / `runAgentPhase` /
   `runFilteredQuery` / `pickRows` / `winnerFor` / `clampInt`. A small
   sink contract (`{ write(type, payload) }`) lets HTTP, stdout, and
   array sinks drive the same code path. `bin/lab-web-server.mjs` is now
   HTTP routing only; `bin/referee.mjs` is a standalone CLI that runs
   one auto-game from a spec JSON.
2. Per-host `quack_query` spans: parse `duckdb_logs_parsed('Quack')` output
   and emit one span per remote call instead of the current aggregate span.
3. Hosted-LLM provider path: Anthropic's `/messages` API is not
   OpenAI-compatible. A new branch in `container/agent-act.sh` (or a
   sibling shim) is needed for first-class Anthropic support.
4. Deception-quality metrics that require LLM-as-judge — the current
   aggregator covers prompt-following, game-shape, belief, and performance,
   but `deception_production_rate` / `deception_detection_rate` from the
   WOLF taxonomy require a separate judge pass over `reasoning_content`.
5. Larger N profiles for variance analysis (`omlx-large` at 100 games,
   `openai-mini` at 25 games once an API key is wired).
