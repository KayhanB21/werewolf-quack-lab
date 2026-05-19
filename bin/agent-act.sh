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
        done: ((.done // false) == true),
        suspicions: (if (.suspicions // null) | type == "array" then .suspicions else [] end),
        knowledge: (if (.knowledge // null) | type == "array" then .knowledge else [] end)
      }
    ' <<<"${content}"
    return 0
  fi

  text_turn_json "${content}"
}

role_brief() {
  case "${ROLE}" in
    wolf)
      printf "You are a WOLF. Each night your wolf team chooses one player to eliminate. You want the village to fail to identify the wolves. Lie when useful; sound like a villager during the day."
      ;;
    seer)
      printf "You are the SEER. Each night you may investigate one player and learn whether they are a wolf. You want the village to win. Decide when to reveal your information: claiming Seer too early invites a wolf kill."
      ;;
    doctor)
      printf "You are the DOCTOR. Each night you may protect one player (including yourself) from the wolf's attack. You want the village to win."
      ;;
    *)
      printf "You are a VILLAGER. You have no special ability. You win by helping the village correctly lynch the wolves."
      ;;
  esac
}

openai_turn_json() {
  if [[ "${LLM_PROVIDER}" == "openai" && -z "${LLM_API_KEY}" ]]; then
    echo "LLM_API_KEY is required when LLM_PROVIDER=${LLM_PROVIDER}" >&2
    exit 1
  fi

  local wolf_channel="${WOLF_CHANNEL_JSON:-[]}"
  local context_json="${CONTEXT_JSON:-{\}}"
  local role_text
  role_text="$(role_brief)"
  local system_text
  system_text="You are ${NODE_ID}, one of the agents playing Werewolf.

${role_text}

Always respond with a single JSON object of this shape:
{
  \"rationale\": \"<short private reasoning, 1-2 sentences>\",
  \"public_text\": \"<what you say out loud this rotation, 1-2 sentences, always non-empty during day>\",
  \"done\": <true ONLY if you genuinely have nothing new to add after speaking at least once this round, otherwise false>,
  \"action\": \"wolf-kill|wolf-done|seer-investigate|doctor-save|speak|accuse|investigate|vote\",
  \"target\": \"<one of the living agent ids, or empty when no target>\",
  \"suspicions\": [{\"target\": \"<agent id>\", \"p_wolf\": <0..1>, \"reasoning\": \"<one sentence>\"}],
  \"knowledge\": [{\"source\": \"deduction|seer|claim|behavior\", \"content\": \"<one fact>\", \"confidence\": <0..1>}]
}

The suspicions and knowledge arrays are optional and private. Use them to log what you believe about other players this round. They will be persisted to your own private DuckDB and influence your future turns. Keep each array to at most four entries.

Action type by phase:
- day: action is speak, accuse, or investigate. target may be empty for speak; otherwise an alive non-self id. public_text must be present.
- vote: action=vote. target=an alive non-self id to lynch, OR target=\"\" (empty) to abstain. public_text optional.
- wolf (you are a wolf): action=wolf-kill with target=an alive non-partner non-self id; or action=wolf-done (or wolf-kill with done=true) to accept the wolf channel's current target as final. public_text must be empty.
- seer (you are the seer): action=seer-investigate, target=an alive non-self id, public_text must be empty.
- doctor (you are the doctor): action=doctor-save, target=any alive id including yourself, public_text must be empty.

The word JSON is required. Keep rationale honest and private. Keep public_text consistent with your bluff or claim. Never reveal that you are an LLM or break character."
  local payload
  payload="$(
    jq -n \
      --arg model "${LLM_MODEL}" \
      --arg system "${system_text}" \
      --arg node "${NODE_ID}" \
      --arg role "${ROLE}" \
      --arg partners "${PARTNERS:-none}" \
      --arg phase "${PHASE}" \
      --arg round "${ROUND}" \
      --arg wolf_channel "${wolf_channel}" \
      --arg context "${context_json}" \
      '{
        model: $model,
        temperature: 0.2,
        max_tokens: 260,
        response_format: {type: "json_object"},
        messages: [
          {
            role: "system",
            content: $system
          },
          {
            role: "user",
            content: ("Return JSON for this turn.\nagent=" + $node + "\nrole=" + $role + "\npartners=" + $partners + "\nphase=" + $phase + "\nround=" + $round + "\ncontext=" + $context + "\nwolf_channel=" + $wolf_channel)
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
      if [[ -z "${raw_target}" ]]; then
        target=""
        public_text="${raw_public_text:-${NODE_ID}: I abstain this round.}"
      else
        target="$(normalize_target "${raw_target}")"
        public_text="${raw_public_text}"
        if [[ -z "${public_text}" ]]; then
          public_text="$(fallback_public_text "${action}" "${target}")"
        fi
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

raw_turn_json="${turn_json}"
turn_json="$(normalize_turn_json "${turn_json}")"

clamp_unit() {
  awk -v v="$1" 'BEGIN{
    if (v+0 != v+0) {print "0.5"; exit}
    if (v+0 < 0) {print "0"; exit}
    if (v+0 > 1) {print "1"; exit}
    printf "%g", v+0
  }'
}

emit_suspicions_sql() {
  local raw="$1"
  local entries entry target p_wolf reasoning count=0
  entries="$(jq -c '(.suspicions // []) | if type == "array" then .[:4] else [] end | .[]' <<<"${raw}" 2>/dev/null || true)"
  [[ -z "${entries}" ]] && return 0
  while IFS= read -r entry; do
    [[ -z "${entry}" ]] && continue
    target="$(jq -r '.target // ""' <<<"${entry}" 2>/dev/null)"
    [[ -z "${target}" ]] && continue
    contains_csv "${target}" "${PLAYER_IDS}" || continue
    p_wolf="$(jq -r '(.p_wolf // 0.5) | tostring' <<<"${entry}" 2>/dev/null)"
    p_wolf="$(clamp_unit "${p_wolf}")"
    reasoning="$(jq -r '.reasoning // ""' <<<"${entry}" 2>/dev/null)"
    printf 'INSERT INTO suspicions (round, agent_id, target_agent, p_wolf, reasoning, updated_at) VALUES (%s, %s, %s, %s, %s, now());\n' \
      "${ROUND}" \
      "$(sql_quote "${NODE_ID}")" \
      "$(sql_quote "${target}")" \
      "${p_wolf}" \
      "$(sql_quote "${reasoning}")"
    count=$((count + 1))
  done <<<"${entries}"
}

emit_knowledge_sql() {
  local raw="$1"
  local entries entry source content confidence
  entries="$(jq -c '(.knowledge // []) | if type == "array" then .[:4] else [] end | .[]' <<<"${raw}" 2>/dev/null || true)"
  [[ -z "${entries}" ]] && return 0
  while IFS= read -r entry; do
    [[ -z "${entry}" ]] && continue
    content="$(jq -r '.content // ""' <<<"${entry}" 2>/dev/null)"
    [[ -z "${content}" ]] && continue
    source="$(jq -r '.source // "deduction"' <<<"${entry}" 2>/dev/null)"
    confidence="$(jq -r '(.confidence // 0.5) | tostring' <<<"${entry}" 2>/dev/null)"
    confidence="$(clamp_unit "${confidence}")"
    printf 'INSERT INTO knowledge (round, agent_id, source, content, confidence, created_at) VALUES (%s, %s, %s, %s, %s, now());\n' \
      "${ROUND}" \
      "$(sql_quote "${NODE_ID}")" \
      "$(sql_quote "${source}")" \
      "$(sql_quote "${content}")" \
      "${confidence}"
  done <<<"${entries}"
}

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

suspicions_sql="$(emit_suspicions_sql "${raw_turn_json}")"
knowledge_sql="$(emit_knowledge_sql "${raw_turn_json}")"

{
  cat <<SQL
INSERT INTO intents (round, agent_id, action, target, rationale, public_text, decided_at)
VALUES (${ROUND}, ${agent_sql}, ${action_sql}, ${target_sql}, ${rationale_sql}, ${public_sql}, now());
SQL
  [[ -n "${suspicions_sql}" ]] && printf "%s\n" "${suspicions_sql}"
  [[ -n "${knowledge_sql}" ]] && printf "%s\n" "${knowledge_sql}"
} > "${ACTION_PIPE}"

beliefs_marker="$(
  jq -c -n \
    --arg agent "${NODE_ID}" \
    --arg phase "${PHASE}" \
    --argjson round "${ROUND}" \
    --argjson suspicions "$(jq -c '(.suspicions // []) | if type == "array" then .[:4] else [] end' <<<"${raw_turn_json}" 2>/dev/null || printf '[]')" \
    --argjson knowledge "$(jq -c '(.knowledge // []) | if type == "array" then .[:4] else [] end' <<<"${raw_turn_json}" 2>/dev/null || printf '[]')" \
    '{agent: $agent, phase: $phase, round: $round, suspicions: $suspicions, knowledge: $knowledge}'
)"
printf "__BELIEFS__ %s\n" "${beliefs_marker}"

echo "[${NODE_ID}] wrote ${action} for phase=${PHASE}"
