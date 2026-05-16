#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

CONFIG_PATH="${TMP_DIR}/game.json"
OUT_DIR="${TMP_DIR}/generated"

cat > "${CONFIG_PATH}" <<'JSON'
{
  "players": [
    { "id": "agent-a", "role": "wolf" },
    { "id": "agent-b", "role": "villager" },
    { "id": "agent-c", "role": "seer" },
    { "id": "agent-d", "role": "wolf" },
    { "id": "agent-e", "role": "doctor" },
    { "id": "agent-f", "role": "villager" }
  ],
  "model": {
    "provider": "stub",
    "model": "stub-werewolf-v1"
  }
}
JSON

"${ROOT_DIR}/bin/generate-compose.sh" --config "${CONFIG_PATH}" --out-dir "${OUT_DIR}" >/dev/null

players_json="$(cat "${OUT_DIR}/players.json")"
compose_yaml="$(cat "${OUT_DIR}/docker-compose.yml")"

if ! jq -e 'length == 6' >/dev/null <<<"${players_json}"; then
  echo "generated players.json should contain six players" >&2
  exit 1
fi

if ! jq -e '.[] | select(.id == "agent-f" and .role == "villager")' >/dev/null <<<"${players_json}"; then
  echo "generated players.json should include agent-f" >&2
  exit 1
fi

if ! jq -e '.[] | select(.id == "agent-a") | .partners == ["agent-d"]' >/dev/null <<<"${players_json}"; then
  echo "wolf partners should be computed from config" >&2
  exit 1
fi

if ! grep -q "agent-f:" <<<"${compose_yaml}"; then
  echo "generated compose should include agent-f service" >&2
  exit 1
fi

if grep -Eq "PUBLIC_TEXT|RATIONALE_TEXT|WOLF_TARGET" <<<"${compose_yaml}"; then
  echo "generated compose should not contain hardcoded agent actions" >&2
  exit 1
fi

echo "ok - generated compose supports arbitrary configured players"
