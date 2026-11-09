#!/usr/bin/env node
/**
 * Run a command with the same environment file the services load.
 *
 * Prisma only reads `.env` on its own, but this workspace keeps its template as `localehub.env`
 * (the repository denies reading and writing `.env*`), so `pnpm db:migrate` failed with
 * "Environment variable not found: DATABASE_URL" unless the caller exported it by hand. This
 * wrapper applies the same first-match-wins order as `@localehub/config` and then execs the
 * command, leaving already-exported variables untouched.
 *
 * Usage: node scripts/run-with-env.mjs prisma migrate deploy
 *        node scripts/run-with-env.mjs --database-url-var MIGRATE_DATABASE_URL prisma migrate deploy
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const candidates = [
  process.env.LOCALEHUB_ENV_FILE,
  resolve(root, '.env'),
  resolve(root, 'localehub.env'),
].filter(Boolean);

for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;
  for (const rawLine of readFileSync(candidate, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  break; // first match wins, matching @localehub/config
}

const argv = process.argv.slice(2);

// Migrations run as the schema owner, not as the application role: `localehub_app` is
// deliberately not the owner of these tables, which is what makes the RLS policies bind it.
// Prisma only reads `env("DATABASE_URL")`, so swap in the owner URL for the migration commands.
let databaseUrlVar = null;
if (argv[0] === '--database-url-var') {
  databaseUrlVar = argv[1];
  argv.splice(0, 2);
}
if (databaseUrlVar) {
  const ownerUrl = process.env[databaseUrlVar];
  if (!ownerUrl) {
    console.error(`${databaseUrlVar} is not set; migrations need the schema owner connection string.`);
    process.exit(2);
  }
  process.env.DATABASE_URL = ownerUrl;
}

const [command, ...args] = argv;
if (!command) {
  console.error('usage: node scripts/run-with-env.mjs [--database-url-var NAME] <command> [args...]');
  process.exit(2);
}

const result = spawnSync(command, args, { stdio: 'inherit', cwd: process.cwd(), env: process.env });
process.exit(result.status ?? 1);
