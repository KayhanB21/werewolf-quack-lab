#!/usr/bin/env bash
set -euo pipefail

docker compose up --build -d
docker compose exec -T gateway /app/bin/gateway-smoke-test.sh
