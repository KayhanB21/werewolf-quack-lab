#!/usr/bin/env bash
# Sourceable helper for federation timeline spans. Each span is a single
# JSON object appended to a JSONL file in the gateway's mounted volume.

emit_span() {
  local name=""
  local scope=""
  local status="ok"
  local hosts=""
  local duration_ms="0"
  local ts="${SPAN_TS:-}"
  local out="${SPAN_OUT:-/data/timeline.jsonl}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) name="$2"; shift 2 ;;
      --scope) scope="$2"; shift 2 ;;
      --status) status="$2"; shift 2 ;;
      --hosts) hosts="$2"; shift 2 ;;
      --duration-ms) duration_ms="$2"; shift 2 ;;
      --ts) ts="$2"; shift 2 ;;
      --out) out="$2"; shift 2 ;;
      *) echo "emit_span: unknown arg $1" >&2; return 2 ;;
    esac
  done

  if [[ -z "${ts}" ]]; then
    ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  local hosts_json="[]"
  if [[ -n "${hosts}" ]]; then
    hosts_json="$(jq -cn --arg csv "${hosts}" '$csv | split(",") | map(select(length > 0))')"
  fi

  mkdir -p "$(dirname "${out}")"
  jq -cn \
    --arg ts "${ts}" \
    --arg name "${name}" \
    --arg scope "${scope}" \
    --arg status "${status}" \
    --argjson duration_ms "${duration_ms}" \
    --argjson hosts "${hosts_json}" \
    '{ts: $ts, kind: "quack_query", name: $name, scope: $scope, status: $status, duration_ms: $duration_ms, hosts: $hosts}' \
    >> "${out}"
}

span_now_ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    awk -v t="${EPOCHREALTIME}" 'BEGIN{
      sub(/,/, ".", t)
      printf "%.0f", t * 1000
    }'
    return 0
  fi
  date -u +%s000
}
