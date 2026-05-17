#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MINT="${ROOT_DIR}/bin/mint-token.sh"

# Token shape: <b64>.<b64>
token="$(LAB_QUACK_SECRET="testsecret" "${MINT}" public_log 60)"
if [[ "${token}" != *.* ]]; then
  echo "minted token should be <payload>.<sig>" >&2
  echo "got: ${token}" >&2
  exit 1
fi

payload_b64="${token%%.*}"
sig_b64="${token##*.}"
if [[ -z "${payload_b64}" || -z "${sig_b64}" ]]; then
  echo "minted token halves must be non-empty" >&2
  exit 1
fi

# Payload decodes to JSON with the expected fields.
payload_json="$(printf "%s" "${payload_b64}" | openssl base64 -d -A)"
client="$(jq -r '.client' <<<"${payload_json}")"
scope="$(jq -r '.scope' <<<"${payload_json}")"
nonce="$(jq -r '.nonce' <<<"${payload_json}")"
exp="$(jq -r '.exp' <<<"${payload_json}")"

[[ "${client}" == "gateway" ]] || { echo "default client should be gateway"; exit 1; }
[[ "${scope}" == "public_log" ]] || { echo "scope should round-trip"; exit 1; }
[[ -n "${nonce}" ]] || { echo "nonce must be non-empty"; exit 1; }
[[ "${exp}" -gt "$(date +%s)" ]] || { echo "exp must be in the future"; exit 1; }

# Signature reproducibility: same secret + same payload (pinned now/nonce) ->
# same signature.
fixed1="$(LAB_QUACK_SECRET="testsecret" MINT_NOW=1700000000 MINT_NONCE="abcd1234" "${MINT}" public_log 60)"
fixed2="$(LAB_QUACK_SECRET="testsecret" MINT_NOW=1700000000 MINT_NONCE="abcd1234" "${MINT}" public_log 60)"
if [[ "${fixed1}" != "${fixed2}" ]]; then
  echo "same secret+payload should produce the same token" >&2
  echo "fixed1=${fixed1}" >&2
  echo "fixed2=${fixed2}" >&2
  exit 1
fi

# Different secret -> different signature.
diff_secret="$(LAB_QUACK_SECRET="OTHER" MINT_NOW=1700000000 MINT_NONCE="abcd1234" "${MINT}" public_log 60)"
if [[ "${fixed1#*.}" == "${diff_secret#*.}" ]]; then
  echo "different secrets must produce different signatures" >&2
  exit 1
fi

# Independent reference signature: hand-compute it the same way the player
# DuckDB macro will, and confirm the mint script matches.
fixed_payload_b64="${fixed1%%.*}"
fixed_sig_b64="${fixed1##*.}"
expected_sig="$(printf "%stestsecret%s" "" "${fixed_payload_b64}" | openssl dgst -sha256 -binary | openssl base64 -A)"
# (Note: printf "%stestsecret%s" "" "$x" === "testsecret$x" — keeps the test
# explicit about the secret-comes-first concatenation order.)
if [[ "${fixed_sig_b64}" != "${expected_sig}" ]]; then
  echo "mint signature must equal sha256(secret||payload_b64)" >&2
  echo "from mint:     ${fixed_sig_b64}" >&2
  echo "hand-computed: ${expected_sig}" >&2
  exit 1
fi

# Custom client name flows through.
custom="$(LAB_QUACK_SECRET="testsecret" "${MINT}" wolf_channel 30 referee)"
custom_payload="$(printf "%s" "${custom%%.*}" | openssl base64 -d -A)"
[[ "$(jq -r '.client' <<<"${custom_payload}")" == "referee" ]] || { echo "client arg ignored"; exit 1; }
[[ "$(jq -r '.scope' <<<"${custom_payload}")" == "wolf_channel" ]] || { echo "scope arg ignored"; exit 1; }

# TTL flows into exp.
ttl_token="$(LAB_QUACK_SECRET="testsecret" MINT_NOW=1700000000 MINT_NONCE="x" "${MINT}" public_log 600)"
ttl_payload="$(printf "%s" "${ttl_token%%.*}" | openssl base64 -d -A)"
[[ "$(jq -r '.exp' <<<"${ttl_payload}")" == "1700000600" ]] || { echo "ttl not applied"; exit 1; }

echo "ok - mint-token signs and round-trips lab tokens"
