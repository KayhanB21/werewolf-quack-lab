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
    "${ROOT_DIR}/container/agent-act.sh" --phase "${phase}" --round 2 >/dev/null

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
url=""
for arg in "$@"; do
  if [[ "${prev}" == "-d" && -n "${FAKE_CURL_PAYLOAD_PATH:-}" ]]; then
    printf "%s" "${arg}" > "${FAKE_CURL_PAYLOAD_PATH}"
  fi
  # capture the URL (first positional that looks like http*)
  if [[ -z "${url}" && "${arg}" == http* ]]; then
    url="${arg}"
  fi
  prev="${arg}"
done
if [[ "${url}" == *"/messages"* ]]; then
  # Anthropic-shaped response
  jq -n --arg content "${FAKE_TURN_CONTENT:?FAKE_TURN_CONTENT is required}" \
    '{content: [{type:"text", text: $content}], usage: {input_tokens: 420, output_tokens: 180}, stop_reason: "end_turn"}'
else
  # OpenAI-shaped response (default for openai|openai-compatible|omlx)
  jq -n --arg content "${FAKE_TURN_CONTENT:?FAKE_TURN_CONTENT is required}" \
    '{choices: [{message: {content: $content}}], usage: {prompt_tokens: 0, completion_tokens: 0}}'
fi
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
  "${ROOT_DIR}/container/agent-act.sh" --phase "seer" --round 2 >/dev/null &
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

marker_sql="${TMP_DIR}/marker.sql"
marker_pipe="${marker_sql}.fifo"
marker_stdout="${TMP_DIR}/marker.stdout"
mkfifo "${marker_pipe}"
cat "${marker_pipe}" > "${marker_sql}" &
marker_reader_pid="$!"

env \
  NODE_ID="agent-a" \
  ROLE="villager" \
  PARTNERS="" \
  PLAYER_IDS="agent-a,agent-b,agent-d" \
  LLM_PROVIDER="openai-compatible" \
  LLM_BASE_URL="http://fake-openai.local/v1" \
  FAKE_TURN_CONTENT='{"action":"speak","target":"","public_text":"hi.","rationale":"r.","suspicions":[{"target":"agent-b","p_wolf":0.4,"reasoning":"quiet"}],"knowledge":[{"source":"behavior","content":"b is quiet","confidence":0.5}]}' \
  CONTEXT_JSON='{}' \
  WOLF_CHANNEL_JSON='[]' \
  PATH="${fake_bin}:${PATH}" \
  ACTION_PIPE="${marker_pipe}" \
  "${ROOT_DIR}/container/agent-act.sh" --phase "day" --round 3 >"${marker_stdout}"

wait "${marker_reader_pid}"

if ! grep -Fq "__BELIEFS__" "${marker_stdout}"; then
  echo "agent-act should emit a __BELIEFS__ marker line to stdout" >&2
  cat "${marker_stdout}" >&2
  exit 1
fi

marker_line="$(grep -F "__BELIEFS__" "${marker_stdout}" | tail -n1)"
marker_json="${marker_line#*__BELIEFS__ }"

if ! jq -e '.agent == "agent-a" and .round == 3 and .phase == "day"' >/dev/null <<<"${marker_json}"; then
  echo "marker JSON should include agent, round, phase" >&2
  printf '%s\n' "${marker_json}" >&2
  exit 1
fi

if ! jq -e '.suspicions[0].target == "agent-b" and .knowledge[0].source == "behavior"' >/dev/null <<<"${marker_json}"; then
  echo "marker JSON should carry suspicions and knowledge payloads" >&2
  printf '%s\n' "${marker_json}" >&2
  exit 1
fi

if ! grep -Fq "__TURN_STATS__" "${marker_stdout}"; then
  echo "agent-act should emit a __TURN_STATS__ marker line to stdout" >&2
  cat "${marker_stdout}" >&2
  exit 1
fi

stats_line="$(grep -F "__TURN_STATS__" "${marker_stdout}" | tail -n1)"
stats_json="${stats_line#*__TURN_STATS__ }"

if ! jq -e '
  .agent == "agent-a"
  and .role == "villager"
  and .phase == "day"
  and .round == 3
  and .provider == "openai-compatible"
  and .parse_path == "object"
  and .valid_json == true
  and .action_in_phase == true
  and .normalized_action == "speak"
  and (.raw_target | type == "string")
  and (.normalized_target | type == "string")
  and (.target_overridden | type == "boolean")
  and .suspicions_count == 1
  and .knowledge_count == 1
  and (.tokens | type == "object")
  and (.latency_ms | type == "number")
  and (.reasoning_content == "")
' >/dev/null <<<"${stats_json}"; then
  echo "turn-stats marker JSON missing expected fields" >&2
  printf '%s\n' "${stats_json}" >&2
  exit 1
fi

stats_text_sql="${TMP_DIR}/stats-text.sql"
stats_text_pipe="${stats_text_sql}.fifo"
stats_text_stdout="${TMP_DIR}/stats-text.stdout"
mkfifo "${stats_text_pipe}"
cat "${stats_text_pipe}" > "${stats_text_sql}" &
stats_text_reader_pid="$!"

env \
  NODE_ID="agent-a" \
  ROLE="villager" \
  PARTNERS="" \
  PLAYER_IDS="agent-a,agent-b,agent-d" \
  LLM_PROVIDER="openai-compatible" \
  LLM_BASE_URL="http://fake-openai.local/v1" \
  FAKE_TURN_CONTENT='I think we should vote agent-b this round.' \
  CONTEXT_JSON='{}' \
  WOLF_CHANNEL_JSON='[]' \
  PATH="${fake_bin}:${PATH}" \
  ACTION_PIPE="${stats_text_pipe}" \
  "${ROOT_DIR}/container/agent-act.sh" --phase "day" --round 4 >"${stats_text_stdout}"

wait "${stats_text_reader_pid}"

stats_text_line="$(grep -F "__TURN_STATS__" "${stats_text_stdout}" | tail -n1)"
stats_text_json="${stats_text_line#*__TURN_STATS__ }"

if ! jq -e '.parse_path == "text" and .valid_json == false and .action_in_phase == true' >/dev/null <<<"${stats_text_json}"; then
  echo "prose-fallback turn-stats should record parse_path=text valid_json=false" >&2
  printf '%s\n' "${stats_text_json}" >&2
  exit 1
fi

stats_stub_sql="${TMP_DIR}/stats-stub.sql"
stats_stub_pipe="${stats_stub_sql}.fifo"
stats_stub_stdout="${TMP_DIR}/stats-stub.stdout"
mkfifo "${stats_stub_pipe}"
cat "${stats_stub_pipe}" > "${stats_stub_sql}" &
stats_stub_reader_pid="$!"

env \
  NODE_ID="agent-a" \
  ROLE="seer" \
  PARTNERS="" \
  PLAYER_IDS="agent-a,agent-b,agent-d" \
  LLM_PROVIDER="stub" \
  ACTION_PIPE="${stats_stub_pipe}" \
  "${ROOT_DIR}/container/agent-act.sh" --phase "seer" --round 2 >"${stats_stub_stdout}"

wait "${stats_stub_reader_pid}"

stats_stub_line="$(grep -F "__TURN_STATS__" "${stats_stub_stdout}" | tail -n1)"
stats_stub_json="${stats_stub_line#*__TURN_STATS__ }"

if ! jq -e '
  .provider == "stub"
  and .parse_path == "stub"
  and .normalized_action == "seer-investigate"
  and .action_in_phase == true
  and .tokens.prompt == 0
  and .tokens.completion == 0
' >/dev/null <<<"${stats_stub_json}"; then
  echo "stub provider turn-stats should record parse_path=stub and zero tokens" >&2
  printf '%s\n' "${stats_stub_json}" >&2
  exit 1
fi

stats_thinking_sql="${TMP_DIR}/stats-thinking.sql"
stats_thinking_pipe="${stats_thinking_sql}.fifo"
stats_thinking_stdout="${TMP_DIR}/stats-thinking.stdout"
thinking_payload="${TMP_DIR}/thinking.payload"
mkfifo "${stats_thinking_pipe}"
cat "${stats_thinking_pipe}" > "${stats_thinking_sql}" &
stats_thinking_reader_pid="$!"

env \
  NODE_ID="agent-a" \
  ROLE="villager" \
  PARTNERS="" \
  PLAYER_IDS="agent-a,agent-b,agent-d" \
  LLM_PROVIDER="omlx" \
  LLM_BASE_URL="http://fake-openai.local/v1" \
  LLM_THINKING_BUDGET="400" \
  LLM_TEMPERATURE="0.1" \
  LLM_MAX_TOKENS="600" \
  FAKE_TURN_CONTENT='{"action":"speak","target":"","public_text":"hi.","rationale":"r."}' \
  FAKE_CURL_PAYLOAD_PATH="${thinking_payload}" \
  CONTEXT_JSON='{}' \
  WOLF_CHANNEL_JSON='[]' \
  PATH="${fake_bin}:${PATH}" \
  ACTION_PIPE="${stats_thinking_pipe}" \
  "${ROOT_DIR}/container/agent-act.sh" --phase "day" --round 1 >"${stats_thinking_stdout}"

wait "${stats_thinking_reader_pid}"

if ! jq -e '.thinking_budget == 400 and .temperature == 0.1 and .max_tokens == 600' >/dev/null <<<"$(cat "${thinking_payload}")"; then
  echo "thinking_budget, temperature, max_tokens should be threaded into the payload" >&2
  cat "${thinking_payload}" >&2
  exit 1
fi

# === target override: model picks a dead/invalid target; shim retargets ===
# vote phase + raw target outside PLAYER_IDS forces normalize_target to pick
# a valid replacement, so the __TURN_STATS__ marker should carry
# target_overridden=true.
stats_override_sql="${TMP_DIR}/stats-override.sql"
stats_override_pipe="${stats_override_sql}.fifo"
stats_override_stdout="${TMP_DIR}/stats-override.stdout"
mkfifo "${stats_override_pipe}"
cat "${stats_override_pipe}" > "${stats_override_sql}" &
stats_override_reader_pid="$!"

env \
  NODE_ID="agent-a" \
  ROLE="villager" \
  PARTNERS="" \
  PLAYER_IDS="agent-a,agent-b,agent-d" \
  LLM_PROVIDER="openai-compatible" \
  LLM_BASE_URL="http://fake-openai.local/v1" \
  FAKE_TURN_CONTENT='{"action":"vote","target":"ghost-player","public_text":"voting","rationale":"r"}' \
  CONTEXT_JSON='{}' \
  WOLF_CHANNEL_JSON='[]' \
  PATH="${fake_bin}:${PATH}" \
  ACTION_PIPE="${stats_override_pipe}" \
  "${ROOT_DIR}/container/agent-act.sh" --phase "vote" --round 1 >"${stats_override_stdout}"

wait "${stats_override_reader_pid}"

stats_override_line="$(grep -F "__TURN_STATS__" "${stats_override_stdout}" | tail -n1)"
stats_override_json="${stats_override_line#*__TURN_STATS__ }"

if ! jq -e '
  .raw_target == "ghost-player"
  and .normalized_target != "ghost-player"
  and .normalized_target != ""
  and .target_overridden == true
  and .normalized_action == "vote"
' >/dev/null <<<"${stats_override_json}"; then
  echo "expected target_overridden=true when raw_target is not in PLAYER_IDS" >&2
  printf '%s\n' "${stats_override_json}" >&2
  exit 1
fi

# === target NOT overridden: model picks a valid target ===
stats_clean_sql="${TMP_DIR}/stats-clean.sql"
stats_clean_pipe="${stats_clean_sql}.fifo"
stats_clean_stdout="${TMP_DIR}/stats-clean.stdout"
mkfifo "${stats_clean_pipe}"
cat "${stats_clean_pipe}" > "${stats_clean_sql}" &
stats_clean_reader_pid="$!"

env \
  NODE_ID="agent-a" \
  ROLE="villager" \
  PARTNERS="" \
  PLAYER_IDS="agent-a,agent-b,agent-d" \
  LLM_PROVIDER="openai-compatible" \
  LLM_BASE_URL="http://fake-openai.local/v1" \
  FAKE_TURN_CONTENT='{"action":"vote","target":"agent-b","public_text":"voting agent-b","rationale":"r"}' \
  CONTEXT_JSON='{}' \
  WOLF_CHANNEL_JSON='[]' \
  PATH="${fake_bin}:${PATH}" \
  ACTION_PIPE="${stats_clean_pipe}" \
  "${ROOT_DIR}/container/agent-act.sh" --phase "vote" --round 1 >"${stats_clean_stdout}"

wait "${stats_clean_reader_pid}"

stats_clean_line="$(grep -F "__TURN_STATS__" "${stats_clean_stdout}" | tail -n1)"
stats_clean_json="${stats_clean_line#*__TURN_STATS__ }"

if ! jq -e '
  .raw_target == "agent-b"
  and .normalized_target == "agent-b"
  and .target_overridden == false
' >/dev/null <<<"${stats_clean_json}"; then
  echo "expected target_overridden=false when raw_target is valid" >&2
  printf '%s\n' "${stats_clean_json}" >&2
  exit 1
fi

# === Anthropic provider: payload shape, response parsing, prompt cache control ===
anthropic_sql="${TMP_DIR}/anthropic.sql"
anthropic_pipe="${anthropic_sql}.fifo"
anthropic_stdout="${TMP_DIR}/anthropic.stdout"
anthropic_payload="${TMP_DIR}/anthropic.payload"
mkfifo "${anthropic_pipe}"
cat "${anthropic_pipe}" > "${anthropic_sql}" &
anthropic_reader_pid="$!"

env \
  NODE_ID="agent-a" \
  ROLE="villager" \
  PARTNERS="" \
  PLAYER_IDS="agent-a,agent-b,agent-d" \
  LLM_PROVIDER="anthropic" \
  LLM_BASE_URL="https://api.anthropic.test" \
  LLM_API_KEY="fake-anthropic-key" \
  LLM_MAX_TOKENS="500" \
  LLM_TEMPERATURE="0.3" \
  FAKE_TURN_CONTENT='{"action":"speak","target":"","public_text":"Hello team.","rationale":"open with a neutral statement"}' \
  FAKE_CURL_PAYLOAD_PATH="${anthropic_payload}" \
  CONTEXT_JSON='{}' \
  WOLF_CHANNEL_JSON='[]' \
  PATH="${fake_bin}:${PATH}" \
  ACTION_PIPE="${anthropic_pipe}" \
  "${ROOT_DIR}/container/agent-act.sh" --phase "day" --round 1 >"${anthropic_stdout}"

wait "${anthropic_reader_pid}"

# 1. payload must use Anthropic shape: top-level `system`, no `response_format`.
if ! jq -e '
  .model == "claude-test"
  or .system != null
' >/dev/null <<<"$(cat "${anthropic_payload}")"; then
  echo "Anthropic payload must include top-level system" >&2
  cat "${anthropic_payload}" >&2
  exit 1
fi

if ! jq -e '
  (.system | type == "array")
  and (.system[0].type == "text")
  and (.system[0].cache_control.type == "ephemeral")
  and (.messages | length == 1)
  and (.messages[0].role == "user")
  and (.response_format // null) == null
  and (.max_tokens == 500)
  and (.temperature == 0.3)
' >/dev/null <<<"$(cat "${anthropic_payload}")"; then
  echo "Anthropic payload shape is wrong" >&2
  cat "${anthropic_payload}" >&2
  exit 1
fi

# 2. SQL was written with the model's content
if ! grep -Fq "Hello team." "${anthropic_sql}"; then
  echo "Anthropic content did not reach the FIFO" >&2
  cat "${anthropic_sql}" >&2
  exit 1
fi

# 3. turn-stats marker should record provider=anthropic and token usage
anthropic_stats_line="$(grep -F "__TURN_STATS__" "${anthropic_stdout}" | tail -n1)"
anthropic_stats_json="${anthropic_stats_line#*__TURN_STATS__ }"
if ! jq -e '
  .provider == "anthropic"
  and .tokens.prompt == 420
  and .tokens.completion == 180
  and .valid_json == true
  and .finish_reason == "end_turn"
' >/dev/null <<<"${anthropic_stats_json}"; then
  echo "Anthropic turn-stats marker is wrong" >&2
  printf '%s\n' "${anthropic_stats_json}" >&2
  exit 1
fi

# 4. Missing API key must hard-fail (no silent fallback)
if env \
    NODE_ID="agent-a" \
    ROLE="villager" \
    PARTNERS="" \
    PLAYER_IDS="agent-a,agent-b" \
    LLM_PROVIDER="anthropic" \
    LLM_BASE_URL="https://api.anthropic.test" \
    LLM_API_KEY="" \
    FAKE_TURN_CONTENT='{"action":"speak"}' \
    CONTEXT_JSON='{}' \
    WOLF_CHANNEL_JSON='[]' \
    PATH="${fake_bin}:${PATH}" \
    ACTION_PIPE="/dev/null" \
    "${ROOT_DIR}/container/agent-act.sh" --phase "day" --round 1 2>/dev/null; then
  echo "anthropic provider should fail without LLM_API_KEY" >&2
  exit 1
fi

echo "ok - agent action writer emits local DuckDB intents"
