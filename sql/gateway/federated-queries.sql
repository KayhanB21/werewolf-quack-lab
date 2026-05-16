-- Reference gateway queries. bin/gateway-query.sh runs these shapes through
-- quack_query(...) against each player node and UNION ALLs the returned rows.

-- Mid-game public log. Rationale is absent from the exposed view.
SELECT round, agent_id, action, target, public_text, CAST(decided_at AS VARCHAR) AS decided_at
FROM public_intents;

-- Wolf-only channel. All nodes receive this query; non-wolf nodes return zero rows.
SELECT round, agent_id, action, target, rationale, CAST(decided_at AS VARCHAR) AS decided_at
FROM wolf_channel;

-- Post-game log. The view returns rows only after the node's post_game flag is true.
SELECT round, agent_id, action, target, public_text, rationale, CAST(decided_at AS VARCHAR) AS decided_at
FROM post_game_intents;

-- Expected denial path. Direct private-table access should be rejected by
-- quack_authorization_function before this query can run.
SELECT round, agent_id, action, target, rationale
FROM intents;
