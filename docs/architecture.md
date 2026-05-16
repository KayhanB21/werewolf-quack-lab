# Architecture

This lab keeps the same conceptual split as the browser post, but replaces the
shimmed transport with real Quack and moves one-step agent actions into the
player containers.

```text
config/game.sample.json
  -> bin/generate-compose.sh
  -> .generated/docker-compose.yml

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
Compose. To add players, add entries to `config/game.sample.json`:

```json
{ "id": "agent-f", "role": "villager" }
```

The generator computes wolf partners and creates one service and one Docker
volume per player.

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

The default provider is deterministic:

```bash
LLM_PROVIDER=stub
```

For real model calls, use the OpenAI-compatible mode:

```bash
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=...
```

For a local Apple Silicon model served by oMLX, use:

```bash
LLM_PROVIDER=omlx
LLM_BASE_URL=http://host.docker.internal:8000/v1
LLM_MODEL=<model-id-from-http://localhost:8000/v1/models>
LLM_API_KEY=<only-if-oMLX-api-key-auth-is-enabled>
```

The optional `./bin/omlx-smoke-test.sh` checks the host oMLX server, discovers a
model, generates a three-player config, and then runs the same gateway smoke.

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

The gateway can query only the exposed views:

- `public_intents`
- `wolf_channel`
- `post_game_intents`
- `whoami()`

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
return zero rows because their local `self.role` is not `wolf`.

## Why Views First

Quack authorization callbacks receive `(connection_id, query)`. A SQL macro can
inspect query text and read tables, but it cannot rewrite SQL or record session
state. Exposing safe views keeps the first lab simple and native.

For stronger token-scoped ACLs, the roadmap is a small DuckDB extension that maps
the authentication callback's connection id to a caller/scope row that the
authorization callback can consult.
