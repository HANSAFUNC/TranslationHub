#!/usr/bin/env bash
# Create the ./secrets directory consumed by compose.production.yaml.
#
# Usage: ./scripts/init-secrets.sh [db_password]
# Nothing is committed: ./secrets is in .gitignore and .dockerignore.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_PASSWORD="${1:-$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)}"
mkdir -p secrets
umask 077

write_once() {
  local file="$1"; shift
  if [ -f "secrets/$file" ]; then
    printf 'kept existing secrets/%s\n' "$file"
  else
    "$@" > "secrets/$file"
    printf 'created secrets/%s\n' "$file"
  fi
}

write_once auth_secret      openssl rand -base64 36
write_once encryption_key   openssl rand -base64 32
write_once postgres_password openssl rand -base64 24
write_once redis_password   openssl rand -base64 24
write_once app_db_password  printf '%s\n' "$DB_PASSWORD"

[ -f secrets/database_url ] || printf 'postgresql://localehub_app:%s@postgres:5432/localehub?schema=public\n' "$(cat secrets/app_db_password)" > secrets/database_url
[ -f secrets/redis_url ]    || printf 'redis://:%s@redis:6379\n' "$(cat secrets/redis_password)" > secrets/redis_url

chmod 600 secrets/*
printf '\nsecrets ready. TLS certificates go in docker/nginx/certs/{fullchain.pem,privkey.pem}.\n'
printf 'Application role credentials (store them in your password manager):\n  user: localehub_app\n  password: %s\n' "$(cat secrets/app_db_password)"
