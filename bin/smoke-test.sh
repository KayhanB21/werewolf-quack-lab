#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX=(node --import tsx)

npm --prefix "${ROOT_DIR}" run build:web >/dev/null
npm --prefix "${ROOT_DIR}" run typecheck
npm --prefix "${ROOT_DIR}" run lint:no-any

"${ROOT_DIR}/tests/agent-act.sh"
"${ROOT_DIR}/tests/mint-token.sh"
"${ROOT_DIR}/tests/lab-authz.sh"
"${ROOT_DIR}/tests/lab-span.sh"
"${ROOT_DIR}/tests/generated-compose.sh"
"${TSX[@]}" "${ROOT_DIR}/tests/lab-web.ts"
"${TSX[@]}" "${ROOT_DIR}/tests/referee.ts"
"${TSX[@]}" "${ROOT_DIR}/tests/eval-aggregate.ts"
"${TSX[@]}" "${ROOT_DIR}/tests/eval-gates.ts"
"${TSX[@]}" "${ROOT_DIR}/tests/eval-run.ts"
"${TSX[@]}" "${ROOT_DIR}/tests/eval-judge.ts"
"${TSX[@]}" "${ROOT_DIR}/tests/eval-deep.ts"
"${TSX[@]}" "${ROOT_DIR}/tests/eval-report.ts"
"${ROOT_DIR}/bin/labctl" smoke
