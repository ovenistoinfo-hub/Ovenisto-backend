import crypto from 'crypto';
import { describe, it, expect } from 'vitest';
import { readSafepayConfig, buildCheckoutUrl, isValidReturnSignature, isValidWebhookSignature, isTrackerPaid, type SafepayConfig } from '../safepay.js';

const cfg: SafepayConfig = { env: 'sandbox', apiKey: 'sec_test', v1Secret: 'v1-secret', webhookSecret: 'wh-secret' };

describe('readSafepayConfig', () => {
  it('turns the gateway on only when all four settings are present', () => {
    expect(readSafepayConfig({ SAFEPAY_ENV: 'sandbox', SAFEPAY_API_KEY: 'k', SAFEPAY_V1_SECRET: 's', SAFEPAY_WEBHOOK_SECRET: 'w' }))
      .toEqual({ env: 'sandbox', apiKey: 'k', v1Secret: 's', webhookSecret: 'w' });
    expect(readSafepayConfig({ SAFEPAY_ENV: 'sandbox', SAFEPAY_API_KEY: 'k', SAFEPAY_V1_SECRET: 's' })).toBeNull();
    expect(readSafepayConfig({ SAFEPAY_ENV: 'live', SAFEPAY_API_KEY: 'k', SAFEPAY_V1_SECRET: 's', SAFEPAY_WEBHOOK_SECRET: 'w' })).toBeNull();
    expect(readSafepayConfig({})).toBeNull();
  });

  it('trims the values, since a pasted key often carries a space or newline', () => {
    expect(readSafepayConfig({ SAFEPAY_ENV: ' sandbox\n', SAFEPAY_API_KEY: '  k ', SAFEPAY_V1_SECRET: 's\n', SAFEPAY_WEBHOOK_SECRET: '\tw ' }))
      .toEqual({ env: 'sandbox', apiKey: 'k', v1Secret: 's', webhookSecret: 'w' });
  });

  it('treats a whitespace-only value as missing', () => {
    expect(readSafepayConfig({ SAFEPAY_ENV: 'sandbox', SAFEPAY_API_KEY: '   ', SAFEPAY_V1_SECRET: 's', SAFEPAY_WEBHOOK_SECRET: 'w' })).toBeNull();
    expect(readSafepayConfig({ SAFEPAY_ENV: 'sandbox', SAFEPAY_API_KEY: 'k', SAFEPAY_V1_SECRET: 's', SAFEPAY_WEBHOOK_SECRET: '\n' })).toBeNull();
  });

  it('accepts production', () => {
    expect(readSafepayConfig({ SAFEPAY_ENV: 'production', SAFEPAY_API_KEY: 'k', SAFEPAY_V1_SECRET: 's', SAFEPAY_WEBHOOK_SECRET: 'w' }))
      .toEqual({ env: 'production', apiKey: 'k', v1Secret: 's', webhookSecret: 'w' });
  });
});

describe('buildCheckoutUrl', () => {
  it('uses the SDK query parameters', () => {
    const url = new URL(buildCheckoutUrl(cfg, {
      token: 'track_1',
      orderId: 'ORD-101',
      redirectUrl: 'https://api.example.com/api/payments/safepay/return?pid=p1',
      cancelUrl: 'https://site.example.com/order/o1?payment=cancelled',
    }));
    expect(url.origin + url.pathname).toBe('https://sandbox.api.getsafepay.com/checkout');
    expect(url.searchParams.get('beacon')).toBe('track_1');
    expect(url.searchParams.get('order_id')).toBe('ORD-101');
    expect(url.searchParams.get('redirect_url')).toBe('https://api.example.com/api/payments/safepay/return?pid=p1');
    expect(url.searchParams.get('cancel_url')).toBe('https://site.example.com/order/o1?payment=cancelled');
    expect(url.searchParams.get('env')).toBe('sandbox');
    expect(url.searchParams.get('source')).toBe('custom');
    expect(url.searchParams.get('webhooks')).toBe('true');
  });

  it('points production at getsafepay.com', () => {
    expect(buildCheckoutUrl({ ...cfg, env: 'production' }, { token: 't', orderId: 'o', redirectUrl: 'r', cancelUrl: 'c' }))
      .toMatch(/^https:\/\/getsafepay\.com\/checkout\?/);
  });
});

describe('isValidReturnSignature', () => {
  const sig = crypto.createHmac('sha256', 'v1-secret').update('track_1').digest('hex');

  it('accepts the HMAC-SHA256 of the tracker', () => {
    expect(isValidReturnSignature(cfg, 'track_1', sig)).toBe(true);
  });

  it('rejects a wrong tracker, a wrong signature or missing values', () => {
    expect(isValidReturnSignature(cfg, 'track_2', sig)).toBe(false);
    expect(isValidReturnSignature(cfg, 'track_1', 'abc')).toBe(false);
    expect(isValidReturnSignature(cfg, 'track_1', undefined)).toBe(false);
    expect(isValidReturnSignature(cfg, '', sig)).toBe(false);
  });
});

describe('isValidWebhookSignature', () => {
  const data = { tracker: 'track_1', state: 'PAID' };
  const signature = crypto.createHmac('sha512', 'wh-secret').update(Buffer.from(JSON.stringify(data))).digest('hex');

  it('accepts the HMAC-SHA512 of JSON.stringify(data)', () => {
    expect(isValidWebhookSignature(cfg, data, signature)).toBe(true);
  });

  it('rejects tampered data, a wrong header or no data', () => {
    expect(isValidWebhookSignature(cfg, { ...data, state: 'FAILED' }, signature)).toBe(false);
    expect(isValidWebhookSignature(cfg, data, 'nope')).toBe(false);
    expect(isValidWebhookSignature(cfg, undefined, signature)).toBe(false);
  });
});

describe('isTrackerPaid', () => {
  const tracker = 'track_1';
  const signature = crypto.createHmac('sha256', cfg.v1Secret).update(tracker).digest('hex');
  // The shape Safepay's GET /order/v1/{tracker} returned for a paid sandbox order.
  const paid = { token: tracker, client: cfg.apiKey, state: 'TRACKER_ENDED', transaction: { tracker, amount: 2411, signature } };

  it('accepts an ended tracker with a signed transaction for the amount', () => {
    expect(isTrackerPaid(cfg, tracker, 2411, paid)).toBe(true);
  });

  it('rejects a tracker that was only started or was cancelled', () => {
    expect(isTrackerPaid(cfg, tracker, 2411, { token: tracker, client: cfg.apiKey, state: 'TRACKER_STARTED', transaction: null })).toBe(false);
    expect(isTrackerPaid(cfg, tracker, 2411, { ...paid, state: 'TRACKER_CANCELLED' })).toBe(false);
    expect(isTrackerPaid(cfg, tracker, 2411, null)).toBe(false);
  });

  it('rejects a smaller amount, another account, another tracker or a bad signature', () => {
    expect(isTrackerPaid(cfg, tracker, 2500, paid)).toBe(false);
    expect(isTrackerPaid(cfg, tracker, 2411, { ...paid, client: 'sec_other' })).toBe(false);
    expect(isTrackerPaid(cfg, 'track_2', 2411, paid)).toBe(false);
    expect(isTrackerPaid(cfg, tracker, 2411, { ...paid, transaction: { ...paid.transaction, signature: 'nope' } })).toBe(false);
  });
});
