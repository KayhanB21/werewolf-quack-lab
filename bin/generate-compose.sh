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
    def token_for($id): ($id | gsub("[^A-Za-z0-9_-]"; "-")) + "-dev-token";
    .players as $players
    | ([ $players[] | select(.role == "wolf") | .id ]) as $wolves
    | [ $players[]
        | . as $p
        | {
            id: $p.id,
            role: $p.role,
            token: ($p.token // token_for($p.id)),
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

cat > "${OUT_DIR}/players.json" <<<"${PLAYERS_JSON}"

cat > "${OUT_DIR}/docker-compose.yml" <<YAML
services:
YAML

while IFS= read -r player; do
  id="$(jq -r '.id' <<<"${player}")"
  role="$(jq -r '.role' <<<"${player}")"
  token="$(jq -r '.token' <<<"${player}")"
  partners="$(jq -r '.partners | join(",")' <<<"${player}")"
  cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
  ${id}:
    platform: linux/amd64
    build:
      context: .
      args:
        DUCKDB_VERSION: \${DUCKDB_VERSION:-v1.5.2}
    command: ["/app/bin/player-node.sh"]
    hostname: ${id}
    environment:
      NODE_ID: ${id}
      ROLE: ${role}
      PARTNERS: "${partners}"
      PLAYER_IDS: "${PLAYER_IDS}"
      QUACK_TOKEN: ${token}
      LLM_PROVIDER: \${LLM_PROVIDER:-${MODEL_PROVIDER}}
      LLM_MODEL: \${LLM_MODEL:-${MODEL_MODEL}}
      LLM_BASE_URL: \${LLM_BASE_URL:-${MODEL_BASE_URL}}
      LLM_API_KEY: \${LLM_API_KEY:-}
      POST_GAME: \${POST_GAME:-false}
    expose:
      - "9494"
    volumes:
      - ${id}-data:/data

YAML
done < <(jq -c '.[]' <<<"${PLAYERS_JSON}")

cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
  gateway:
    depends_on:
YAML

while IFS= read -r id; do
  cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
      - ${id}
YAML
done < <(jq -r '.[].id' <<<"${PLAYERS_JSON}")

cat >> "${OUT_DIR}/docker-compose.yml" <<YAML
    environment:
      PLAYERS_JSON: '${PLAYERS_JSON_ESCAPED}'

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
