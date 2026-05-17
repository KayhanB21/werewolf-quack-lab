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
LLM_TIMEOUT_SECONDS="${LLM_TIMEOUT_SECONDS:-60}"
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
  local allow_self="false"
  [[ "${PHASE}" == "doctor" ]] && allow_self="true"
  IFS="," read -r -a ids <<< "${PLAYER_IDS}"
  for id in "${ids[@]}"; do
    id="${id// /}"
    [[ -z "${id}" ]] && continue
    if [[ "${allow_self}" != "true" && "${id}" == "${NODE_ID}" ]]; then
      continue
    fi
    if [[ "${ROLE}" == "wolf" ]] && contains_csv "${id}" "${PARTNERS}"; then
      continue
    fi
    printf "%s" "${id}"
    return 0
  done
  printf "%s" "${NODE_ID}"
}

target_is_valid() {
  local candidate="$1"
  [[ -n "${candidate}" ]] || return 1
  contains_csv "${candidate}" "${PLAYER_IDS}" || return 1
  if [[ "${PHASE}" != "doctor" && "${candidate}" == "${NODE_ID}" ]]; then
    return 1
  fi
  if [[ "${PHASE}" == "wolf" && "${ROLE}" == "wolf" ]] && contains_csv "${candidate}" "${PARTNERS}"; then
    return 1
  fi
  return 0
}

normalize_target() {
  local candidate="$1"
  if target_is_valid "${candidate}"; then
    printf "%s" "${candidate}"
    return 0
  fi
  pick_target
}

fallback_public_text() {
  local action="$1"
  local target="$2"

  case "${action}" in
    accuse)
      printf "%s: I suspect %s." "${NODE_ID}" "${target}"
      ;;
    investigate)
      printf "%s: I am checking %s." "${NODE_ID}" "${target}"
      ;;
    vote)
      printf "%s: I vote %s." "${NODE_ID}" "${target}"
      ;;
    *)
      printf "%s: I am checking the public record in round %s." "${NODE_ID}" "${ROUND}"
      ;;
  esac
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
    seer)
      if [[ "${ROLE}" != "seer" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a seer"}'
        return 0
      fi
      jq -n \
        --arg action "seer-investigate" \
        --arg target "${target}" \
        --arg public_text "" \
        --arg rationale "Stub seer ${NODE_ID} investigates ${target}." \
        '{action: $action, target: $target, public_text: $public_text, rationale: $rationale}'
      ;;
    doctor)
      if [[ "${ROLE}" != "doctor" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a doctor"}'
        return 0
      fi
      jq -n \
        --arg action "doctor-save" \
        --arg target "${NODE_ID}" \
        --arg public_text "" \
        --arg rationale "Stub doctor ${NODE_ID} saves self." \
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

target_from_text() {
  local content="$1"
  local id

  IFS="," read -r -a ids <<< "${PLAYER_IDS}"
  for id in "${ids[@]}"; do
    id="${id// /}"
    [[ -z "${id}" || "${id}" == "${NODE_ID}" ]] && continue
    if [[ "${ROLE}" == "wolf" ]] && contains_csv "${id}" "${PARTNERS}"; then
      continue
    fi
    if [[ "${content}" == *"${id}"* ]]; then
      printf "%s" "${id}"
      return 0
    fi
  done

  pick_target
}

text_turn_json() {
  local content="$1"
  local lower action target public_text rationale
  lower="$(tr '[:upper:]' '[:lower:]' <<<"${content}")"

  case "${PHASE}" in
    wolf)
      if [[ "${ROLE}" != "wolf" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a wolf"}'
        return 0
      fi
      action="wolf-kill"
      target="$(target_from_text "${content}")"
      public_text=""
      ;;
    seer)
      if [[ "${ROLE}" != "seer" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a seer"}'
        return 0
      fi
      action="seer-investigate"
      target="$(target_from_text "${content}")"
      public_text=""
      ;;
    doctor)
      if [[ "${ROLE}" != "doctor" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a doctor"}'
        return 0
      fi
      action="doctor-save"
      target="$(target_from_text "${content}")"
      if [[ -z "${target}" || "${target}" == "${NODE_ID}" ]]; then
        target="${NODE_ID}"
      fi
      public_text=""
      ;;
    day)
      if [[ "${lower}" == *"vote"* || "${lower}" == *"accuse"* || "${lower}" == *"suspect"* ]]; then
        action="accuse"
      elif [[ "${lower}" == *"investigate"* || "${lower}" == *"check"* ]]; then
        action="investigate"
      else
        action="speak"
      fi

      target=""
      if [[ "${action}" != "speak" ]]; then
        target="$(target_from_text "${content}")"
      fi
      public_text="$(fallback_public_text "${action}" "${target}")"
      ;;
    vote)
      action="vote"
      target="$(target_from_text "${content}")"
      public_text="$(fallback_public_text "${action}" "${target}")"
      ;;
    *)
      echo "unsupported phase: ${PHASE}" >&2
      exit 2
      ;;
  esac

  rationale="Model returned prose instead of JSON; normalized a safe ${action} turn."
  jq -n \
    --arg action "${action}" \
    --arg target "${target}" \
    --arg public_text "${public_text}" \
    --arg rationale "${rationale}" \
    '{action: $action, target: $target, public_text: $public_text, rationale: $rationale}'
}

model_content_turn_json() {
  local content="$1"

  if jq -e 'type == "object"' >/dev/null 2>&1 <<<"${content}"; then
    jq -c '
      {
        action: (.action // "speak"),
        target: (.target // ""),
        public_text: (.public_text // ""),
        rationale: (.rationale // "No rationale returned."),
        done: ((.done // false) == true)
      }
    ' <<<"${content}"
    return 0
  fi

  text_turn_json "${content}"
}

openai_turn_json() {
  if [[ "${LLM_PROVIDER}" == "openai" && -z "${LLM_API_KEY}" ]]; then
    echo "LLM_API_KEY is required when LLM_PROVIDER=${LLM_PROVIDER}" >&2
    exit 1
  fi

  local wolf_channel="${WOLF_CHANNEL_JSON:-[]}"
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
      --arg wolf_channel "${wolf_channel}" \
      '{
        model: $model,
        temperature: 0.2,
        max_tokens: 220,
        response_format: {type: "json_object"},
        messages: [
          {
            role: "system",
            content: "You are one Werewolf game agent. Return one JSON object only with action, target, public_text, rationale, and (for wolves) an optional boolean done. The word JSON is required. In day phase, this is public discussion only: use speak, accuse, or investigate, and do not vote. In vote phase, use vote. In wolf phase, choose a non-partner non-self alive target and keep public_text empty: emit action=wolf-kill to propose this target, or action=wolf-kill with done=true (or action=wolf-done) when you accept the channel consensus as final. In seer phase, use seer-investigate, choose an alive non-self target, and keep public_text empty. In doctor phase, use doctor-save, choose any alive target including yourself, and keep public_text empty. Make public_text a short natural sentence from this agent only when the phase allows public speech."
          },
          {
            role: "user",
            content: ("Return JSON for this turn. agent=" + $node + " role=" + $role + " partners=" + $partners + " player_ids=" + $player_ids + " phase=" + $phase + " round=" + $round + " wolf_channel=" + $wolf_channel)
          }
        ]
      }'
  )"

  curl_args=(
    --max-time "${LLM_TIMEOUT_SECONDS}"
    -fsS "${LLM_BASE_URL%/}/chat/completions"
    -H "Content-Type: application/json"
    -d "${payload}"
  )
  if [[ -n "${LLM_API_KEY}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${LLM_API_KEY}")
  fi

  local response content
  response="$(curl "${curl_args[@]}")"
  content="$(jq -r '.choices[0].message.content // empty' <<<"${response}")"
  model_content_turn_json "${content}"
}

normalize_turn_json() {
  local raw_json="$1"
  local raw_action raw_target raw_public_text raw_rationale raw_public_lower
  local action target public_text rationale

  raw_action="$(jq -r '.action // "" | ascii_downcase | gsub("_"; "-")' <<<"${raw_json}")"
  raw_target="$(jq -r '.target // ""' <<<"${raw_json}")"
  raw_public_text="$(jq -r '.public_text // ""' <<<"${raw_json}")"
  raw_public_lower="$(tr '[:upper:]' '[:lower:]' <<<"${raw_public_text}")"
  raw_rationale="$(jq -r '.rationale // ""' <<<"${raw_json}")"

  case "${PHASE}" in
    day)
      case "${raw_action}" in
        speak|accuse|investigate)
          action="${raw_action}"
          ;;
        vote)
          action="accuse"
          ;;
        *)
          action="speak"
          ;;
      esac

      if [[ "${action}" == "speak" ]]; then
        target=""
      else
        target="$(normalize_target "${raw_target}")"
      fi

      public_text="${raw_public_text}"
      if [[ "${raw_action}" == "vote" || "${raw_public_lower}" == *"vote"* ]]; then
        public_text=""
      fi
      if [[ -z "${public_text}" ]]; then
        public_text="$(fallback_public_text "${action}" "${target}")"
      fi
      rationale="${raw_rationale:-No rationale returned.}"
      ;;
    wolf)
      if [[ "${ROLE}" != "wolf" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a wolf"}'
        return 0
      fi

      local raw_done
      raw_done="$(jq -r '(.done // false) | tostring' <<<"${raw_json}")"
      target="$(normalize_target "${raw_target}")"
      if [[ "${raw_done}" == "true" || "${raw_action}" == "wolf-done" ]]; then
        action="wolf-done"
      else
        action="wolf-kill"
      fi
      public_text=""
      rationale="${raw_rationale:-Wolf phase private action.}"
      ;;
    seer)
      if [[ "${ROLE}" != "seer" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a seer"}'
        return 0
      fi

      action="seer-investigate"
      target="$(normalize_target "${raw_target}")"
      public_text=""
      rationale="${raw_rationale:-Seer phase private action.}"
      ;;
    doctor)
      if [[ "${ROLE}" != "doctor" ]]; then
        jq -n --arg action "noop" '{action: $action, target: "", public_text: "", rationale: "not a doctor"}'
        return 0
      fi

      action="doctor-save"
      if target_is_valid "${raw_target}"; then
        target="${raw_target}"
      else
        target="${NODE_ID}"
      fi
      public_text=""
      rationale="${raw_rationale:-Doctor phase private action.}"
      ;;
    vote)
      action="vote"
      target="$(normalize_target "${raw_target}")"
      public_text="${raw_public_text}"
      if [[ -z "${public_text}" ]]; then
        public_text="$(fallback_public_text "${action}" "${target}")"
      fi
      rationale="${raw_rationale:-No rationale returned.}"
      ;;
    *)
      echo "unsupported phase: ${PHASE}" >&2
      exit 2
      ;;
  esac

  jq -n \
    --arg action "${action}" \
    --arg target "${target}" \
    --arg public_text "${public_text}" \
    --arg rationale "${rationale}" \
    '{action: $action, target: $target, public_text: $public_text, rationale: $rationale}'
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
  openai|openai-compatible|omlx)
    turn_json="$(openai_turn_json)"
    ;;
  *)
    echo "unsupported LLM_PROVIDER=${LLM_PROVIDER}" >&2
    exit 2
    ;;
esac

turn_json="$(normalize_turn_json "${turn_json}")"

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
