import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Environment loading.
 *
 * Secret values may be provided either inline or through a `*_FILE` variable pointing at a
 * secret file (spec §13.3). The loader never logs values and refuses to start in production
 * when a required secret is missing.
 */

let loaded = false;

export function loadEnvFiles(cwd: string = process.cwd()): string[] {
  if (loaded) return [];
  const candidates = [
    process.env.LOCALEHUB_ENV_FILE,
    resolve(cwd, '.env'),
    resolve(cwd, 'localehub.env'),
    resolve(cwd, '../../localehub.env'),
    resolve(cwd, '../../env.example'),
  ].filter((p): p is string => Boolean(p));
  const used: string[] = [];
  for (const file of candidates) {
    const path = resolve(file);
    if (!existsSync(path)) continue;
    applyEnvFile(path);
    used.push(path);
    break; // first match wins; later files do not silently override real secrets
  }
  loaded = true;
  return used;
}

function applyEnvFile(path: string): void {
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
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
}

/** Read a value from `<NAME>` or from the file named by `<NAME>_FILE`. */
export function readSecret(name: string, options: { required?: boolean; fallback?: string } = {}): string {
  const direct = process.env[name];
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar) {
    if (!existsSync(fileVar)) {
      throw new Error(`Secret file ${fileVar} referenced by ${name}_FILE does not exist`);
    }
    return readFileSync(fileVar, 'utf8').trim();
  }
  if (direct !== undefined && direct !== '') return direct;
  if (options.fallback !== undefined) return options.fallback;
  if (options.required) {
    throw new Error(`Missing required environment variable ${name} (or ${name}_FILE)`);
  }
  return '';
}

/**
 * Origin the web app is served from when nothing is configured.
 *
 * Exported because more than one component has to agree on the allowlist: the CORS middleware and
 * the CSRF guard. Reading `process.env` directly in the guard made it disagree with CORS on any
 * instance where no env *file* exists (CI, a container started with real env vars) — the schema
 * default applied to CORS, while the guard saw an empty string and rejected the web origin.
 */
export const DEFAULT_CORS_ORIGINS = 'http://localhost:3000';

/** Effective CORS allowlist: configured value, or the default. Trailing slashes stripped. */
export function corsOrigins(): string[] {
  return (process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS)
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  API_BASE_URL: z.string().default('http://localhost:3001/api/v1'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://127.0.0.1:56379'),
  AUTH_SECRET: z.string().min(8),
  ENCRYPTION_KEY: z.string().min(8),
  API_PORT: z.coerce.number().default(3001),
  WEB_PORT: z.coerce.number().default(3000),
  WORKER_PORT: z.coerce.number().default(3002),
  MCP_REMOTE_PORT: z.coerce.number().default(3003),
  CORS_ORIGINS: z.string().default(DEFAULT_CORS_ORIGINS),
  /** Express `trust proxy`: number of hops, or true/false. Off by default so X-Forwarded-For
   *  cannot be spoofed to dodge rate limits unless a reverse proxy really is in front. */
  TRUST_PROXY: z.string().default('false'),
  RATE_LIMIT_ENABLED: z.coerce.boolean().default(true),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Requests per window for an authenticated actor (interactive session or MCP token). */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
  /** Requests per window per IP for unauthenticated credential-submitting routes. */
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(12),
  /** browser session cookie */
  SESSION_COOKIE_NAME: z.string().default('localehub_session'),
  CSRF_COOKIE_NAME: z.string().default('localehub_csrf'),
  CSRF_HEADER_NAME: z.string().default('x-csrf-token'),
  MCP_REMOTE_ENABLED: z.coerce.boolean().default(true),
  /** URL an MCP client should use to reach the Remote MCP. Shown in the web UI and the CLI. */
  MCP_PUBLIC_URL: z.string().default('http://localhost:3003/mcp'),
  AI_DEFAULT_POLICY: z.string().default('hybrid'),
  SYNC_PLAN_TTL_SECONDS: z.coerce.number().default(1800),
  SYNC_MAX_ENTRIES_PER_BATCH: z.coerce.number().default(20000),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(cwd?: string): AppEnv {
  const files = loadEnvFiles(cwd);
  const parsed = {
    NODE_ENV: process.env.NODE_ENV,
    APP_BASE_URL: process.env.APP_BASE_URL,
    API_BASE_URL: process.env.API_BASE_URL,
    DATABASE_URL: readSecret('DATABASE_URL'),
    REDIS_URL: readSecret('REDIS_URL', { fallback: 'redis://127.0.0.1:56379' }),
    AUTH_SECRET: readSecret('AUTH_SECRET', {
      fallback: process.env.NODE_ENV === 'production' ? undefined : 'dev-only-auth-secret-change-me',
    }),
    ENCRYPTION_KEY: readSecret('ENCRYPTION_KEY', {
      fallback: process.env.NODE_ENV === 'production' ? undefined : 'dev-only-encryption-key-change-me',
    }),
    API_PORT: process.env.API_PORT,
    WEB_PORT: process.env.WEB_PORT,
    WORKER_PORT: process.env.WORKER_PORT,
    MCP_REMOTE_PORT: process.env.MCP_REMOTE_PORT,
    CORS_ORIGINS: process.env.CORS_ORIGINS,
    TRUST_PROXY: process.env.TRUST_PROXY,
    RATE_LIMIT_ENABLED: process.env.RATE_LIMIT_ENABLED,
    RATE_LIMIT_WINDOW_SECONDS: process.env.RATE_LIMIT_WINDOW_SECONDS,
    RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
    RATE_LIMIT_AUTH_MAX: process.env.RATE_LIMIT_AUTH_MAX,
    SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME,
    CSRF_COOKIE_NAME: process.env.CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME: process.env.CSRF_HEADER_NAME,
    MCP_REMOTE_ENABLED: process.env.MCP_REMOTE_ENABLED,
    MCP_PUBLIC_URL: process.env.MCP_PUBLIC_URL,
    AI_DEFAULT_POLICY: process.env.AI_DEFAULT_POLICY,
    SYNC_PLAN_TTL_SECONDS: process.env.SYNC_PLAN_TTL_SECONDS,
    SYNC_MAX_ENTRIES_PER_BATCH: process.env.SYNC_MAX_ENTRIES_PER_BATCH,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  };
  const result = envSchema.safeParse(stripUndefined(parsed));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment (files: ${files.join(', ') || 'none'}): ${issues}`);
  }
  return result.data;
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}
