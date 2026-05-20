#!/usr/bin/env bash
set -euo pipefail

DUCKDB_BIN="${DUCKDB_BIN:-duckdb}"
DATA_DIR="${DATA_DIR:-/data}"
NODE_ID="${NODE_ID:?NODE_ID is required}"
ROLE="${ROLE:?ROLE is required}"
PARTNERS="${PARTNERS:-}"
PLAYER_IDS="${PLAYER_IDS:?PLAYER_IDS is required}"
QUACK_PORT="${QUACK_PORT:-9494}"
LAB_QUACK_SECRET="${LAB_QUACK_SECRET:?LAB_QUACK_SECRET is required}"
POST_GAME="${POST_GAME:-false}"
DB_PATH="${DB_PATH:-${DATA_DIR}/${NODE_ID}.duckdb}"
INIT_SQL="/tmp/${NODE_ID}-init.sql"
ACTION_PIPE="${ACTION_PIPE:-/tmp/${NODE_ID}-duckdb.fifo}"

mkdir -p "${DATA_DIR}"

if [[ "${POST_GAME}" == "true" ]]; then
  POST_GAME_SQL="true"
else
  POST_GAME_SQL="false"
fi

if [[ -n "${PARTNERS}" ]]; then
  IFS="," read -r -a PARTNER_ITEMS <<< "${PARTNERS}"
  PARTNER_SQL="ARRAY["
  for partner in "${PARTNER_ITEMS[@]}"; do
    partner="${partner// /}"
    [[ -z "${partner}" ]] && continue
    if [[ "${PARTNER_SQL}" != "ARRAY[" ]]; then
      PARTNER_SQL+=", "
    fi
    PARTNER_SQL+="'${partner}'"
  done
  PARTNER_SQL+="]::VARCHAR[]"
else
  PARTNER_SQL="ARRAY[]::VARCHAR[]"
fi

cat > "${INIT_SQL}" <<SQL
PRAGMA enable_progress_bar = false;

FORCE INSTALL quack FROM core_nightly;
LOAD quack;

CREATE TABLE IF NOT EXISTS self (
  agent_id VARCHAR PRIMARY KEY,
  role VARCHAR NOT NULL,
  partners VARCHAR[]
);

CREATE TABLE IF NOT EXISTS game_flags (
  post_game BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge (
  round INTEGER NOT NULL,
  agent_id VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  content VARCHAR NOT NULL,
  confidence DOUBLE NOT NULL DEFAULT 0.5,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suspicions (
  round INTEGER NOT NULL,
  agent_id VARCHAR NOT NULL,
  target_agent VARCHAR NOT NULL,
  p_wolf DOUBLE NOT NULL,
  reasoning VARCHAR NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS intents (
  round INTEGER NOT NULL,
  agent_id VARCHAR NOT NULL,
  action VARCHAR NOT NULL,
  target VARCHAR,
  rationale VARCHAR,
  public_text VARCHAR,
  decided_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS votes (
  round INTEGER NOT NULL,
  voter VARCHAR NOT NULL,
  target VARCHAR NOT NULL,
  decided_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS eliminations (
  round INTEGER NOT NULL,
  agent_id VARCHAR NOT NULL,
  role VARCHAR NOT NULL,
  cause VARCHAR NOT NULL,
  decided_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lab_secret (
  secret VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS quack_scopes (
  scope_name VARCHAR PRIMARY KEY,
  allowed_identifiers VARCHAR[]
);

DELETE FROM self;
DELETE FROM game_flags;
DELETE FROM knowledge;
DELETE FROM suspicions;
DELETE FROM intents;
DELETE FROM votes;
DELETE FROM eliminations;
DELETE FROM lab_secret;
DELETE FROM quack_scopes;

INSERT INTO self VALUES ('${NODE_ID}', '${ROLE}', ${PARTNER_SQL});
INSERT INTO game_flags VALUES (${POST_GAME_SQL});
INSERT INTO lab_secret VALUES ('${LAB_QUACK_SECRET}');

INSERT INTO quack_scopes VALUES
  ('whoami',         ['whoami']),
  ('public_log',     ['public_intents']),
  ('wolf_channel',   ['wolf_channel']),
  ('seer_channel',   ['seer_channel']),
  ('doctor_channel', ['doctor_channel']),
  ('full_log',       ['post_game_intents']),
  ('smoke',          ['public_intents', 'wolf_channel', 'post_game_intents', 'whoami']),
  ('denied',         []);

CREATE OR REPLACE VIEW public_intents AS
SELECT round, agent_id, action, target, public_text, decided_at
FROM intents
WHERE public_text IS NOT NULL;

CREATE OR REPLACE VIEW wolf_channel AS
SELECT round, agent_id, action, target, rationale, decided_at
FROM intents
WHERE action IN ('wolf-kill', 'wolf-done')
  AND (SELECT role FROM self LIMIT 1) = 'wolf';

CREATE OR REPLACE VIEW seer_channel AS
SELECT round, agent_id, action, target, rationale, decided_at
FROM intents
WHERE action = 'seer-investigate'
  AND (SELECT role FROM self LIMIT 1) = 'seer';

CREATE OR REPLACE VIEW doctor_channel AS
SELECT round, agent_id, action, target, rationale, decided_at
FROM intents
WHERE action = 'doctor-save'
  AND (SELECT role FROM self LIMIT 1) = 'doctor';

CREATE OR REPLACE VIEW post_game_intents AS
SELECT round, agent_id, action, target, public_text, rationale, decided_at
FROM intents
WHERE (SELECT post_game FROM game_flags LIMIT 1);

-- A lab token is "<payload_b64>.<sig_b64>" where:
--   payload   = compact JSON {client, scope, exp, nonce}
--   signature = sha256(LAB_QUACK_SECRET || payload_b64), base64-encoded
-- The macro recomputes the expected signature and checks expiry. No replay
-- protection beyond TTL; that is fine for the lab.
CREATE OR REPLACE MACRO lab_check_token(sid, client_token, server_token) AS (
  to_base64(unhex(sha256(
    (SELECT secret FROM lab_secret LIMIT 1) ||
    string_split(client_token, '.')[1]
  ))) = string_split(client_token, '.')[2]
  AND CAST(
    json_extract_string(
      decode(from_base64(string_split(client_token, '.')[1])),
      '\$.exp'
    ) AS BIGINT
  ) > epoch(now())
);

-- Scope-aware authorization, driven by the quack_scopes table.
-- Each federated query carries a leading "/* scope: <name> */" comment minted
-- by the gateway. The macro looks up the scope, computes the set of public
-- identifiers the query references, and grants only if that set is a subset
-- of the scope's allowed_identifiers. Private tables are always denied.
CREATE OR REPLACE MACRO lab_authorize(sid, query) AS (
  regexp_matches(upper(regexp_replace(trim(query), '^/\*[^*]*\*/\s*', '', 'g')), '^(SELECT|FROM|WITH|EXPLAIN|DESCRIBE|SHOW)\b')
  AND NOT regexp_matches(lower(query), '\b(self|intents|knowledge|suspicions|votes|eliminations|game_flags|lab_secret|quack_scopes)\b')
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

CALL enable_logging('Quack');
CALL quack_identify(
  name => '${NODE_ID}',
  provider => 'docker-compose',
  hostname => '${NODE_ID}',
  region => 'local',
  meta => '{"role_hash":"redacted-in-lab","post_game":${POST_GAME_SQL}}'
);

SELECT *
FROM quack_serve(
  'quack:0.0.0.0:${QUACK_PORT}',
  token => 'lab-server',
  allow_other_hostname => true,
  disable_ssl => true
);
SQL

echo "[${NODE_ID}] starting DuckDB Quack server on quack:0.0.0.0:${QUACK_PORT}"
echo "[${NODE_ID}] database: ${DB_PATH}"
echo "[${NODE_ID}] action pipe: ${ACTION_PIPE}"

rm -f "${ACTION_PIPE}"
mkfifo "${ACTION_PIPE}"
chmod 666 "${ACTION_PIPE}"

{
  cat "${INIT_SQL}"
  while true; do
    cat "${ACTION_PIPE}"
  done
} | "${DUCKDB_BIN}" "${DB_PATH}"
