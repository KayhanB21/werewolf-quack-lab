.PHONY: up down logs test check typecheck build-web web web-dev web-test eval-test eval-run eval-report eval-matrix eval-inspect-test eval-large eval-mini eval-nothink eval-7p eval-hot eval-anthropic eval-all-omlx baseline-refresh baseline-check whoami public wolf full denied shell

TSX := node --import tsx

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

eval-test:
	$(TSX) ./tests/eval-aggregate.ts
	$(TSX) ./tests/eval-gates.ts
	$(TSX) ./tests/eval-run.ts
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

eval-inspect-test:
	uv run --project eval/inspect python -m py_compile eval/inspect/werewolf_task.py

eval-large:
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-large.json

eval-mini:
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-mini.json

eval-nothink:
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-nothink.json

eval-7p:
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-7p.json

eval-hot:
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-hot.json

# Run every omlx profile back-to-back. Each profile has its own gates;
# the first failure short-circuits.
eval-anthropic:
	$(TSX) ./eval/run.ts ./eval/profiles/anthropic-haiku.json

eval-all-omlx:
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-mini.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-nothink.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-7p.json
	$(TSX) ./eval/run.ts ./eval/profiles/omlx-qwen35-hot.json
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
