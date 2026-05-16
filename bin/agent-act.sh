#!/usr/bin/env bash
set -euo pipefail

NODE_ID="${NODE_ID:?NODE_ID is required}"
ROLE="${ROLE:?ROLE is required}"
PARTNERS="${PARTNERS:-}"
PLAYER_IDS="${PLAYER_IDS:?PLAYER_IDS is required}"
LLM_PROVIDER="${LLM_PROVIDER:-stub}"
LLM_MODEL="${LLM_MODEL:-stub-werewolf-v1}"
LLM_BASE_URL="${LLM_BASE_URL:-https://api.openai.com/v1}"
LLM_API_KEY="${LLM_API_KEY:-}"
ACTION_PIPE="${ACTION_PIPE:-/tmp/${NODE_ID}-duckdb.fifo}"
PHASE="day"
ROUND="1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)
      PHASE="${2:?--phase requires a value}"
      shift 2
      ;;
    --round)
      ROUND="${2:?--round requires a value}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

sql_quote() {
  local value="${1//\'/\'\'}"
  printf "'%s'" "${value}"
}

contains_csv() {
  local needle="$1"
  local csv="$2"
  IFS="," read -r -a items <<< "${csv}"
  for item in "${items[@]}"; do
    item="${item// /}"
    [[ "${item}" == "${needle}" ]] && return 0
  done
  return 1
}

pick_target() {
  IFS="," read -r -a ids <<< "${PLAYER_IDS}"
  for id in "${ids[@]}"; do
    id="${id// /}"
    [[ -z "${id}" || "${id}" == "${NODE_ID}" ]] && continue
    if [[ "${ROLE}" == "wolf" ]] && contains_csv "${id}" "${PARTNERS}"; then
      continue
    fi
    printf "%s" "${id}"
    return 0
  done
  printf "%s" "${NODE_ID}"
}

stub_turn_json() {
  local target
  target="$(pick_target)"

  case "${PHASE}" in
    day)
      jq -n \
        --arg action "speak" \
        --arg target "" \
        --arg public_text "${NODE_ID}: I am checking the public record in round ${ROUND}." \
        --arg rationale "Stub agent ${NODE_ID} considered role=${ROLE}, partners=${PARTNERS:-none}, and player_ids=${PLAYER_IDS}." \
        '{action: $action, target: $target, public_text: $public_text, rationale: $rationale}'
      ;;
    wolf)
      if [[ "${ROLE}" != "wolf" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a wolf"}'
        return 0
      fi
      jq -n \
        --arg action "wolf-kill" \
        --arg target "${target}" \
        --arg public_text "" \
        --arg rationale "Stub wolf ${NODE_ID} proposes ${target}; partners=${PARTNERS:-none}." \
        '{action: $action, target: $target, public_text: $public_text, rationale: $rationale}'
      ;;
    vote)
      jq -n \
        --arg action "vote" \
        --arg target "${target}" \
        --arg public_text "${NODE_ID}: I vote ${target}." \
        --arg rationale "Stub voter ${NODE_ID} chose the first eligible target, ${target}." \
        '{action: $action, target: $target, public_text: $public_text, rationale: $rationale}'
      ;;
    *)
      echo "unsupported phase: ${PHASE}" >&2
      exit 2
      ;;
  esac
}

openai_turn_json() {
  if [[ -z "${LLM_API_KEY}" ]]; then
    echo "LLM_API_KEY is required when LLM_PROVIDER=${LLM_PROVIDER}" >&2
    exit 1
  fi

  local payload
  payload="$(
    jq -n \
      --arg model "${LLM_MODEL}" \
      --arg node "${NODE_ID}" \
      --arg role "${ROLE}" \
      --arg partners "${PARTNERS:-none}" \
      --arg player_ids "${PLAYER_IDS}" \
      --arg phase "${PHASE}" \
      --arg round "${ROUND}" \
      '{
        model: $model,
        temperature: 0.2,
        response_format: {type: "json_object"},
        messages: [
          {
            role: "system",
            content: "You are one Werewolf game agent. Return one JSON object only with action, target, public_text, and rationale."
          },
          {
            role: "user",
            content: ("Return JSON for this turn. agent=" + $node + " role=" + $role + " partners=" + $partners + " player_ids=" + $player_ids + " phase=" + $phase + " round=" + $round)
          }
        ]
      }'
  )"

  curl -fsS "${LLM_BASE_URL%/}/chat/completions" \
    -H "Authorization: Bearer ${LLM_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "${payload}" \
    | jq -r '.choices[0].message.content' \
    | jq -c '
        {
          action: (.action // "speak"),
          target: (.target // ""),
          public_text: (.public_text // ""),
          rationale: (.rationale // "No rationale returned.")
        }
      '
}

wait_for_pipe() {
  for _ in $(seq 1 100); do
    [[ -p "${ACTION_PIPE}" ]] && return 0
    sleep 0.1
  done
  echo "agent action pipe is not ready: ${ACTION_PIPE}" >&2
  exit 1
}

case "${LLM_PROVIDER}" in
  stub)
    turn_json="$(stub_turn_json)"
    ;;
  openai|openai-compatible)
    turn_json="$(openai_turn_json)"
    ;;
  *)
    echo "unsupported LLM_PROVIDER=${LLM_PROVIDER}" >&2
    exit 2
    ;;
esac

action="$(jq -r '.action' <<<"${turn_json}")"
target="$(jq -r '.target // ""' <<<"${turn_json}")"
public_text="$(jq -r '.public_text // ""' <<<"${turn_json}")"
rationale="$(jq -r '.rationale // ""' <<<"${turn_json}")"

if [[ "${action}" == "noop" ]]; then
  echo "[${NODE_ID}] no action for phase=${PHASE}"
  exit 0
fi

target_sql="NULL"
[[ -n "${target}" ]] && target_sql="$(sql_quote "${target}")"

public_sql="NULL"
[[ -n "${public_text}" ]] && public_sql="$(sql_quote "${public_text}")"

rationale_sql="$(sql_quote "${rationale}")"
action_sql="$(sql_quote "${action}")"
agent_sql="$(sql_quote "${NODE_ID}")"

wait_for_pipe

cat > "${ACTION_PIPE}" <<SQL
INSERT INTO intents (round, agent_id, action, target, rationale, public_text, decided_at)
VALUES (${ROUND}, ${agent_sql}, ${action_sql}, ${target_sql}, ${rationale_sql}, ${public_sql}, now());
SQL

echo "[${NODE_ID}] wrote ${action} for phase=${PHASE}"
