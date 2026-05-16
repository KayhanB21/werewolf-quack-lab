# Roadmap

## Phase 1: Real Quack Transport

Status: this repo.

- Start five native DuckDB Quack servers.
- Query them from a gateway DuckDB client.
- Prove public federation, wolf row filtering, denied private-table access, and
  Quack logs.

## Phase 2: Real Game Controller

- Port the browser orchestrator into a small controller service.
- Keep LLM calls in the controller.
- Write each agent action into that agent's Quack node.
- Stream turns, federation rows, and Quack logs to the browser.

## Phase 3: Token-Scoped ACLs

SQL macros are good for the first lab, but they cannot maintain session state.
For production-like scoping:

- Write a tiny DuckDB extension for authentication.
- Record `connection_id -> caller/scope`.
- Let the authorization callback check that mapping before allowing a query.
- Keep the safe views as defense in depth.

## Phase 4: Browser Integration

- Add a "Connect to Quack Lab" mode in the post.
- Detect the local controller on `localhost`.
- Show real Quack logs beside the current shim logs.
- Keep browser-only mode as the default portable demo.

## Phase 5: Ephemeral Hosted Labs

- Launch short-lived Quack node groups per reader.
- Put a reverse proxy in front of every Quack server.
- Terminate TLS at the proxy.
- Enforce short TTLs and resource quotas.
- Tear down inactive labs automatically.
