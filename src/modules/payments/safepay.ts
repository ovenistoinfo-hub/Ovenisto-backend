// Safepay (website online payment): the calls we use, written to match the official SDK
// `@sfpy/node-sdk` 3.0.2 without pulling in its axios dependency. Pure except createTracker and fetchTracker.
import crypto from 'crypto';

export type SafepayEnv = 'sandbox' | 'production';

export interface SafepayConfig {
  env: SafepayEnv;
  apiKey: string;
  v1Secret: string;
  webhookSecret: string;
}

const API_URL: Record<SafepayEnv, string> = {
  sandbox: 'https://sandbox.api.getsafepay.com',
  production: 'https://api.getsafepay.com',
};

const CHECKOUT_URL: Record<SafepayEnv, string> = {
  sandbox: 'https://sandbox.api.getsafepay.com/checkout',
  production: 'https://getsafepay.com/checkout',
};

/**
 * The gateway is on only when all four settings are present. Values are trimmed (a key pasted into
 * Railway often carries a trailing space or newline, which would silently break every signature) and
 * a blank one counts as missing.
 */
export function readSafepayConfig(e: Record<string, string | undefined>): SafepayConfig | null {
  const env = e.SAFEPAY_ENV?.trim();
  const apiKey = e.SAFEPAY_API_KEY?.trim();
  const v1Secret = e.SAFEPAY_V1_SECRET?.trim();
  const webhookSecret = e.SAFEPAY_WEBHOOK_SECRET?.trim();
  if (env !== 'sandbox' && env !== 'production') return null;
  if (!apiKey || !v1Secret || !webhookSecret) return null;
  return { env, apiKey, v1Secret, webhookSecret };
}

/** Safepay's hosted checkout page for a tracker token. */
export function buildCheckoutUrl(
  cfg: SafepayConfig,
  p: { token: string; orderId: string; redirectUrl: string; cancelUrl: string }
): string {
  const params = new URLSearchParams({
    beacon: p.token,
    cancel_url: p.cancelUrl,
    env: cfg.env,
    order_id: p.orderId,
    redirect_url: p.redirectUrl,
    source: 'custom',
    webhooks: 'true',
  });
  return `${CHECKOUT_URL[cfg.env]}?${params.toString()}`;
}

function hmacMatches(algorithm: 'sha256' | 'sha512', secret: string, payload: string | Buffer, given: unknown): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const expected = Buffer.from(crypto.createHmac(algorithm, secret).update(payload).digest('hex'));
  const actual = Buffer.from(given);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** HMAC-SHA256(v1Secret, tracker), hex: the SDK's redirect `sig`, and the `signature` on a paid tracker's transaction. */
export function isValidReturnSignature(cfg: SafepayConfig, tracker: unknown, sig: unknown): boolean {
  if (typeof tracker !== 'string' || tracker.length === 0) return false;
  return hmacMatches('sha256', cfg.v1Secret, tracker, sig);
}

/** A webhook: header `x-sfpy-signature` = HMAC-SHA512(webhookSecret, JSON.stringify(body.data)), hex. */
export function isValidWebhookSignature(cfg: SafepayConfig, data: unknown, signature: unknown): boolean {
  if (data === undefined) return false;
  return hmacMatches('sha512', cfg.webhookSecret, Buffer.from(JSON.stringify(data)), signature);
}

/** Starts a payment for `amount` rupees and returns Safepay's tracker token. */
export async function createTracker(cfg: SafepayConfig, amount: number): Promise<string> {
  const res = await fetch(`${API_URL[cfg.env]}/order/v1/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: cfg.apiKey, amount, currency: 'PKR', environment: cfg.env }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { data?: { token?: unknown } } | null;
  const token = body?.data?.token;
  if (!res.ok || typeof token !== 'string' || token.length === 0) {
    throw new Error(`Safepay init failed (HTTP ${res.status})`);
  }
  return token;
}

/** A tracker as Safepay reports it (the fields we read). */
export interface TrackerRecord {
  token?: unknown;
  client?: unknown;
  state?: unknown;
  transaction?: { tracker?: unknown; amount?: unknown; signature?: unknown } | null;
}

/**
 * Whether Safepay's own record says this tracker was paid: it ended with a transaction on our account
 * for at least `amount` rupees, and that transaction's signature checks out. The redirect back brings
 * no signature (seen in the sandbox), so this record is what we trust.
 */
export function isTrackerPaid(cfg: SafepayConfig, tracker: string, amount: number, rec: TrackerRecord | null | undefined): boolean {
  const txn = rec?.transaction;
  if (!rec || !txn) return false;
  return rec.token === tracker
    && rec.client === cfg.apiKey
    && rec.state === 'TRACKER_ENDED'
    && txn.tracker === tracker
    && Number(txn.amount) >= amount - 0.5
    && isValidReturnSignature(cfg, tracker, txn.signature);
}

/** Reads a tracker from Safepay (it asks for no key on this call). */
export async function fetchTracker(cfg: SafepayConfig, tracker: string): Promise<TrackerRecord | null> {
  const res = await fetch(`${API_URL[cfg.env]}/order/v1/${encodeURIComponent(tracker)}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Safepay tracker lookup failed (HTTP ${res.status})`);
  const body = (await res.json().catch(() => null)) as { data?: TrackerRecord } | null;
  return body?.data ?? null;
}
