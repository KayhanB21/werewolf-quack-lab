#!/usr/bin/env bash
set -euo pipefail

DUCKDB_BIN="${DUCKDB_BIN:-duckdb}"
DATA_DIR="${DATA_DIR:-/data}"
NODE_ID="${NODE_ID:?NODE_ID is required}"
ROLE="${ROLE:?ROLE is required}"
PARTNERS="${PARTNERS:-}"
PLAYER_IDS="${PLAYER_IDS:?PLAYER_IDS is required}"
QUACK_PORT="${QUACK_PORT:-9494}"
QUACK_TOKEN="${QUACK_TOKEN:-${NODE_ID}-dev-token}"
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

CREATE TABLE IF NOT EXISTS quack_tokens (
  auth_token VARCHAR PRIMARY KEY,
  user_name VARCHAR NOT NULL
);

DELETE FROM self;
DELETE FROM game_flags;
DELETE FROM knowledge;
DELETE FROM suspicions;
DELETE FROM intents;
DELETE FROM votes;
DELETE FROM quack_tokens;

INSERT INTO self VALUES ('${NODE_ID}', '${ROLE}', ${PARTNER_SQL});
INSERT INTO game_flags VALUES (${POST_GAME_SQL});
INSERT INTO quack_tokens VALUES ('${QUACK_TOKEN}', 'gateway');

CREATE OR REPLACE VIEW public_intents AS
SELECT round, agent_id, action, target, public_text, decided_at
FROM intents
WHERE public_text IS NOT NULL;

CREATE OR REPLACE VIEW wolf_channel AS
SELECT round, agent_id, action, target, rationale, decided_at
FROM intents
WHERE action = 'wolf-kill'
  AND (SELECT role FROM self LIMIT 1) = 'wolf';

CREATE OR REPLACE VIEW post_game_intents AS
SELECT round, agent_id, action, target, public_text, rationale, decided_at
FROM intents
WHERE (SELECT post_game FROM game_flags LIMIT 1);

CREATE OR REPLACE MACRO lab_check_token(sid, client_token, server_token) AS (
  EXISTS (SELECT 1 FROM quack_tokens WHERE auth_token = client_token)
);

CREATE OR REPLACE MACRO lab_authorize(sid, query) AS (
  regexp_matches(upper(trim(query)), '^(SELECT|FROM|WITH|EXPLAIN|DESCRIBE|SHOW)\b')
  AND (
    regexp_matches(lower(query), '\b(public_intents|wolf_channel|post_game_intents)\b')
    OR regexp_matches(lower(query), 'whoami\(\)')
  )
  AND NOT regexp_matches(lower(query), '\b(self|intents|knowledge|suspicions|votes|game_flags|quack_tokens)\b')
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
  token => '${QUACK_TOKEN}',
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
