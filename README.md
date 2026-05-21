# Werewolf Quack Lab

Real DuckDB Quack infrastructure for the "Five LLMs, One Browser" Werewolf post.

The post's default demo runs entirely in one browser tab, so it uses a
`postMessage` shim for the server side of Quack. This repo is the companion lab
for the real transport: native DuckDB processes serving Quack over HTTP, queried
by a gateway DuckDB client, with player-local agent actions and a small browser
runner.

## Current State

- Config-driven native DuckDB player nodes, each running `quack_serve(...)`.
- One gateway container that queries the player nodes with real `quack_query(...)`.
- Generated player services from JSON config, plus a browser UI that can generate
  a 3 to 12 player roster and choose each role.
- Per-player private tables: `self`, `knowledge`, `suspicions`, `intents`, `votes`.
- Container-local agent actions through `container/agent-act.sh`, written into
  the running DuckDB process through a FIFO to avoid file-lock conflicts.
- Scripted, oMLX, OpenAI-compatible, and OpenAI provider modes. OpenAI defaults
  to `gpt-4o-mini`; oMLX discovers local models through `/v1/models`.
- Model output normalization before writes: phase actions are constrained, wolf
  targets are forced to valid non-partners, and wolf actions cannot publish text.
- Public views that expose only safe columns during play.
- A wolf-channel view that row-filters locally based on the player's own role.
- Optional post-game audit view through `POST_GAME=true`.
- Browser controls for `Play Game`, `Audit Log`, `Download JSON`, `Stop`, plus
  collapsible manual commands.
- A lightweight auto-play referee that starts the lab, runs discussion, vote, and
  wolf phases, tracks alive players, applies plurality eliminations, and declares
  village, wolves, or undecided after the max round limit.
- Server-side Quack authentication and authorization callbacks.
- Quack protocol logging from the gateway side.

This is now more than a transport smoke test, but it is still a lab. The current
referee is intentionally small: it handles votes, wolf kills, alive-player
filtering, and win checks, but it is not a complete Werewolf rules engine with
rich role powers, persistent long-term agent memory, or production session
security.

## Requirements

- Docker with Compose v2.
- `jq` on the host.
- Node 18 or newer for the browser runner.
- Network access during image build so Docker can download the DuckDB CLI and the
  Quack extension from DuckDB's extension repository.

Quack is currently a DuckDB 1.5 beta feature. The Dockerfile defaults to
`v1.5.2`; change `DUCKDB_VERSION` if the Quack extension requires a newer release.
The Compose file pins `linux/amd64` because DuckDB's CLI release assets are most
predictable there. Docker Desktop will emulate it on Apple Silicon.

## Quick Start

Run the deterministic Quack smoke test:

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
- verifies `post_game_intents` is closed while `POST_GAME=false`
- verifies `denied_private_table` fails because player authorization rejects
  direct access to the private `intents` table

Start the browser runner:

```bash
make web
```

Then open `http://localhost:5174`.

During development, use the hot-reload runner:

```bash
make web-dev
```

It polls `bin`, `lib`, `container`, `eval`, `web`, `sql`, `config`, `Dockerfile`,
`docker-compose.yml`, and `Makefile`. When one of those files changes, it
restarts the Node web server and the browser reloads after the reconnect.

## Browser Round Runner

The browser runner is the easiest way to exercise the lab. It wraps the same
`labctl` commands and writes a runtime config to `.generated/web-game.json`.

Main controls:

- `Players`: choose 3 to 12 generated players and set each role.
- `Provider`: choose `Scripted`, `oMLX`, `Compatible`, or `OpenAI`.
- `Play Game`: runs the lightweight referee through discussion, vote, and wolf
  phases until village wins, wolves win, or the max round limit is reached.
- `Audit Log`: queries `full_log`, which returns private rationale only when
  post-game audit is enabled.
- `Download JSON`: exports nodes, public log, wolf channel, audit log, roster,
  provider, model, round, and export warnings.
- `Stop`: tears down the generated lab and removes volumes.
- `Manual steps`: exposes lower-level controls such as start, day, wolf, public
  log, wolf channel, denied scope, whoami, smoke, and one full manual round.

For OpenAI, set `LLM_API_KEY` in the shell that starts `make web`, select
`OpenAI` in the UI, and leave the API key field blank. The UI will default the
model to `gpt-4o-mini`.

For oMLX, start the local server on the host, choose `oMLX`, click `Discover`,
then run the game controls. Player containers reach the host through
`http://host.docker.internal:8000/v1`.

## Manual Flow

```bash
./bin/labctl generate
./bin/labctl up
./bin/labctl run-day
./bin/labctl run-wolf
./bin/labctl query public_log
./bin/labctl query wolf_channel
./bin/labctl query denied_private_table
```

Run a single player action:

```bash
./bin/labctl run-agent agent-a vote
./bin/labctl run-agent agent-d wolf
```

Clean up:

```bash
./bin/labctl down
```

To change the default CLI roster, edit `config/game.sample.json`. The generated
Compose file is not source controlled.

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
`container/agent-act.sh` writes to DuckDB, it normalizes the action for the
current phase, retargets invalid wolf choices, and strips public text from
wolf-phase actions.

## How It Maps To The Browser Demo

| Browser post | Real Quack lab |
| --- | --- |
| Player Web Worker | Native DuckDB process in a container |
| Worker-owned DuckDB-WASM DB | Container-owned DuckDB database file |
| `postMessage` request/response | Quack HTTP protocol |
| JS token/policy shim | Quack auth/authz callbacks |
| Gateway worker fan-out | Gateway DuckDB running `quack_query(...)` |
| Browser orchestrator asking an agent to act | `labctl run-agent`, `run-day`, and `run-wolf` invoking `container/agent-act.sh` inside each player container |
| Browser game loop | Browser runner plus server-side lightweight referee |
| `wolf-team-read` row predicate | `wolf_channel` view checks local `self.role` |

The default post still matters because it runs for anyone in one browser tab.
This lab is for readers who want the real distributed version.

## Commands

`labctl` accepts these commands:

```text
generate
up
down
run-agent <id> <day|vote|wolf>
run-day
run-wolf
query <whoami|public_log|wolf_channel|full_log|denied_private_table>
smoke
config
```

Useful make targets:

```text
make web        Start the browser runner on http://localhost:5174
make web-dev    Start the browser runner with file watching and browser reload
make web-test   Run the orchestrator unit checks (tests/lab-web.mjs)
make eval-test  Run the eval framework unit checks
make eval-run PROFILE=eval/profiles/<name>.json  Run a batch eval profile
make eval-large Run the 50-game omlx variance profile
make test       Run agent, generator, web, eval, and real Quack smoke checks
make down       Stop the generated lab
```

`full_log` reads from `post_game_intents`. By default the player nodes start with
`POST_GAME=false`, so the view returns no rows. Set `POST_GAME=true` before
starting the nodes, or check `Post-game audit` in the browser runner, to expose
private rationale through that view. This is an explicit post-game audit surface,
not hidden chain-of-thought.

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
- API keys can be passed through environment variables or the browser form. For
  repeatable local testing, prefer setting `LLM_API_KEY` in the shell that starts
  the browser runner and leaving the UI field blank.
- There is no TLS in the lab. Put a reverse proxy in front of Quack for anything
  beyond local development.

The important property is architectural: each player server owns the private data,
and policy is evaluated on that player's DuckDB side before rows leave the node.

## Repository Layout

```
bin/        user-callable entry points (labctl, web servers, smoke runner)
container/  scripts that run INSIDE Docker player / gateway containers
lib/        importable modules (orchestrator helpers, lab-span, mint-token,
            generate-compose)
eval/       eval framework (aggregate.mjs, run.mjs, profiles/)
tests/      every test suite
sql/        DuckDB SQL fragments (player init, gateway init, scopes)
web/        browser runner static assets
docs/       architecture, roadmap, eval plan, implementation status
```

In the container image, the host directories `container/` and `lib/` are
copied to `/app/container/` and `/app/lib/` respectively. Callers
(`labctl`, `gateway-query.sh`, the generated compose) use those container
paths.

## Documentation

- `docs/architecture.md`: implementation architecture and current boundaries.
- `docs/roadmap.md`: completed work and next milestones.
- `docs/eval-plan.md`: eval framework design and metric taxonomy.
- `docs/implementation-status.md`: per-feature status, including the eval
  framework and the omlx + Qwen3.5 reasoning-mode notes.
