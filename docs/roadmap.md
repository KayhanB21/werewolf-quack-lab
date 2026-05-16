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

Status: first version complete.

- Start a clean lab for `Play Game`.
- Track alive players outside the player containers.
- Run public discussion actions only for alive players.
- Query current-round discussion rows through `public_log`.
- Run vote actions only for alive players.
- Query current-round vote rows through `public_log`.
- Apply plurality day eliminations.
- Run wolf actions only for alive wolves.
- Query current-round wolf rows through `wolf_channel`.
- Apply plurality wolf kills.
- Declare village when all wolves are gone.
- Declare wolves when wolves reach parity with town.
- Return an undecided result when the max round limit is reached.

Remaining work:

- Move referee state into a durable event log.
- Expose max rounds in the UI.
- Add tie-breaking policy controls.
- Add seer and doctor night powers.
- Feed richer recent public history into each agent prompt.
- Add memory compaction for longer games.
- Add tests for multi-round edge cases and tie outcomes.

## Phase 5: Token-Scoped ACLs

SQL macros are good for the first lab, but they cannot maintain session state.
For production-like scoping:

- Write a small DuckDB extension for authentication.
- Record `connection_id -> caller/scope`.
- Let the authorization callback check that mapping before allowing a query.
- Keep safe views as defense in depth.
- Add tests that prove caller-specific policy, not only local role-based policy.

## Phase 6: Browser Post Integration

- Add a "Connect to Quack Lab" mode in the post.
- Detect the local controller on `localhost`.
- Show real Quack logs beside the current shim logs.
- Let the post link to exported lab JSON.
- Keep browser-only mode as the default portable demo.

## Phase 7: Hosted Ephemeral Labs

- Launch short-lived Quack node groups per reader.
- Put a reverse proxy in front of every Quack server.
- Terminate TLS at the proxy.
- Enforce short TTLs and resource quotas.
- Tear down inactive labs automatically.
- Provide shareable exports without exposing API keys or private runtime data.
