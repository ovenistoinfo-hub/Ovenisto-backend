import { describe, it, expect } from 'vitest';
import { isTrackedAdvance, advanceStampOnCreate, advanceChangesOnUpdate, advanceDeleteBlock } from '../reservation.advance.js';

const now = new Date('2026-10-12T10:00:00Z');
const manager = { id: 'u-1', name: 'Sara' };
const open = { advancePaid: 500, advanceCollectedById: 'u-1', advanceSettlementId: null, advanceRefunded: false, status: 'confirmed' };
const ctx = { user: manager, now, linkedOrderNumber: null as string | null };

describe('isTrackedAdvance', () => {
  it('needs both an amount and a collector', () => {
    expect(isTrackedAdvance(open)).toBe(true);
    expect(isTrackedAdvance({ ...open, advancePaid: 0 })).toBe(false);
    expect(isTrackedAdvance({ ...open, advanceCollectedById: null })).toBe(false);
  });
});

describe('advanceStampOnCreate', () => {
  it('stamps whoever records an advance', () => {
    expect(advanceStampOnCreate(500, manager, now)).toEqual({ advanceCollectedById: 'u-1', advanceCollectedByName: 'Sara', advanceCollectedAt: now });
  });
  it('stamps nothing without an advance', () => {
    expect(advanceStampOnCreate(0, manager, now)).toEqual({});
  });
});

describe('advanceChangesOnUpdate', () => {
  it('stamps the editor when an advance is added to a booking that had none', () => {
    const r = advanceChangesOnUpdate({ ...open, advancePaid: 0, advanceCollectedById: null }, { advancePaid: 300 }, ctx);
    expect(r).toEqual({ ok: true, data: { advanceCollectedById: 'u-1', advanceCollectedByName: 'Sara', advanceCollectedAt: now } });
  });

  it('keeps the original collector when an open advance is edited', () => {
    expect(advanceChangesOnUpdate(open, { advancePaid: 700 }, { ...ctx, user: { id: 'u-2', name: 'Ali' } })).toEqual({ ok: true, data: {} });
  });

  it('clears the collector when the advance is removed before settlement', () => {
    const r = advanceChangesOnUpdate(open, { advancePaid: 0 }, ctx);
    expect(r).toEqual({ ok: true, data: { advanceCollectedById: null, advanceCollectedByName: null, advanceCollectedAt: null, advanceRefunded: false } });
  });

  it('refuses to change a settled advance or one already on an order', () => {
    expect(advanceChangesOnUpdate({ ...open, advanceSettlementId: 's-1' }, { advancePaid: 600 }, ctx).ok).toBe(false);
    expect(advanceChangesOnUpdate(open, { advancePaid: 600 }, { ...ctx, linkedOrderNumber: 'ORD-9' })).toEqual({
      ok: false, message: 'This advance is already on order ORD-9, so it can\'t be changed.',
    });
  });

  it('lets an unrelated edit through on a settled advance', () => {
    expect(advanceChangesOnUpdate({ ...open, advanceSettlementId: 's-1' }, { advancePaid: 500 }, ctx)).toEqual({ ok: true, data: {} });
  });

  it('records a refund only on a cancelled, unsettled, unused advance', () => {
    expect(advanceChangesOnUpdate(open, { status: 'cancelled', advanceRefunded: true }, ctx)).toEqual({ ok: true, data: { advanceRefunded: true } });
    expect(advanceChangesOnUpdate(open, { status: 'cancelled', advanceRefunded: false }, ctx)).toEqual({ ok: true, data: { advanceRefunded: false } });
    expect(advanceChangesOnUpdate(open, { status: 'confirmed', advanceRefunded: true }, ctx).ok).toBe(false);
    expect(advanceChangesOnUpdate({ ...open, advanceSettlementId: 's-1' }, { status: 'cancelled', advanceRefunded: true }, ctx).ok).toBe(false);
    expect(advanceChangesOnUpdate(open, { status: 'cancelled', advanceRefunded: true }, { ...ctx, linkedOrderNumber: 'ORD-9' }).ok).toBe(false);
  });

  it('clears the refund flag when a cancelled booking is reopened', () => {
    expect(advanceChangesOnUpdate({ ...open, status: 'cancelled', advanceRefunded: true }, { status: 'confirmed' }, ctx))
      .toEqual({ ok: true, data: { advanceRefunded: false } });
  });
});

describe('advanceDeleteBlock', () => {
  it('blocks deleting a booking whose advance is still open', () => {
    expect(advanceDeleteBlock(open)).toMatch(/Cancel this booking instead/);
  });
  it('allows deleting once the advance is settled, refunded, or was never tracked', () => {
    expect(advanceDeleteBlock({ ...open, advanceSettlementId: 's-1' })).toBeNull();
    expect(advanceDeleteBlock({ ...open, advanceRefunded: true })).toBeNull();
    expect(advanceDeleteBlock({ ...open, advanceCollectedById: null })).toBeNull();
  });
});
