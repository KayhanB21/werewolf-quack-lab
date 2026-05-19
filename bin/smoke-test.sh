#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${ROOT_DIR}/bin/agent-act-test.sh"
"${ROOT_DIR}/bin/mint-token-test.sh"
"${ROOT_DIR}/bin/lab-authz-test.sh"
"${ROOT_DIR}/bin/lab-span-test.sh"
"${ROOT_DIR}/bin/generated-compose-test.sh"
node "${ROOT_DIR}/bin/lab-web-test.mjs"
"${ROOT_DIR}/bin/labctl" smoke
