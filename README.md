# Werewolf Quack Lab

Real DuckDB Quack infrastructure for the "Five LLMs, One Browser" Werewolf post.

The post's default demo runs entirely in one browser tab, so it uses a `postMessage`
shim for the server side of Quack. This repo is the companion lab for the real
transport: native DuckDB processes serving Quack over HTTP, queried by a gateway
DuckDB client.

## What Works In This Lab

- Five native DuckDB player nodes, each running `quack_serve(...)`.
- One gateway container that queries the player nodes with real `quack_query(...)`.
- Per-player private tables: `self`, `knowledge`, `suspicions`, `intents`, `votes`.
- Public views that expose only safe columns during play.
- A wolf-channel view that row-filters locally based on the player's own role.
- Server-side Quack authentication and authorization callbacks.
- Quack protocol logging from the gateway side.

This is not yet the full LLM game controller. It is the smallest useful real-Quack
lab: prove the transport, policies, row filtering, federation shape, and logs with
native DuckDB servers.

## Requirements

- Docker with Compose v2.
- Network access during image build so Docker can download the DuckDB CLI and the
  Quack extension from DuckDB's extension repository.

Quack is currently a DuckDB 1.5 beta feature. The Dockerfile defaults to
`v1.5.2`; change `DUCKDB_VERSION` if the Quack extension requires a newer release.
The Compose file pins `linux/amd64` because DuckDB's CLI release assets are most
predictable there; Docker Desktop will emulate it on Apple Silicon.

## Quick Start

```bash
docker compose up --build -d
docker compose exec gateway /app/bin/gateway-query.sh whoami
docker compose exec gateway /app/bin/gateway-query.sh public_log
docker compose exec gateway /app/bin/gateway-query.sh wolf_channel
docker compose exec gateway /app/bin/gateway-query.sh denied_private_table
```

Expected behavior:

- `whoami` returns one row per player node.
- `public_log` returns public statements from all five players and no rationale.
- `wolf_channel` queries all five players, but only wolf nodes return rows.
- `denied_private_table` fails because the player authorization callback rejects
  direct access to the private `intents` table.

Clean up:

```bash
docker compose down -v
```

Run the smoke test:

```bash
./bin/smoke-test.sh
```

The smoke test boots the lab, validates five `whoami()` responses, confirms that
public federation hides `rationale`, confirms that the wolf channel returns only
the two wolf nodes, confirms that post-game rationale is closed by default, and
checks that direct `intents` access is rejected by Quack authorization.

## How It Maps To The Browser Demo

| Browser post | Real Quack lab |
| --- | --- |
| Player Web Worker | Native DuckDB process in a container |
| Worker-owned DuckDB-WASM DB | Container-owned DuckDB database file |
| `postMessage` request/response | Quack HTTP protocol |
| JS token/policy shim | Quack auth/authz callbacks |
| Gateway worker fan-out | Gateway DuckDB running `quack_query(...)` |
| `wolf-team-read` row predicate | `wolf_channel` view checks local `self.role` |

The default post still matters because it runs for anyone in one browser tab.
This lab is for readers who want the real distributed version.

## Commands

The gateway script accepts these query names:

```text
whoami
public_log
wolf_channel
full_log
denied_private_table
```

`full_log` reads from `post_game_intents`. By default the player nodes start with
`POST_GAME=false`, so the view returns no rows. Set `POST_GAME=true` and restart
the nodes to expose private rationale through that view. The next milestone is a
controller service that flips this state at the end of a real game without a
restart.

## Security Model

This is a local lab, not a production deployment.

- Quack binds inside a Docker network.
- Each player has its own token.
- Authentication is backed by a `quack_tokens` table.
- Authorization is a SQL macro that allowlists read-only queries against exposed
  views and rejects raw private tables.
- There is no TLS in the lab. Put a reverse proxy in front of Quack for anything
  beyond local development.

The important property is architectural: each player server owns the private data,
and policy is evaluated on that player's DuckDB side before rows leave the node.

## Roadmap

1. Add a controller service that drives the full Werewolf state machine.
2. Stream gateway results and Quack logs to the browser post over WebSocket.
3. Move post-game unlock from an environment variable to a controller-owned local
   admin path.
4. Add a custom DuckDB auth extension for session-scoped caller identity and
   token-scoped ACLs.
5. Add a hosted ephemeral lab mode with short-lived containers per reader.
