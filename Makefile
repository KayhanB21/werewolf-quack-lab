.PHONY: up down logs test whoami public wolf full denied shell

up:
	docker compose up --build -d

down:
	docker compose down -v

logs:
	docker compose logs -f

test:
	./bin/smoke-test.sh

whoami:
	docker compose exec gateway /app/bin/gateway-query.sh whoami

public:
	docker compose exec gateway /app/bin/gateway-query.sh public_log

wolf:
	docker compose exec gateway /app/bin/gateway-query.sh wolf_channel

full:
	docker compose exec gateway /app/bin/gateway-query.sh full_log

denied:
	docker compose exec gateway /app/bin/gateway-query.sh denied_private_table

shell:
	docker compose exec gateway bash
