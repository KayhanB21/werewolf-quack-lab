# Werewolf Quack Lab

Real DuckDB Quack infrastructure for the "Five LLMs, One Browser" Werewolf post.

The post's default demo runs entirely in one browser tab, so it uses a `postMessage`
shim for the server side of Quack. This repo is the companion lab for the real
transport: native DuckDB processes serving Quack over HTTP, queried by a gateway
DuckDB client.

## What Works In This Lab

- Config-driven native DuckDB player nodes, each running `quack_serve(...)`.
- One gateway container that queries the player nodes with real `quack_query(...)`.
- Per-player private tables: `self`, `knowledge`, `suspicions`, `intents`, `votes`.
- A container-local agent action entry point, `agent-act.sh`, that writes actions
  into that player's own running DuckDB process.
- Stub, OpenAI-compatible, and local oMLX agent modes. The default smoke test
  uses `stub` so it is deterministic and does not need network access.
- Model output normalization before writes: phase actions are constrained, wolf
  targets are forced to valid non-partners, and wolf actions cannot publish text.
- Public views that expose only safe columns during play.
- A wolf-channel view that row-filters locally based on the player's own role.
- Server-side Quack authentication and authorization callbacks.
- Quack protocol logging from the gateway side.

This is not yet the full Werewolf game controller. It is the smallest useful
real-Quack lab: generate an arbitrary player set, start native DuckDB servers,
ask each player container to take actions, then prove the transport, policies,
row filtering, federation shape, and logs with real Quack.

## Requirements

- Docker with Compose v2.
- `jq` on the host.
- Network access during image build so Docker can download the DuckDB CLI and the
  Quack extension from DuckDB's extension repository.

Quack is currently a DuckDB 1.5 beta feature. The Dockerfile defaults to
`v1.5.2`; change `DUCKDB_VERSION` if the Quack extension requires a newer release.
The Compose file pins `linux/amd64` because DuckDB's CLI release assets are most
predictable there; Docker Desktop will emulate it on Apple Silicon.

## Quick Start

```bash
./bin/labctl smoke
```

The smoke test:

- generates `.generated/docker-compose.yml` from `config/game.sample.json`
- starts one gateway and one container per configured player
- asks every player container to take one day action
- asks every wolf container to take one wolf action
- verifies `whoami` returns one row per player node
- verifies `public_log` returns public statements and no rationale
- verifies `wolf_channel` queries every player, but only wolf nodes return rows
- verifies `denied_private_table` fails because the player authorization callback rejects
  direct access to the private `intents` table.

Manual flow:

```bash
./bin/labctl generate
./bin/labctl up
./bin/labctl run-day
./bin/labctl run-wolf
./bin/labctl query public_log
./bin/labctl query wolf_channel
./bin/labctl query denied_private_table
```

Clean up:

```bash
./bin/labctl down
```

To add players, edit `config/game.sample.json`. The generated Compose file is not
source controlled.

## Browser Round Runner

For a step-by-step local view of one round, start the tiny browser runner:

```bash
make web
```

Then open `http://localhost:5174`. The page wraps the same `labctl` commands:
start the containers, run day actions, query `public_log`, run wolf actions, and
query `wolf_channel`. The `Full Round` button runs that sequence end to end, while
`Smoke` still runs the fast assertion harness.

For local oMLX, choose `oMLX`, enter the API key if your server requires one,
click `Discover Models`, then run the round controls.

## Local Model Smoke With oMLX

[oMLX](https://github.com/jundot/omlx) exposes an OpenAI-compatible API at
`http://localhost:8000/v1`, including `/v1/chat/completions` and `/v1/models`.
Because the player agents run inside Docker, they reach the host server through
`host.docker.internal`.

Start oMLX on the host:

```bash
brew services start omlx
```

or run the CLI server directly:

```bash
omlx serve --model-dir ~/models
```

Then run the optional integration smoke:

```bash
./bin/omlx-smoke-test.sh
```

If oMLX API key authentication is enabled, set `OMLX_API_KEY` or `LLM_API_KEY`
before running the script. The script checks `/v1/models`, chooses the first
model unless `OMLX_MODEL` is set, generates a three-player config, asks each
container-local agent to act through oMLX, and then runs the same Quack gateway
assertions as the deterministic smoke.

The model response is treated as a proposal, not as trusted SQL input. Before
`agent-act.sh` writes to DuckDB, it normalizes the action for the current phase,
retargets invalid wolf choices, and strips public text from wolf-phase actions.

## How It Maps To The Browser Demo

| Browser post | Real Quack lab |
| --- | --- |
| Player Web Worker | Native DuckDB process in a container |
| Worker-owned DuckDB-WASM DB | Container-owned DuckDB database file |
| `postMessage` request/response | Quack HTTP protocol |
| JS token/policy shim | Quack auth/authz callbacks |
| Gateway worker fan-out | Gateway DuckDB running `quack_query(...)` |
| Browser orchestrator asking an agent to act | `labctl run-day` / `run-wolf` invoking `agent-act.sh` inside each player container |
| `wolf-team-read` row predicate | `wolf_channel` view checks local `self.role` |

The default post still matters because it runs for anyone in one browser tab.
This lab is for readers who want the real distributed version.

## Commands

`labctl` accepts these commands:

```text
generate
up
down
run-day
run-wolf
query <whoami|public_log|wolf_channel|full_log|denied_private_table>
smoke
config
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
- Agent actions write through a local FIFO into the DuckDB process already
  running inside the player container. That avoids DuckDB file-lock conflicts and
  keeps action writes local to the player node rather than granting the gateway a
  write path.
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
