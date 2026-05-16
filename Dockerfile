FROM debian:bookworm-slim

ARG DUCKDB_VERSION=v1.5.2
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    jq \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) duckdb_asset="duckdb_cli-linux-amd64.zip" ;; \
    arm64) duckdb_asset="duckdb_cli-linux-aarch64.zip" ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/${duckdb_asset}" -o /tmp/duckdb.zip; \
  unzip /tmp/duckdb.zip -d /usr/local/bin; \
  chmod +x /usr/local/bin/duckdb; \
  rm /tmp/duckdb.zip

WORKDIR /app

COPY bin/ /app/bin/
COPY sql/ /app/sql/
COPY docs/ /app/docs/

RUN chmod +x /app/bin/*.sh

ENV DUCKDB_BIN=/usr/local/bin/duckdb
ENV DATA_DIR=/data

CMD ["sleep", "infinity"]
