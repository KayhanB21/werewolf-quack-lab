# Architecture

This lab keeps the same conceptual split as the browser post, but replaces the
shimmed transport with real Quack.

```text
gateway container
  DuckDB CLI
  LOAD quack
  quack_query('quack:agent-a:9494', ...)
  quack_query('quack:agent-b:9494', ...)
  quack_query('quack:agent-c:9494', ...)
  quack_query('quack:agent-d:9494', ...)
  quack_query('quack:agent-e:9494', ...)

agent-* containers
  DuckDB CLI
  LOAD quack
  private player tables
  exposed views
  quack_authentication_function
  quack_authorization_function
  quack_serve('quack:0.0.0.0:9494')
```

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
