#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${HUB_DB_CONTAINER:-ownables-hub-postgres}"
VOLUME_NAME="${HUB_DB_VOLUME:-ownables-hub-postgres-data}"
PORT="${HUB_DB_PORT:-54329}"
DB_NAME="${HUB_DB_NAME:-ownables_hub}"
DB_USER="${HUB_DB_USER:-ownables}"
DB_PASSWORD="${HUB_DB_PASSWORD:-ownables}"

LOCAL_DATABASE_URL_DEFAULT="postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PORT}/${DB_NAME}"
LOCAL_DATABASE_URL="${HUB_LOCAL_DATABASE_URL:-$LOCAL_DATABASE_URL_DEFAULT}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for yarn db:start" >&2
  exit 1
fi

RUNNING_STATE=""
if docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" >/dev/null 2>&1; then
  RUNNING_STATE="$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME")"
fi

if [[ "$RUNNING_STATE" == "true" ]]; then
  echo "postgres container already running: $CONTAINER_NAME"
elif [[ "$RUNNING_STATE" == "false" ]]; then
  echo "starting existing postgres container: $CONTAINER_NAME"
  docker start "$CONTAINER_NAME" >/dev/null
else
  echo "creating postgres container: $CONTAINER_NAME"
  docker run -d \
    --name "$CONTAINER_NAME" \
    -e POSTGRES_DB="$DB_NAME" \
    -e POSTGRES_USER="$DB_USER" \
    -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -p "${PORT}:5432" \
    -v "${VOLUME_NAME}:/var/lib/postgresql/data" \
    postgres:16-alpine >/dev/null
fi

echo "waiting for postgres readiness on 127.0.0.1:${PORT}..."
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
  echo "postgres did not become ready in time" >&2
  exit 1
fi

echo "postgres ready"
echo "DATABASE_URL=${LOCAL_DATABASE_URL}"

echo "running migrations with yarn db:migrate:up"
DATABASE_URL="$LOCAL_DATABASE_URL" yarn db:migrate:up

echo "db:start complete"
