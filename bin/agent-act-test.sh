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

echo "ok - agent action writer emits local DuckDB intents"
