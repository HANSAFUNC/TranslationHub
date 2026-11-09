#!/usr/bin/env bash
# Start PostgreSQL/Redis, apply migrations and generate the Prisma client.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d postgres redis
until docker compose exec -T postgres pg_isready -U postgres -d localehub >/dev/null 2>&1; do
  printf 'waiting for postgres...\n'
  sleep 2
done

DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:55432/localehub?schema=public" \
  pnpm --filter @localehub/database migrate:deploy
pnpm --filter @localehub/database generate
printf 'database ready.\n'
