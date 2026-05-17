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
      decode(from_base64(string_split(client_token, '.')[1])),
      '$.exp'
    ) AS BIGINT
  ) > epoch(now())
);

CREATE TABLE quack_scopes (
  scope_name VARCHAR PRIMARY KEY,
  allowed_identifiers VARCHAR[]
);

-- Scope-aware authorization. Each federated query carries a leading
-- "/* scope: <name> */" comment minted by the gateway. The macro looks up the
-- scope and grants only if every public identifier the query references is in
-- the scope's allowed_identifiers list. Private tables are always denied.
CREATE MACRO lab_authorize(sid, query) AS (
  regexp_matches(upper(regexp_replace(trim(query), '^/\*[^*]*\*/\s*', '', 'g')), '^(SELECT|FROM|WITH|EXPLAIN|DESCRIBE|SHOW)\b')
  AND NOT regexp_matches(lower(query), '\b(self|intents|knowledge|suspicions|votes|game_flags|lab_secret|quack_scopes)\b')
  AND EXISTS (
    SELECT 1
    FROM quack_scopes s
    WHERE s.scope_name = regexp_extract(query, 'scope:\s*([a-z_]+)', 1)
      AND list_has_all(
        s.allowed_identifiers,
        list_filter(
          ['public_intents', 'wolf_channel', 'seer_channel', 'doctor_channel', 'post_game_intents', 'whoami'],
          v -> regexp_matches(lower(query), '\b' || v || '\b')
        )
      )
  )
);

SET GLOBAL quack_authentication_function = 'lab_check_token';
SET GLOBAL quack_authorization_function = 'lab_authorize';
