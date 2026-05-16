# Architecture

This lab keeps the same conceptual split as the browser post, but replaces the
shimmed transport with real Quack and moves agent actions into the player
containers. A small local web server adds the browser runner and the lightweight
auto-play referee.

```text
config/game.sample.json or browser settings
  -> buildGameConfig(...)
  -> .generated/web-game.json when using the browser runner
  -> bin/generate-compose.sh
  -> .generated/docker-compose.yml

browser runner
  static UI from web/
  POST /api/run for commands and Play Game
  POST /api/models for OpenAI-compatible model discovery
  POST /api/export for downloadable game JSON
  GET /api/dev-events for hot reload when LAB_WEB_DEV=1

lab web server
  bin/lab-web-server.mjs
  writes runtime config
  streams command output as NDJSON
  runs the lightweight referee for Play Game

dev runner
  bin/lab-web-dev.mjs
  polls lab source files
  restarts the web server on change
  lets the browser reload after the dev event stream reconnects

gateway container
  DuckDB CLI
  LOAD quack
  quack_query('quack:<player-id>:9494', ...) for every configured player

agent-* containers
  DuckDB CLI
  LOAD quack
  private player tables
  local SQL action pipe
  agent-act.sh
  exposed views
  quack_authentication_function
  quack_authorization_function
  quack_serve('quack:0.0.0.0:9494')
```

## Generated Players

Player services are generated from JSON config instead of being hand-written in
Compose. The CLI reads `config/game.sample.json` by default:

```json
{ "id": "agent-f", "role": "villager" }
```

The browser runner can generate a runtime roster with 3 to 12 players and role
selects for each player. It writes that runtime config to
`.generated/web-game.json` and starts the same generated Compose stack.

The generator computes wolf partners and creates one service and one Docker
volume per player. Supported roles are:

- `wolf`
- `villager`
- `seer`
- `doctor`

The current game loop treats roles mostly as data. Wolves get private wolf
actions and the win condition counts wolves versus town. Seer and doctor are
available in config and prompts, but their full rule powers are still future
work.

## Container-Local Agent Actions

DuckDB locks a database file while the Quack server process has it open, so a
second `duckdb /data/agent-a.duckdb` process cannot safely write actions. Each
player node therefore creates a local FIFO:

```text
/tmp/agent-a-duckdb.fifo
```

`agent-act.sh` writes SQL into that FIFO. The already-running DuckDB process reads
the command and inserts the row. This keeps the action write inside the player
container and avoids giving the gateway write access.

`labctl` can invoke all players, wolves only, or one player:

```bash
./bin/labctl run-day
./bin/labctl run-wolf
./bin/labctl run-agent agent-a vote
./bin/labctl run-agent agent-d wolf
```

For auto-play, the referee passes `ACTIVE_PLAYER_IDS` into `run-agent`. `labctl`
maps that to `PLAYER_IDS` inside the selected container, so eliminated players are
not chosen as targets by later actions.

Model output is normalized before the write. Day and vote actions are constrained
to the allowed public action set, wolf-phase actions become private `wolf-kill`
intents, wolf targets must be valid non-partner players, and wolf public text is
discarded.

## Model Providers

The default provider is deterministic:

```bash
LLM_PROVIDER=stub
LLM_MODEL=stub-werewolf-v1
```

For hosted OpenAI:

```bash
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=...
```

For any OpenAI-compatible endpoint:

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.example.test/v1
LLM_MODEL=<model-id>
LLM_API_KEY=...
```

For a local Apple Silicon model served by oMLX:

```bash
LLM_PROVIDER=omlx
LLM_BASE_URL=http://host.docker.internal:8000/v1
LLM_MODEL=<model-id-from-http://localhost:8000/v1/models>
LLM_API_KEY=<only-if-oMLX-api-key-auth-is-enabled>
```

The browser runner has provider tiles for `Scripted`, `oMLX`, `Compatible`, and
`OpenAI`. OpenAI defaults to `gpt-4o-mini`. oMLX and compatible endpoints can use
the `Discover` button to query `/v1/models` from the host side while containers
use the container-side base URL.

## Browser Runner And Referee

`make web` starts `bin/lab-web-server.mjs` at `http://localhost:5174`.
`make web-dev` starts `bin/lab-web-dev.mjs`, which polls the lab source tree,
restarts the web server on changes, and enables a tiny browser reload hook through
`/api/dev-events`.

The primary UI actions are:

- `Play Game`: starts a clean generated lab and runs the lightweight referee.
- `Audit Log`: queries `full_log`.
- `Download JSON`: exports the current federated rows and config metadata.
- `Stop`: runs `labctl down`.

The `Manual steps` disclosure exposes the lower-level commands for debugging:
start, day, public log, wolf, wolf channel, denied scope, full round, whoami, and
smoke.

`Play Game` does this:

1. Run `labctl down` and `labctl up`.
2. For each round, ask every alive player to run `vote`.
3. Query `public_log` through the gateway.
4. Eliminate the plurality vote target, if any.
5. If wolves are gone, village wins.
6. Ask each alive wolf to run `wolf`.
7. Query `wolf_channel` through the gateway.
8. Kill the plurality wolf target, if any.
9. If wolves have parity with town, wolves win.
10. Stop after the max round limit and mark the result undecided.

The referee is deliberately small. It proves that real containers, real Quack
queries, local write boundaries, and federated policy checks can support a full
round flow. It does not yet implement full Werewolf role powers, player memory
compression, or a production-grade event store.

## Player Node Boundary

Each player owns raw private tables. The gateway cannot query those tables
directly because the player-side `lab_authorize` macro rejects SQL mentioning:

- `self`
- `intents`
- `knowledge`
- `suspicions`
- `votes`
- `game_flags`
- `quack_tokens`

The gateway can query only the exposed surfaces:

- `public_intents`
- `wolf_channel`
- `post_game_intents`
- `whoami()`

`public_log` and `full_log` are gateway query names that read those player-side
views through `quack_query(...)`.

## Wolf Channel

The interesting row-level policy is implemented as a normal DuckDB view:

```sql
CREATE VIEW wolf_channel AS
SELECT round, agent_id, action, target, rationale, decided_at
FROM intents
WHERE action = 'wolf-kill'
  AND (SELECT role FROM self LIMIT 1) = 'wolf';
```

The gateway sends the same query to every player. Villager, seer, and doctor nodes
return zero rows because their local `self.role` is not `wolf`. That means the
filter is evaluated on the player node before rows leave the node.

## Post-Game Audit

`post_game_intents` exposes private rationale only when `POST_GAME=true` for the
player node. The browser runner's `Post-game audit` checkbox sets this flag for
the generated runtime lab. The `Audit Log` button queries `full_log`, which maps
to `post_game_intents`.

This is intended as an explicit post-game audit surface. It should not be treated
as hidden chain-of-thought. The model is asked for a short rationale field, and
that field is private during play unless post-game audit is enabled.

## Why Views First

Quack authorization callbacks receive `(connection_id, query)`. A SQL macro can
inspect query text and read tables, but it cannot rewrite SQL or maintain richer
session state. Exposing safe views keeps the first real Quack lab native and easy
to inspect.

For stronger token-scoped ACLs, the roadmap is a small DuckDB extension that maps
the authentication callback's connection id to a caller or scope row that the
authorization callback can consult.

## Current Constraints

- The browser runner is local only and has no TLS.
- The lightweight referee is not a complete Werewolf engine.
- Seer and doctor are modeled as roles but do not yet have full night powers.
- Player memory is still minimal. Agents see their role, partner list, player
  ids, phase, and current round through the action prompt.
- API keys are best passed through the environment of the web server or lab
  command. The UI can accept a key for convenience, but it is not a secret
  manager.
