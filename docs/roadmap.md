# Roadmap

## Phase 1: Real Quack Transport And Local Agent Actions

Status: complete in this repo.

- Start native DuckDB Quack servers for generated players.
- Query them from a gateway DuckDB client.
- Generate player services from JSON config.
- Move agent action writes into the player containers.
- Write actions through a FIFO into the already-running DuckDB process.
- Support deterministic scripted actions.
- Support OpenAI-compatible model calls from inside player containers.
- Prove public federation, wolf row filtering, denied private-table access, and
  Quack logs.

## Phase 2: Browser Runner And Configurable Rosters

Status: complete in this repo.

- Add a local web server and browser UI.
- Replace the provider dropdown with clearer provider tiles.
- Support 3 to 12 players from the UI.
- Let the user choose role combinations without editing Compose YAML.
- Generate `.generated/web-game.json` from browser settings.
- Add primary actions for `Play Game`, `Audit Log`, `Download JSON`, and `Stop`.
- Keep low-level commands available under `Manual steps`.
- Add structured timeline rendering plus collapsible raw command output.
- Export nodes, public log, wolf channel, audit log, provider metadata, roster,
  and query warnings as JSON.
- Add `make web-dev` so local UI and server work can hot-reload without manually
  killing the web process.

## Phase 3: Model Provider Hardening

Status: mostly complete for local lab use.

- Add oMLX model discovery through `/v1/models`.
- Add an oMLX smoke test that runs real model calls through Dockerized agents.
- Add OpenAI as a first-class provider, defaulting to `gpt-4o-mini`.
- Keep OpenAI-compatible custom endpoints for other providers.
- Normalize non-JSON model responses into safe actions.
- Limit model output size with `max_tokens`.
- Keep stop and read-only query actions independent of model configuration.

Remaining work:

- Add retry and backoff around transient model failures.
- Show clearer provider-specific error messages in the browser timeline.
- Add a redacted diagnostic bundle for failed model runs.
- Add optional per-provider cost and token accounting.

## Phase 4: Lightweight Full-Game Referee

Status: complete.

- Start a clean lab for `Play Game`.
- Track alive players outside the player containers.
- Run public discussion actions only for alive players.
- Query current-round discussion rows through `public_log`.
- Run vote actions only for alive players.
- Query current-round vote rows through `public_log`.
- Apply plurality day eliminations.
- Run wolf actions only for alive wolves (with multi-rotation consensus,
  configurable cap up to 6).
- Query current-round wolf rows through `wolf_channel`.
- Apply plurality wolf kills.
- Doctor save-cancels-kill resolution.
- Seer night investigation with private knowledge writeback.
- Role reveal announcements when a player is eliminated.
- Declare village when all wolves are gone.
- Declare wolves when wolves reach parity with town.
- Return an undecided result when the max round limit is reached.
- Durable referee event log in `.generated/games/<id>.jsonl` covering
  `game-start`, `round-start`, `turn-stats`, `lynch`, `no-lynch`,
  `wolf-kill`, `wolf-saved`, `no-kill`, `seer-learn`, `game-end`.

Remaining work:

- Promote the referee out of `bin/lab-web-server.mjs` into a standalone
  `bin/referee.mjs` so the HTTP server is just a thin shell.
- Expose max rounds and wolf rotation cap in the UI (wired via API today).
- Add tie-breaking policy controls.
- Add memory compaction for longer games.

## Phase 5: Eval Framework

Status: complete (P3 in `docs/implementation-status.md`).

- Per-turn `__TURN_STATS__ <json>` marker on agent stdout, capturing parse
  path, JSON validity, action legality, finish reason, prompt / completion /
  reasoning token counts, latency (ms), suspicion / knowledge counts, and a
  truncated `reasoning_content`.
- omlx `thinking_budget` is first-class: setting it non-zero unlocks the
  `reasoning_content` split for Qwen3 family models that otherwise loop on
  unbounded CoT.
- `lib/lab-web-actions.mjs#parseTurnStatsMarkers` parses the marker; the
  orchestrator appends `turn-stats` events to the durable log.
- `eval/aggregate.mjs` computes a scorecard with `prompt_following`,
  `game_shape`, `belief_quality`, and `performance` sections.
- `eval/run.mjs` drives N games via `/api/run`, collects each durable log,
  aggregates, and writes `scorecard.json`.
- Profiles in `eval/profiles/`: `stub-smoke.json` (3-game pipeline sanity),
  `omlx-qwen35.json` (10 games against local omlx with `thinking_budget=400`).

Remaining work:

- Hosted-LLM provider path (Anthropic `/messages` is not OpenAI-compatible).
- LLM-as-judge deception metrics (`deception_production_rate`,
  `deception_detection_rate` from the WOLF taxonomy).
- Larger N profiles for variance analysis (omlx-large at 100 games,
  openai-mini once an API key is wired).

## Phase 6: Token-Scoped ACLs

SQL macros are good for the first lab, but they cannot maintain session state.
For production-like scoping:

- Write a small DuckDB extension for authentication.
- Record `connection_id -> caller/scope`.
- Let the authorization callback check that mapping before allowing a query.
- Keep safe views as defense in depth.
- Add tests that prove caller-specific policy, not only local role-based policy.

## Phase 7: Browser Post Integration

- Add a "Connect to Quack Lab" mode in the post.
- Detect the local controller on `localhost`.
- Show real Quack logs beside the current shim logs.
- Let the post link to exported lab JSON.
- Keep browser-only mode as the default portable demo.

## Phase 8: Hosted Ephemeral Labs

- Launch short-lived Quack node groups per reader.
- Put a reverse proxy in front of every Quack server.
- Terminate TLS at the proxy.
- Enforce short TTLs and resource quotas.
- Tear down inactive labs automatically.
- Provide shareable exports without exposing API keys or private runtime data.
