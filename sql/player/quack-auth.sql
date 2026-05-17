-- Reference Quack auth callbacks for one player node.
-- These callbacks are installed by bin/player-node.sh.

CREATE TABLE lab_secret (
  secret VARCHAR NOT NULL
);

-- The gateway mints a fresh token per call. Token format:
--   "<payload_b64>.<sig_b64>"
--   payload = compact JSON {client, scope, exp, nonce}
--   sig     = sha256(LAB_QUACK_SECRET || payload_b64), base64
-- The macro recomputes the expected signature and checks expiry.
CREATE MACRO lab_check_token(sid, client_token, server_token) AS (
  to_base64(unhex(sha256(
    (SELECT secret FROM lab_secret LIMIT 1) ||
    string_split(client_token, '.')[1]
  ))) = string_split(client_token, '.')[2]
  AND CAST(
    json_extract_string(
      CAST(from_base64(string_split(client_token, '.')[1]) AS VARCHAR),
      '$.exp'
    ) AS BIGINT
  ) > epoch(now())
);

CREATE MACRO lab_authorize(sid, query) AS (
  regexp_matches(upper(trim(query)), '^(SELECT|FROM|WITH|EXPLAIN|DESCRIBE|SHOW)\b')
  AND (
    regexp_matches(lower(query), '\b(public_intents|wolf_channel|seer_channel|doctor_channel|post_game_intents)\b')
    OR regexp_matches(lower(query), 'whoami\(\)')
  )
  AND NOT regexp_matches(lower(query), '\b(self|intents|knowledge|suspicions|votes|game_flags|lab_secret)\b')
);

SET GLOBAL quack_authentication_function = 'lab_check_token';
SET GLOBAL quack_authorization_function = 'lab_authorize';
