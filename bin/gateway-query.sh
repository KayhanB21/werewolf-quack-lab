#!/usr/bin/env bash
set -euo pipefail

DUCKDB_BIN="${DUCKDB_BIN:-duckdb}"
DATA_DIR="${DATA_DIR:-/data}"
DB_PATH="${DB_PATH:-${DATA_DIR}/gateway.duckdb}"
QUERY_NAME="${1:-public_log}"
QUERY_SQL="/tmp/gateway-${QUERY_NAME}.sql"

mkdir -p "${DATA_DIR}"

: "${LAB_QUACK_SECRET:?LAB_QUACK_SECRET is required}"
: "${PLAYERS_JSON:?PLAYERS_JSON is required}"

mapfile -t PLAYER_HOSTS < <(jq -r '.[].id' <<<"${PLAYERS_JSON}")
TOKEN="$(LAB_QUACK_SECRET="${LAB_QUACK_SECRET}" /app/bin/mint-token.sh "${QUERY_NAME}" 60 gateway)"

case "${QUERY_NAME}" in
  whoami)
    REMOTE_SQL="SELECT name, provider, hostname, region, CAST(uptime AS VARCHAR) AS uptime, CAST(ts_now AS VARCHAR) AS ts_now, meta FROM whoami()"
    FINAL_SQL="SELECT * FROM tmp_federated ORDER BY name;"
    ;;
  public_log)
    REMOTE_SQL="SELECT round, agent_id, action, target, public_text, CAST(decided_at AS VARCHAR) AS decided_at FROM public_intents"
    FINAL_SQL="SELECT * FROM tmp_federated ORDER BY round, decided_at, agent_id;"
    ;;
  wolf_channel)
    REMOTE_SQL="SELECT round, agent_id, action, target, rationale, CAST(decided_at AS VARCHAR) AS decided_at FROM wolf_channel"
    FINAL_SQL="SELECT * FROM tmp_federated ORDER BY round, decided_at, agent_id;"
    ;;
  seer_channel)
    REMOTE_SQL="SELECT round, agent_id, action, target, rationale, CAST(decided_at AS VARCHAR) AS decided_at FROM seer_channel"
    FINAL_SQL="SELECT * FROM tmp_federated ORDER BY round, decided_at, agent_id;"
    ;;
  doctor_channel)
    REMOTE_SQL="SELECT round, agent_id, action, target, rationale, CAST(decided_at AS VARCHAR) AS decided_at FROM doctor_channel"
    FINAL_SQL="SELECT * FROM tmp_federated ORDER BY round, decided_at, agent_id;"
    ;;
  full_log)
    REMOTE_SQL="SELECT round, agent_id, action, target, public_text, rationale, CAST(decided_at AS VARCHAR) AS decided_at FROM post_game_intents"
    FINAL_SQL="SELECT * FROM tmp_federated ORDER BY round, decided_at, agent_id;"
    ;;
  denied_private_table)
    REMOTE_SQL="SELECT round, agent_id, action, target, rationale FROM intents"
    FINAL_SQL="SELECT * FROM tmp_federated;"
    ;;
  *)
    echo "unknown query: ${QUERY_NAME}" >&2
    echo "valid queries: whoami, public_log, wolf_channel, seer_channel, doctor_channel, full_log, denied_private_table" >&2
    exit 2
    ;;
esac

cat > "${QUERY_SQL}" <<SQL
PRAGMA enable_progress_bar = false;

FORCE INSTALL quack FROM core_nightly;
LOAD quack;

CALL enable_logging('Quack');
CALL truncate_duckdb_logs();

CREATE OR REPLACE TABLE gateway_query_run AS
SELECT '${QUERY_NAME}' AS query_name, now() AS started_at;
SQL

append_logs_query() {
  cat >> "${QUERY_SQL}" <<SQL

SELECT
  message_type,
  query,
  server,
  duration_ms,
  response_type,
  error
FROM duckdb_logs_parsed('Quack')
ORDER BY timestamp;
SQL
}

if [[ "${QUERY_NAME}" == "denied_private_table" ]]; then
  first_host="${PLAYER_HOSTS[0]}"
  cat >> "${QUERY_SQL}" <<SQL

SELECT *
FROM quack_query(
  'quack:${first_host}:9494',
  '${REMOTE_SQL}',
  token => '${TOKEN}',
  disable_ssl => true
);
SQL
  append_logs_query

  echo "[gateway] running ${QUERY_NAME}"
  echo "[gateway] remote SQL: ${REMOTE_SQL}"
  output_file="/tmp/gateway-${QUERY_NAME}.out"
  set +e
  "${DUCKDB_BIN}" -json "${DB_PATH}" < "${QUERY_SQL}" 2>&1 | tee "${output_file}"
  status="${PIPESTATUS[0]}"
  set -e
  if grep -q "Authorization failed" "${output_file}"; then
    echo "[gateway] expected Quack authorization denial observed"
    exit 0
  fi
  exit "${status}"
fi

cat >> "${QUERY_SQL}" <<SQL
CREATE TEMP TABLE tmp_federated AS
SQL

first="true"
for host in "${PLAYER_HOSTS[@]}"; do
  if [[ "${first}" == "true" ]]; then
    first="false"
  else
    printf "\nUNION ALL\n" >> "${QUERY_SQL}"
  fi
  printf "SELECT * FROM quack_query('quack:%s:9494', '%s', token => '%s', disable_ssl => true)" \
    "${host}" "${REMOTE_SQL}" "${TOKEN}" >> "${QUERY_SQL}"
done

cat >> "${QUERY_SQL}" <<SQL
;

${FINAL_SQL}
SQL

append_logs_query

echo "[gateway] running ${QUERY_NAME}"
echo "[gateway] remote SQL: ${REMOTE_SQL}"
"${DUCKDB_BIN}" -json "${DB_PATH}" < "${QUERY_SQL}"
