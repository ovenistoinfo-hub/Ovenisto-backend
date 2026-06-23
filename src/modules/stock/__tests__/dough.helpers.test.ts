import { describe, it, expect } from 'vitest';
import { computeExpiry, effectiveExpiry, minutesRemaining, batchStatus, fifoDrawdown } from '../dough.helpers.js';

describe('computeExpiry', () => {
  it('adds shelfLifeHours to createdAt', () => {
    expect(computeExpiry(new Date('2026-06-20T09:00:00.000Z'), 8).toISOString())
      .toBe('2026-06-20T17:00:00.000Z');
  });
});

describe('effectiveExpiry', () => {
  const made = new Date('2026-06-20T09:00:00.000Z');
  it('uses the per-batch minutes when present (overrides ingredient hours)', () => {
    // 270 min = 4h30m -> 13:30, ignoring the ingredient default of 8h
    expect(effectiveExpiry(made, 270, 8).toISOString()).toBe('2026-06-20T13:30:00.000Z');
  });
  it('falls back to ingredient shelfLifeHours when batch minutes is null', () => {
    expect(effectiveExpiry(made, null, 8).toISOString()).toBe('2026-06-20T17:00:00.000Z');
  });
  it('honours a zero-minute override (expires immediately at made-at)', () => {
    expect(effectiveExpiry(made, 0, 8).toISOString()).toBe('2026-06-20T09:00:00.000Z');
  });
  it('treats a batch with neither value as already expired (expiry === createdAt)', () => {
    expect(effectiveExpiry(made, null, null).toISOString()).toBe('2026-06-20T09:00:00.000Z');
  });
});

describe('minutesRemaining', () => {
  it('returns whole minutes until expiry', () => {
    expect(minutesRemaining(new Date('2026-06-20T17:00:00.000Z'), new Date('2026-06-20T15:30:00.000Z'))).toBe(90);
  });
  it('floors at 0 when already expired', () => {
    expect(minutesRemaining(new Date('2026-06-20T17:00:00.000Z'), new Date('2026-06-20T18:00:00.000Z'))).toBe(0);
  });
});

describe('batchStatus', () => {
  const exp = new Date('2026-06-20T17:00:00.000Z');
  it('active when more than 60 min left', () => {
    expect(batchStatus(exp, new Date('2026-06-20T15:00:00.000Z'))).toBe('active');
  });
  it('near-expiry at exactly 60 min', () => {
    expect(batchStatus(exp, new Date('2026-06-20T16:00:00.000Z'))).toBe('near-expiry');
  });
  it('expired at exactly 0', () => {
    expect(batchStatus(exp, new Date('2026-06-20T17:00:00.000Z'))).toBe('expired');
  });
  it('expired when past', () => {
    expect(batchStatus(exp, new Date('2026-06-20T18:00:00.000Z'))).toBe('expired');
  });
});

describe('fifoDrawdown', () => {
  it('draws from oldest first, flooring each at 0', () => {
    const batches = [
      { id: 'a', remainingQty: 3 }, // caller passes oldest-first
      { id: 'b', remainingQty: 5 },
    ];
    expect(fifoDrawdown(batches, 4)).toEqual([
      { id: 'a', newRemaining: 0 },
      { id: 'b', newRemaining: 4 },
    ]);
  });
  it('only touches batches it draws from', () => {
    const batches = [{ id: 'a', remainingQty: 10 }, { id: 'b', remainingQty: 5 }];
    expect(fifoDrawdown(batches, 4)).toEqual([{ id: 'a', newRemaining: 6 }]);
  });
  it('drains all and stops when qty exceeds available', () => {
    const batches = [{ id: 'a', remainingQty: 2 }, { id: 'b', remainingQty: 1 }];
    expect(fifoDrawdown(batches, 10)).toEqual([
      { id: 'a', newRemaining: 0 },
      { id: 'b', newRemaining: 0 },
    ]);
  });
});
