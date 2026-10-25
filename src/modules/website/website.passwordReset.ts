/**
 * Website customers reset a forgotten password with a 6-digit code sent by email, entered on the website,
 * instead of Firebase's link email (owner, 2026-10-25).
 *
 * Stateless, no table: the request returns a signed "challenge" (email + expiry + HMAC over the code). The code
 * only travels in the email. The HMAC also covers the account's tokensValidAfterTime, which the reset bumps
 * (revokeRefreshTokens), so a code works once. Guessing is held off by the expiry and the per-IP rate limits.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import nodemailer, { type Transporter } from 'nodemailer';
import { getAuth } from 'firebase-admin/auth';
import { env } from '../../config/env.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ApiError } from '../../utils/ApiError.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { getFirebaseApp } from '../notifications/push.service.js';

export const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_AFTER_MS = 60 * 1000;
const WRONG_CODE = 'That code is wrong or has expired. Ask for a new one.';

export function makeResetCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function sign(secret: string, email: string, code: string, exp: number, stamp: string): string {
  return crypto.createHmac('sha256', secret).update(`${email}\n${code}\n${exp}\n${stamp}`).digest('base64url');
}

/** `stamp` = the account's tokensValidAfterTime ('' when there is no account), so a used code stops working. */
export function createChallenge(secret: string, email: string, code: string, stamp: string, nowMs: number): string {
  const exp = nowMs + RESET_CODE_TTL_MS;
  return Buffer.from(JSON.stringify({ e: email, x: exp, s: sign(secret, email, code, exp, stamp) })).toString('base64url');
}

/** The challenge's email (to look the account up), or null when it's malformed or expired. */
export function challengeEmail(challenge: string, nowMs: number): string | null {
  try {
    const { e, x } = JSON.parse(Buffer.from(challenge, 'base64url').toString('utf8'));
    return typeof e === 'string' && typeof x === 'number' && x > nowMs ? e : null;
  } catch {
    return null;
  }
}

export function checkChallenge(secret: string, challenge: string, code: string, stamp: string, nowMs: number): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  try {
    const { e, x, s } = JSON.parse(Buffer.from(challenge, 'base64url').toString('utf8'));
    if (typeof e !== 'string' || typeof x !== 'number' || typeof s !== 'string' || x <= nowMs) return false;
    const want = Buffer.from(sign(secret, e, code, x, stamp));
    const got = Buffer.from(s);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

const secret = () => `${env.JWT_SECRET}:website-password-reset`;
const normEmail = (raw: unknown) => String(raw ?? '').trim().toLowerCase();

let transporter: Transporter | null | undefined;
/** SMTP from env (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, optional MAIL_FROM); null when not set up. */
function mailer(): Transporter | null {
  if (transporter !== undefined) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  const port = Number(SMTP_PORT) || 587;
  transporter = SMTP_HOST && SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
    : null;
  return transporter;
}

async function sendCodeEmail(to: string, code: string): Promise<void> {
  const mail = mailer();
  if (!mail) {
    // Local development only (production answers 503 before this): lets the flow be tried without SMTP.
    console.log(`[password-reset] code for ${to}: ${code}`);
    return;
  }
  await mail.sendMail({
    from: process.env.MAIL_FROM || `Ovenisto <${process.env.SMTP_USER}>`,
    to,
    subject: `${code} is your Ovenisto password reset code`,
    text: `Your Ovenisto password reset code is ${code}.\n\nEnter it on the website within 10 minutes to choose a new password.\nIf you didn't ask for this, you can ignore this email; your password stays the same.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#141413">
<p style="font-size:16px;margin:0 0 12px">Your Ovenisto password reset code:</p>
<p style="font-size:32px;font-weight:bold;letter-spacing:8px;margin:0 0 16px;color:#c96442">${code}</p>
<p style="font-size:14px;color:#6e6d68;margin:0">Enter it on the website within 10 minutes to choose a new password. If you didn't ask for this, ignore this email; your password stays the same.</p>
</div>`,
  });
}

function adminAuth() {
  const app = getFirebaseApp();
  if (!app) throw new ApiError('Password reset by code is not set up yet.', 503);
  return getAuth(app);
}

async function findAccount(email: string) {
  return adminAuth().getUserByEmail(email).catch(() => null);
}

// One code per email per minute; a small in-memory map is enough (it only slows down repeats).
const lastSent = new Map<string, number>();

export const requestPasswordReset = asyncHandler(async (req: Request, res: Response) => {
  const email = normEmail(req.body.email);
  if (!mailer() && env.NODE_ENV === 'production') throw new ApiError('Password reset by code is not set up yet.', 503);
  const now = Date.now();
  if (now - (lastSent.get(email) ?? 0) < RESEND_AFTER_MS) throw ApiError.tooManyRequests('Please wait a minute before asking for another code.');
  if (lastSent.size > 5000) lastSent.clear();
  lastSent.set(email, now);

  // The same answer whether or not the account exists, so the form can't be used to find accounts.
  const user = await findAccount(email);
  const code = makeResetCode();
  const challenge = createChallenge(secret(), email, code, user?.tokensValidAfterTime ?? '', now);
  if (user) {
    try {
      await sendCodeEmail(email, code);
    } catch (err) {
      console.error('[password-reset] email failed:', err);
      lastSent.delete(email);
      throw new ApiError("We couldn't send the email. Try again in a minute.", 502);
    }
  }
  res.json(ApiResponse.success({ challenge, expiresInMinutes: RESET_CODE_TTL_MS / 60000 }));
});

async function accountForCode(challenge: string, code: string) {
  const email = challengeEmail(challenge, Date.now());
  const user = email ? await findAccount(email) : null;
  if (!user || !checkChallenge(secret(), challenge, code, user.tokensValidAfterTime ?? '', Date.now())) throw ApiError.badRequest(WRONG_CODE);
  return user;
}

export const verifyPasswordResetCode = asyncHandler(async (req: Request, res: Response) => {
  await accountForCode(String(req.body.challenge), String(req.body.code));
  res.json(ApiResponse.success({ valid: true }));
});

export const confirmPasswordReset = asyncHandler(async (req: Request, res: Response) => {
  const user = await accountForCode(String(req.body.challenge), String(req.body.code));
  const auth = adminAuth();
  // The code proved they own the address, so it counts as verified; old sessions are signed out.
  await auth.updateUser(user.uid, { password: String(req.body.password), emailVerified: true });
  await auth.revokeRefreshTokens(user.uid);
  res.json(ApiResponse.success({ reset: true }));
});
