#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

HOST_OMLX_BASE_URL="${HOST_OMLX_BASE_URL:-http://localhost:8000/v1}"
CONTAINER_OMLX_BASE_URL="${CONTAINER_OMLX_BASE_URL:-http://host.docker.internal:8000/v1}"
OMLX_API_KEY="${OMLX_API_KEY:-${LLM_API_KEY:-}}"

models_file="${TMP_DIR}/models.json"
curl_args=(
  -sS
  -o "${models_file}"
  -w "%{http_code}"
  "${HOST_OMLX_BASE_URL%/}/models"
)
if [[ -n "${OMLX_API_KEY}" ]]; then
  curl_args+=(-H "Authorization: Bearer ${OMLX_API_KEY}")
fi

models_status="$(curl "${curl_args[@]}" 2>/dev/null || true)"

case "${models_status}" in
  200)
    models_json="$(cat "${models_file}")"
    ;;
  401|403)
    cat >&2 <<EOF
OMLX server rejected /models with HTTP ${models_status}.
Set OMLX_API_KEY or LLM_API_KEY if your oMLX server has API key authentication enabled.
EOF
    exit 1
    ;;
  *)
    cat >&2 <<EOF
OMLX server is not reachable at ${HOST_OMLX_BASE_URL}.
Start oMLX first, for example:

  brew services start omlx

or:

  omlx serve --model-dir ~/models

Then rerun:

  ./bin/omlx-smoke-test.sh
EOF
    exit 1
    ;;
esac

model="${OMLX_MODEL:-$(jq -r '.data[0].id // empty' <<<"${models_json}")}"
if [[ -z "${model}" ]]; then
  echo "OMLX server responded, but /models did not return a model id. Download or load a model first." >&2
  exit 1
fi

config_path="${TMP_DIR}/game.omlx-smoke.json"
jq -n \
  --arg provider "omlx" \
  --arg model "${model}" \
  --arg base_url "${CONTAINER_OMLX_BASE_URL%/}" \
  '{
    game_id: "werewolf-quack-omlx-smoke",
    players: [
      {id: "agent-a", role: "wolf"},
      {id: "agent-b", role: "villager"},
      {id: "agent-c", role: "seer"}
    ],
    model: {
      provider: $provider,
      model: $model,
      base_url: $base_url
    }
  }' > "${config_path}"

echo "Using OMLX model: ${model}"
echo "Host OMLX API: ${HOST_OMLX_BASE_URL%/}"
echo "Container OMLX API: ${CONTAINER_OMLX_BASE_URL%/}"

CONFIG_PATH="${config_path}" \
LLM_PROVIDER="omlx" \
LLM_MODEL="${model}" \
LLM_BASE_URL="${CONTAINER_OMLX_BASE_URL%/}" \
LLM_API_KEY="${OMLX_API_KEY}" \
"${ROOT_DIR}/bin/labctl" smoke
