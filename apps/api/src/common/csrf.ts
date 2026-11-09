import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';
import type { AuthenticatedRequest } from './auth';
import { csrfCookieName, csrfHeaderName } from './auth';

/**
 * CSRF protection for cookie-authenticated requests.
 *
 * Two independent layers, because a browser attaches the session cookie to any request that
 * reaches this origin, whether or not the page meant to make it:
 *
 *   1. SameSite=Lax on the session cookie keeps it off cross-site requests in the first place.
 *   2. For unsafe methods this guard additionally requires (a) a double-submit token whose value
 *      matches the readable `localehub_csrf` cookie, and (b) an `Origin`/`Referer` that belongs to
 *      this deployment.
 *
 * Bearer-authenticated requests (CLI, MCP servers, integration scripts) are exempt from the
 * double-submit check: the credential is attached deliberately, so there is nothing for an
 * attacker's page to borrow. They are still subject to the origin check when they send an Origin.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;

    const cookieAuthenticated = request.actor?.credentialSource === 'cookie';

    assertOriginIsTrusted(request);
    if (cookieAuthenticated) assertDoubleSubmitTokenMatches(request);
    return true;
  }
}

/**
 * `Origin` is authoritative when present; `Referer` is the fallback. Browsers set one of the two
 * on every unsafe request, and a page cannot forge either for its own request.
 */
function assertOriginIsTrusted(request: AuthenticatedRequest): void {
  const origin = requestOrigin(request);
  // Neither header present: not a browser-initiated cross-site request (curl, an MCP client, a
  // server-to-server call). The double-submit token still guards cookie credentials.
  if (!origin) return;
  if (trustedOrigins(request).has(origin)) return;
  throw new LocaleHubError(ErrorCode.CSRF_VERIFICATION_FAILED, `Origin ${origin} is not allowed to call this API`, 403, {
    origin,
  });
}

function assertDoubleSubmitTokenMatches(request: AuthenticatedRequest): void {
  const header = request.headers[csrfHeaderName()];
  const supplied = Array.isArray(header) ? header[0] : header;
  const cookies = (request as AuthenticatedRequest & { cookies?: Record<string, string> }).cookies;
  const expected = cookies?.[csrfCookieName()];
  if (!supplied || !expected || !constantTimeEquals(supplied, expected)) {
    throw new LocaleHubError(
      ErrorCode.CSRF_VERIFICATION_FAILED,
      `Missing or mismatched ${csrfHeaderName()} header for a cookie-authenticated request`,
      403,
    );
  }
}

function requestOrigin(request: AuthenticatedRequest): string | null {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin && origin !== 'null') return origin.replace(/\/+$/, '');
  const referer = request.headers.referer;
  if (typeof referer === 'string' && referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The configured CORS allowlist plus this API's own origin, so a same-origin deployment keeps
 * working even when `CORS_ORIGINS` was only set for the web app during development.
 */
function trustedOrigins(request: AuthenticatedRequest): Set<string> {
  const origins = new Set<string>();
  for (const entry of (process.env.CORS_ORIGINS ?? '').split(',')) {
    const trimmed = entry.trim().replace(/\/+$/, '');
    if (trimmed) origins.add(trimmed);
  }
  const host = request.headers.host;
  if (host) {
    const forwarded = request.headers['x-forwarded-proto'];
    const proto = typeof forwarded === 'string' ? forwarded.split(',')[0]!.trim() : request.protocol;
    origins.add(`${proto}://${host}`);
  }
  return origins;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
