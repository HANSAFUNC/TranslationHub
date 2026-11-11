import { createHmac, timingSafeEqual } from 'node:crypto';
import { ErrorCode, LocaleHubError } from '@localehub/contracts';

/**
 * Webhook signing and retry policy.
 *
 * Kept in `domain` rather than in the worker because both ends of the contract need it: the worker
 * signs, and a consumer verifies — and the verification helper is what makes the header format
 * checkable rather than folklore.
 */

export interface WebhookEvent {
  /** Unique per event; also the idempotency key a consumer should deduplicate on. */
  id: string;
  type: string;
  organizationId: string;
  projectId?: string | null;
  createdAt: string;
  data: Record<string, unknown>;
}

/**
 * Signature header format: `t=<unix seconds>,v1=<hex>`.
 *
 * The timestamp is inside the signed payload, not merely alongside it, so a captured request
 * cannot be replayed later by editing the header — the signature would no longer match. Same
 * shape as Stripe's, deliberately: consumers have seen it before.
 */
export function signWebhook(input: { timestamp: number; body: string }, secret: string): string {
  const signature = createHmac('sha256', secret).update(`${input.timestamp}.${input.body}`).digest('hex');
  return `t=${input.timestamp},v1=${signature}`;
}

/**
 * Verify a signature header. Provided for consumers and used by the tests.
 *
 * `toleranceSeconds` rejects stale deliveries; pass `0` to accept any timestamp (useful when
 * replaying from the delivery log during an integration).
 */
export function verifyWebhookSignature(
  input: { header: string | null; body: string; secret: string; toleranceSeconds?: number; now?: number },
): boolean {
  if (!input.header) return false;
  const parts = Object.fromEntries(
    input.header
      .split(',')
      .map((piece) => piece.split('='))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isFinite(timestamp) || !provided) return false;

  const tolerance = input.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > tolerance) return false;
  }

  const expected = createHmac('sha256', input.secret).update(`${timestamp}.${input.body}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // Length check first: timingSafeEqual throws on a length mismatch, which would itself leak.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Retry schedule, in seconds after the previous attempt.
 *
 * Spread over roughly half a day: a consumer that is down for a maintenance window should still
 * receive the event, and a consumer that is permanently gone should not be hammered. After the
 * last entry the delivery is marked `FAILED` and stays visible in the delivery log.
 */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [10, 30, 120, 600, 1800, 7200, 21600] as const;

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;

/** When the next attempt is due, or `null` when the delivery is exhausted. */
export function nextWebhookAttempt(attempts: number, now: Date = new Date()): Date | null {
  const delay = WEBHOOK_RETRY_DELAYS_SECONDS[attempts - 1];
  if (delay === undefined) return null;
  return new Date(now.getTime() + delay * 1000);
}

/**
 * Which endpoints receive an event.
 *
 * An endpoint with no `eventTypes` receives everything — that is what an operator means by adding
 * a webhook without narrowing it, and the alternative (silently receiving nothing) is worse.
 */
export function webhookAccepts(eventType: string, eventTypes: readonly string[]): boolean {
  if (eventTypes.length === 0) return true;
  return eventTypes.includes(eventType);
}

/** Delivery is a plain HTTP POST; anything else is a configuration mistake worth naming. */
export function assertDeliverableWebhookUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `Not a valid URL: ${url}`, 422);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, `Webhook URL must be http or https, got ${parsed.protocol}`, 422);
  }
  if (parsed.username || parsed.password) {
    // Credentials in the URL would be logged, stored and shown in the UI; a header is the place.
    throw new LocaleHubError(ErrorCode.VALIDATION_ERROR, 'Webhook URL must not embed credentials', 422);
  }
  return parsed;
}
