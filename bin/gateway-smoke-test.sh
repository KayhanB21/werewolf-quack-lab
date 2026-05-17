#!/usr/bin/env bash
set -euo pipefail

DUCKDB_BIN="${DUCKDB_BIN:-duckdb}"
BOOTSTRAP_SQL="FORCE INSTALL quack FROM core_nightly; LOAD quack;"

: "${LAB_QUACK_SECRET:?LAB_QUACK_SECRET is required}"
: "${PLAYERS_JSON:?PLAYERS_JSON is required}"

mapfile -t PLAYER_HOSTS < <(jq -r '.[].id' <<<"${PLAYERS_JSON}")
EXPECTED_NAMES="$(jq -c '[.[].id] | sort' <<<"${PLAYERS_JSON}")"
EXPECTED_WOLVES="$(jq -c '[.[] | select(.role == "wolf") | .id] | sort' <<<"${PLAYERS_JSON}")"

EXPECTED_COUNT="${#PLAYER_HOSTS[@]}"
EXPECTED_WOLF_COUNT="$(jq 'length' <<<"${EXPECTED_WOLVES}")"

mint_token() {
  LAB_QUACK_SECRET="${LAB_QUACK_SECRET}" /app/bin/mint-token.sh "$1" 60 gateway
}

duck_json() {
  local sql="$1"
  "${DUCKDB_BIN}" -json :memory: "${BOOTSTRAP_SQL} ${sql}"
}

escape_sql_string() {
  printf "%s" "$1" | sed "s/'/''/g"
}

federate_json() {
  local remote_sql="$1"
  local scope="${2:-smoke}"
  local scoped_sql="/* scope: ${scope} */ ${remote_sql}"
  local escaped_remote_sql
  escaped_remote_sql="$(escape_sql_string "${scoped_sql}")"
  local token
  token="$(mint_token "${scope}")"
  local union_sql=""
  local first="true"

  for host in "${PLAYER_HOSTS[@]}"; do
    if [[ "${first}" == "true" ]]; then
      first="false"
    else
      union_sql+=" UNION ALL "
    fi
    union_sql+="SELECT * FROM quack_query('quack:${host}:9494', '${escaped_remote_sql}', token => '${token}', disable_ssl => true)"
  done

  duck_json "${union_sql};"
}

pass() {
  echo "ok - $1"
}

fail() {
  echo "not ok - $1" >&2
  exit 1
}

assert_jq() {
  local json="$1"
  local filter="$2"
  local label="$3"

  if jq -e "${filter}" >/dev/null <<<"${json}"; then
    pass "${label}"
  else
    echo "${json}" | jq . >&2
    fail "${label}"
  fi
}

whoami_json="$(federate_json "SELECT name FROM whoami()")"
assert_jq "${whoami_json}" "length == ${EXPECTED_COUNT}" "whoami returns all Quack nodes"
assert_jq "${whoami_json}" "[.[].name] | sort == ${EXPECTED_NAMES}" "whoami returns expected node names"

public_json="$(federate_json "SELECT round, agent_id, public_text FROM public_intents")"
assert_jq "${public_json}" "length == ${EXPECTED_COUNT}" "public_log federation returns one public row per player"
assert_jq "${public_json}" 'all(.[]; has("rationale") | not)' "public_log federation does not expose rationale"

wolf_json="$(federate_json "SELECT agent_id, target, rationale FROM wolf_channel")"
assert_jq "${wolf_json}" "length == ${EXPECTED_WOLF_COUNT}" "wolf_channel returns only wolf rows"
assert_jq "${wolf_json}" "[.[].agent_id] | sort == ${EXPECTED_WOLVES}" "wolf_channel row filtering is evaluated on player nodes"

full_json="$(federate_json "SELECT agent_id, rationale FROM post_game_intents")"
assert_jq "${full_json}" 'length == 0' "post_game_intents is closed while POST_GAME=false"

set +e
denied_output="$(
  first_host="${PLAYER_HOSTS[0]}"
  token="$(mint_token denied)"
  duck_json "SELECT * FROM quack_query('quack:${first_host}:9494', '/* scope: denied */ SELECT round, agent_id, rationale FROM intents', token => '${token}', disable_ssl => true);" 2>&1
)"
denied_status="$?"
set -e

if [[ "${denied_status}" -eq 0 ]]; then
  echo "${denied_output}" >&2
  fail "private intents query should be rejected"
fi

if grep -q "Authorization failed" <<<"${denied_output}"; then
  pass "private intents query is rejected by Quack authorization"
else
  echo "${denied_output}" >&2
  fail "private intents query failed for the wrong reason"
fi

echo "real Quack smoke test passed"
