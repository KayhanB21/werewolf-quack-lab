#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${ROOT_DIR}/tests/agent-act.sh"
"${ROOT_DIR}/tests/mint-token.sh"
"${ROOT_DIR}/tests/lab-authz.sh"
"${ROOT_DIR}/tests/lab-span.sh"
"${ROOT_DIR}/tests/generated-compose.sh"
node "${ROOT_DIR}/tests/lab-web.mjs"
node "${ROOT_DIR}/tests/eval-aggregate.mjs"
node "${ROOT_DIR}/tests/eval-gates.mjs"
node "${ROOT_DIR}/tests/eval-run.mjs"
node "${ROOT_DIR}/tests/eval-deep.mjs"
"${ROOT_DIR}/bin/labctl" smoke
