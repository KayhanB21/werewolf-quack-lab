.PHONY: up down logs test web web-dev web-test eval-test eval-run whoami public wolf full denied shell

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

eval-test:
	node ./tests/eval-aggregate.mjs
	node ./tests/eval-run.mjs

eval-run:
	@if [ -z "$(PROFILE)" ]; then echo "usage: make eval-run PROFILE=eval/profiles/stub-smoke.json"; exit 1; fi
	node ./eval/run.mjs $(PROFILE)

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
