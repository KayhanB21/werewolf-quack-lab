#!/usr/bin/env bash
# Mint a Quack lab token: <payload_b64>.<sig_b64>
#
# payload = compact JSON {client, scope, exp, nonce}
# sig     = sha256(LAB_QUACK_SECRET || payload_b64), base64-encoded
#
# Usage:  bin/mint-token.sh <scope> [ttl_seconds] [client]
#         LAB_QUACK_SECRET=<hex> bin/mint-token.sh public_log 60 gateway
#
# Verification lives in the DuckDB lab_check_token macro on the player node.
set -euo pipefail

SCOPE="${1:?scope is required}"
TTL="${2:-60}"
CLIENT="${3:-gateway}"
SECRET="${LAB_QUACK_SECRET:?LAB_QUACK_SECRET is required}"

now_seconds() {
  if [[ -n "${MINT_NOW:-}" ]]; then
    printf "%s" "${MINT_NOW}"
  else
    date +%s
  fi
}

random_nonce() {
  if [[ -n "${MINT_NONCE:-}" ]]; then
    printf "%s" "${MINT_NONCE}"
  else
    openssl rand -hex 8
  fi
}

exp=$(($(now_seconds) + TTL))
nonce="$(random_nonce)"

payload="$(
  jq -n \
    --arg client "${CLIENT}" \
    --arg scope "${SCOPE}" \
    --argjson exp "${exp}" \
    --arg nonce "${nonce}" \
    -c \
    '{client:$client,scope:$scope,exp:$exp,nonce:$nonce}'
)"

payload_b64="$(printf "%s" "${payload}" | openssl base64 -A)"
sig_b64="$(printf "%s%s" "${SECRET}" "${payload_b64}" | openssl dgst -sha256 -binary | openssl base64 -A)"

printf "%s.%s" "${payload_b64}" "${sig_b64}"
