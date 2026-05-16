-- Reference Quack auth callbacks for one player node.
-- These callbacks are installed by bin/player-node.sh.

CREATE TABLE quack_tokens (
  auth_token VARCHAR PRIMARY KEY,
  user_name VARCHAR NOT NULL
);

CREATE MACRO lab_check_token(sid, client_token, server_token) AS (
  EXISTS (SELECT 1 FROM quack_tokens WHERE auth_token = client_token)
);

CREATE MACRO lab_authorize(sid, query) AS (
  regexp_matches(upper(trim(query)), '^(SELECT|FROM|WITH|EXPLAIN|DESCRIBE|SHOW)\b')
  AND (
    regexp_matches(lower(query), '\b(public_intents|wolf_channel|post_game_intents)\b')
    OR regexp_matches(lower(query), 'whoami\(\)')
  )
  AND NOT regexp_matches(lower(query), '\b(self|intents|knowledge|suspicions|votes|game_flags|quack_tokens)\b')
);

SET GLOBAL quack_authentication_function = 'lab_check_token';
SET GLOBAL quack_authorization_function = 'lab_authorize';
