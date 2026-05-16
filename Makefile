.PHONY: up down logs test web web-test whoami public wolf full denied shell

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

web-test:
	node ./bin/lab-web-test.mjs

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
