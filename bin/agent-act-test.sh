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
  local provider="${5:-stub}"
  local fake_content="${6:-}"
  local test_path="${7:-${PATH}}"
  local pipe_path="${out_file}.fifo"

  mkfifo "${pipe_path}"
  cat "${pipe_path}" > "${out_file}" &
  local reader_pid="$!"

  env \
    NODE_ID="agent-a" \
    ROLE="${role}" \
    PARTNERS="${partners}" \
    PLAYER_IDS="agent-a,agent-b,agent-d" \
    LLM_PROVIDER="${provider}" \
    LLM_BASE_URL="http://fake-openai.local/v1" \
    FAKE_TURN_CONTENT="${fake_content}" \
    FAKE_CURL_PAYLOAD_PATH="${FAKE_CURL_PAYLOAD_PATH:-}" \
    CONTEXT_JSON="${CONTEXT_JSON:-{\}}" \
    WOLF_CHANNEL_JSON="${WOLF_CHANNEL_JSON:-[]}" \
    PATH="${test_path}" \
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

fake_bin="${TMP_DIR}/bin"
mkdir -p "${fake_bin}"
cat > "${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
prev=""
for arg in "$@"; do
  if [[ "${prev}" == "-d" && -n "${FAKE_CURL_PAYLOAD_PATH:-}" ]]; then
    printf "%s" "${arg}" > "${FAKE_CURL_PAYLOAD_PATH}"
  fi
  prev="${arg}"
done
jq -n --arg content "${FAKE_TURN_CONTENT:?FAKE_TURN_CONTENT is required}" \
  '{choices: [{message: {content: $content}}]}'
SH
chmod +x "${fake_bin}/curl"

model_wolf_sql="${TMP_DIR}/model-wolf.sql"
run_action \
  "wolf" \
  "wolf" \
  "agent-d" \
  "${model_wolf_sql}" \
  "openai-compatible" \
  '{"action":"kill","target":"agent-d","public_text":"Agent D is safe because they are with me.","rationale":"The model leaked a private wolf plan."}' \
  "${fake_bin}:${PATH}"

if ! grep -Fq "'wolf-kill'" "${model_wolf_sql}"; then
  echo "model wolf action should normalize to wolf-kill" >&2
  exit 1
fi

if ! grep -Fq "'agent-b'" "${model_wolf_sql}"; then
  echo "model wolf action should retarget away from self and partners" >&2
  exit 1
fi

if grep -Fq "Agent D is safe" "${model_wolf_sql}"; then
  echo "model wolf action should not write public_text" >&2
  exit 1
fi

model_prose_sql="${TMP_DIR}/model-prose.sql"
run_action \
  "day" \
  "villager" \
  "" \
  "${model_prose_sql}" \
  "openai-compatible" \
  "I think agent-b is suspicious, so I will vote agent-b this round." \
  "${fake_bin}:${PATH}"

if ! grep -Fq "'accuse'" "${model_prose_sql}"; then
  echo "model discussion prose should normalize vote language to accuse" >&2
  exit 1
fi

if ! grep -Fq "'agent-b'" "${model_prose_sql}"; then
  echo "model prose response should preserve an eligible target" >&2
  exit 1
fi

seer_sql="${TMP_DIR}/seer.sql"
run_action "seer" "seer" "" "${seer_sql}"

if ! grep -Fq "'seer-investigate', 'agent-b'" "${seer_sql}"; then
  echo "seer stub action should investigate agent-b as the first non-self alive player" >&2
  cat "${seer_sql}" >&2
  exit 1
fi

if grep -Fq "'seer-investigate', 'agent-a'" "${seer_sql}"; then
  echo "seer stub action must not investigate self" >&2
  exit 1
fi

seer_wrong_role_sql="${TMP_DIR}/seer-wrong-role.sql"
mkfifo "${seer_wrong_role_sql}.fifo"
cat "${seer_wrong_role_sql}.fifo" > "${seer_wrong_role_sql}" &
seer_reader_pid="$!"
env \
  NODE_ID="agent-a" \
  ROLE="villager" \
  PARTNERS="" \
  PLAYER_IDS="agent-a,agent-b,agent-d" \
  LLM_PROVIDER="stub" \
  ACTION_PIPE="${seer_wrong_role_sql}.fifo" \
  "${ROOT_DIR}/bin/agent-act.sh" --phase "seer" --round 2 >/dev/null &
agent_pid="$!"
sleep 0.5
if kill -0 "${agent_pid}" 2>/dev/null; then
  echo "non-seer seer phase should exit immediately without writing to the pipe" >&2
  kill "${agent_pid}" "${seer_reader_pid}" 2>/dev/null || true
  exit 1
fi
wait "${agent_pid}" || true
kill "${seer_reader_pid}" 2>/dev/null || true
wait "${seer_reader_pid}" 2>/dev/null || true

if [[ -s "${seer_wrong_role_sql}" ]]; then
  echo "non-seer seer phase should not write any SQL" >&2
  exit 1
fi

doctor_sql="${TMP_DIR}/doctor.sql"
run_action "doctor" "doctor" "" "${doctor_sql}"

if ! grep -Fq "'doctor-save', 'agent-a'" "${doctor_sql}"; then
  echo "doctor stub action should default to self-save (target=agent-a)" >&2
  cat "${doctor_sql}" >&2
  exit 1
fi

model_doctor_sql="${TMP_DIR}/model-doctor.sql"
run_action \
  "doctor" \
  "doctor" \
  "" \
  "${model_doctor_sql}" \
  "openai-compatible" \
  '{"action":"doctor-save","target":"agent-b","public_text":"I will save agent-b tonight.","rationale":"Doctor thinks agent-b is at risk."}' \
  "${fake_bin}:${PATH}"

if ! grep -Fq "'doctor-save', 'agent-b'" "${model_doctor_sql}"; then
  echo "model doctor action should save agent-b" >&2
  cat "${model_doctor_sql}" >&2
  exit 1
fi

if grep -Fq "I will save agent-b tonight." "${model_doctor_sql}"; then
  echo "doctor action must not leak public_text" >&2
  exit 1
fi

model_seer_sql="${TMP_DIR}/model-seer.sql"
run_action \
  "seer" \
  "seer" \
  "" \
  "${model_seer_sql}" \
  "openai-compatible" \
  '{"action":"seer-investigate","target":"agent-a","public_text":"I will check myself.","rationale":"Confused seer wants to self-check."}' \
  "${fake_bin}:${PATH}"

if ! grep -Fq "'seer-investigate'" "${model_seer_sql}"; then
  echo "model seer action should produce a seer-investigate intent" >&2
  cat "${model_seer_sql}" >&2
  exit 1
fi

if grep -Fq "'seer-investigate', 'agent-a'" "${model_seer_sql}"; then
  echo "model seer action must reject self-investigation" >&2
  cat "${model_seer_sql}" >&2
  exit 1
fi

if grep -Fq "I will check myself" "${model_seer_sql}"; then
  echo "seer action must not leak public_text" >&2
  exit 1
fi

model_wolf_done_sql="${TMP_DIR}/model-wolf-done.sql"
run_action \
  "wolf" \
  "wolf" \
  "agent-d" \
  "${model_wolf_done_sql}" \
  "openai-compatible" \
  '{"action":"wolf-kill","target":"agent-b","public_text":"","rationale":"agreeing","done":true}' \
  "${fake_bin}:${PATH}"

if ! grep -Fq "'wolf-done', 'agent-b'" "${model_wolf_done_sql}"; then
  echo "wolf turn with done=true should normalize to a wolf-done action" >&2
  cat "${model_wolf_done_sql}" >&2
  exit 1
fi

context_payload_path="${TMP_DIR}/context-payload.json"
context_sql="${TMP_DIR}/context.sql"
CONTEXT_JSON='{"round":2,"phase":"day-discuss","you":"agent-a","alive":["agent-a","agent-b","agent-d"],"eliminated":[{"id":"agent-c","role":"villager","round":1,"cause":"wolf-kill"}],"public_events":["Round 1: agent-c was killed by wolves. Revealed role: villager."],"public_log":[{"round":1,"speaker":"agent-b","action":"speak","target":"","text":"I trust agent-a"}],"private_notes":["Round 1: agent-d is wolf."]}' \
FAKE_CURL_PAYLOAD_PATH="${context_payload_path}" \
run_action \
  "day" \
  "seer" \
  "" \
  "${context_sql}" \
  "openai-compatible" \
  '{"action":"accuse","target":"agent-d","public_text":"I have evidence agent-d is a wolf.","rationale":"Reveal seer claim now."}' \
  "${fake_bin}:${PATH}"

if [[ ! -s "${context_payload_path}" ]]; then
  echo "fake curl did not capture the OpenAI payload" >&2
  exit 1
fi

if ! jq -e '.messages[1].content | contains("context=")' >/dev/null <"${context_payload_path}"; then
  echo "OpenAI user message should embed context=<json>" >&2
  cat "${context_payload_path}" >&2
  exit 1
fi

if ! jq -e '.messages[1].content | contains("Revealed role: villager")' >/dev/null <"${context_payload_path}"; then
  echo "OpenAI user message should include the public events from CONTEXT_JSON" >&2
  cat "${context_payload_path}" >&2
  exit 1
fi

if ! jq -e '.messages[1].content | contains("agent-d is wolf")' >/dev/null <"${context_payload_path}"; then
  echo "OpenAI user message should include the agent's private notes" >&2
  cat "${context_payload_path}" >&2
  exit 1
fi

if ! jq -e '.messages[0].content | test("You are the SEER")' >/dev/null <"${context_payload_path}"; then
  echo "OpenAI system prompt should include the role brief for the seer" >&2
  cat "${context_payload_path}" >&2
  exit 1
fi

abstain_sql="${TMP_DIR}/abstain.sql"
run_action \
  "vote" \
  "villager" \
  "" \
  "${abstain_sql}" \
  "openai-compatible" \
  '{"action":"vote","target":"","public_text":"","rationale":"I do not have enough information to vote."}' \
  "${fake_bin}:${PATH}"

if ! grep -Fq "'vote', NULL" "${abstain_sql}"; then
  echo "vote with empty target should insert target=NULL (abstain)" >&2
  cat "${abstain_sql}" >&2
  exit 1
fi

if ! grep -Fq "I abstain this round" "${abstain_sql}"; then
  echo "abstain should have a default public_text noting the abstention" >&2
  cat "${abstain_sql}" >&2
  exit 1
fi

suspicions_sql="${TMP_DIR}/suspicions.sql"
run_action \
  "day" \
  "villager" \
  "" \
  "${suspicions_sql}" \
  "openai-compatible" \
  '{"action":"speak","target":"","public_text":"agent-b is acting strange.","rationale":"Reading the room.","suspicions":[{"target":"agent-b","p_wolf":0.7,"reasoning":"Dodged questions."},{"target":"agent-d","p_wolf":0.3,"reasoning":"Helpful tone."},{"target":"not-a-player","p_wolf":0.9,"reasoning":"Should be filtered."}],"knowledge":[{"source":"behavior","content":"agent-b avoided eye contact metaphorically.","confidence":0.6}]}' \
  "${fake_bin}:${PATH}"

if ! grep -Fq "INSERT INTO suspicions" "${suspicions_sql}"; then
  echo "agent should emit suspicion INSERTs when the model returns suspicions" >&2
  cat "${suspicions_sql}" >&2
  exit 1
fi

if ! grep -Fq "'agent-b', 0.7" "${suspicions_sql}"; then
  echo "suspicion row should carry target=agent-b and p_wolf=0.7" >&2
  cat "${suspicions_sql}" >&2
  exit 1
fi

if grep -Fq "not-a-player" "${suspicions_sql}"; then
  echo "suspicions targeting non-players should be filtered out" >&2
  cat "${suspicions_sql}" >&2
  exit 1
fi

if ! grep -Fq "INSERT INTO knowledge" "${suspicions_sql}"; then
  echo "agent should emit knowledge INSERTs when the model returns knowledge" >&2
  cat "${suspicions_sql}" >&2
  exit 1
fi

if ! grep -Fq "'behavior'" "${suspicions_sql}"; then
  echo "knowledge row should carry source=behavior" >&2
  cat "${suspicions_sql}" >&2
  exit 1
fi

no_suspicions_sql="${TMP_DIR}/no-suspicions.sql"
run_action \
  "day" \
  "villager" \
  "" \
  "${no_suspicions_sql}" \
  "openai-compatible" \
  '{"action":"speak","target":"","public_text":"hello.","rationale":"nothing yet."}' \
  "${fake_bin}:${PATH}"

if grep -Fq "INSERT INTO suspicions" "${no_suspicions_sql}"; then
  echo "agent should not emit suspicion INSERTs when none are returned" >&2
  cat "${no_suspicions_sql}" >&2
  exit 1
fi

if grep -Fq "INSERT INTO knowledge" "${no_suspicions_sql}"; then
  echo "agent should not emit knowledge INSERTs when none are returned" >&2
  cat "${no_suspicions_sql}" >&2
  exit 1
fi

echo "ok - agent action writer emits local DuckDB intents"
