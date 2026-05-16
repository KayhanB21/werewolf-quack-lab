#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

run_action() {
  local phase="$1"
  local role="$2"
  local partners="$3"
  local out_file="$4"
  local pipe_path="${TMP_DIR}/${phase}-${role}.fifo"

  mkfifo "${pipe_path}"
  cat "${pipe_path}" > "${out_file}" &
  local reader_pid="$!"

  env \
    NODE_ID="agent-a" \
    ROLE="${role}" \
    PARTNERS="${partners}" \
    PLAYER_IDS="agent-a,agent-b,agent-d" \
    LLM_PROVIDER="stub" \
    ACTION_PIPE="${pipe_path}" \
    "${ROOT_DIR}/bin/agent-act.sh" --phase "${phase}" --round 2 >/dev/null

  wait "${reader_pid}"
}

wolf_sql="${TMP_DIR}/wolf.sql"
run_action "wolf" "wolf" "agent-d" "${wolf_sql}"

if ! grep -Fq "wolf-kill" "${wolf_sql}"; then
  echo "wolf action should insert a wolf-kill intent" >&2
  exit 1
fi

if ! grep -Fq "'agent-b'" "${wolf_sql}"; then
  echo "wolf action should target the first non-self, non-partner player" >&2
  exit 1
fi

if grep -Fq "'agent-d'" "${wolf_sql}"; then
  echo "wolf action should not target a wolf partner" >&2
  exit 1
fi

day_sql="${TMP_DIR}/day.sql"
run_action "day" "seer" "" "${day_sql}"

if ! grep -Fq "'speak'" "${day_sql}"; then
  echo "day action should insert a speak intent" >&2
  exit 1
fi

if grep -Fq "Stub agent" "${day_sql}" && ! grep -Fq "role=seer" "${day_sql}"; then
  echo "day rationale should include the agent role" >&2
  exit 1
fi

echo "ok - agent action writer emits local DuckDB intents"
