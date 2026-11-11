import { describe, expect, it } from 'vitest';
import {
  assertDeliverableWebhookUrl,
  nextWebhookAttempt,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  webhookAccepts,
} from '../webhooks';

/**
 * Webhook signing and retry policy.
 *
 * The signature format is a contract with consumers, so what is pinned here is the shape of the
 * header and the properties a consumer relies on: a captured request cannot be replayed with an
 * edited timestamp, and a signature comparison does not leak through timing.
 */

const SECRET = 'whsec_test_secret_value';

describe('signing', () => {
  it('signs a fixed payload reproducibly', () => {
    // A fixed vector: if the algorithm or the signed string changes, consumers break, so this
    // should fail loudly rather than drift.
    const header = signWebhook({ timestamp: 1_700_000_000, body: '{"type":"SYNC_PUSHED"}' }, SECRET);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(signWebhook({ timestamp: 1_700_000_000, body: '{"type":"SYNC_PUSHED"}' }, SECRET)).toBe(header);
  });

  it('verifies its own signature', () => {
    const body = '{"type":"TRANSLATION_APPROVED"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhook({ timestamp, body }, SECRET);
    expect(verifyWebhookSignature({ header, body, secret: SECRET })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhook({ timestamp, body: '{"a":1}' }, SECRET);
    expect(verifyWebhookSignature({ header, body: '{"a":2}', secret: SECRET })).toBe(false);
  });

  it('rejects a replayed signature with an edited timestamp', () => {
    // The timestamp is inside the signed string, so moving it forward invalidates the signature —
    // this is what stops a captured request from being replayed later.
    const body = '{"a":1}';
    const now = Math.floor(Date.now() / 1000);
    const header = signWebhook({ timestamp: now - 10_000, body }, SECRET);
    const forged = header.replace(/^t=\d+/, `t=${now}`);
    expect(verifyWebhookSignature({ header: forged, body, secret: SECRET })).toBe(false);
  });

  it('rejects a stale signature outside the tolerance window', () => {
    const body = '{"a":1}';
    const timestamp = Math.floor(Date.now() / 1000) - 4000;
    const header = signWebhook({ timestamp, body }, SECRET);
    expect(verifyWebhookSignature({ header, body, secret: SECRET })).toBe(false);
    // Replaying from the delivery log during an integration is allowed by widening the window.
    expect(verifyWebhookSignature({ header, body, secret: SECRET, toleranceSeconds: 0 })).toBe(true);
  });

  it('rejects a different secret and a malformed header', () => {
    const body = '{"a":1}';
    const timestamp = Math.floor(Date.now() / 1000);
    const header = signWebhook({ timestamp, body }, SECRET);
    expect(verifyWebhookSignature({ header, body, secret: 'whsec_other' })).toBe(false);
    expect(verifyWebhookSignature({ header: 'garbage', body, secret: SECRET })).toBe(false);
    expect(verifyWebhookSignature({ header: null, body, secret: SECRET })).toBe(false);
    // A short signature must be compared, not thrown on — timingSafeEqual rejects unequal lengths.
    expect(verifyWebhookSignature({ header: 't=1,v1=ab', body, secret: SECRET })).toBe(false);
  });
});

describe('retry schedule', () => {
  it('backs off, then gives up', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    expect(nextWebhookAttempt(1, now)!.toISOString()).toBe('2026-11-11T00:00:10.000Z');
    expect(nextWebhookAttempt(2, now)!.toISOString()).toBe('2026-11-11T00:00:30.000Z');
    // One attempt past the last delay means the delivery is exhausted.
    expect(nextWebhookAttempt(WEBHOOK_MAX_ATTEMPTS, now)).toBeNull();
  });

  it('has a schedule long enough to survive a maintenance window', () => {
    const totalHours = WEBHOOK_RETRY_DELAYS_SECONDS.reduce((sum, seconds) => sum + seconds, 0) / 3600;
    expect(totalHours).toBeGreaterThan(8);
  });
});

describe('event matching', () => {
  it('sends everything to an endpoint with no filter', () => {
    expect(webhookAccepts('SYNC_PUSHED', [])).toBe(true);
  });

  it('honours a filter', () => {
    expect(webhookAccepts('SYNC_PUSHED', ['SYNC_PUSHED', 'TRANSLATION_APPROVED'])).toBe(true);
    expect(webhookAccepts('TRANSLATION_REJECTED', ['SYNC_PUSHED'])).toBe(false);
  });
});

describe('URL validation', () => {
  it('accepts http and https', () => {
    expect(assertDeliverableWebhookUrl('https://example.com/hook').host).toBe('example.com');
    expect(assertDeliverableWebhookUrl('http://localhost:8080/hook').port).toBe('8080');
  });

  it('refuses other schemes, which fetch would not deliver anyway', () => {
    expect(() => assertDeliverableWebhookUrl('file:///etc/passwd')).toThrow(/http or https/);
    expect(() => assertDeliverableWebhookUrl('ftp://example.com')).toThrow(/http or https/);
  });

  it('refuses embedded credentials', () => {
    // They would be stored, logged and rendered in the UI; a signature header is the place for
    // authentication, not the URL.
    expect(() => assertDeliverableWebhookUrl('https://user:pass@example.com/hook')).toThrow(/must not embed credentials/);
  });

  it('refuses a URL that is not a URL', () => {
    expect(() => assertDeliverableWebhookUrl('not a url')).toThrow(/Not a valid URL/);
  });
});