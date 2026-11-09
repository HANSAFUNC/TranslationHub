#!/usr/bin/env bash
# Full local verification: typecheck, lint, unit tests, integration tests, e2e demo.
#
# Requires: pnpm install, docker compose up -d postgres redis, migrations applied.
# The integration suite boots the API itself when nothing listens on API_BASE_URL.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

step "build"
pnpm -r build

step "typecheck"
pnpm -r typecheck

step "lint"
pnpm lint

step "unit tests"
pnpm test

step "integration tests"
pnpm test:integration

step "acceptance demo (scenario A-E)"
node apps/e2e-demo/dist/run-demo.js

step "done"
printf 'All verification steps passed.\n'
