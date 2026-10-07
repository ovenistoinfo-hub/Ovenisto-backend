import { describe, it, expect } from 'vitest';
import { reservationSchema, quoteReservationSchema } from '../website.schema.js';

const OUTLET = '143113a2-e108-41f7-81f7-03db9ba1e55c';
const ITEM = { menuItemId: '1600dc6c-469f-418c-8740-96c875cb3afd', name: 'Zinger', qty: 1 };
const base = { outletId: OUTLET, customerName: 'Test', customerPhone: '0300-1234567', date: '2026-12-01', time: '19:00' };

describe('reservationSchema', () => {
  it('keeps the old Dine In table booking working (defaults: Dine In, 1 guest, no items)', () => {
    const parsed = reservationSchema.parse(base);
    expect(parsed).toMatchObject({ orderType: 'Dine In', guestCount: 1, items: [] });
  });

  it('requires a pre-order for Take Away and Delivery', () => {
    expect(reservationSchema.safeParse({ ...base, orderType: 'Take Away' }).success).toBe(false);
    expect(reservationSchema.safeParse({ ...base, orderType: 'Take Away', items: [ITEM] }).success).toBe(true);
  });

  it('requires a 10+ character address for Delivery', () => {
    expect(reservationSchema.safeParse({ ...base, orderType: 'Delivery', items: [ITEM], deliveryAddress: 'short' }).success).toBe(false);
    expect(reservationSchema.safeParse({ ...base, orderType: 'Delivery', items: [ITEM], deliveryAddress: 'House 1, Street 2, Lahore' }).success).toBe(true);
  });

  it('rejects an unknown booking type', () => {
    expect(reservationSchema.safeParse({ ...base, orderType: 'Foodpanda', items: [ITEM] }).success).toBe(false);
  });
});

describe('quoteReservationSchema', () => {
  it('allows an empty Dine In quote but not an empty Delivery one', () => {
    expect(quoteReservationSchema.safeParse({ outletId: OUTLET, orderType: 'Dine In' }).success).toBe(true);
    expect(quoteReservationSchema.safeParse({ outletId: OUTLET, orderType: 'Delivery', items: [] }).success).toBe(false);
  });
});
