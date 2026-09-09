import { describe, it, expect } from 'vitest';
import { parseTimeOfDay, isWithinTimeOfDay } from '../order.controller.js';

describe('parseTimeOfDay', () => {
  it('returns null when undefined', () => {
    expect(parseTimeOfDay(undefined)).toBeNull();
  });

  it('parses a valid HH:MM into minutes-since-midnight', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('09:30')).toBe(570);
    expect(parseTimeOfDay('23:59')).toBe(1439);
  });

  it('throws on malformed input', () => {
    expect(() => parseTimeOfDay('9:30')).toThrow();
    expect(() => parseTimeOfDay('not-a-time')).toThrow();
    expect(() => parseTimeOfDay('')).not.toThrow(); // empty string is falsy -> null, not malformed
  });

  it('throws on an out-of-range hour or minute', () => {
    expect(() => parseTimeOfDay('24:00')).toThrow();
    expect(() => parseTimeOfDay('10:60')).toThrow();
  });
});

describe('isWithinTimeOfDay', () => {
  // 2026-01-15 12:00 PKT = 2026-01-15 07:00 UTC
  const noonPkt = new Date('2026-01-15T07:00:00.000Z');
  // 2026-01-15 23:30 PKT = 2026-01-15 18:30 UTC
  const latePkt = new Date('2026-01-15T18:30:00.000Z');
  // 2026-01-16 01:00 PKT = 2026-01-15 20:00 UTC
  const earlyMorningPkt = new Date('2026-01-15T20:00:00.000Z');

  it('returns true when no bounds are given', () => {
    expect(isWithinTimeOfDay(noonPkt, null, null)).toBe(true);
  });

  it('matches a normal (non-wrapping) window', () => {
    expect(isWithinTimeOfDay(noonPkt, 11 * 60, 13 * 60)).toBe(true);
    expect(isWithinTimeOfDay(noonPkt, 13 * 60, 14 * 60)).toBe(false);
  });

  it('is inclusive of the lower bound and exclusive of the upper bound', () => {
    expect(isWithinTimeOfDay(noonPkt, 12 * 60, 13 * 60)).toBe(true); // exactly at fromMin
    expect(isWithinTimeOfDay(noonPkt, 11 * 60, 12 * 60)).toBe(false); // exactly at toMin
  });

  it('defaults a missing fromTime to start of day', () => {
    expect(isWithinTimeOfDay(noonPkt, null, 13 * 60)).toBe(true);
    expect(isWithinTimeOfDay(latePkt, null, 13 * 60)).toBe(false);
  });

  it('defaults a missing toTime to end of day', () => {
    expect(isWithinTimeOfDay(latePkt, 20 * 60, null)).toBe(true);
    expect(isWithinTimeOfDay(noonPkt, 20 * 60, null)).toBe(false);
  });

  it('wraps past midnight when fromMin > toMin', () => {
    // window 22:00 -> 02:00
    expect(isWithinTimeOfDay(latePkt, 22 * 60, 2 * 60)).toBe(true); // 23:30 PKT
    expect(isWithinTimeOfDay(earlyMorningPkt, 22 * 60, 2 * 60)).toBe(true); // 01:00 PKT next day
    expect(isWithinTimeOfDay(noonPkt, 22 * 60, 2 * 60)).toBe(false); // 12:00 PKT is outside
  });
});
