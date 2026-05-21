.PHONY: up down logs test web web-dev web-test eval-test eval-run eval-large eval-mini eval-nothink eval-7p eval-hot eval-all-omlx baseline-refresh baseline-check whoami public wolf full denied shell

up:
	./bin/labctl up

down:
	./bin/labctl down

logs:
	docker compose -f docker-compose.yml -f .generated/docker-compose.yml logs -f

test:
	./bin/smoke-test.sh

web:
	node ./bin/lab-web-server.mjs

web-dev:
	node ./bin/lab-web-dev.mjs

web-test:
	node ./tests/lab-web.mjs
	node ./tests/referee.mjs

eval-test:
	node ./tests/eval-aggregate.mjs
	node ./tests/eval-gates.mjs
	node ./tests/eval-run.mjs
	node ./tests/eval-deep.mjs

eval-run:
	@if [ -z "$(PROFILE)" ]; then echo "usage: make eval-run PROFILE=eval/profiles/stub-smoke.json"; exit 1; fi
	node ./eval/run.mjs $(PROFILE)

eval-large:
	node ./eval/run.mjs ./eval/profiles/omlx-large.json

eval-mini:
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35-mini.json

eval-nothink:
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35-nothink.json

eval-7p:
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35-7p.json

eval-hot:
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35-hot.json

# Run every omlx profile back-to-back. Each profile has its own gates;
# the first failure short-circuits.
eval-all-omlx:
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35-mini.json
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35.json
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35-nothink.json
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35-7p.json
	node ./eval/run.mjs ./eval/profiles/omlx-qwen35-hot.json
	node ./eval/run.mjs ./eval/profiles/omlx-large.json

baseline-refresh:
	node ./eval/baseline-refresh.mjs

baseline-check:
	node ./eval/baseline-refresh.mjs --check

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
