#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="config/game.sample.json"
OUT_DIR=".generated"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_PATH="${2:?--config requires a path}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:?--out-dir requires a path}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to generate the lab compose file" >&2
  exit 1
fi

if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "config not found: ${CONFIG_PATH}" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

PLAYERS_JSON="$(
  jq -c '
    .players as $players
    | ([ $players[] | select(.role == "wolf") | .id ]) as $wolves
    | [ $players[]
        | . as $p
        | {
            id: $p.id,
            role: $p.role,
            partners: (if $p.role == "wolf" then ($wolves - [$p.id]) else [] end)
          }
      ]
  ' "${CONFIG_PATH}"
)"

COUNT="$(jq 'length' <<<"${PLAYERS_JSON}")"
if [[ "${COUNT}" -lt 3 ]]; then
  echo "at least three players are required" >&2
  exit 1
fi

while IFS= read -r id; do
  if [[ ! "${id}" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
    echo "invalid player id: ${id}" >&2
    exit 1
  fi
done < <(jq -r '.[].id' <<<"${PLAYERS_JSON}")

duplicate_count="$(
  jq -r '.[].id' <<<"${PLAYERS_JSON}" | sort | uniq -d | wc -l | tr -d ' '
)"
if [[ "${duplicate_count}" != "0" ]]; then
  echo "player ids must be unique" >&2
  exit 1
fi

while IFS= read -r role; do
  case "${role}" in
    wolf|villager|seer|doctor) ;;
    *)
      echo "invalid role: ${role}" >&2
      exit 1
      ;;
  esac
done < <(jq -r '.[].role' <<<"${PLAYERS_JSON}")

PLAYER_IDS="$(jq -r '[.[].id] | join(",")' <<<"${PLAYERS_JSON}")"
MODEL_PROVIDER="$(jq -r '.model.provider // "stub"' "${CONFIG_PATH}")"
MODEL_MODEL="$(jq -r '.model.model // "stub-werewolf-v1"' "${CONFIG_PATH}")"
MODEL_BASE_URL="$(jq -r '.model.base_url // "https://api.openai.com/v1"' "${CONFIG_PATH}")"

PLAYERS_JSON_ESCAPED="$(printf "%s" "${PLAYERS_JSON}" | sed "s/'/''/g")"

LAB_SECRET_PATH="${OUT_DIR}/lab-secret"
if [[ ! -s "${LAB_SECRET_PATH}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "${LAB_SECRET_PATH}"
  else
    head -c 64 /dev/urandom | xxd -p -c 256 > "${LAB_SECRET_PATH}"
  fi
  chmod 600 "${LAB_SECRET_PATH}"
fi
LAB_SECRET="$(cat "${LAB_SECRET_PATH}")"

cat > "${OUT_DIR}/players.json" <<<"${PLAYERS_JSON}"

cat > "${OUT_DIR}/docker-compose.yml" <<YAML
services:
YAML

while IFS= read -r player; do
  id="$(jq -r '.id' <<<"${player}")"
  role="$(jq -r '.role' <<<"${player}")"
  partners="$(jq -r '.partners | join(",")' <<<"${player}")"
  cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
  ${id}:
    platform: linux/amd64
    build:
      context: .
      args:
        DUCKDB_VERSION: \${DUCKDB_VERSION:-v1.5.2}
    command: ["/app/container/player-node.sh"]
    hostname: ${id}
    environment:
      NODE_ID: ${id}
      ROLE: ${role}
      PARTNERS: "${partners}"
      PLAYER_IDS: "${PLAYER_IDS}"
      LAB_QUACK_SECRET: ${LAB_SECRET}
      LLM_PROVIDER: \${LLM_PROVIDER:-${MODEL_PROVIDER}}
      LLM_MODEL: \${LLM_MODEL:-${MODEL_MODEL}}
      LLM_BASE_URL: \${LLM_BASE_URL:-${MODEL_BASE_URL}}
      LLM_API_KEY: \${LLM_API_KEY:-}
      LLM_TIMEOUT_SECONDS: \${LLM_TIMEOUT_SECONDS:-60}
      LLM_THINKING_BUDGET: \${LLM_THINKING_BUDGET:-}
      LLM_TEMPERATURE: \${LLM_TEMPERATURE:-0.2}
      LLM_MAX_TOKENS: \${LLM_MAX_TOKENS:-260}
      POST_GAME: \${POST_GAME:-false}
    expose:
      - "9494"
    networks:
      - lab-${id}
    mem_limit: \${LAB_PLAYER_MEM_LIMIT:-512m}
    cpus: \${LAB_PLAYER_CPUS:-0.5}
    pids_limit: \${LAB_PLAYER_PIDS_LIMIT:-256}
    volumes:
      - ${id}-data:/data

YAML
done < <(jq -c '.[]' <<<"${PLAYERS_JSON}")

cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
  gateway:
    mem_limit: \${LAB_GATEWAY_MEM_LIMIT:-1g}
    cpus: \${LAB_GATEWAY_CPUS:-1.0}
    pids_limit: \${LAB_GATEWAY_PIDS_LIMIT:-512}
    networks:
YAML

while IFS= read -r id; do
  cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
      - lab-${id}
YAML
done < <(jq -r '.[].id' <<<"${PLAYERS_JSON}")

cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
    depends_on:
YAML

while IFS= read -r id; do
  cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
      - ${id}
YAML
done < <(jq -r '.[].id' <<<"${PLAYERS_JSON}")

cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
    environment:
      LAB_QUACK_SECRET: ${LAB_SECRET}
      PLAYERS_JSON: '${PLAYERS_JSON_ESCAPED}'

networks:
YAML

while IFS= read -r id; do
  cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
  lab-${id}:
    driver: bridge
YAML
done < <(jq -r '.[].id' <<<"${PLAYERS_JSON}")

cat >> "${OUT_DIR}/docker-compose.yml" <<YAML

volumes:
YAML

while IFS= read -r id; do
  cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
  ${id}-data:
YAML
done < <(jq -r '.[].id' <<<"${PLAYERS_JSON}")

cat > "${OUT_DIR}/tokens.env" <<ENV
PLAYERS_JSON='${PLAYERS_JSON_ESCAPED}'
ENV

echo "generated ${OUT_DIR}/docker-compose.yml for ${COUNT} players"
