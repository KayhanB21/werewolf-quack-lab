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
    "provider": "omlx",
    "model": "local-test-model",
    "base_url": "http://host.docker.internal:8000/v1"
  }
}
JSON

"${ROOT_DIR}/lib/generate-compose.sh" --config "${CONFIG_PATH}" --out-dir "${OUT_DIR}" >/dev/null

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

if jq -e '.[] | has("token")' >/dev/null <<<"${players_json}"; then
  echo "players.json should no longer carry per-player tokens (tokens are minted per call)" >&2
  exit 1
fi

if [[ ! -s "${OUT_DIR}/lab-secret" ]]; then
  echo "generate-compose should produce a lab-secret file" >&2
  exit 1
fi

secret_value="$(cat "${OUT_DIR}/lab-secret")"
if [[ "${#secret_value}" -lt 32 ]]; then
  echo "lab-secret should be at least 32 chars of entropy" >&2
  exit 1
fi

if ! grep -Fq "LAB_QUACK_SECRET: ${secret_value}" <<<"${compose_yaml}"; then
  echo "generated compose should inject LAB_QUACK_SECRET into services" >&2
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

if ! grep -Fq 'LLM_PROVIDER: ${LLM_PROVIDER:-omlx}' <<<"${compose_yaml}"; then
  echo "generated compose should preserve the configured LLM provider" >&2
  exit 1
fi

if ! grep -Fq 'LLM_MODEL: ${LLM_MODEL:-local-test-model}' <<<"${compose_yaml}"; then
  echo "generated compose should preserve the configured LLM model" >&2
  exit 1
fi

if ! grep -Fq 'LLM_BASE_URL: ${LLM_BASE_URL:-http://host.docker.internal:8000/v1}' <<<"${compose_yaml}"; then
  echo "generated compose should preserve the configured LLM base URL" >&2
  exit 1
fi

if ! grep -Fq 'LLM_THINKING_BUDGET: ${LLM_THINKING_BUDGET:-}' <<<"${compose_yaml}"; then
  echo "generated compose should thread LLM_THINKING_BUDGET into player containers" >&2
  exit 1
fi

if ! grep -Fq 'LLM_TEMPERATURE: ${LLM_TEMPERATURE:-0.2}' <<<"${compose_yaml}"; then
  echo "generated compose should thread LLM_TEMPERATURE into player containers" >&2
  exit 1
fi

if ! grep -Fq 'LLM_MAX_TOKENS: ${LLM_MAX_TOKENS:-260}' <<<"${compose_yaml}"; then
  echo "generated compose should thread LLM_MAX_TOKENS into player containers" >&2
  exit 1
fi

if ! grep -Eq "^networks:" <<<"${compose_yaml}"; then
  echo "generated compose should declare a top-level networks: block" >&2
  exit 1
fi

for id in agent-a agent-b agent-c agent-d agent-e agent-f; do
  if ! grep -q "  lab-${id}:" <<<"${compose_yaml}"; then
    echo "generated compose should declare a per-player network lab-${id}" >&2
    exit 1
  fi
done

if ! grep -Fq "mem_limit: \${LAB_PLAYER_MEM_LIMIT:-512m}" <<<"${compose_yaml}"; then
  echo "generated compose should set a per-player memory cap" >&2
  exit 1
fi

if ! grep -Fq "pids_limit: \${LAB_PLAYER_PIDS_LIMIT:-256}" <<<"${compose_yaml}"; then
  echo "generated compose should set a per-player pid cap" >&2
  exit 1
fi

if ! grep -Fq "cpus: \${LAB_GATEWAY_CPUS:-1.0}" <<<"${compose_yaml}"; then
  echo "generated compose should set a gateway cpu cap" >&2
  exit 1
fi

# Each player must list exactly one network (its own lab-<id>) so it cannot
# reach the other players. The gateway should list ALL player networks.
section_lines() {
  local header="$1"
  awk -v hdr="${header}" '
    $0 == hdr {flag=1; next}
    /^[a-zA-Z]/ {flag=0}
    /^  [a-zA-Z]/ {flag=0}
    flag {print}
  ' <<<"${compose_yaml}"
}

gateway_networks="$(section_lines "  gateway:" | grep -E '^\s+- lab-' | sort -u)"
gateway_network_count="$(grep -c . <<<"${gateway_networks}")"
if [[ "${gateway_network_count}" -ne 6 ]]; then
  echo "gateway should attach to all six per-player networks (got ${gateway_network_count})" >&2
  echo "${gateway_networks}" >&2
  exit 1
fi

agent_a_networks="$(section_lines "  agent-a:" | grep -E '^\s+- lab-' | sort -u)"
agent_a_network_count="$(grep -c . <<<"${agent_a_networks}")"
if [[ "${agent_a_network_count}" -ne 1 ]]; then
  echo "agent-a should attach to exactly one network (got ${agent_a_network_count})" >&2
  echo "${agent_a_networks}" >&2
  exit 1
fi
if ! grep -Fq -- "- lab-agent-a" <<<"${agent_a_networks}"; then
  echo "agent-a should be on its own lab-agent-a network" >&2
  exit 1
fi

echo "ok - generated compose supports arbitrary configured players and local model defaults"
