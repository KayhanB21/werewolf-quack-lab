#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

# shellcheck source=/dev/null
source "${ROOT_DIR}/bin/lab-span.sh"

OUT="${TMP_DIR}/timeline.jsonl"

emit_span \
  --name public_log \
  --scope public_log \
  --status ok \
  --hosts "agent-a,agent-b,agent-c" \
  --duration-ms 42 \
  --ts "2026-05-18T00:00:00.000Z" \
  --out "${OUT}"

emit_span \
  --name denied_private_table \
  --scope denied \
  --status denied \
  --hosts "agent-a" \
  --duration-ms 11 \
  --ts "2026-05-18T00:00:01.000Z" \
  --out "${OUT}"

if [[ "$(wc -l < "${OUT}")" -ne 2 ]]; then
  echo "expected 2 spans in timeline" >&2
  cat "${OUT}" >&2
  exit 1
fi

first="$(sed -n 1p "${OUT}")"
second="$(sed -n 2p "${OUT}")"

if ! jq -e '.kind == "quack_query" and .name == "public_log" and .scope == "public_log" and .status == "ok" and .duration_ms == 42' <<<"${first}" >/dev/null; then
  echo "first span shape unexpected" >&2
  printf '%s\n' "${first}" >&2
  exit 1
fi

if ! jq -e '.hosts == ["agent-a","agent-b","agent-c"]' <<<"${first}" >/dev/null; then
  echo "first span should carry all three hosts as a json array" >&2
  printf '%s\n' "${first}" >&2
  exit 1
fi

if ! jq -e '.scope == "denied" and .status == "denied" and .hosts == ["agent-a"]' <<<"${second}" >/dev/null; then
  echo "denied span shape unexpected" >&2
  printf '%s\n' "${second}" >&2
  exit 1
fi

empty_out="${TMP_DIR}/empty-timeline.jsonl"
emit_span \
  --name whoami \
  --scope whoami \
  --status ok \
  --hosts "" \
  --duration-ms 7 \
  --ts "2026-05-18T00:00:02.000Z" \
  --out "${empty_out}"

if ! jq -e '.hosts == [] and .duration_ms == 7' < "${empty_out}" >/dev/null; then
  echo "empty hosts should serialize as an empty array" >&2
  cat "${empty_out}" >&2
  exit 1
fi

# span_now_ms returns a positive integer in milliseconds
now="$(span_now_ms)"
if [[ ! "${now}" =~ ^[0-9]+$ ]] || (( now < 1000000000000 )); then
  echo "span_now_ms should return a 13-digit millisecond epoch" >&2
  printf '%s\n' "${now}" >&2
  exit 1
fi

echo "ok - lab-span emits federation timeline spans"
