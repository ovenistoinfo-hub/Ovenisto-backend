import { describe, it, expect } from 'vitest';
import { makeResetCode, createChallenge, challengeEmail, checkChallenge, RESET_CODE_TTL_MS } from '../website.passwordReset.js';

const SECRET = 'test-secret';
const NOW = 1_800_000_000_000;

describe('password reset challenge', () => {
  it('makes 6-digit codes', () => {
    for (let i = 0; i < 50; i++) expect(makeResetCode()).toMatch(/^\d{6}$/);
  });

  it('accepts the right code for the same account state, before expiry', () => {
    const ch = createChallenge(SECRET, 'a@b.com', '123456', 'Mon, 20 Oct 2026 10:00:00 GMT', NOW);
    expect(challengeEmail(ch, NOW)).toBe('a@b.com');
    expect(checkChallenge(SECRET, ch, '123456', 'Mon, 20 Oct 2026 10:00:00 GMT', NOW + 1000)).toBe(true);
  });

  it('refuses a wrong code, another secret, a used code (stamp changed) and an expired one', () => {
    const stamp = 'Mon, 20 Oct 2026 10:00:00 GMT';
    const ch = createChallenge(SECRET, 'a@b.com', '123456', stamp, NOW);
    expect(checkChallenge(SECRET, ch, '654321', stamp, NOW)).toBe(false);
    expect(checkChallenge('other', ch, '123456', stamp, NOW)).toBe(false);
    expect(checkChallenge(SECRET, ch, '123456', 'Sat, 25 Oct 2026 10:00:00 GMT', NOW)).toBe(false);
    expect(checkChallenge(SECRET, ch, '123456', stamp, NOW + RESET_CODE_TTL_MS)).toBe(false);
    expect(challengeEmail(ch, NOW + RESET_CODE_TTL_MS)).toBeNull();
  });

  it('refuses a tampered email and garbage', () => {
    const stamp = '';
    const ch = createChallenge(SECRET, 'a@b.com', '123456', stamp, NOW);
    const parsed = JSON.parse(Buffer.from(ch, 'base64url').toString('utf8'));
    const forged = Buffer.from(JSON.stringify({ ...parsed, e: 'victim@b.com' })).toString('base64url');
    expect(checkChallenge(SECRET, forged, '123456', stamp, NOW)).toBe(false);
    expect(checkChallenge(SECRET, 'not-a-challenge', '123456', stamp, NOW)).toBe(false);
    expect(checkChallenge(SECRET, ch, '12345', stamp, NOW)).toBe(false);
  });
});
