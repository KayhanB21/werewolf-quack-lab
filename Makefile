.PHONY: up down logs test check typecheck build-web web web-dev web-test eval-test eval-run eval-report eval-matrix eval-matrix-node24 eval-inspect-test eval-omlx-smoke eval-large eval-mini eval-nothink eval-7p eval-hot eval-anthropic eval-all-omlx baseline-refresh baseline-check whoami public wolf full denied shell

TSX := node --import tsx
OMLX_PREFLIGHT := $(TSX) ./eval/omlx-preflight.ts

up:
	./bin/labctl up

down:
	./bin/labctl down

logs:
	docker compose -f docker-compose.yml -f .generated/docker-compose.yml logs -f

test:
	./bin/smoke-test.sh

check:
	npm run check

typecheck:
	npm run typecheck

build-web:
	npm run build:web

web:
	npm run build:web
	$(TSX) ./bin/lab-web-server.ts

web-dev:
	npm run build:web
	$(TSX) ./bin/lab-web-dev.ts

web-test:
	$(TSX) ./tests/lab-web.ts
	$(TSX) ./tests/referee.ts
	$(TSX) ./tests/generated-js-boundary.ts

eval-test:
	$(TSX) ./tests/eval-aggregate.ts
	$(TSX) ./tests/eval-gates.ts
	$(TSX) ./tests/eval-run.ts
	$(TSX) ./tests/eval-omlx-preflight.ts
	$(TSX) ./tests/eval-promptfoo-provider.ts
	$(TSX) ./tests/eval-judge.ts
	$(TSX) ./tests/eval-deep.ts
	$(TSX) ./tests/eval-report.ts

eval-run:
	@if [ -z "$(PROFILE)" ]; then echo "usage: make eval-run PROFILE=eval/profiles/stub-smoke.json"; exit 1; fi
	$(TSX) ./eval/run.ts $(PROFILE)

eval-report:
	$(TSX) ./eval/report.ts ./eval/runs --out ./eval/runs/report.md --json ./eval/runs/report.json

eval-matrix:
	npm run eval:matrix

eval-matrix-node24:
	npx -y -p node@24 node ./node_modules/promptfoo/dist/src/main.js eval -c ./eval/promptfooconfig.yaml --max-concurrency 1

eval-inspect-test:
	uv run --project eval/inspect python -m py_compile eval/inspect/werewolf_task.py

eval-omlx-smoke:
	$(OMLX_PREFLIGHT) --base-url "$${OMLX_BASE_URL:-http://localhost:8000/v1}" --api-key-env OMLX_API_KEY --model "$${OMLX_MODEL:-}"
	./bin/omlx-smoke-test.sh

eval-large:
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-large.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-large.json

eval-mini:
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35-mini.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-mini.json

eval-nothink:
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35-nothink.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-nothink.json

eval-7p:
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35-7p.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-7p.json

eval-hot:
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35-hot.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-hot.json

# Run every omlx profile back-to-back. Each profile has its own gates;
# the first failure short-circuits.
eval-anthropic:
	$(TSX) ./eval/run.ts ./eval/profiles/anthropic-haiku.json

eval-all-omlx:
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35-mini.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-mini.json
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35.json
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35-nothink.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-nothink.json
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35-7p.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-7p.json
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-qwen35-hot.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-hot.json
	$(OMLX_PREFLIGHT) ./eval/profiles/omlx-large.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-large.json

baseline-refresh:
	$(TSX) ./eval/baseline-refresh.ts

baseline-check:
	$(TSX) ./eval/baseline-refresh.ts --check

whoami:
	./bin/labctl query whoami

public:
	./bin/labctl query public_log

wolf:
	./bin/labctl query wolf_channel

full:
	./bin/labctl query full_log

denied:
	./bin/labctl query denied_private_table

shell:
	docker compose -f docker-compose.yml -f .generated/docker-compose.yml exec gateway bash
