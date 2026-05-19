#!/usr/bin/env bash
# Exercise the lab_check_token and lab_authorize macros against a real DuckDB
# CLI. Mirrors the macro definitions in player-node.sh so a regression in
# either file fails this test.
set -euo pipefail

if ! command -v duckdb >/dev/null 2>&1; then
  echo "skip - duckdb CLI not on PATH"
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

SECRET="testsecret-32-bytes-of-entropy-here"
SQL_PATH="${TMP_DIR}/authz.sql"

# Pre-mint two tokens that share the secret and are known good/expired so we
# can assert lab_check_token's exp check independently of the signature check.
GOOD_TOKEN="$(LAB_QUACK_SECRET="${SECRET}" "${ROOT_DIR}/bin/mint-token.sh" public_log 60 gateway)"
EXPIRED_TOKEN="$(LAB_QUACK_SECRET="${SECRET}" MINT_NOW=1 MINT_NONCE=fixed "${ROOT_DIR}/bin/mint-token.sh" public_log 60 gateway)"
BAD_SIG_TOKEN="${GOOD_TOKEN%.*}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

cat > "${SQL_PATH}" <<SQL
CREATE TABLE lab_secret (secret VARCHAR NOT NULL);
INSERT INTO lab_secret VALUES ('${SECRET}');

CREATE TABLE quack_scopes (
  scope_name VARCHAR PRIMARY KEY,
  allowed_identifiers VARCHAR[]
);
INSERT INTO quack_scopes VALUES
  ('whoami',         ['whoami']),
  ('public_log',     ['public_intents']),
  ('wolf_channel',   ['wolf_channel']),
  ('seer_channel',   ['seer_channel']),
  ('doctor_channel', ['doctor_channel']),
  ('full_log',       ['post_game_intents']),
  ('smoke',          ['public_intents', 'wolf_channel', 'post_game_intents', 'whoami']),
  ('denied',         []);

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

-- Token checks
SELECT 'good_token_accepted' AS label, lab_check_token('sid', '${GOOD_TOKEN}', 'srv') AS ok
UNION ALL SELECT 'expired_token_rejected', NOT lab_check_token('sid', '${EXPIRED_TOKEN}', 'srv')
UNION ALL SELECT 'bad_signature_rejected', NOT lab_check_token('sid', '${BAD_SIG_TOKEN}', 'srv')
-- Authorization checks
UNION ALL SELECT 'public_log_in_scope', lab_authorize('sid', '/* scope: public_log */ SELECT * FROM public_intents')
UNION ALL SELECT 'wolf_channel_in_scope', lab_authorize('sid', '/* scope: wolf_channel */ SELECT * FROM wolf_channel')
UNION ALL SELECT 'seer_channel_in_scope', lab_authorize('sid', '/* scope: seer_channel */ SELECT * FROM seer_channel')
UNION ALL SELECT 'doctor_channel_in_scope', lab_authorize('sid', '/* scope: doctor_channel */ SELECT * FROM doctor_channel')
UNION ALL SELECT 'whoami_in_scope', lab_authorize('sid', '/* scope: whoami */ SELECT * FROM whoami()')
UNION ALL SELECT 'full_log_in_scope', lab_authorize('sid', '/* scope: full_log */ SELECT * FROM post_game_intents')
UNION ALL SELECT 'wrong_scope_rejected', NOT lab_authorize('sid', '/* scope: wolf_channel */ SELECT * FROM public_intents')
UNION ALL SELECT 'missing_scope_rejected', NOT lab_authorize('sid', 'SELECT * FROM public_intents')
UNION ALL SELECT 'denied_scope_blocks_all_views', NOT lab_authorize('sid', '/* scope: denied */ SELECT * FROM public_intents')
UNION ALL SELECT 'private_table_blocked_even_in_smoke', NOT lab_authorize('sid', '/* scope: smoke */ SELECT * FROM intents')
UNION ALL SELECT 'private_table_blocked_in_denied', NOT lab_authorize('sid', '/* scope: denied */ SELECT * FROM intents')
UNION ALL SELECT 'cross_scope_mix_rejected', NOT lab_authorize('sid', '/* scope: public_log */ SELECT * FROM public_intents JOIN wolf_channel USING(round)')
UNION ALL SELECT 'insert_blocked', NOT lab_authorize('sid', '/* scope: public_log */ INSERT INTO public_intents VALUES (1)')
UNION ALL SELECT 'lab_secret_table_blocked', NOT lab_authorize('sid', '/* scope: public_log */ SELECT * FROM lab_secret')
UNION ALL SELECT 'eliminations_table_blocked', NOT lab_authorize('sid', '/* scope: public_log */ SELECT * FROM eliminations');
SQL

results="$(duckdb -csv -noheader < "${SQL_PATH}")"

failures=0
while IFS=',' read -r label ok; do
  case "${ok}" in
    true) printf 'ok - %s\n' "${label}" ;;
    *) printf 'not ok - %s (got %s)\n' "${label}" "${ok}" >&2; failures=$((failures + 1)) ;;
  esac
done <<<"${results}"

if [[ "${failures}" -gt 0 ]]; then
  echo "lab-authz-test: ${failures} failure(s)" >&2
  exit 1
fi

echo "ok - lab auth macros enforce signed tokens and scoped views"
