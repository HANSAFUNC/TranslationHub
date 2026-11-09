import { type CanActivate, type ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';
import type { Response } from 'express';
import type { ActorContext, AuthenticatedRequest } from './auth';

/**
 * Rate limiting for every endpoint.
 *
 * Keyed by the actor once one is known, and by IP for the routes that run before authentication
 * (login / register). Keying authenticated traffic per actor rather than per IP is deliberate: a
 * whole office, or a CI runner executing the acceptance suite and then the demo, shares one
 * egress IP and would otherwise exhaust a single bucket with entirely legitimate traffic.
 *
 * Counters live in Redis so that every API replica shares one budget; when Redis is unreachable
 * the limiter degrades to per-process counters instead of failing open silently — a single replica
 * still enforces the configured limit, and the degradation is logged.
 */

export interface RateLimitRule {
  /** Window length in seconds. */
  windowSeconds: number;
  /** Allowed requests within the window. */
  max: number;
  /** Bucket name; requests with different scopes never share a counter. */
  scope: string;
}

/** A rule plus the value it counts against. */
interface RateLimitCheck {
  rule: RateLimitRule;
  key: string;
}

/** Routes that take a credential and therefore must not be brute-forceable. */
const CREDENTIAL_ROUTES = new Set(['/api/v1/auth/login', '/api/v1/auth/register']);

interface Counter {
  count: number;
  resetAt: number;
}

/** Minimal Redis surface we need, so tests can substitute an in-memory implementation. */
export interface RateLimitStore {
  increment(key: string, windowSeconds: number): Promise<{ count: number; resetAt: number }>;
}

class InMemoryStore implements RateLimitStore {
  private readonly counters = new Map<string, Counter>();

  async increment(key: string, windowSeconds: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const existing = this.counters.get(key);
    if (!existing || existing.resetAt <= now) {
      const resetAt = now + windowSeconds * 1_000;
      this.counters.set(key, { count: 1, resetAt });
      return { count: 1, resetAt };
    }
    existing.count += 1;
    return { count: existing.count, resetAt: existing.resetAt };
  }
}

class RedisStore implements RateLimitStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly redis: any) {}

  async increment(key: string, windowSeconds: number): Promise<{ count: number; resetAt: number }> {
    // INCR + EXPIRE NX in one round trip pair: the window is fixed at the first request, so a
    // steady stream cannot keep pushing the reset time out.
    const pipeline = this.redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, windowSeconds, 'NX');
    const results = (await pipeline.exec()) as [Error | null, number][] | null;
    const count = Number(results?.[0]?.[1] ?? 1);
    const ttl = Number(await this.redis.ttl(key));
    const effectiveTtl = ttl > 0 ? ttl : windowSeconds;
    return { count, resetAt: Date.now() + effectiveTtl * 1_000 };
  }
}

@Injectable()
export class RateLimitService {
  private readonly logger = new Logger('RateLimitService');
  private readonly memory = new InMemoryStore();
  private redis: RedisStore | null = null;
  private redisHealthy = false;
  private redisUnavailableLogged = false;

  constructor() {
    void this.connect();
  }

  private async connect(): Promise<void> {
    const url = process.env.REDIS_URL;
    if (!url) return;
    try {
      const { default: IORedis } = await import('ioredis');
      const client = new IORedis(url, { maxRetriesPerRequest: 1, lazyConnect: false });
      client.on('error', () => this.noteRedisUnavailable());
      client.on('ready', () => {
        this.redisHealthy = true;
      });
      this.redis = new RedisStore(client);
    } catch {
      this.noteRedisUnavailable();
    }
  }

  private noteRedisUnavailable(): void {
    this.redisHealthy = false;
    if (this.redisUnavailableLogged) return;
    this.redisUnavailableLogged = true;
    this.logger.warn('Redis is unavailable; rate limits fall back to per-process counters.');
  }

  /** The store to use right now: Redis when it is up, the local map otherwise. */
  private store(): RateLimitStore {
    return this.redis && this.redisHealthy ? this.redis : this.memory;
  }

  async check(rule: RateLimitRule, key: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const store = this.store();
    let result: { count: number; resetAt: number };
    try {
      result = await store.increment(`rl:${rule.scope}:${key}`, rule.windowSeconds);
    } catch {
      // A store failure must not take the API down: fall back to the local counter for this call.
      this.noteRedisUnavailable();
      result = await this.memory.increment(`rl:${rule.scope}:${key}`, rule.windowSeconds);
    }
    const allowed = result.count <= rule.max;
    return { allowed, remaining: Math.max(0, rule.max - result.count), resetAt: result.resetAt };
  }
}

/**
 * Enforces the limits. Registered after `AuthGuard`, so authenticated requests are counted per
 * actor; routes marked `@Public()` are counted per IP.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly limiter: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.RATE_LIMIT_ENABLED === 'false') return true;

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? 60);
    const defaultMax = Number(process.env.RATE_LIMIT_MAX ?? 600);
    const authMax = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 12);

    const path = request.path ?? request.url.split('?')[0] ?? '';
    const rules = CREDENTIAL_ROUTES.has(path)
      ? credentialRules(path, windowSeconds, authMax, request)
      : [authenticatedRule(request, windowSeconds, defaultMax)];

    let tightest: { max: number; remaining: number; resetAt: number } | null = null;
    for (const check of rules) {
      const result = await this.limiter.check(check.rule, check.key);
      if (!result.allowed) {
        this.reject(response, check.rule, result.resetAt);
      }
      // The advertised budget is the tightest bucket: that is the one that will stop the caller.
      if (!tightest || result.remaining < tightest.remaining) {
        tightest = { ...result, max: check.rule.max };
      }
    }

    if (tightest) {
      response.setHeader('X-RateLimit-Limit', String(tightest.max));
      response.setHeader('X-RateLimit-Remaining', String(tightest.remaining));
      response.setHeader('X-RateLimit-Reset', String(Math.ceil(tightest.resetAt / 1_000)));
    }
    return true;
  }

  private reject(response: Response, rule: RateLimitRule, resetAt: number): never {
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000));
    response.setHeader('Retry-After', String(retryAfter));
    throw new LocaleHubError(ErrorCode.RATE_LIMITED, `Too many requests. Retry in ${retryAfter}s.`, 429, {
      scope: rule.scope,
      limit: rule.max,
      windowSeconds: rule.windowSeconds,
      retryAfter,
    });
  }
}

/**
 * Authenticated traffic is counted per actor. A whole office — or a CI runner executing the
 * acceptance suite and the demo back to back — shares one egress IP, so an IP-keyed bucket would
 * throttle entirely legitimate work.
 */
function authenticatedRule(request: AuthenticatedRequest, windowSeconds: number, max: number): RateLimitCheck {
  const actor = request.actor as ActorContext | undefined;
  const key = actor ? (actor.mcpClientId ? `token:${actor.mcpClientId}` : `user:${actor.userId}`) : `ip:${clientIp(request)}`;
  return { rule: { scope: 'api', windowSeconds, max }, key };
}

/**
 * Credential submission is counted twice, because the two attacks look different:
 *
 *   - per (IP, account): brute-forcing one password. This is the tight limit.
 *   - per IP: spraying one password across many accounts. Deliberately looser, so that a single
 *     user under attack — or a developer retrying their own password — cannot lock out everyone
 *     else behind the same NAT.
 */
function credentialRules(path: string, windowSeconds: number, max: number, request: AuthenticatedRequest): RateLimitCheck[] {
  const ip = clientIp(request);
  const account = submittedAccount(request);
  return [
    { rule: { scope: `auth:account:${path}`, windowSeconds, max }, key: `${ip}|${account ?? 'unknown'}` },
    { rule: { scope: `auth:ip:${path}`, windowSeconds, max: max * 5 }, key: ip },
  ];
}

/** Best effort: the body is parsed by Nest after guards run, so read the raw JSON when present. */
function submittedAccount(request: AuthenticatedRequest): string | null {
  const body = (request as AuthenticatedRequest & { body?: { email?: unknown } }).body;
  if (body && typeof body.email === 'string') return body.email.toLowerCase();
  return null;
}

/**
 * `req.ip` honours `X-Forwarded-For` only when Express `trust proxy` is configured, which
 * `main.ts` does from the `TRUST_PROXY` variable. Without it the socket address is used, so a
 * client cannot mint fresh buckets by inventing forwarding headers.
 */
function clientIp(request: AuthenticatedRequest): string {
  return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
}
